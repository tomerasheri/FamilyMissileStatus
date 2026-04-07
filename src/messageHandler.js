'use strict';

/**
 * Handles all inbound WhatsApp messages routed by the webhook.
 *
 * ── Location message ──────────────────────────────────────────────────────────
 *   User shares their location → register / update them.
 *
 * ── Button reply ──────────────────────────────────────────────────────────────
 *   safe_yes__<pendingId>  → mark safe, broadcast to group
 *   safe_no__<pendingId>   → mark unsafe, broadcast to group
 *
 * ── Text commands ─────────────────────────────────────────────────────────────
 *   /create <name>     → create a family group, return invite code
 *   /join <code>       → join a group by invite code
 *   /leave <code>      → leave a group
 *   /status            → show all groups and member statuses
 *   /help              → show help
 *   (anything else)    → send help hint
 */

const { v4: uuid }    = require('uuid');
const crypto           = require('crypto');
const db               = require('./db');
const wa               = require('./whatsapp');
const { reverseGeocode } = require('./geocoder');
const {
  validateGroupName,
  validateCoordinates,
  validateUuid,
} = require('./security');

// ── Entry point ───────────────────────────────────────────────────────────────

async function handle(parsed) {
  if (!parsed) return;

  switch (parsed.type) {
    case 'location':     return handleLocation(parsed);
    case 'button_reply': return handleButtonReply(parsed);
    case 'text':         return handleText(parsed);
  }
}

// ── Location ──────────────────────────────────────────────────────────────────

async function handleLocation({ waId, name, lat, lon }) {
  if (!validateCoordinates(lat, lon)) {
    console.warn(`[MsgHandler] Invalid coordinates from ${waId}: ${lat},${lon}`);
    return;
  }

  let geo = { cityHe: null, cityEn: null, display: `${lat},${lon}` };
  try {
    geo = await reverseGeocode(lat, lon);
  } catch (err) {
    console.error('[MsgHandler] Geocoding failed:', err.message);
  }

  db.upsertUser({
    wa_id:   waId,
    phone:   waId,
    city_he: geo.cityHe,
    city_en: geo.cityEn,
    lat,
    lon,
  });

  const cityDisplay = geo.cityHe
    ? `${geo.cityHe}${geo.cityEn ? ` (${geo.cityEn})` : ''}`
    : geo.display;

  await wa.sendText(
    waId,
    `✅ *Registered!*\n\n` +
    `Hi ${name}, you're now registered in *${cityDisplay}*.\n\n` +
    `You'll receive alerts when there's a rocket warning in your area.\n\n` +
    `Want to create or join a family group? Send */help* for commands.`,
  );
}

// ── Button reply ──────────────────────────────────────────────────────────────

async function handleButtonReply({ waId, name, buttonId }) {
  // Button IDs are  "safe_yes__<uuid>"  or  "safe_no__<uuid>"
  const [action, pendingId] = buttonId.split('__');

  if (!pendingId || (action !== 'safe_yes' && action !== 'safe_no')) {
    return; // unknown button
  }

  // Validate UUID format to guard against injection / path traversal via buttonId
  if (!validateUuid(pendingId)) {
    console.warn(`[MsgHandler] Malformed pendingId in button reply from ${waId}`);
    return;
  }

  // Ownership check: only the user the alert was sent to may respond to it
  const pending = db.getOpenPending(waId);
  if (!pending || pending.id !== pendingId) {
    console.warn(`[MsgHandler] Button reply ownership mismatch from ${waId} for ${pendingId}`);
    // Don't reveal whether the pending ID exists to the sender
    return;
  }

  const response = action === 'safe_yes' ? 'safe' : 'unsafe';
  db.markResponded(pendingId, response);

  if (response === 'safe') {
    await wa.sendText(waId, '✅ Glad you\'re safe! Your family has been notified.');
  } else {
    await wa.sendText(
      waId,
      '🆘 *Help alert sent to your family group!*\n\n' +
      'Please try to reach a shelter immediately.\n' +
      'Emergency services: *101* (police) | *102* (fire) | *101* (Magen David Adom)',
    );
  }

  await broadcastResponseToGroup(waId, response);
}

async function broadcastResponseToGroup(waId, response) {
  const groups = db.getUserGroups(waId);
  const user   = db.getUser(waId);
  const name   = user?.phone || waId;

  if (groups.length === 0) return;

  const statusText = response === 'safe'
    ? `${name} is *safe* ✅`
    : `⚠️ ${name} *needs help* 🆘`;

  for (const group of groups) {
    const members = db.getMembers(group.id);

    // Build a full group status summary
    const summaryLines = await buildGroupSummary(group.id, waId, response);

    for (const member of members) {
      if (member.wa_id === waId) continue;

      const text =
        `👨‍👩‍👧 *${group.name}* – Status Update\n\n` +
        `${statusText}\n\n` +
        `*Group summary:*\n${summaryLines}`;

      wa.sendText(member.wa_id, text).catch(() => {});
    }
  }
}

/**
 * Builds a bullet-point status summary for all group members.
 * The calling member's fresh response is injected directly so we
 * don't rely on the DB having been updated yet.
 */
async function buildGroupSummary(groupId, respondedWaId, respondedStatus) {
  const members = db.getMembers(groupId);
  const lines   = [];

  for (const m of members) {
    const pending = db.getOpenPending(m.wa_id);
    let status;

    if (m.wa_id === respondedWaId) {
      status = respondedStatus === 'safe' ? '✅ Safe' : '🆘 Needs help';
    } else if (!pending) {
      status = '⬜ No active alert';
    } else if (pending.response === 'safe') {
      status = '✅ Safe';
    } else if (pending.response === 'unsafe') {
      status = '🆘 Needs help';
    } else {
      status = '⏳ Waiting for response';
    }

    const label = m.city_he ? `${m.phone || m.wa_id} (${m.city_he})` : (m.phone || m.wa_id);
    lines.push(`• ${label}: ${status}`);
  }

  return lines.join('\n');
}

// ── Text commands ─────────────────────────────────────────────────────────────

async function handleText({ waId, name, text }) {
  const lower = text.toLowerCase().trim();

  if (lower.startsWith('/create ') || lower.startsWith('create ')) {
    return cmdCreate(waId, name, text);
  }
  if (lower.startsWith('/join ') || lower.startsWith('join ')) {
    return cmdJoin(waId, name, text);
  }
  if (lower.startsWith('/leave') || lower.startsWith('leave')) {
    return cmdLeave(waId, name, text);
  }
  if (lower === '/status' || lower === 'status') {
    return cmdStatus(waId);
  }
  if (lower === '/delete' || lower === 'delete') {
    return cmdDelete(waId);
  }
  if (lower === '/help' || lower === 'help' || lower === 'hi' || lower === 'hello' || lower === 'שלום') {
    return cmdHelp(waId, name);
  }

  // Fallback: encourage them to share location or type /help
  const user = db.getUser(waId);
  if (!user) {
    await wa.sendText(
      waId,
      `👋 Hi ${name}! To register, please *share your live location* with this chat.\n\nType */help* for all commands.`,
    );
  } else {
    await wa.sendText(waId, 'Type */help* to see available commands.');
  }
}

const MAX_GROUPS_PER_USER = 5;
const MAX_MEMBERS_PER_GROUP = 20;

// /create <group name>
async function cmdCreate(waId, name, text) {
  const raw = text.replace(/^\/?create\s+/i, '');
  const validation = validateGroupName(raw);
  if (!validation.ok) {
    return wa.sendText(waId, `⚠️ ${validation.reason}\n\nUsage: */create* _Family Group Name_`);
  }
  const groupName = validation.value;

  const user = db.getUser(waId);
  if (!user) {
    return wa.sendText(waId, '⚠️ Please share your location first to register.');
  }

  // Limit how many groups a single user can create to prevent message-amplification attacks
  if (db.countGroupsCreatedBy(waId) >= MAX_GROUPS_PER_USER) {
    return wa.sendText(waId, `⚠️ You can create at most ${MAX_GROUPS_PER_USER} groups.`);
  }

  const groupId    = uuid();
  const inviteCode = generateCode();

  db.createGroup({ id: groupId, name: groupName, invite_code: inviteCode, created_by: waId });
  db.addMember(groupId, waId);

  await wa.sendText(
    waId,
    `✅ *Family group "${groupName}" created!*\n\n` +
    `📋 Invite code: *${inviteCode}*\n\n` +
    `Share this code with family members. They can join by sending:\n` +
    `*/join ${inviteCode}*`,
  );
}

// /join <code>
async function cmdJoin(waId, name, text) {
  // Strip everything except alphanumeric chars so someone can't probe the DB
  const code = text.replace(/^\/?join\s+/i, '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!code || code.length !== 6) {
    return wa.sendText(waId, 'Usage: */join* _INVITE_CODE_ (6-character code)');
  }

  const user = db.getUser(waId);
  if (!user) {
    return wa.sendText(waId, '⚠️ Please share your location first to register.');
  }

  const group = db.getGroupByCode(code);
  if (!group) {
    return wa.sendText(waId, `❌ No group found with code *${code}*. Check the code and try again.`);
  }

  if (db.isMember(group.id, waId)) {
    return wa.sendText(waId, `ℹ️ You're already a member of *${group.name}*.`);
  }

  // Cap group size to limit alert fan-out
  if (db.countGroupMembers(group.id) >= MAX_MEMBERS_PER_GROUP) {
    return wa.sendText(waId, `⚠️ This group is full (max ${MAX_MEMBERS_PER_GROUP} members).`);
  }

  db.addMember(group.id, waId);

  const members = db.getMembers(group.id);

  // Notify the new member
  await wa.sendText(
    waId,
    `✅ Joined *${group.name}*!\n\n` +
    `Members: ${members.map(m => m.phone || m.wa_id).join(', ')}`,
  );

  // Notify existing members — sanitize name before broadcasting to others
  const safeName = sanitizeName(name);
  for (const m of members) {
    if (m.wa_id === waId) continue;
    wa.sendText(m.wa_id, `👋 *${safeName}* joined the group *${group.name}*!`).catch(() => {});
  }
}

// /leave [code]  — if no code, leave all groups
async function cmdLeave(waId, name, text) {
  const code = text.replace(/^\/?leave\s*/i, '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

  if (code) {
    const group = db.getGroupByCode(code);
    if (!group) {
      return wa.sendText(waId, `❌ No group found with code *${code}*.`);
    }
    if (!db.isMember(group.id, waId)) {
      return wa.sendText(waId, `ℹ️ You're not a member of *${group.name}*.`);
    }
    db.removeMember(group.id, waId);

    await wa.sendText(waId, `✅ Left *${group.name}*.`);

    const remaining = db.getMembers(group.id);
    const safeName  = sanitizeName(name);
    for (const m of remaining) {
      wa.sendText(m.wa_id, `ℹ️ ${safeName} left *${group.name}*.`).catch(() => {});
    }
  } else {
    const groups = db.getUserGroups(waId);
    if (groups.length === 0) {
      return wa.sendText(waId, `ℹ️ You're not in any groups.`);
    }
    for (const g of groups) {
      db.removeMember(g.id, waId);
    }
    await wa.sendText(waId, `✅ Left ${groups.length} group(s).`);
  }
}

// /status
async function cmdStatus(waId) {
  const groups = db.getUserGroups(waId);

  if (groups.length === 0) {
    return wa.sendText(
      waId,
      `ℹ️ You're not in any family groups.\n\nCreate one with */create _Group Name_*`,
    );
  }

  const lines = [];
  for (const group of groups) {
    lines.push(`👨‍👩‍👧 *${group.name}* (code: ${group.invite_code})`);
    const members = db.getMembers(group.id);
    for (const m of members) {
      const pending = db.getOpenPending(m.wa_id);
      let status = '⬜ No active alert';
      if (pending) {
        if (pending.response === 'safe')   status = '✅ Safe';
        else if (pending.response === 'unsafe') status = '🆘 Needs help';
        else if (pending.nudge_sent)       status = '⏰ Nudged – no reply yet';
        else                               status = '⏳ Alert sent – awaiting reply';
      }
      const loc = m.city_he ? ` – ${m.city_he}` : '';
      lines.push(`  • ${m.phone || m.wa_id}${loc}: ${status}`);
    }
    lines.push('');
  }

  await wa.sendText(waId, lines.join('\n').trim());
}

// /delete — erase all personal data for this user
async function cmdDelete(waId) {
  const user = db.getUser(waId);
  if (!user) {
    return wa.sendText(waId, `ℹ️ You're not registered, so there's nothing to delete.`);
  }

  db.deleteUser(waId);

  await wa.sendText(
    waId,
    `🗑️ *All your data has been deleted.*\n\n` +
    `Your location, group memberships, and alert history have been removed.\n\n` +
    `You will no longer receive alerts. Share your location again to re-register.`,
  );
}

// /help
async function cmdHelp(waId, name) {
  await wa.sendText(
    waId,
    `🛡️ *Family Missile Status Bot* – Help\n\n` +
    `*Registration*\n` +
    `📍 Share your location to register and receive alerts for your area.\n\n` +
    `*Family Groups*\n` +
    `*/create* _Name_ – Create a new family group\n` +
    `*/join* _CODE_ – Join a group using an invite code\n` +
    `*/leave* _CODE_ – Leave a specific group\n` +
    `*/status* – See the current safety status of all your group members\n` +
    `*/delete* – Permanently erase all your data from this bot\n\n` +
    `*How it works*\n` +
    `When a rocket alert fires in your city, you'll receive a message with two buttons: ✅ Safe or 🆘 Help.\n` +
    `If you don't respond within 10 minutes, we'll send a reminder and notify your family group.`,
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O,0,I,1 to avoid visual confusion
  // Use crypto.randomBytes for cryptographically secure randomness.
  // Math.random() is predictable and must never be used for security-sensitive tokens.
  const bytes = crypto.randomBytes(6);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

/**
 * Sanitise a WhatsApp display name before embedding it in messages sent to
 * other users. The name comes from the webhook payload and is fully controlled
 * by the sender, so it must be treated as untrusted input.
 *  - Strips WhatsApp markdown formatting characters (* _ ~ ` > [ ])
 *    to prevent spoofed bold/italic text in messages to others.
 *  - Truncates to 50 characters.
 */
function sanitizeName(raw) {
  if (!raw || typeof raw !== 'string') return 'Unknown';
  return raw
    .replace(/[*_~`>\[\]]/g, '')  // strip WhatsApp markdown
    .trim()
    .slice(0, 50) || 'Unknown';
}

module.exports = { handle };

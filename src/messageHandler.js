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
const db               = require('./db');
const wa               = require('./whatsapp');
const { reverseGeocode } = require('./geocoder');

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

// /create <group name>
async function cmdCreate(waId, name, text) {
  const groupName = text.replace(/^\/?create\s+/i, '').trim();
  if (!groupName) {
    return wa.sendText(waId, 'Usage: */create* _Family Group Name_');
  }

  const user = db.getUser(waId);
  if (!user) {
    return wa.sendText(waId, '⚠️ Please share your location first to register.');
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
  const code = text.replace(/^\/?join\s+/i, '').trim().toUpperCase();
  if (!code) {
    return wa.sendText(waId, 'Usage: */join* _INVITE_CODE_');
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

  db.addMember(group.id, waId);

  const members = db.getMembers(group.id);

  // Notify the new member
  await wa.sendText(
    waId,
    `✅ Joined *${group.name}*!\n\n` +
    `Members: ${members.map(m => m.phone || m.wa_id).join(', ')}`,
  );

  // Notify existing members
  for (const m of members) {
    if (m.wa_id === waId) continue;
    wa.sendText(m.wa_id, `👋 *${name}* joined the group *${group.name}*!`).catch(() => {});
  }
}

// /leave [code]  — if no code, leave all groups
async function cmdLeave(waId, name, text) {
  const code = text.replace(/^\/?leave\s*/i, '').trim().toUpperCase();

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
    for (const m of remaining) {
      wa.sendText(m.wa_id, `ℹ️ ${name} left *${group.name}*.`).catch(() => {});
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
    `*/status* – See the current safety status of all your group members\n\n` +
    `*How it works*\n` +
    `When a rocket alert fires in your city, you'll receive a message with two buttons: ✅ Safe or 🆘 Help.\n` +
    `If you don't respond within 10 minutes, we'll send a reminder and notify your family group.`,
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O,0,I,1
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

module.exports = { handle };

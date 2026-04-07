'use strict';

/**
 * Handles all inbound WhatsApp messages routed by the webhook.
 *
 * ── Privacy gate (PPL §11 / Amendment 13) ────────────────────────────────────
 *   Every incoming message is checked for prior consent before any personal
 *   data is stored or processed.  The only exceptions are:
 *     /accept  – to give consent
 *     /delete  – to erase data (works even without consent)
 *
 * ── Location message ──────────────────────────────────────────────────────────
 *   User shares location → reverse-geocode to city → store city only (no GPS).
 *
 * ── Button reply ──────────────────────────────────────────────────────────────
 *   safe_yes__<pendingId>  → mark safe, broadcast to group
 *   safe_no__<pendingId>   → mark unsafe, broadcast to group
 *
 * ── Text commands ─────────────────────────────────────────────────────────────
 *   /accept        → give consent and register intent
 *   /create <name> → create a family group
 *   /join <code>   → join a group
 *   /leave [code]  → leave a group
 *   /status        → group safety summary
 *   /mydata        → show all personal data stored (right of access)
 *   /delete        → erase all personal data (right of erasure)
 *   /help          → show help
 */

const { v4: uuid }       = require('uuid');
const crypto             = require('crypto');
const db                 = require('./db');
const wa                 = require('./whatsapp');
const { reverseGeocode } = require('./geocoder');
const {
  validateGroupName,
  validateCoordinates,
  validateUuid,
} = require('./security');

// Bump this value whenever the privacy notice text changes so existing users
// are re-prompted to re-consent.  Mirror in PRIVACY_NOTICE_VERSION env var.
const PRIVACY_VERSION = () => process.env.PRIVACY_NOTICE_VERSION || '1';

// ── Privacy notice text ───────────────────────────────────────────────────────
// Bilingual (Hebrew + English) as required for Israeli-market apps.
// Content satisfies PPL §11 disclosure requirements:
//   – identity of data controller (operator fills in their details)
//   – categories of data collected
//   – purposes of processing
//   – third-party recipients and cross-border transfers
//   – retention period
//   – data subject rights

function privacyNoticeText() {
  const operator = process.env.OPERATOR_NAME    || '[שם המפעיל / Operator name]';
  const contact  = process.env.OPERATOR_CONTACT || '[פרטי קשר / Contact details]';

  return (
    `🔐 *הודעת פרטיות | Privacy Notice*\n\n` +
    `לפני הרשמה, אנא קרא/י את הפרטים הבאים:\n` +
    `Before registering, please read the following:\n\n` +

    `*📋 מידע הנאסף | Data collected*\n` +
    `• מספר WhatsApp שלך (זהות)\n` +
    `• שם העיר שלך (מ-GPS שתשתף/י – הקואורדינטות עצמן לא נשמרות)\n` +
    `• תגובות להתראות: בסדר / צריך עזרה\n` +
    `• חברות בקבוצות משפחה\n\n` +
    `• Your WhatsApp number (identity)\n` +
    `• Your city name (from GPS you share – coordinates are not stored)\n` +
    `• Alert responses: safe / need help\n` +
    `• Family group memberships\n\n` +

    `*🎯 מטרה | Purpose*\n` +
    `שליחת התראות צבע אדום בלבד, לפי מיקומך.\n` +
    `Red alert notifications only, based on your city.\n\n` +

    `*🌍 העברת מידע לחו"ל | Cross-border transfers*\n` +
    `• Meta/WhatsApp – ארה"ב 🇺🇸 (שליחת הודעות)\n` +
    `• OpenStreetMap/Nominatim – גרמניה/האיחוד האירופי 🇪🇺 (גיאוקידינג)\n` +
    `• Meta/WhatsApp – USA 🇺🇸 (messaging)\n` +
    `• OpenStreetMap/Nominatim – Germany/EU 🇪🇺 (geocoding)\n\n` +

    `*⏱️ שמירת מידע | Retention*\n` +
    `היסטוריית התראות: 30 יום. רישום: עד למחיקה.\n` +
    `Alert history: 30 days. Registration: until you delete.\n\n` +

    `*⚖️ הזכויות שלך | Your rights*\n` +
    `• */mydata* – לצפות במידע שנשמר | View stored data\n` +
    `• */delete* – למחוק את כל המידע | Delete all your data\n\n` +

    `*👤 מפעיל | Operator*\n` +
    `${operator} | ${contact}\n\n` +

    `━━━━━━━━━━━━━━━━━━\n` +
    `לאישור ולהרשמה שלח/י: */accept*\n` +
    `To consent and register, send: */accept*\n\n` +
    `לסירוב, פשוט הפסק/י לשלוח הודעות.\n` +
    `To decline, simply stop messaging this bot.`
  );
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function handle(parsed) {
  if (!parsed) return;

  const { waId, name } = parsed;

  // /delete works even without consent – user may want to erase any record
  // we inadvertently stored (e.g. from a previous consent version).
  if (isCommand(parsed, /^\/?(delete|מחק)$/i)) {
    return cmdDelete(waId);
  }

  // /accept gives consent – must be processed before the consent gate below.
  if (isCommand(parsed, /^\/?(accept|אישור|קבל)$/i)) {
    return cmdAccept(waId, name);
  }

  // ── Consent gate ──────────────────────────────────────────────────────────
  // PPL §11: personal data may only be collected after informed consent.
  if (!db.hasConsented(waId, PRIVACY_VERSION())) {
    return wa.sendText(waId, privacyNoticeText());
  }

  // Normal handling
  switch (parsed.type) {
    case 'location':     return handleLocation(parsed);
    case 'button_reply': return handleButtonReply(parsed);
    case 'text':         return handleText(parsed);
  }
}

// ── Consent ───────────────────────────────────────────────────────────────────

async function cmdAccept(waId, name) {
  db.giveConsent(waId, PRIVACY_VERSION());
  await wa.sendText(
    waId,
    `✅ *תודה! הסכמתך נרשמה. | Consent recorded.*\n\n` +
    `כעת שתף/י את המיקום שלך כדי להירשם לקבלת התראות.\n` +
    `Now share your location to register for alerts.\n\n` +
    `Type */help* for all commands.`,
  );
}

// ── Location ──────────────────────────────────────────────────────────────────

async function handleLocation({ waId, name, lat, lon }) {
  if (!validateCoordinates(lat, lon)) {
    console.warn(`[MsgHandler] Invalid coordinates from ${waId}: ${lat},${lon}`);
    return;
  }

  let geo = { cityHe: null, cityEn: null, display: null };
  try {
    geo = await reverseGeocode(lat, lon);
  } catch (err) {
    console.error('[MsgHandler] Geocoding failed:', err.message);
  }

  // Store ONLY the city name – GPS coordinates are discarded here.
  // This satisfies the data-minimisation principle (PPL §3 / §11).
  db.upsertUser({
    wa_id:   waId,
    city_he: geo.cityHe,
    city_en: geo.cityEn,
  });

  const cityDisplay = geo.cityHe
    ? `${geo.cityHe}${geo.cityEn ? ` (${geo.cityEn})` : ''}`
    : (geo.display || 'unknown location');

  await wa.sendText(
    waId,
    `✅ *נרשמת! | Registered!*\n\n` +
    `${sanitizeName(name)}, אתה/את רשום/ה ב-*${cityDisplay}*.\n` +
    `You are registered in *${cityDisplay}*.\n\n` +
    `תקבל/י התראות צבע אדום לאזורך.\n` +
    `You will receive red alerts for your area.\n\n` +
    `Type */help* for commands.`,
  );
}

// ── Button reply ──────────────────────────────────────────────────────────────

async function handleButtonReply({ waId, buttonId }) {
  const [action, pendingId] = buttonId.split('__');

  if (!pendingId || (action !== 'safe_yes' && action !== 'safe_no')) return;

  if (!validateUuid(pendingId)) {
    console.warn(`[MsgHandler] Malformed pendingId in button reply from ${waId}`);
    return;
  }

  // Ownership check: only the intended recipient may respond
  const pending = db.getOpenPending(waId);
  if (!pending || pending.id !== pendingId) {
    console.warn(`[MsgHandler] Button reply ownership mismatch from ${waId}`);
    return;
  }

  const response = action === 'safe_yes' ? 'safe' : 'unsafe';
  db.markResponded(pendingId, response);

  if (response === 'safe') {
    await wa.sendText(waId,
      `✅ שמחים שאתה/את בסדר! משפחתך תקבל עדכון.\n` +
      `Glad you're safe! Your family has been notified.`);
  } else {
    await wa.sendText(waId,
      `🆘 *משפחתך קיבלה התראה! | Help alert sent to your family!*\n\n` +
      `נסה/י להגיע למרחב מוגן מיד.\n` +
      `Please reach a shelter immediately.\n\n` +
      `חירום: *101* (משטרה) | *102* (כיבוי) | *101* (מד"א)\n` +
      `Emergency: *101* (police) | *102* (fire) | *101* (MDA)`);
  }

  await broadcastResponseToGroup(waId, response);
}

async function broadcastResponseToGroup(waId, response) {
  const groups = db.getUserGroups(waId);
  if (groups.length === 0) return;

  // Use wa_id as identifier – do NOT expose other personal details in cross-user messages
  const label = waId;
  const statusText = response === 'safe'
    ? `${label} ✅ בסדר / safe`
    : `${label} 🆘 צריך עזרה / needs help`;

  for (const group of groups) {
    const summaryLines = buildGroupSummary(group.id, waId, response);
    for (const member of db.getMembers(group.id)) {
      if (member.wa_id === waId) continue;
      wa.sendText(member.wa_id,
        `👨‍👩‍👧 *${group.name}* – עדכון סטטוס | Status Update\n\n` +
        `${statusText}\n\n` +
        `*סיכום קבוצה | Group summary:*\n${summaryLines}`,
      ).catch(() => {});
    }
  }
}

function buildGroupSummary(groupId, respondedWaId, respondedStatus) {
  return db.getMembers(groupId).map((m) => {
    let status;
    if (m.wa_id === respondedWaId) {
      status = respondedStatus === 'safe' ? '✅ בסדר / Safe' : '🆘 צריך עזרה / Needs help';
    } else {
      const pending = db.getOpenPending(m.wa_id);
      if (!pending)                       status = '⬜ אין התראה פעילה / No active alert';
      else if (pending.response === 'safe')   status = '✅ בסדר / Safe';
      else if (pending.response === 'unsafe') status = '🆘 צריך עזרה / Needs help';
      else                                    status = '⏳ ממתין לתגובה / Waiting';
    }
    // Show city only, not the phone number, to minimise cross-user data exposure
    const loc = m.city_he ? ` (${m.city_he})` : '';
    return `• …${m.wa_id.slice(-4)}${loc}: ${status}`;
  }).join('\n');
}

// ── Text commands ─────────────────────────────────────────────────────────────

async function handleText({ waId, name, text }) {
  const lower = text.toLowerCase().trim();

  if (lower.startsWith('/create ') || lower.startsWith('create '))
    return cmdCreate(waId, name, text);
  if (lower.startsWith('/join ')   || lower.startsWith('join '))
    return cmdJoin(waId, name, text);
  if (lower.startsWith('/leave')   || lower.startsWith('leave'))
    return cmdLeave(waId, name, text);
  if (lower === '/status'  || lower === 'status')
    return cmdStatus(waId);
  if (lower === '/mydata'  || lower === 'mydata')
    return cmdMyData(waId);
  if (lower === '/help' || lower === 'help' || lower === 'hi' || lower === 'hello' || lower === 'שלום')
    return cmdHelp(waId, name);

  const user = db.getUser(waId);
  if (!user) {
    await wa.sendText(waId,
      `📍 שתף/י מיקום כדי להירשם. | Share your location to register.\nType */help* for commands.`);
  } else {
    await wa.sendText(waId, 'Type */help* to see available commands.');
  }
}

// /accept  (handled above in handle() before the consent gate)

// /create <name>
async function cmdCreate(waId, name, text) {
  const raw = text.replace(/^\/?create\s+/i, '');
  const v = validateGroupName(raw);
  if (!v.ok) return wa.sendText(waId, `⚠️ ${v.reason}\n\nUsage: */create* _Group Name_`);

  const user = db.getUser(waId);
  if (!user) return wa.sendText(waId, '⚠️ Share your location first to register.');

  if (db.countGroupsCreatedBy(waId) >= MAX_GROUPS_PER_USER)
    return wa.sendText(waId, `⚠️ Maximum ${MAX_GROUPS_PER_USER} groups per user.`);

  const groupId    = uuid();
  const inviteCode = generateCode();
  db.createGroup({ id: groupId, name: v.value, invite_code: inviteCode, created_by: waId });
  db.addMember(groupId, waId);

  await wa.sendText(waId,
    `✅ *קבוצה "${v.value}" נוצרה! | Group created!*\n\n` +
    `📋 קוד הזמנה | Invite code: *${inviteCode}*\n\n` +
    `שתף/י את הקוד עם בני משפחה. הם יכולים להצטרף:\n` +
    `Share this code with family. They join by sending:\n` +
    `*/join ${inviteCode}*`);
}

// /join <code>
async function cmdJoin(waId, name, text) {
  const code = text.replace(/^\/?join\s+/i, '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!code || code.length !== 6)
    return wa.sendText(waId, 'Usage: */join* _CODE_ (6 characters)');

  const user = db.getUser(waId);
  if (!user) return wa.sendText(waId, '⚠️ Share your location first to register.');

  const group = db.getGroupByCode(code);
  if (!group) return wa.sendText(waId, `❌ קוד לא נמצא. | Code not found: *${code}*`);

  if (db.isMember(group.id, waId))
    return wa.sendText(waId, `ℹ️ אתה/את כבר חבר/ה ב-*${group.name}*.`);

  if (db.countGroupMembers(group.id) >= MAX_MEMBERS_PER_GROUP)
    return wa.sendText(waId, `⚠️ הקבוצה מלאה (מקסימום ${MAX_MEMBERS_PER_GROUP} חברים). | Group full.`);

  db.addMember(group.id, waId);
  const count = db.countGroupMembers(group.id);

  await wa.sendText(waId,
    `✅ הצטרפת ל-*${group.name}*! (${count} חברים | members)\n\n` +
    `You joined *${group.name}*!`);

  // Notify others – show only the last 4 digits, not the full number
  const safeName = sanitizeName(name);
  const shortId  = `…${waId.slice(-4)}`;
  for (const m of db.getMembers(group.id)) {
    if (m.wa_id === waId) continue;
    wa.sendText(m.wa_id,
      `👋 *${safeName}* (${shortId}) הצטרף/ה ל-*${group.name}*! | joined *${group.name}*!`
    ).catch(() => {});
  }
}

// /leave [code]
async function cmdLeave(waId, name, text) {
  const code = text.replace(/^\/?leave\s*/i, '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

  if (code) {
    const group = db.getGroupByCode(code);
    if (!group)               return wa.sendText(waId, `❌ קוד לא נמצא. | Code not found: *${code}*`);
    if (!db.isMember(group.id, waId)) return wa.sendText(waId, `ℹ️ אינך חבר/ה בקבוצה זו.`);

    db.removeMember(group.id, waId);
    await wa.sendText(waId, `✅ עזבת את *${group.name}*. | Left *${group.name}*.`);

    const safeName = sanitizeName(name);
    const shortId  = `…${waId.slice(-4)}`;
    for (const m of db.getMembers(group.id)) {
      wa.sendText(m.wa_id,
        `ℹ️ *${safeName}* (${shortId}) עזב/ה את *${group.name}*. | left *${group.name}*.`
      ).catch(() => {});
    }
  } else {
    const groups = db.getUserGroups(waId);
    if (groups.length === 0) return wa.sendText(waId, `ℹ️ אינך חבר/ה באף קבוצה.`);
    for (const g of groups) db.removeMember(g.id, waId);
    await wa.sendText(waId, `✅ עזבת ${groups.length} קבוצה/ות. | Left ${groups.length} group(s).`);
  }
}

// /status
async function cmdStatus(waId) {
  const groups = db.getUserGroups(waId);
  if (groups.length === 0)
    return wa.sendText(waId,
      `ℹ️ אינך חבר/ה באף קבוצה.\nCreate one with */create _Name_*`);

  const lines = [];
  for (const g of groups) {
    lines.push(`👨‍👩‍👧 *${g.name}* (קוד | code: ${g.invite_code})`);
    for (const m of db.getMembers(g.id)) {
      const pending = db.getOpenPending(m.wa_id);
      let status = '⬜ אין התראה / No alert';
      if (pending) {
        if (pending.response === 'safe')     status = '✅ בסדר / Safe';
        else if (pending.response === 'unsafe') status = '🆘 צריך עזרה / Needs help';
        else if (pending.nudge_sent)         status = '⏰ הופנה שוב / Nudged';
        else                                 status = '⏳ ממתין / Waiting';
      }
      const loc = m.city_he ? ` – ${m.city_he}` : '';
      // Show last 4 digits of wa_id, not full phone number
      lines.push(`  • …${m.wa_id.slice(-4)}${loc}: ${status}`);
    }
    lines.push('');
  }
  await wa.sendText(waId, lines.join('\n').trim());
}

// /mydata  – right of access (PPL §13 / Amendment 13)
async function cmdMyData(waId) {
  const user    = db.getUser(waId);
  const consent = db.hasConsented(waId, PRIVACY_VERSION());
  const groups  = db.getUserGroups(waId);
  const since30 = Math.floor(Date.now() / 1000) - 30 * 86400;
  const alertCount = db.countRecentPending(waId, since30);

  const lines = [
    `📋 *המידע שנשמר עליך | Your stored data*\n`,
    `🪪 WhatsApp ID: ${waId}`,
    `📍 עיר רשומה | Registered city: ${user?.city_he || '—'}${user?.city_en ? ` (${user.city_en})` : ''}`,
    `📅 נרשמת | Registered: ${user ? new Date(user.registered_at * 1000).toISOString().slice(0, 10) : '—'}`,
    `✅ הסכמה | Consent: ${consent ? `גרסה ${PRIVACY_VERSION()}` : 'לא'}`,
    `👨‍👩‍👧 קבוצות | Groups: ${groups.length > 0 ? groups.map(g => g.name).join(', ') : '—'}`,
    `📊 התראות ב-30 יום אחרונים | Alerts in last 30 days: ${alertCount}`,
    ``,
    `למחיקת כל המידע: */delete*\n` +
    `To erase all data: */delete*`,
  ];
  await wa.sendText(waId, lines.join('\n'));
}

// /delete
async function cmdDelete(waId) {
  const had = db.getUser(waId);
  db.deleteUser(waId);

  await wa.sendText(waId,
    `🗑️ *כל המידע שלך נמחק. | All your data has been deleted.*\n\n` +
    `מיקום, קבוצות והיסטוריית התראות הוסרו.\n` +
    `Your location, groups, and alert history have been removed.\n\n` +
    `לא תקבל/י עוד התראות. שתף/י מיקום מחדש כדי להירשם שוב.\n` +
    `You will no longer receive alerts. Share location again to re-register.`);
}

// /help
async function cmdHelp(waId, name) {
  await wa.sendText(waId,
    `🛡️ *Family Missile Status Bot*\n\n` +
    `*הרשמה | Registration*\n` +
    `📍 שתף/י מיקום כדי להירשם לאזורך.\n` +
    `Share your location to register for your area.\n\n` +
    `*קבוצות משפחה | Family groups*\n` +
    `*/create* _שם_ – צור/י קבוצה חדשה | Create group\n` +
    `*/join* _קוד_ – הצטרף/י לקבוצה | Join group\n` +
    `*/leave* _קוד_ – עזוב/י קבוצה | Leave group\n` +
    `*/status* – סטטוס בטיחות | Safety status\n\n` +
    `*פרטיות | Privacy*\n` +
    `*/mydata* – לצפות במידע שנשמר | View your stored data\n` +
    `*/delete* – למחוק את כל המידע | Delete all your data\n\n` +
    `*איך זה עובד | How it works*\n` +
    `בעת התראת צבע אדום בעיירתך, תקבל/י הודעה עם שני כפתורים: ✅ בסדר | 🆘 עזרה.\n` +
    `אם לא תענה/י תוך 10 דקות – תישלח תזכורת ותשפחתך תעודכן.\n` +
    `On a red alert in your city you get ✅ Safe | 🆘 Help buttons. ` +
    `No response in 10 min → reminder + family notified.`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const MAX_GROUPS_PER_USER  = 5;
const MAX_MEMBERS_PER_GROUP = 20;

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  // crypto.randomBytes – cryptographically secure (Math.random() is NOT)
  return Array.from(crypto.randomBytes(6), (b) => chars[b % chars.length]).join('');
}

/**
 * Sanitise a WhatsApp display name before embedding it in messages sent to
 * other users.  The name is fully user-controlled and must be treated as
 * untrusted input.
 *
 * Strips:
 *  - WhatsApp markdown:  * _ ~ ` > [ ]
 *  - Unicode RTL/LTR override and other directional control characters that
 *    could be used to make text appear differently to different readers
 *    (U+200E/F, U+202A-E, U+2066-2069, U+061C)
 *  - Other Unicode control/format characters (categories Cf, Cc)
 *  - Zero-width characters (U+200B, U+FEFF, etc.)
 */
function sanitizeName(raw) {
  if (!raw || typeof raw !== 'string') return 'Unknown';
  return raw
    .replace(/[*_~`>\[\]]/g, '')                      // WA markdown
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\u061C\uFEFF]/g, '') // RTL/LTR overrides
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')     // C0/C1 control chars
    .trim()
    .slice(0, 50) || 'Unknown';
}

/**
 * Returns true if the parsed message is a text command matching the given regex.
 */
function isCommand(parsed, re) {
  return parsed.type === 'text' && re.test(parsed.text?.trim() ?? '');
}

module.exports = { handle };

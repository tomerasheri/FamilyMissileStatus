'use strict';

/**
 * Nudge Scheduler
 *
 * Every 60 s we scan pending_responses where:
 *   - responded_at IS NULL
 *   - nudge_sent = 0
 *   - sent_at <= (now - 10 min)
 *
 * For each expired row we:
 *   1. Send the user a follow-up ("We still haven't heard from you…")
 *   2. Mark nudge_sent = 1
 *   3. Notify their group members about the non-response
 *
 * On startup we run an immediate scan so that missed nudges (e.g. after a
 * server restart) are caught right away.
 */

const db = require('./db');
const wa = require('./whatsapp');

const NUDGE_AFTER_S = 10 * 60;   // 10 minutes
const SCAN_INTERVAL = 60_000;     // check every 60 s

let _timer = null;

async function scan() {
  const cutoff  = Math.floor(Date.now() / 1000) - NUDGE_AFTER_S;
  const expired = db.getExpiredPending(cutoff);

  for (const row of expired) {
    db.markNudged(row.id);
    await sendNudge(row);
    await notifyGroupOfSilence(row);
  }
}

async function sendNudge(row) {
  const text =
    `⏰ *Check-in reminder*\n\n` +
    `We sent you a safety alert for *${row.city}* 10 minutes ago and haven't heard back.\n\n` +
    `Please let us know you're okay:`;

  try {
    await wa.sendButtons(
      row.wa_id,
      text,
      [
        { id: `safe_yes__${row.id}`, title: '✅ בסדר / Safe' },
        { id: `safe_no__${row.id}`,  title: '🆘 צריך עזרה / Help' },
      ],
    );
  } catch (err) {
    console.error(`[Nudge] Failed to nudge ${row.wa_id}:`, err.message);
  }
}

async function notifyGroupOfSilence(row) {
  const user   = db.getUser(row.wa_id);
  const groups = db.getUserGroups(row.wa_id);
  if (groups.length === 0) return;

  // Show only last-4 digits – never broadcast a full phone number cross-user
  const shortId = `…${row.wa_id.slice(-4)}`;

  for (const group of groups) {
    const members = db.getMembers(group.id);

    for (const member of members) {
      if (member.wa_id === row.wa_id) continue;

      const text =
        `⚠️ *${group.name}* – אין תגובה | No response\n\n` +
        `${shortId} קיבל/ה התראה על *${row.city}* לפני 10 דקות ולא ענה/תה.\n` +
        `${shortId} was alerted about *${row.city}* 10 min ago and has not responded.\n\n` +
        `אנא בדוק/י אם ניתן. | Please check on them if possible.`;

      wa.sendText(member.wa_id, text).catch(() => {});
    }
  }
}

function start() {
  if (_timer) return;
  console.log('[NudgeScheduler] Starting');
  scan(); // run immediately on startup
  _timer = setInterval(scan, SCAN_INTERVAL);
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { start, stop };

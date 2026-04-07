'use strict';

/**
 * Polls https://www.oref.org.il/WarningMessages/alert/alerts.json every 5 s.
 *
 * When a NEW alert is detected (by alert id), it:
 *   1. Finds every registered user whose city matches an alerted city.
 *   2. Sends each of them a "are you safe?" message with two quick-reply buttons.
 *   3. Notifies their family group members that the alert was sent.
 *   4. Stores a pending_response row so the nudge scheduler can follow up.
 */

const axios        = require('axios');
const { v4: uuid } = require('uuid');

const db         = require('./db');
const wa         = require('./whatsapp');
const { cityMatches } = require('./geocoder');

const ALERT_URL     = 'https://www.oref.org.il/WarningMessages/alert/alerts.json';
const POLL_INTERVAL = 5_000; // 5 seconds

// Headers required by oref to avoid 403
const OREF_HEADERS = {
  'Referer':          'https://www.oref.org.il/',
  'X-Requested-With': 'XMLHttpRequest',
  'User-Agent':       'Mozilla/5.0 (compatible; FamilyMissileStatusBot/1.0)',
};

let _timer = null;

// ── Fetch & parse ─────────────────────────────────────────────────────────────

async function fetchAlert() {
  try {
    const { data, status } = await axios.get(ALERT_URL, {
      headers:           OREF_HEADERS,
      timeout:           4_000,
      // oref returns an empty body or BOM-prefixed JSON when there's no alert
      validateStatus:    () => true,
      responseType:      'text',
    });

    if (status !== 200 || !data || data.trim().length < 5) return null;

    // Strip UTF-8 BOM if present
    const cleaned = data.replace(/^\uFEFF/, '').trim();
    if (!cleaned.startsWith('{')) return null;

    const parsed = JSON.parse(cleaned);
    if (!parsed.id || !Array.isArray(parsed.data) || parsed.data.length === 0) return null;

    return parsed; // { id, cat, title, data: [cityName, ...], desc }
  } catch {
    return null; // network errors are expected; just skip this tick
  }
}

// ── Process a newly-seen alert ────────────────────────────────────────────────

async function processAlert(alert) {
  const { id: alertId, title, data: cities, desc } = alert;

  console.log(`[Alert] New alert ${alertId}: ${cities.join(', ')}`);
  db.markAlertSeen(alertId, JSON.stringify(cities));

  const allUsers = db.getAllUsers();
  if (allUsers.length === 0) return;

  for (const city of cities) {
    const affected = allUsers.filter(
      (u) => u.city_he && cityMatches(u.city_he, city),
    );

    for (const user of affected) {
      await notifyUser(user, alertId, city, title, desc);
    }
  }
}

async function notifyUser(user, alertId, city, title, desc) {
  const pendingId = uuid();
  const now       = Math.floor(Date.now() / 1000);

  db.createPending({
    id:       pendingId,
    wa_id:    user.wa_id,
    alert_id: alertId,
    city,
    sent_at:  now,
  });

  const bodyText =
    `🚨 *${title}*\n` +
    `📍 ${city}\n` +
    `${desc}\n\n` +
    `האם אתה/את בסדר? Are you safe?`;

  try {
    await wa.sendButtons(
      user.wa_id,
      bodyText,
      [
        { id: `safe_yes__${pendingId}`, title: '✅ בסדר / Safe' },
        { id: `safe_no__${pendingId}`,  title: '🆘 צריך עזרה / Help' },
      ],
      '⚠️ Red Alert – התראה אדומה',
    );
  } catch {
    // message failed – nudge scheduler will still fire at T+10 min
  }

  // Notify other group members that this user was alerted
  await notifyGroupMembers(user, city, title, alertId);
}

async function notifyGroupMembers(alertedUser, city, alertTitle, alertId) {
  const groups = db.getUserGroups(alertedUser.wa_id);
  if (groups.length === 0) return;

  const name = alertedUser.phone || alertedUser.wa_id;

  for (const group of groups) {
    const members = db.getMembers(group.id);

    for (const member of members) {
      if (member.wa_id === alertedUser.wa_id) continue;

      const text =
        `👨‍👩‍👧 *${group.name}* – Group Alert\n\n` +
        `⚠️ ${alertTitle} in *${city}*\n` +
        `Waiting for ${name} to confirm they're safe.\n\n` +
        `You'll get an update once they respond.`;

      wa.sendText(member.wa_id, text).catch(() => {});
    }
  }
}

// ── Poller ────────────────────────────────────────────────────────────────────

async function tick() {
  const alert = await fetchAlert();
  if (!alert) return;
  if (db.isAlertSeen(alert.id)) return;
  await processAlert(alert);
}

function start() {
  if (_timer) return;
  console.log('[AlertPoller] Starting – polling every 5 s');
  tick(); // immediate first check
  _timer = setInterval(tick, POLL_INTERVAL);
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { start, stop, processAlert }; // processAlert exported for testing

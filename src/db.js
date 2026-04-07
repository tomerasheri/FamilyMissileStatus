'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');

// Create data directory with owner-only permissions (700).
// This prevents other OS users / processes from reading the database file,
// which contains sensitive personal data (phone numbers, city, alert history).
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
} else {
  // Enforce permissions even if the directory already existed
  fs.chmodSync(DATA_DIR, 0o700);
}

const DB_PATH = path.join(DATA_DIR, 'bot.db');
const db = new Database(DB_PATH);

// Lock the database file itself to owner-read/write only after opening it
try { fs.chmodSync(DB_PATH, 0o600); } catch { /* file may not exist yet on first run */ }

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    wa_id         TEXT PRIMARY KEY,
    -- GPS coordinates are intentionally NOT stored.
    -- They are used only during registration to reverse-geocode a city name
    -- and are discarded immediately afterwards (data minimisation, PPL §3 / §11).
    city_he       TEXT,
    city_en       TEXT,
    registered_at INTEGER DEFAULT (strftime('%s','now'))
  );

  -- Explicit consent record (PPL §11 – must obtain informed consent before
  -- collecting personal data; Amendment 13 strengthens this obligation).
  CREATE TABLE IF NOT EXISTS consents (
    wa_id        TEXT PRIMARY KEY,
    consented_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    -- version matches PRIVACY_NOTICE_VERSION env var.
    -- When the notice changes, bump the version so users are re-prompted.
    version      TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS family_groups (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    invite_code TEXT UNIQUE NOT NULL,
    created_by  TEXT NOT NULL,
    created_at  INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS group_members (
    group_id  TEXT NOT NULL,
    wa_id     TEXT NOT NULL,
    joined_at INTEGER DEFAULT (strftime('%s','now')),
    PRIMARY KEY (group_id, wa_id)
  );

  -- One row per user per alert. Alert history is auto-expired after 30 days
  -- (see purgeOldPendingResponses). Retention period disclosed in privacy notice.
  CREATE TABLE IF NOT EXISTS pending_responses (
    id           TEXT PRIMARY KEY,
    wa_id        TEXT NOT NULL,
    alert_id     TEXT NOT NULL,
    city         TEXT NOT NULL,
    sent_at      INTEGER NOT NULL,
    responded_at INTEGER,
    response     TEXT,        -- 'safe' | 'unsafe'
    nudge_sent   INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS seen_alerts (
    alert_id TEXT PRIMARY KEY,
    cities   TEXT NOT NULL,
    seen_at  INTEGER DEFAULT (strftime('%s','now'))
  );
`);

// Lock WAL/SHM sidecar files too (they appear after the first write)
function lockDbSidecars() {
  for (const ext of ['-wal', '-shm']) {
    const p = DB_PATH + ext;
    try { if (fs.existsSync(p)) fs.chmodSync(p, 0o600); } catch { /* ignore */ }
  }
}
lockDbSidecars();

// ── Users ─────────────────────────────────────────────────────────────────────

const _upsertUser = db.prepare(`
  INSERT INTO users (wa_id, city_he, city_en)
  VALUES (@wa_id, @city_he, @city_en)
  ON CONFLICT(wa_id) DO UPDATE SET
    city_he = excluded.city_he,
    city_en = excluded.city_en
`);

const _getUser        = db.prepare('SELECT * FROM users WHERE wa_id = ?');
const _getUsersByCity = db.prepare('SELECT * FROM users WHERE city_he = ?');
const _getAllUsers    = db.prepare('SELECT * FROM users');

// ── Consents ──────────────────────────────────────────────────────────────────

const _giveConsent = db.prepare(`
  INSERT INTO consents (wa_id, version)
  VALUES (@wa_id, @version)
  ON CONFLICT(wa_id) DO UPDATE SET
    consented_at = strftime('%s','now'),
    version      = excluded.version
`);

// Returns the consent row if the user has consented to the *current* version,
// null otherwise (triggers re-prompt when the privacy notice is updated).
const _hasConsented = db.prepare(`
  SELECT 1 FROM consents WHERE wa_id = ? AND version = ?
`);

// ── Groups ────────────────────────────────────────────────────────────────────

const _createGroup    = db.prepare(`
  INSERT INTO family_groups (id, name, invite_code, created_by)
  VALUES (@id, @name, @invite_code, @created_by)
`);
const _getGroupByCode = db.prepare('SELECT * FROM family_groups WHERE invite_code = ?');
const _getGroupById   = db.prepare('SELECT * FROM family_groups WHERE id = ?');

const _addMember    = db.prepare(`
  INSERT OR IGNORE INTO group_members (group_id, wa_id)
  VALUES (@group_id, @wa_id)
`);
const _removeMember = db.prepare(`
  DELETE FROM group_members WHERE group_id = ? AND wa_id = ?
`);
const _getMembers   = db.prepare(`
  SELECT u.* FROM users u
  JOIN group_members gm ON gm.wa_id = u.wa_id
  WHERE gm.group_id = ?
`);
const _getUserGroups = db.prepare(`
  SELECT fg.* FROM family_groups fg
  JOIN group_members gm ON gm.group_id = fg.id
  WHERE gm.wa_id = ?
`);
const _isMember = db.prepare(`
  SELECT 1 FROM group_members WHERE group_id = ? AND wa_id = ?
`);

// ── Pending responses ─────────────────────────────────────────────────────────

const _createPending  = db.prepare(`
  INSERT OR REPLACE INTO pending_responses (id, wa_id, alert_id, city, sent_at)
  VALUES (@id, @wa_id, @alert_id, @city, @sent_at)
`);
const _getOpenPending = db.prepare(`
  SELECT * FROM pending_responses
  WHERE wa_id = ? AND responded_at IS NULL
  ORDER BY sent_at DESC LIMIT 1
`);
const _markResponded = db.prepare(`
  UPDATE pending_responses
  SET responded_at = strftime('%s','now'), response = ?
  WHERE id = ?
`);
const _markNudged = db.prepare(`
  UPDATE pending_responses SET nudge_sent = 1 WHERE id = ?
`);
const _getExpiredPending = db.prepare(`
  SELECT * FROM pending_responses
  WHERE responded_at IS NULL
    AND nudge_sent = 0
    AND sent_at <= ?
`);
const _getPendingForAlert = db.prepare(`
  SELECT pr.*, u.city_he, u.city_en FROM pending_responses pr
  JOIN users u ON u.wa_id = pr.wa_id
  WHERE pr.alert_id = ?
`);
// Retention: delete alert history older than the given epoch (30-day default).
const _purgeOldPending = db.prepare(`
  DELETE FROM pending_responses WHERE sent_at < ?
`);
// For /mydata: count of responses in the last 30 days (no raw content exposed)
const _countRecentPending = db.prepare(`
  SELECT COUNT(*) AS n FROM pending_responses
  WHERE wa_id = ? AND sent_at >= ?
`);

// ── Seen alerts ───────────────────────────────────────────────────────────────

const _markSeen = db.prepare(`
  INSERT OR IGNORE INTO seen_alerts (alert_id, cities) VALUES (?, ?)
`);
const _isSeen = db.prepare('SELECT 1 FROM seen_alerts WHERE alert_id = ?');
// Purge old seen_alerts to prevent unbounded growth
const _purgeOldSeenAlerts = db.prepare(`
  DELETE FROM seen_alerts WHERE seen_at < ?
`);

// ── Limits ────────────────────────────────────────────────────────────────────

const _countGroupsCreatedBy = db.prepare(`
  SELECT COUNT(*) AS n FROM family_groups WHERE created_by = ?
`);
const _countGroupMembers = db.prepare(`
  SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?
`);

// ── Data deletion – right to erasure (PPL §14 / Amendment 13) ────────────────

const _deleteUser = db.transaction((waId) => {
  db.prepare('DELETE FROM consents          WHERE wa_id = ?').run(waId);
  db.prepare('DELETE FROM group_members     WHERE wa_id = ?').run(waId);
  db.prepare('DELETE FROM pending_responses WHERE wa_id = ?').run(waId);
  db.prepare('DELETE FROM users             WHERE wa_id = ?').run(waId);
  // Remove groups this user created that are now empty
  db.prepare(`
    DELETE FROM family_groups
    WHERE created_by = ?
      AND id NOT IN (SELECT group_id FROM group_members)
  `).run(waId);
});

// ── Public API ────────────────────────────────────────────────────────────────

module.exports = {
  // Users
  upsertUser:   (row) => _upsertUser.run(row),
  getUser:      (waId) => _getUser.get(waId),
  getUsersByCity: (cityHe) => _getUsersByCity.all(cityHe),
  getAllUsers:   () => _getAllUsers.all(),

  // Consents
  giveConsent:  (waId, version) => _giveConsent.run({ wa_id: waId, version }),
  hasConsented: (waId, version) => !!_hasConsented.get(waId, version),

  // Groups
  createGroup:  (row) => _createGroup.run(row),
  getGroupByCode: (code) => _getGroupByCode.get(code),
  getGroupById: (id) => _getGroupById.get(id),
  addMember:    (groupId, waId) => _addMember.run({ group_id: groupId, wa_id: waId }),
  removeMember: (groupId, waId) => _removeMember.run(groupId, waId),
  getMembers:   (groupId) => _getMembers.all(groupId),
  getUserGroups: (waId) => _getUserGroups.all(waId),
  isMember:     (groupId, waId) => !!_isMember.get(groupId, waId),

  // Pending responses
  createPending:    (row) => _createPending.run(row),
  getOpenPending:   (waId) => _getOpenPending.get(waId),
  markResponded:    (id, response) => _markResponded.run(response, id),
  markNudged:       (id) => _markNudged.run(id),
  getExpiredPending: (cutoff) => _getExpiredPending.all(cutoff),
  getPendingForAlert: (alertId) => _getPendingForAlert.all(alertId),
  countRecentPending: (waId, since) => _countRecentPending.get(waId, since).n,

  // Alerts
  markAlertSeen: (alertId, cities) => _markSeen.run(alertId, cities),
  isAlertSeen:   (alertId) => !!_isSeen.get(alertId),

  // Limits
  countGroupsCreatedBy: (waId) => _countGroupsCreatedBy.get(waId).n,
  countGroupMembers:    (groupId) => _countGroupMembers.get(groupId).n,

  // Deletion
  deleteUser: (waId) => _deleteUser(waId),

  // Retention – call periodically to enforce data retention policy
  purgeExpiredData(retentionDays = 30) {
    const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86400;
    const r1 = _purgeOldPending.run(cutoff);
    const r2 = _purgeOldSeenAlerts.run(cutoff);
    if (r1.changes || r2.changes) {
      console.log(`[DB] Purged ${r1.changes} old alert records, ${r2.changes} old seen-alerts`);
    }
  },
};

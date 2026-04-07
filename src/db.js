'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'bot.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    wa_id       TEXT PRIMARY KEY,
    phone       TEXT,
    city_he     TEXT,
    city_en     TEXT,
    lat         REAL,
    lon         REAL,
    registered_at INTEGER DEFAULT (strftime('%s','now'))
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

  -- One row per user per alert. Tracks whether they replied.
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

// ── Users ─────────────────────────────────────────────────────────────────────

const _upsertUser = db.prepare(`
  INSERT INTO users (wa_id, phone, city_he, city_en, lat, lon)
  VALUES (@wa_id, @phone, @city_he, @city_en, @lat, @lon)
  ON CONFLICT(wa_id) DO UPDATE SET
    city_he = excluded.city_he,
    city_en = excluded.city_en,
    lat     = excluded.lat,
    lon     = excluded.lon,
    phone   = excluded.phone
`);

const _getUser          = db.prepare('SELECT * FROM users WHERE wa_id = ?');
const _getUsersByCity   = db.prepare('SELECT * FROM users WHERE city_he = ?');
const _getAllUsers      = db.prepare('SELECT * FROM users');

// ── Groups ────────────────────────────────────────────────────────────────────

const _createGroup    = db.prepare(`
  INSERT INTO family_groups (id, name, invite_code, created_by)
  VALUES (@id, @name, @invite_code, @created_by)
`);
const _getGroupByCode = db.prepare('SELECT * FROM family_groups WHERE invite_code = ?');
const _getGroupById   = db.prepare('SELECT * FROM family_groups WHERE id = ?');

const _addMember      = db.prepare(`
  INSERT OR IGNORE INTO group_members (group_id, wa_id)
  VALUES (@group_id, @wa_id)
`);
const _removeMember   = db.prepare(`
  DELETE FROM group_members WHERE group_id = ? AND wa_id = ?
`);
const _getMembers     = db.prepare(`
  SELECT u.* FROM users u
  JOIN group_members gm ON gm.wa_id = u.wa_id
  WHERE gm.group_id = ?
`);
const _getUserGroups  = db.prepare(`
  SELECT fg.* FROM family_groups fg
  JOIN group_members gm ON gm.group_id = fg.id
  WHERE gm.wa_id = ?
`);
const _isMember       = db.prepare(`
  SELECT 1 FROM group_members WHERE group_id = ? AND wa_id = ?
`);
const _getUserGroupsWithMembers = db.prepare(`
  SELECT DISTINCT fg.id, fg.name FROM family_groups fg
  JOIN group_members gm ON gm.group_id = fg.id
  WHERE gm.wa_id = ?
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
const _markResponded  = db.prepare(`
  UPDATE pending_responses
  SET responded_at = strftime('%s','now'), response = ?
  WHERE id = ?
`);
const _markNudged     = db.prepare(`
  UPDATE pending_responses SET nudge_sent = 1 WHERE id = ?
`);
// Rows where 10 min have elapsed with no response and no nudge yet
const _getExpiredPending = db.prepare(`
  SELECT * FROM pending_responses
  WHERE responded_at IS NULL
    AND nudge_sent = 0
    AND sent_at <= ?
`);
// All pending for an alert (to build group status summary)
const _getPendingForAlert = db.prepare(`
  SELECT pr.*, u.city_he, u.city_en FROM pending_responses pr
  JOIN users u ON u.wa_id = pr.wa_id
  WHERE pr.alert_id = ?
`);

// ── Seen alerts ───────────────────────────────────────────────────────────────

const _markSeen  = db.prepare(`
  INSERT OR IGNORE INTO seen_alerts (alert_id, cities) VALUES (?, ?)
`);
const _isSeen    = db.prepare('SELECT 1 FROM seen_alerts WHERE alert_id = ?');

// ── Public API ────────────────────────────────────────────────────────────────

module.exports = {
  upsertUser:   (row) => _upsertUser.run(row),
  getUser:      (waId) => _getUser.get(waId),
  getUsersByCity: (cityHe) => _getUsersByCity.all(cityHe),
  getAllUsers:   () => _getAllUsers.all(),

  createGroup:  (row) => _createGroup.run(row),
  getGroupByCode: (code) => _getGroupByCode.get(code),
  getGroupById: (id) => _getGroupById.get(id),
  addMember:    (groupId, waId) => _addMember.run({ group_id: groupId, wa_id: waId }),
  removeMember: (groupId, waId) => _removeMember.run(groupId, waId),
  getMembers:   (groupId) => _getMembers.all(groupId),
  getUserGroups: (waId) => _getUserGroups.all(waId),
  isMember:     (groupId, waId) => !!_isMember.get(groupId, waId),
  getUserGroupsWithMembers: (waId) => _getUserGroupsWithMembers.all(waId),

  createPending:  (row) => _createPending.run(row),
  getOpenPending: (waId) => _getOpenPending.get(waId),
  markResponded:  (id, response) => _markResponded.run(response, id),
  markNudged:     (id) => _markNudged.run(id),
  getExpiredPending: (cutoffEpoch) => _getExpiredPending.all(cutoffEpoch),
  getPendingForAlert: (alertId) => _getPendingForAlert.all(alertId),

  markAlertSeen: (alertId, cities) => _markSeen.run(alertId, cities),
  isAlertSeen:   (alertId) => !!_isSeen.get(alertId),
};

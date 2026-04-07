'use strict';

/**
 * Security middleware and helpers.
 *
 * ── Webhook signature verification ───────────────────────────────────────────
 * Meta signs every POST to your webhook with HMAC-SHA256 using your app secret.
 * The signature is in the X-Hub-Signature-256 header as "sha256=<hex>".
 * Without this check, anyone who discovers your webhook URL can forge messages,
 * register fake users, hijack family groups, or mark real users as unsafe.
 *
 * Requires WHATSAPP_APP_SECRET in the environment.
 * The raw request body must be available as req.rawBody (set by express.json verify).
 *
 * ── Rate limiting ─────────────────────────────────────────────────────────────
 * Simple in-memory sliding-window limiter per WhatsApp sender ID.
 * Prevents a compromised or abusive account from flooding the bot.
 */

const crypto = require('crypto');

// ── Webhook signature ─────────────────────────────────────────────────────────

/**
 * Express middleware.
 * Returns 401 if the signature is missing or wrong, 501 if app secret is not set.
 */
function verifyWebhookSignature(req, res, next) {
  const appSecret = process.env.WHATSAPP_APP_SECRET;

  if (!appSecret) {
    // Warn loudly but let the request through in dev so the app can still start.
    // In production you should set APP_SECRET – without it any attacker can forge messages.
    if (process.env.NODE_ENV === 'production') {
      console.error('[Security] WHATSAPP_APP_SECRET not set – rejecting request');
      return res.sendStatus(501);
    }
    console.warn('[Security] WHATSAPP_APP_SECRET not set – signature check skipped (dev mode)');
    return next();
  }

  const sigHeader = req.get('x-hub-signature-256');
  if (!sigHeader || !sigHeader.startsWith('sha256=')) {
    console.warn('[Security] Missing X-Hub-Signature-256 – rejecting');
    return res.sendStatus(401);
  }

  const rawBody = req.rawBody;
  if (!rawBody) {
    console.error('[Security] rawBody not available – check express.json verify config');
    return res.sendStatus(500);
  }

  const expected = crypto
    .createHmac('sha256', appSecret)
    .update(rawBody)
    .digest('hex');

  const received = sigHeader.slice('sha256='.length);

  // Constant-time comparison to prevent timing attacks
  let valid = false;
  try {
    valid = crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(received.padEnd(expected.length, '0').slice(0, expected.length), 'hex'),
    );
    // Also check lengths match (timingSafeEqual requires same-length buffers)
    valid = valid && expected.length === received.length;
  } catch {
    valid = false;
  }

  if (!valid) {
    console.warn('[Security] Signature mismatch – rejecting request');
    return res.sendStatus(401);
  }

  next();
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

const RATE_WINDOW_MS  = 60_000; // 1 minute window
const RATE_MAX        = 20;     // max messages per window per sender

// Map<waId, { count, windowStart }>
const _rateMap = new Map();

// Prune stale entries every 5 minutes to avoid unbounded memory growth
setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [key, val] of _rateMap) {
    if (val.windowStart < cutoff) _rateMap.delete(key);
  }
}, 5 * 60_000).unref(); // .unref() so this timer doesn't keep the process alive

/**
 * Returns true if the sender is within the rate limit, false if exceeded.
 */
function checkRateLimit(waId) {
  const now  = Date.now();
  const entry = _rateMap.get(waId);

  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    _rateMap.set(waId, { count: 1, windowStart: now });
    return true;
  }

  if (entry.count >= RATE_MAX) {
    return false;
  }

  entry.count += 1;
  return true;
}

// ── Input validation ──────────────────────────────────────────────────────────

const GROUP_NAME_MAX    = 50;
const GROUP_NAME_RE     = /^[\p{L}\p{N}\p{Z}\-'".!?]+$/u; // letters, numbers, spaces, basic punctuation

/**
 * Validate and sanitise a user-supplied group name.
 * Returns { ok: true, value } or { ok: false, reason }.
 */
function validateGroupName(raw) {
  if (!raw || typeof raw !== 'string') {
    return { ok: false, reason: 'Group name is required.' };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'Group name cannot be empty.' };
  }
  if (trimmed.length > GROUP_NAME_MAX) {
    return { ok: false, reason: `Group name must be ${GROUP_NAME_MAX} characters or fewer.` };
  }
  if (!GROUP_NAME_RE.test(trimmed)) {
    return { ok: false, reason: 'Group name contains invalid characters.' };
  }
  return { ok: true, value: trimmed };
}

/**
 * Validate a WhatsApp sender ID (wa_id / phone number).
 * Must be digits only, 7–15 characters (E.164 without the +).
 */
function validateWaId(waId) {
  return typeof waId === 'string' && /^\d{7,15}$/.test(waId);
}

/**
 * Validate GPS coordinates.
 */
function validateCoordinates(lat, lon) {
  return (
    typeof lat === 'number' && isFinite(lat) && lat >= -90  && lat <= 90 &&
    typeof lon === 'number' && isFinite(lon) && lon >= -180 && lon <= 180
  );
}

/**
 * Validate that a UUID v4 string looks like one (basic sanity check).
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validateUuid(str) {
  return typeof str === 'string' && UUID_RE.test(str);
}

module.exports = {
  verifyWebhookSignature,
  checkRateLimit,
  validateGroupName,
  validateWaId,
  validateCoordinates,
  validateUuid,
};

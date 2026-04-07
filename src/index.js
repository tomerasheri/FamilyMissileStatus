'use strict';

require('dotenv').config();

const express        = require('express');
const alertPoller    = require('./alertPoller');
const nudgeScheduler = require('./nudgeScheduler');
const wa             = require('./whatsapp');
const msgHandler     = require('./messageHandler');
const security       = require('./security');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────

// Capture the raw body buffer so we can verify Meta's HMAC-SHA256 signature.
// Must come before any body-parsing middleware.
app.use(
  express.json({
    verify: (req, _res, buf) => { req.rawBody = buf; },
  }),
);

// ── Webhook verification (GET) ────────────────────────────────────────────────
// Meta calls this with hub.challenge when you first configure the webhook.

app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log('[Webhook] Verified successfully');
    return res.status(200).send(challenge);
  }

  console.warn('[Webhook] Verification failed – token mismatch');
  res.sendStatus(403);
});

// ── Incoming messages (POST) ──────────────────────────────────────────────────

app.post(
  '/webhook',
  security.verifyWebhookSignature,   // ← reject forged requests first
  async (req, res) => {
    // Acknowledge immediately – Meta requires a 200 within 5 s.
    res.sendStatus(200);

    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    const parsed = wa.parseWebhookEntry(body);
    if (!parsed) return;

    // Validate sender ID format before touching the DB or sending replies
    if (!security.validateWaId(parsed.waId)) {
      console.warn(`[Webhook] Suspicious wa_id rejected: ${parsed.waId}`);
      return;
    }

    // Rate limit: drop if this sender is sending too fast
    if (!security.checkRateLimit(parsed.waId)) {
      console.warn(`[Webhook] Rate limit hit for ${parsed.waId}`);
      return;
    }

    // Mark as read (fire-and-forget)
    if (parsed.msgId) wa.markRead(parsed.msgId);

    try {
      await msgHandler.handle(parsed);
    } catch (err) {
      console.error('[Webhook] Handler error:', err);
    }
  },
);

// ── Health check ──────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// ── Start ─────────────────────────────────────────────────────────────────────

function checkEnv() {
  const required = [
    'WHATSAPP_PHONE_NUMBER_ID',
    'WHATSAPP_TOKEN',
    'WHATSAPP_VERIFY_TOKEN',
    'WHATSAPP_APP_SECRET',
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`[Startup] Missing required env vars: ${missing.join(', ')}`);
    console.error('         Copy .env.example to .env and fill in the values.');
    process.exit(1);
  }
}

app.listen(PORT, () => {
  checkEnv();
  console.log(`[Server] Listening on port ${PORT}`);
  console.log(`[Server] Webhook URL: POST http://YOUR_DOMAIN/webhook`);

  alertPoller.start();
  nudgeScheduler.start();
});

// Graceful shutdown
process.on('SIGTERM', () => { alertPoller.stop(); nudgeScheduler.stop(); process.exit(0); });
process.on('SIGINT',  () => { alertPoller.stop(); nudgeScheduler.stop(); process.exit(0); });

'use strict';

require('dotenv').config();

const express       = require('express');
const alertPoller   = require('./alertPoller');
const nudgeScheduler = require('./nudgeScheduler');
const wa            = require('./whatsapp');
const msgHandler    = require('./messageHandler');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(express.json());

// ── Webhook verification (GET) ────────────────────────────────────────────────
// Meta calls this URL with a challenge when you configure the webhook in the
// Developer Portal. Respond with hub.challenge to verify ownership.

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

app.post('/webhook', async (req, res) => {
  // Acknowledge immediately – Meta requires a 200 within 5 s
  res.sendStatus(200);

  const body = req.body;

  // Ignore status updates (delivered, read receipts, etc.)
  if (body.object !== 'whatsapp_business_account') return;

  const parsed = wa.parseWebhookEntry(body);
  if (!parsed) return;

  // Mark as read (fire-and-forget)
  if (parsed.msgId) wa.markRead(parsed.msgId);

  try {
    await msgHandler.handle(parsed);
  } catch (err) {
    console.error('[Webhook] Handler error:', err);
  }
});

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
process.on('SIGTERM', () => {
  alertPoller.stop();
  nudgeScheduler.stop();
  process.exit(0);
});
process.on('SIGINT', () => {
  alertPoller.stop();
  nudgeScheduler.stop();
  process.exit(0);
});

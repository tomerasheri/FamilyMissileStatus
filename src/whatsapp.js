'use strict';

/**
 * Thin wrapper around the Meta WhatsApp Cloud API.
 * https://developers.facebook.com/docs/whatsapp/cloud-api
 */

const axios = require('axios');

const BASE = 'https://graph.facebook.com/v19.0';

function client() {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token         = process.env.WHATSAPP_TOKEN;

  if (!phoneNumberId || !token) {
    throw new Error('WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_TOKEN must be set');
  }

  return axios.create({
    baseURL: `${BASE}/${phoneNumberId}`,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
}

/**
 * Send a plain text message.
 */
async function sendText(to, text) {
  const c = client();
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text, preview_url: false },
  };

  try {
    const { data } = await c.post('/messages', payload);
    return data;
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    console.error(`[WA] sendText to ${to} failed: ${msg}`);
    throw err;
  }
}

/**
 * Send an interactive message with two quick-reply buttons.
 * buttonPairs: [{ id, title }, { id, title }]  (max 3, WhatsApp limit)
 */
async function sendButtons(to, bodyText, buttonPairs, headerText = null) {
  const c = client();

  const interactive = {
    type: 'button',
    body: { text: bodyText },
    action: {
      buttons: buttonPairs.map((b) => ({
        type: 'reply',
        reply: { id: b.id, title: b.title },
      })),
    },
  };

  if (headerText) {
    interactive.header = { type: 'text', text: headerText };
  }

  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive,
  };

  try {
    const { data } = await c.post('/messages', payload);
    return data;
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    console.error(`[WA] sendButtons to ${to} failed: ${msg}`);
    throw err;
  }
}

/**
 * Mark an incoming message as read so the double-tick appears.
 */
async function markRead(messageId) {
  try {
    const c = client();
    await c.post('/messages', {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    });
  } catch {
    // non-critical
  }
}

/**
 * Extract the useful parts from a raw webhook entry.
 * Returns null if the entry is not an inbound user message.
 */
function parseWebhookEntry(body) {
  try {
    const entry   = body.entry?.[0];
    const change  = entry?.changes?.[0];
    const value   = change?.value;
    const message = value?.messages?.[0];

    if (!message) return null;

    const contact = value.contacts?.[0];
    const waId    = message.from;
    const name    = contact?.profile?.name || waId;
    const msgId   = message.id;

    // Location message
    if (message.type === 'location') {
      return {
        type:      'location',
        waId,
        name,
        msgId,
        lat:  message.location.latitude,
        lon:  message.location.longitude,
      };
    }

    // Quick-reply button tap
    if (message.type === 'interactive') {
      const reply = message.interactive?.button_reply;
      if (reply) {
        return {
          type:     'button_reply',
          waId,
          name,
          msgId,
          buttonId: reply.id,
          buttonTitle: reply.title,
        };
      }
    }

    // Plain text command
    if (message.type === 'text') {
      return {
        type:  'text',
        waId,
        name,
        msgId,
        text:  message.text.body.trim(),
      };
    }

    return null;
  } catch (err) {
    console.error('[WA] parseWebhookEntry error:', err.message);
    return null;
  }
}

module.exports = { sendText, sendButtons, markRead, parseWebhookEntry };

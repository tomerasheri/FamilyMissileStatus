# Family Missile Status Bot

A WhatsApp bot that monitors Israeli Home Front Command rocket alerts and tracks your family's safety status in real time.

## How it works

1. **Register** – Share your live WhatsApp location with the bot. It reverse-geocodes your position to a city and stores it.
2. **Alerts** – The bot polls `https://www.oref.org.il/WarningMessages/alert/alerts.json` every **5 seconds**. When a new alert fires, every registered user in the affected city receives a message with two quick-reply buttons:
   - ✅ **בסדר / Safe**
   - 🆘 **צריך עזרה / Help**
3. **Family groups** – Create a group and share an invite code with relatives. When any group member is alerted:
   - All other members are notified immediately.
   - Once the member responds, the whole group gets a status summary.
4. **Nudge** – If a user doesn't respond within **10 minutes**, the bot sends a reminder *and* notifies their family group that there's been no response.

## Setup

### Prerequisites

- Node.js ≥ 18
- A **Meta WhatsApp Business** account with a verified phone number
- A publicly reachable HTTPS URL for the webhook (e.g. via [ngrok](https://ngrok.com/) for local dev)

### 1. Clone & install

```bash
git clone <repo>
cd FamilyMissileStatus
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env and fill in your credentials
```

| Variable | Where to find it |
|---|---|
| `WHATSAPP_PHONE_NUMBER_ID` | Meta Developer Portal → App → WhatsApp → API Setup |
| `WHATSAPP_TOKEN` | Generate a permanent System User token in Business Manager |
| `WHATSAPP_VERIFY_TOKEN` | A secret string you choose; paste the same value in the webhook configuration |

### 3. Configure the Meta webhook

In the [Meta Developer Portal](https://developers.facebook.com/apps/):

1. Go to **WhatsApp → Configuration → Webhooks**
2. Set **Callback URL** to `https://YOUR_DOMAIN/webhook`
3. Set **Verify Token** to the same value as `WHATSAPP_VERIFY_TOKEN` in your `.env`
4. Subscribe to the **messages** field

### 4. Run

```bash
npm start
```

## User commands

| Command | Description |
|---|---|
| Share location | Register / update your city |
| `/create <name>` | Create a new family group |
| `/join <CODE>` | Join a group using a 6-character invite code |
| `/leave <CODE>` | Leave a specific group |
| `/status` | Show current safety status of all group members |
| `/help` | Show this help |

## Architecture

```
src/
├── index.js          – Express server + webhook endpoints
├── db.js             – SQLite (better-sqlite3) schema + queries
├── whatsapp.js       – Meta Cloud API wrapper (send/parse messages)
├── geocoder.js       – Nominatim reverse geocoding (Hebrew + English)
├── alertPoller.js    – Polls oref.org.il every 5 s, fans out alerts
├── messageHandler.js – Handles all inbound WhatsApp events
└── nudgeScheduler.js – 10-minute non-response nudge + group notification
```

### Database tables

| Table | Purpose |
|---|---|
| `users` | Registered users with their geocoded city |
| `family_groups` | Groups with unique invite codes |
| `group_members` | Many-to-many user ↔ group membership |
| `pending_responses` | Per-user per-alert tracking (response + nudge state) |
| `seen_alerts` | Deduplication of processed alert IDs |

## Security notes

- The webhook verify token prevents unauthorized parties from spoofing Meta webhook calls.
- Store your `.env` securely and never commit it to version control.
- For production, use a permanent System User access token with the minimum required permissions (`whatsapp_business_messaging`).

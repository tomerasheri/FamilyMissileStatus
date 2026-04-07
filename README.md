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

---

## Privacy & Legal Compliance (Israel)

This bot is designed to comply with Israeli privacy law. Read this section carefully **before going live**.

### Applicable laws

| Law | Relevance |
|---|---|
| **Protection of Privacy Law 5741-1981 (PPL)** | Main framework: consent, data subject rights, cross-border transfers |
| **Privacy Protection Regulations (Data Security) 5777-2017** | Technical security requirements for databases holding sensitive data |
| **Amendment 13 (2023)** to the PPL | Strengthened consent, erasure rights, higher fines |

### Personal data processed

| Data | Basis | Retention |
|---|---|---|
| WhatsApp ID (phone number) | Consent (PPL §11) | Until `/delete` |
| City name (from location share) | Consent – GPS coordinates are discarded immediately after geocoding | Until `/delete` |
| Alert response history (safe/unsafe) | Consent | **30 days**, then auto-purged |
| Family group memberships | Consent | Until `/delete` |

> **GPS coordinates are never stored.** Only the city name derived from them is kept. This satisfies the data-minimisation principle (PPL §3).

### Consent (PPL §11)

Every new user is shown a bilingual (Hebrew/English) privacy notice before any data is stored. The bot will not register a user, store their location, or send them alerts until they explicitly send `/accept`.

If you materially change data practices, bump `PRIVACY_NOTICE_VERSION` in `.env` — all users will be re-prompted automatically.

### Data subject rights

| Right | How implemented |
|---|---|
| Right of access (PPL §13) | `/mydata` command |
| Right of erasure (PPL §14 / Amendment 13) | `/delete` command — atomic DB transaction |
| Right of correction | Re-share location to update city |

### Database registration (PPL §8 / Registrar of Databases)

Under Israeli law, you **must register your database** with the Privacy Protection Authority (PPA) if it contains **sensitive personal data** (location data qualifies) on **any number of people**, or non-sensitive data on more than 10,000 people.

**Action required:** Register at [gov.il/he/departments/bureaus/36](https://www.gov.il/he/departments/bureaus/36) before collecting data from real users. The registration form asks for: purpose of the database, categories of data, security measures, and third-party recipients.

### Cross-border data transfers (PPL §23)

| Recipient | Country | Adequacy status |
|---|---|---|
| Meta / WhatsApp Cloud API | 🇺🇸 United States | **Not on Israel's adequate-countries list** — transfer is lawful under explicit user consent, which is obtained via the privacy notice |
| OpenStreetMap / Nominatim | 🇩🇪 Germany / EU | EU is considered adequate by Israel — no additional safeguards required |

### Security measures (Privacy Protection Regulations 5777-2017)

Location data is classified as **sensitive**, placing this database in the **"high" security level** under the 2017 Regulations. Required measures:

- [x] Database file restricted to owner-only permissions (mode 0600/0700)
- [x] Webhook requests authenticated with HMAC-SHA256 (app secret)
- [x] Minimal data collected (no GPS stored, only city name)
- [x] Automatic 30-day expiry of alert history
- [ ] **Encryption at rest** — recommended for production; use filesystem-level encryption (LUKS, AWS EBS encryption, GCP CMEK, etc.) or SQLCipher
- [ ] **Access log** — log who accesses the database in production
- [ ] **Incident response plan** — document steps to take if a data breach occurs (required under 2017 Regulations)

### What you must do before going live

1. **Fill in** `OPERATOR_NAME` and `OPERATOR_CONTACT` in `.env` — these appear in every privacy notice.
2. **Register your database** with the Israeli PPA (see above).
3. **Enable encryption at rest** on your server/volume.
4. **Create a written privacy policy** and link it from your operator contact details.
5. **Sign a Data Processing Agreement (DPA) with Meta** if processing data on behalf of others — see [Meta Business Terms](https://www.facebook.com/legal/terms/businesstools_serviceterms).
6. **Do not serve users under 18** without a separate parental-consent flow — the current bot has no age verification.

> ⚠️ This README is informational guidance, not legal advice. Consult an Israeli privacy lawyer before commercial or large-scale deployment.

# AmaniCare

Verified hospital bill payments for families in the DRC, paid by relatives abroad.

1. **Family in Kinshasa** photographs a hospital bill. Claude reads it into line items.
2. **Rules engine** checks prices against reference prices, duplicates, totals and signs of editing, and gives a risk score.
3. **Clinic** confirms the patient and amount on WhatsApp (or in the app).
4. **Diaspora payer** approves and pays. A licensed partner collects the money and **pays the clinic directly**. AmaniCare never holds funds.

High-risk bills stop in a manual review queue before reaching anyone.

Written in **TypeScript** (server and browser), stored in **PostgreSQL**, monitored with **Sentry**.

## Run it

Requires **Node.js 22.13 or newer** and **PostgreSQL 14 or newer**.

```bash
cp .env.example .env      # set DATABASE_URL, ADMIN_PHONE (your own number) and, optionally, SENTRY_DSN
npm install
npm run build             # tsc: server → dist/server, browser → dist/public
npm start                 # http://localhost:3000 (applies database migrations first)
npm test                  # builds, then runs the engine + end-to-end payment tests
```

No local Postgres? `docker compose up --build` starts the app and a database together.

In development, login codes appear on screen (`OTP_DEV=1`). Four demo clinics are created, and each one can log in with its WhatsApp number (`+243810000001` … `+243810000004`).

### Try the full flow on one computer
Use three browser profiles (or one normal and two private windows):
1. **Payer:** sign up as "I pay from abroad", then tap **+ Invite** and copy the code.
2. **Family:** sign up as "I'm family in the DRC", enter the code, and send a bill.
3. **Clinic:** log in with `+243810000001` and confirm.
4. **Payer:** tap **Pay**, then complete the sandbox checkout. The clinic is paid automatically.
5. **Admin:** log in with `ADMIN_PHONE` to see the review queue, ledger, outbox and settings.

## Database

PostgreSQL through [node-postgres](https://node-postgres.com) (`pg`). The schema is plain SQL in `migrations/`:

- Files run in name order, once each, inside a transaction, and are recorded in `schema_migrations`.
- They run automatically when the server starts. To run them alone: `npm run build && npm run migrate`.
- To change the schema, add a new file (e.g. `migrations/002_add_clinic_email.sql`). Never edit a migration that has already run.

Hosted Postgres connection strings work as given (e.g. Neon's `…?sslmode=require&channel_binding=require`): the server certificate is verified and channel binding is used. `DATABASE_SSL=1` forces TLS for strings without `sslmode`.

**Neon:** use the **pooled** string (host contains `-pooler`) for the app. Use the **direct** string (without `-pooler`) for `TEST_DATABASE_URL`, because the tests set their own schema, which the pooler doesn't allow. Better still, run the tests against a separate Neon branch or a local Postgres, not production.

**Tests** use `TEST_DATABASE_URL` (or `DATABASE_URL`). Each run creates a throwaway schema, runs the migrations in it and drops it afterwards, so your data is never touched.

## Error monitoring (Sentry)

Set `SENTRY_DSN` in `.env` to turn Sentry on for both the server and the browser. Leave it empty to turn it off.

- **Server** (`@sentry/node`): loaded first with `node --import ./dist/server/instrument.js`, so HTTP and Postgres calls are instrumented. Unexpected errors and 5xx responses are reported, plus failed payouts, payment-partner errors, WhatsApp send failures and AI read failures.
- **Browser**: the server adds Sentry's official CDN bundle (pinned version with an SRI hash) and the DSN to each page. It loads async, so a slow connection never delays the app. The Content-Security-Policy allows only that CDN and your Sentry ingest host.
- **Privacy:** AmaniCare handles health and payment data, so Sentry collects nothing beyond the error: no request bodies, cookies, query strings, SQL parameters, local variables or user details (only the internal user id and role). See `server/instrument.ts` and `web/monitoring.ts`.

Optional: `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE` (defaults to `amanicare@<version>`), `SENTRY_TRACES_SAMPLE_RATE` (0–1, default 0), `SENTRY_BROWSER=0` to keep Sentry on the server only. When upgrading the browser SDK, update the version and SRI hash in `server/config.ts` together with the `@sentry/browser` dev dependency (used for types).

## Architecture

```
web/               PWA source (TypeScript, compiled by tsc to plain ES modules, no bundler)
  app.ts           All screens: login, payer, family, clinic, admin
  sandbox.ts       Sandbox checkout page
  monitoring.ts    Sentry for the browser
  sw/sw.ts         Service worker (offline app shell)
public/            Static assets: HTML, CSS, icons, 4 languages (i18n/fr, en, ln, sw)
server/
  index.ts         HTTP server, static files, security headers
  instrument.ts    Sentry for Node (loaded before everything else)
  api.ts           REST API (auth, bills, admin, webhooks, sandbox)
  auth.ts          Phone + one-time code login, hashed server-side sessions
  bills.ts         Bill lifecycle, notifications, access control
  screening.ts     Deterministic risk rules (pure functions, unit tested)
  ai.ts            Claude bill reading: photo → structured JSON (never makes decisions)
  payments/
    partners.ts    Partner adapters: sandbox (working) and equity (placeholder)
    flow.ts        Collect → payout state machine, idempotent, webhook-safe
  messaging/       Sandbox outbox or WhatsApp Cloud API (interactive Confirm/Reject buttons)
  db.ts            node-postgres pool, query helpers, transactions
  migrate.ts       SQL migration runner
  seed.ts          Reference prices, default settings, demo clinics
migrations/        SQL schema migrations
test/              node:test unit and end-to-end tests (TypeScript)
```

**Bill statuses:** `review` → `awaiting_clinic` → `awaiting_payer` → `payment_pending` → `paying_out` → `paid`,
with `rejected`, `declined`, `payment_failed` (payer can retry) and `payout_failed` (admin retries; money was collected).

**Design choices**
- **No wallet.** Payers pay per bill, at approval. Holding balances would make AmaniCare a regulated e-money issuer.
- **AI reads, rules decide.** The model only extracts data. Every risk point comes from an explainable rule (`screening.ts`).
- **Edits are tracked.** The server keeps what the AI read and adds risk if the family changes it.
- **Only the clinic's registered WhatsApp number** can confirm its bills by webhook.
- **Idempotent payments.** Every partner call has a unique key, and duplicate webhooks can't trigger a second payout. Bill rows are locked (`SELECT … FOR UPDATE`) while their status changes, so two simultaneous taps can't move a bill twice.

## Going live: checklist

| Area | What's needed |
|---|---|
| Payments | API docs + sandbox credentials from the partner (Equity BCDC). Implement `equityPartner` in `server/payments/partners.ts`, set `PAYMENT_PARTNER=equity`, and set the partner's webhook to `/api/webhooks/payments/equity`. |
| Compliance | KYC of payers (by the partner), AML screening, terms and privacy policy, DRC data-protection review, health-data consent. Confirm where Sentry stores data (choose the EU or US region accordingly). |
| WhatsApp | Meta Business verification, a WhatsApp number, and approved templates for login codes and payment requests. Set `MESSAGING=whatsapp` and the webhook `/api/webhooks/whatsapp`. |
| AI | Set `ANTHROPIC_API_KEY`. Test on 30+ real bills and tune the reference prices. |
| Prices | Replace the illustrative reference prices (Admin → Prices) with real prices from pilot clinics. |
| Translations | Lingala and Swahili are drafts. Have native speakers review `public/i18n/ln.json` and `sw.json`. Missing keys fall back to French. |
| Security | `NODE_ENV=production`, `OTP_DEV=0`, HTTPS, `DATABASE_SSL=1` for managed Postgres, a persistent disk for `/data` (bill photos), daily database backups. |
| Monitoring | Set `SENTRY_DSN` and `SENTRY_ENVIRONMENT=production`; add alerts for "Payout failed" events. |

## Deploy

Any host that runs Node 22 with PostgreSQL and a persistent disk for bill photos works (Render, Railway, Fly.io, a VPS). With Docker:

```bash
docker build -t amanicare .
docker run -p 3000:3000 -v amanicare-data:/data --env-file .env amanicare
```

The image builds with `tsc`, ships only production dependencies and the compiled output, runs as a non-root user, and applies migrations at startup.

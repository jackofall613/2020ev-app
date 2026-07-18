# 2020EV — Codex Reference

> This file is the authoritative guide for Codex. Read it fully before making any changes.
> Last updated: 2026-05-17

---

## What This App Is

A **private mobile app** for ~10 condo residents who share a single Level 2 ChargePoint (CPF50) EV charger. The app coordinates weekday priority scheduling, tracks live sessions, runs a community feed, and handles wallet billing for electricity costs.

- **Residents** install the iOS app (TestFlight) and use it to schedule time, monitor the charger, chat in the feed, and see their wallet balance.
- **Admin (Jordan)** manages everything via the web dashboard at https://2020ev-admin.vercel.app.
- There is **no Stripe**, no public signup, no payment processor — the admin manually tops up resident wallets in dollars, and ChargePoint billing deducts from those balances automatically.

---

## Architecture

```
iPhone App (TestFlight build #19+)
        ↕ REST + WebSocket
Railway API  ←→  PostgreSQL Database
        ↑
Admin Portal (Vercel)
        ↑
ChargePoint SOAP API (daily auto-ingest)
```

| Piece | Stack | Where it lives |
|-------|-------|----------------|
| Mobile app | React Native + Expo SDK 54, iOS only | TestFlight via EAS Build |
| API | Node.js + TypeScript + Express | Railway — always on, Docker |
| Database | PostgreSQL | Railway — always on |
| Admin portal | Next.js + Tailwind CSS | Vercel — always on |
| ChargePoint data | SOAP API v5.1 | Polled daily from API |

**Live URLs:**
- API: `https://2020evapi-production.up.railway.app`
- Admin: `https://2020ev-admin.vercel.app`
- Health check: `GET /health` — returns `{ status: 'ok', build: '2026-05-17-vN' }`. Bump the build tag on every Railway deploy so you can confirm the new code is live.

---

## Monorepo Structure

```
2020ev/
├── AGENTS.md                          ← you are here
├── README.md                          ← user-facing docs
├── docker-compose.yml                 ← local dev (API + Postgres)
├── apps/
│   ├── api/                           ← Express REST API
│   │   ├── src/
│   │   │   ├── index.ts               ← server entry, migrations, socket.io, cron
│   │   │   ├── config.ts              ← port + env
│   │   │   ├── db/index.ts            ← pg Pool (query helper)
│   │   │   ├── middleware/
│   │   │   │   ├── auth.ts            ← authenticate + requireAdmin
│   │   │   │   └── errorHandler.ts
│   │   │   ├── routes/
│   │   │   │   ├── auth.ts            ← register, login, invite, bootstrap
│   │   │   │   ├── sessions.ts        ← charger session booking
│   │   │   │   ├── feed.ts            ← community posts
│   │   │   │   ├── schedule.ts        ← priority day assignments
│   │   │   │   ├── users.ts           ← user management + push token
│   │   │   │   ├── settings.ts        ← key-value settings (electricity rate)
│   │   │   │   ├── chargepoint.ts     ← charger status + SOAP sessions + cron ingest
│   │   │   │   └── wallet.ts          ← billing, CSV import, driver mapping ★ CORE
│   │   │   ├── services/
│   │   │   │   ├── chargepoint.ts     ← SOAP API client (raw XML)
│   │   │   │   ├── ingest.ts          ← daily auto-ingest (calls processRows)
│   │   │   │   ├── notifications.ts   ← Expo push (notifyUser, notifyAdmins)
│   │   │   │   └── pushNotifications.ts ← (older helper, largely superseded)
│   │   │   └── utils/jwt.ts           ← sign + verify access tokens
│   │   ├── .dockerignore              ← CRITICAL: excludes node_modules from Docker
│   │   └── Dockerfile
│   ├── mobile/                        ← Expo React Native iOS app
│   │   ├── src/
│   │   │   ├── screens/
│   │   │   │   ├── HomeScreen.tsx     ← live charger status + active session
│   │   │   │   ├── SessionScreen.tsx  ← start/end a session
│   │   │   │   ├── WalletScreen.tsx   ← balance + charging history (read-only)
│   │   │   │   ├── ScheduleScreen.tsx ← priority day grid
│   │   │   │   ├── FeedScreen.tsx     ← community posts
│   │   │   │   ├── DriversScreen.tsx  ← admin-only driver list (probably unused)
│   │   │   │   ├── ProfileScreen.tsx  ← user profile
│   │   │   │   ├── LoginScreen.tsx
│   │   │   │   └── RegisterScreen.tsx ← invite-token registration
│   │   │   ├── components/
│   │   │   │   ├── GlassCard.tsx      ← frosted glass card used everywhere
│   │   │   │   └── MiamiBackground.tsx ← gradient background
│   │   │   ├── contexts/
│   │   │   │   └── AuthContext.tsx    ← JWT + SecureStore + auto-refresh
│   │   │   └── constants/
│   │   │       ├── api.ts             ← API_URL (always points to Railway, even in DEV)
│   │   │       └── colors.ts          ← design tokens
│   │   └── app.json                   ← Expo config, bundle ID: com.2020ev.app
│   └── web/                           ← Next.js admin dashboard
│       └── app/
│           ├── login/page.tsx
│           └── dashboard/page.tsx     ← ★ MAIN ADMIN UI (single-page)
```

---

## Database Tables

Migrations run automatically in `runMigrations()` in `apps/api/src/index.ts` at startup. There is no separate migration tool — just `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` and `CREATE TABLE IF NOT EXISTS` guards.

### Key tables

| Table | Purpose |
|-------|---------|
| `users` | All app accounts. `role`: `'admin'` or `'user'`. `is_placeholder`: `true` for drivers who don't have the app yet (dummy email `slug.placeholder@2020ev.internal`). `push_token`: Expo push token. |
| `sessions` | Charger booking sessions. `status`: `'scheduled'`, `'active'`, `'completed'`. |
| `wallets` | One row per user. `balance_cents` integer. Created on first wallet operation. |
| `wallet_transactions` | Every debit/credit. `type`: `'charge'` or `'credit'`. `kwh` nullable (null for credits). `chargepoint_session_id`: the ChargePoint Plug In Event ID — has a `UNIQUE` index (where not null) to prevent double-billing. `session_id`: FK to `sessions` (nullable — CSV/API imports won't match). |
| `chargepoint_drivers` | Maps ChargePoint driver account numbers to `users` rows. `status`: `'pending'` (not yet mapped) or `'mapped'` (linked to a user). `driver_account_number` UNIQUE. `chargepoint_user_id`: numeric CP user ID from SOAP API. |
| `report_imports` | Audit log for every CSV upload or auto-ingest run. `csv_hash` UNIQUE prevents re-processing the same file twice. `rows_total`, `rows_matched`, `rows_unmatched`, `total_deducted_cents`. |
| `feed_posts` | Community messages. |
| `invite_tokens` | One-time registration tokens. |
| `settings` | Key-value store. Key `electricity_rate_cents_per_kwh` — default 18 ($0.18/kWh). |

---

## API Routes Reference

### Auth — `/auth`
- `POST /auth/bootstrap` — creates first admin invite (only works on empty DB)
- `POST /auth/register` — claim invite token, set name + password
- `POST /auth/login` → `{ accessToken, refreshToken, user }`
- `POST /auth/refresh` — exchange refresh token for new access token
- `POST /auth/invite` ← `requireAdmin` — generate invite link for new resident

### Users — `/users`
- `GET /users` ← `requireAdmin` — all users with wallet balances
- `POST /users/push-token` ← `authenticate` — register Expo push token

### Wallet — `/wallet` ★ MOST COMPLEX
- `GET /wallet/me` ← `authenticate` — logged-in user's balance + transaction history
- `GET /wallet/balances` ← `requireAdmin` — all users + balances
- `POST /wallet/credit` ← `requireAdmin` — `{ userId, amount_cents, description }` — add/subtract funds
- `GET /wallet/drivers` ← `requireAdmin` — all `chargepoint_drivers` rows with mapped user name
- `POST /wallet/drivers/:id/map` ← `requireAdmin` — `{ userId }` — link driver to user
- `POST /wallet/drivers/:id/create-placeholder` ← `requireAdmin` — creates a placeholder user and maps the driver
- `DELETE /wallet/drivers/:id/transactions` ← `requireAdmin` — "Reset billing": deletes all charge transactions for this driver's user and refunds the amounts back to their wallet
- `POST /wallet/import` ← `requireAdmin` — CSV upload (multipart or JSON body with `csvText`). Returns `{ rows_total, rows_matched, rows_unmatched, rows_already_billed, total_deducted_cents }`

### ChargePoint — `/chargepoint`
- `GET /chargepoint/status` ← `authenticate` — live charger status (60s cache)
- `GET /chargepoint/sessions?days=7` ← `authenticate` — recent SOAP sessions
- `GET /chargepoint/load` ← `authenticate` — current kW draw
- `POST /chargepoint/ingest` — accepts either `X-Ingest-Secret` header OR admin JWT — triggers `ingestYesterdaysSessions()`

### Other
- `GET /health` — no auth — status + build tag
- `GET /debug/drivers` — `X-Ingest-Secret` required — lists users vs CP drivers (diagnostic)
- `/sessions`, `/feed`, `/schedule`, `/settings` — standard CRUD

---

## ChargePoint Billing Pipeline ★ READ THIS

This is the most important and complex part of the system.

### Two ways data comes in:
1. **CSV upload** (admin manually downloads from ChargePoint portal and uploads to admin dashboard)
2. **Daily auto-ingest** (API pulls from ChargePoint SOAP API at 9 AM, or via Railway cron `POST /chargepoint/ingest`)

Both paths funnel through **`processRows()`** in `apps/api/src/routes/wallet.ts`.

### `processRows()` logic:

```
For each row (CP session):
  1. Look up chargepoint_drivers by driver_account_number
     → If driver not found: INSERT new driver as 'pending', increment unmatched
     → If driver found:
        a. status = 'mapped' + user_id exists → use that user_id ✓
        b. status = 'pending' + no user_id → retry name-match against users table
           → if match found: UPDATE driver to 'mapped', use that user_id ✓
           → if no match: increment unmatched, skip
  2. Check wallet_transactions for existing chargepoint_session_id
     → if exists: increment alreadyBilled, skip (deduplication)
  3. Deduct from wallet:
     - amount_cents = kwh × rate_cents_per_kwh
     - INSERT wallet_transactions (type='charge', chargepoint_session_id=...)
     - UPDATE wallets SET balance_cents = balance_cents - amount_cents
     - notifyUser(userId, 'Charging session billed', ...)
  4. Log to report_imports (csv_hash prevents re-processing same CSV file)
```

### Deduplication:
`wallet_transactions.chargepoint_session_id` has a `UNIQUE` index (where not null). The CSV Plug In Event ID = SOAP sessionId. If both sources ingest the same session, only the first succeeds — the second hits `ON CONFLICT DO NOTHING`.

### Electricity rate:
Stored in `settings` table, key `electricity_rate_cents_per_kwh`. Default 18 (= $0.18/kWh). Configurable in admin dashboard Settings tab.

### Driver mapping:
When ChargePoint CSV has a driver name like "Michael Leduc" who isn't in `users`, an admin must either:
- **Map** them to an existing user via the "ChargePoint Drivers" section in the admin dashboard
- **Create a placeholder** user (button "+ New resident") — creates a real `users` row with `is_placeholder=true` and a dummy email `{slug}.placeholder@2020ev.internal`. The placeholder can be "upgraded" later when the real person joins the app.

### Resetting billing (emergency use):
`DELETE /wallet/drivers/:id/transactions` — deletes all `charge` transactions for a driver's linked user where `chargepoint_session_id IS NOT NULL`, then refunds the sum back to their `balance_cents`. Use this if you accidentally imported a CSV twice or need to redo billing.

---

## Mobile App (Expo / React Native)

- **Bundle ID**: `com.2020ev.app`
- **EAS project**: `@jordan_banjo/2020ev`
- **Build profile**: `preview` (ad-hoc distribution via TestFlight)
- **Current build**: #19 (as of 2026-05-17)
- Always points to Railway API even in dev (`API_URL` is hardcoded to production in `api.ts`)

### WalletScreen (read-only for users):
- Shows: Available Balance (large, green/red based on < $100 threshold)
- Low balance warning: "⚠️ Balance is low — contact admin to top up"
- Usage summary: total kWh, session count, total billed
- Charging history: each row shows ⚡ icon, date, kWh chip, duration chip, dollar amount
- Credits show 💳 icon
- Pull-to-refresh
- **No controls** — users cannot add or subtract money. Only admin can via `POST /wallet/credit` (enforced server-side with `requireAdmin` middleware).

### Push notifications:
- Users register their Expo push token via `POST /users/push-token` on app launch
- `notifyUser(userId, title, body)` — sends to a specific user
- `notifyAdmins(title, body)` — sends to all admin users
- Fire-and-forget — never throws, never blocks the billing pipeline

### Building & distributing:
```bash
cd /Users/jordanneustadter/2020ev/apps/mobile

# Build for TestFlight
eas build --profile preview --platform ios

# Submit to TestFlight (after build completes)
eas submit --platform ios --latest
```

TestFlight builds expire every 90 days. A GitHub Actions workflow auto-rebuilds quarterly.

---

## Admin Portal (Next.js)

Single-page dashboard at `apps/web/app/dashboard/page.tsx`. All admin actions happen here.

### Sections:
1. **Live Charger** — real-time status from ChargePoint SOAP API
2. **Active Session** — who's currently charging
3. **Schedule** — priority day assignments grid (M-F per resident)
4. **Resident Wallets** — balance cards with +/− controls for each user. Admin enters a dollar amount and clicks + (credit) or − (deduct).
5. **ChargePoint Drivers** — maps CP driver accounts to app users:
   - 🔴 red dot = pending (not yet mapped)
   - 🟢 green dot = mapped
   - Dropdown + "Map" button for pending drivers
   - "+ New resident" button to create a placeholder user
   - "Reset billing" link for mapped drivers (with confirmation)
6. **Import** — drag-and-drop CSV upload from ChargePoint portal. Shows result: `"X new sessions billed · Y already billed (skipped) · Z unmatched"`
7. **Users** — invite new residents, view user list
8. **Feed** — community posts
9. **Settings** — electricity rate (cents/kWh)

### Deploying the admin portal:
Vercel auto-deploys from GitHub `main`. If GitHub auto-deploy fails (TypeScript errors etc.), deploy manually:
```bash
cd /Users/jordanneustadter/2020ev/apps/web
vercel --prod
```
Requires `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` env vars (or interactive login).

---

## Environment Variables

### Railway (API)
| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Signs access + refresh tokens |
| `CP_API_KEY` | ChargePoint SOAP API username |
| `CP_API_PASSWORD` | ChargePoint SOAP API password |
| `INGEST_SECRET` | Shared secret for `POST /chargepoint/ingest` cron endpoint and `GET /debug/drivers` |

### Vercel (Admin portal)
| Variable | Purpose |
|----------|---------|
| `NEXT_PUBLIC_API_URL` | Railway API URL |

---

## Infrastructure & Deployment

### Railway
- Auto-deploys from GitHub `main` via Docker
- `.dockerignore` at `apps/api/.dockerignore` excludes `node_modules`, `dist`, `.env`, `*.log` — **critical for fast builds (~2 min vs 10-15 min without it)**
- Build tag pattern: bump `build: '2026-05-17-vN'` in the `/health` endpoint with each deploy to confirm the new code is live
- To verify deployment: `curl https://2020evapi-production.up.railway.app/health | jq .build`
- Railway cron can call `POST /chargepoint/ingest` with `X-Ingest-Secret` header for daily billing

### ChargePoint SOAP API
- Endpoint: `https://webservices.chargepoint.com/webservices/chargepoint/services/5.1`
- Our charger EVSE ID: `1:19522681`
- Auth: WS-Security UsernameToken in SOAP header (`CP_API_KEY` / `CP_API_PASSWORD`)
- Used for: station status, session history, current load
- No webhooks — we poll

### Git / GitHub
- Repo: `https://github.com/jackofall613/2020ev.git`
- **All files must be committed** — Railway builds from git. If a file exists locally but isn't committed, the Railway build will fail (this caused weeks of broken builds for `notifications.ts` and `ingest.ts`).

---

## Known Gotchas & Lessons Learned

1. **Commit everything** — Railway builds from git checkout. Local-only files = broken Railway builds. Always run `git status` before pushing.

2. **`.dockerignore` is critical** — Without it, Docker copies `node_modules` on every build (10-15 min). With it: ~2 min.

3. **ChargePoint name matching is unreliable** — The CSV has full names ("Jordan Neustadter") but app accounts might use short names ("Jordan"). Auto-match by exact `LOWER(name)` often fails. The Driver Mapping UI in the admin portal is the real solution — manually link once, stays mapped forever.

4. **`chargepoint_session_id` prevents double-billing** — The same session ID from CSV and SOAP API will only bill once. Safe to re-import CSVs.

5. **`csv_hash` prevents re-importing** — The same CSV file won't be processed twice (SHA-256 of file content stored in `report_imports`).

6. **Placeholder users** — When a ChargePoint driver has no app account yet, use "+ New resident" to create a placeholder (`is_placeholder = true`, dummy email `{slug}.placeholder@2020ev.internal`, bcrypt hash of random UUID as password). They can be upgraded to a real account when they join.

7. **Vercel auto-deploy can fail on TypeScript errors** — If GitHub push triggers a bad Vercel build, use `vercel --prod` from the `apps/web` directory to deploy directly. This bypasses GitHub CI.

8. **`api.ts` always points to production** — The mobile app hits the Railway API even during local development. This is intentional (easier for the small team).

9. **Wallet balance accounting** — `balance_cents` is an integer. `UPDATE wallets SET balance_cents = balance_cents - $1` for charges. Negative balance is possible (no floor enforced at DB level).

10. **Socket.io is connected but minimal** — `io` is set up and exported, residents join `charger_room`. Currently no real-time events are emitted beyond connection tracking. Future use: push live session updates.

---

## Onboarding a New Resident

1. Add their Apple ID email to TestFlight at App Store Connect → Internal Testers
2. In admin portal → Invite User → enter their email → copy the invite link → send to them
3. They install the TestFlight app → tap the invite link → set a password → they're in
4. Admin tops up their wallet with starting balance via the Resident Wallets section

---

## Current State (as of 2026-05-17)

- Build #19 submitted to TestFlight (includes WalletScreen, DriversScreen, push notifications)
- Railway API at build tag `2026-05-17-v5`
- ChargePoint driver mapping is working — Jordan Neustadter and Michael Leduc both mapped
- Billing pipeline confirmed working: 10/10 sessions billed for the May CSV
- `INGEST_SECRET` env var should be set in Railway for the cron endpoint security
- Michael Leduc is a placeholder user (`is_placeholder = true`) — he hasn't installed the app yet
- Daily auto-ingest runs at 9 AM server time (in-process fallback) — Railway cron preferred

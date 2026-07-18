# 2020EV — Claude Code Reference

> This file is the authoritative guide for Claude Code. Read it fully before making any changes.
> Last updated: 2026-07-14

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
├── CLAUDE.md                          ← you are here
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
│   │   │   │   ├── queue.ts           ← "Next Up" charger queue (join/leave/claim/pass)
│   │   │   │   └── wallet.ts          ← billing, CSV import, driver mapping ★ CORE
│   │   │   ├── services/
│   │   │   │   ├── chargepoint.ts     ← SOAP API client (raw XML)
│   │   │   │   ├── chargerWatch.ts    ← move-your-car nudges + queue engine (advanceQueue)
│   │   │   │   ├── realtime.ts        ← socket.io registry; per-building rooms
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
| `charger_queue` | "Next Up" queue (v1.1). `status`: `'waiting'` → `'offered'` (15-min hold) → `'claimed'`/`'passed'`/`'expired'`, or `'cancelled'` on leave. Partial unique indexes enforce one live entry per user per building AND at most one `'offered'` per building. Engine: `advanceQueue()` in `services/chargerWatch.ts`. |
| `invite_tokens` | One-time registration tokens. |
| `settings` | Key-value store. Key `electricity_rate_cents_per_kwh` — default 18 ($0.18/kWh). |

---

## API Routes Reference

### Auth — `/auth`
- `POST /auth/bootstrap` — creates first admin invite (only works on empty DB)
- `POST /auth/register` — claim invite token, set name + password
- `POST /auth/login` → `{ accessToken, refreshToken, user }`
- `POST /auth/refresh` — exchange refresh token for new access token (single-use rotation)
- `POST /auth/change-password` ← `authenticate` — `{ current_password, new_password>=12 }`; verifies current via bcrypt, updates the hash, revokes ALL refresh tokens (logs out other devices), returns a fresh pair so the caller stays signed in. Returns 400 (not 401) on a wrong current password so clients can treat 401 as expired-session. Blocked during a super-admin "view as" session.
- `POST /auth/forgot-password` — `{ email }` — always generic 200 (never reveals account existence); when `RESEND_API_KEY` is set, emails a single-use 30-min reset link to the portal's public `/reset` page. Placeholder accounts skipped. Dormant (still 200, no email) until the key is set.
- `POST /auth/reset-password` — `{ token, new_password>=12 }` — consumes the reset token (SHA-256 at rest, single-use), updates the hash, revokes ALL refresh tokens. Used by `/reset` on the portal — which residents also use (the app's "Forgot password?" opens it).
- `POST /auth/invite` ← `requireAdmin` — generate invite link for new resident
- Login also has a per-ACCOUNT throttle (8 fails/15 min per email, in-memory) on top of the per-IP limiter; password-recovery endpoints get their own rate-limit bucket so login floods can't block recovery.

### Super-admin — `/admin` (all routes `requireSuperAdmin`)
- `GET /admin/buildings` — fleet list + resident/admin counts + MRR
- `POST /admin/buildings` — provision a building + its one-time admin invite
- `PATCH /admin/buildings/:id` — update subscription/metadata (billing_status, price, name, timezone)
- `POST /admin/buildings/:id/impersonate` — 30-min "view as" token (audit-logged)
- `DELETE /admin/buildings/:id` — permanently delete a building + all its tenant data (one transaction, FK-order cascade). Guarded: body `confirm_slug` must match, and the primary `2020` building can never be deleted.

### Users — `/users`
- `GET /users` ← `requireAdmin` — all users with wallet balances
- `POST /users/push-token` ← `authenticate` — register Expo push token
- `DELETE /users/me` ← `authenticate` — self-service account deletion (App Store 5.1.1(v)): scrubs PII/credentials, keeps billing history anonymized; refuses if user is the sole admin

### Wallet — `/wallet` ★ MOST COMPLEX
- `GET /wallet/me` ← `authenticate` — logged-in user's balance + transaction history
- `GET /wallet/me/export?months=12` ← `authenticate` — resident's own history as CSV download (the app's Wallet "⬆ Export" button → iOS share sheet)
- `GET /wallet/balances` ← `requireAdmin` — all users + balances
- `POST /wallet/credit` ← `requireAdmin` — `{ userId, amount_cents, description }` — add/subtract funds
- `GET /wallet/drivers` ← `requireAdmin` — all `chargepoint_drivers` rows with mapped user name
- `POST /wallet/drivers/:id/map` ← `requireAdmin` — `{ userId }` — link driver to user
- `POST /wallet/drivers/:id/unmap` ← `requireAdmin` — revert a mapped driver back to `pending`
- `POST /wallet/drivers/:id/ignore` / `unignore` ← `requireAdmin` — hide/restore a driver so ingests skip it
- `POST /wallet/drivers/:id/create-placeholder` ← `requireAdmin` — creates a placeholder user and maps the driver
- `DELETE /wallet/drivers/:id/transactions` ← `requireAdmin` — "Reset billing": deletes all charge transactions for this driver's user and refunds the amounts back to their wallet
- `GET /wallet/activity` ← `requireAdmin` — last 100 charge transactions across all users (with per-tx `rate_cents_per_kwh`)
- `POST /wallet/import` ← `requireAdmin` — CSV upload (multipart or JSON body with `csvText`). Returns `{ rows_total, rows_matched, rows_unmatched, rows_already_billed, total_deducted_cents }`

### ChargePoint — `/chargepoint`
- `GET /chargepoint/status` ← `authenticate` — live charger status (60s cache)
- `GET /chargepoint/sessions?days=7` ← `authenticate` — recent SOAP sessions
- `GET /chargepoint/load` ← `authenticate` — current kW draw
- `POST /chargepoint/ingest` — accepts either `X-Ingest-Secret` header OR admin JWT — triggers `ingestYesterdaysSessions()`
- `POST /chargepoint/reconcile-drivers` — `X-Ingest-Secret` required — maintenance: backfills `chargepoint_user_id` on `CP_USER_` records, optionally maps phantoms to residents via body `{ links: [{ cp_user_id, user_email }] }`, and auto-links phantoms sharing a numeric ID with a mapped real account. Idempotent.

### Queue — `/queue` (v1.1 "Next Up")
All routes `authenticate + resolveBuilding + requireBuilding`, scoped to `req.buildingId`. Every mutation broadcasts `queue:update` (the live entries) to the building's socket room.
- `GET /queue` — live queue + the caller's own entry/position (`position` 0 = holding the offer)
- `POST /queue/join` — join as `waiting` (no-op if already in; 409 if caller holds the active session). Offers immediately if the charger is actually free.
- `POST /queue/leave` — cancel own entry; leaving while `offered` advances to the next person
- `POST /queue/claim` — "On my way": sets `claimed_at` and EXTENDS the hold; the entry stays `offered` (still holding the charger) until the resident plugs in — session start resolves it to `claimed`. (Resolving on claim would let the tick re-offer the charger mid-walk.)
- `POST /queue/pass` — decline; auto-advances to the next waiting resident
- Engine hooks: session **end** calls `advanceQueue(assumeFree)` (falls back to the old priority-day ping when the queue is empty; response carries `queue_notified`); session **start** is blocked (409) for everyone but the hold-holder while a hold is live, and resolves the starter's live entry to `claimed`; the 5-min `chargerWatch` tick expires lapsed offers and auto-advances (with a ChargePoint IN_USE check).

### Other
- `GET /health` — no auth — status + build tag
- `/sessions`, `/feed`, `/schedule`, `/settings` — standard CRUD
- `GET|PATCH /settings/idle-fee` ← `requireAdmin` — v1.1 Feature 2's opt-in idle fee: `{ idle_fee_cents_per_15min (0–500, 0 = OFF, the default), idle_grace_min (5–120) }`, per building. The fee engine is `accrueIdleFee()` in `chargerWatch.ts` — **strictly prospective metering**: `sessions.idle_fee_billed_through` anchors at the first ELIGIBLE tick (fee on + neighbors waiting + CP confirms idle) and re-anchors after any gap in eligible ticks, so gated time (queue empty overnight, fee enabled mid-idle, car drawing power, CP outage) is skipped, never retro-billed as a lump sum. CAS on `idle_fee_blocks_billed` (with `status='active'`) means races/crashes/ended sessions can only ever under-bill.
- `GET /chargepoint/load` also returns `eta: { car_label, estimated_free_at, idle_minutes }` (v1.1 Feature 3; `utils/eta.ts`, assumed-fraction estimate off the live draw, nulls whenever no car profile/live data — the app then falls back to the user-typed estimate).
- `PATCH /users/me` whitelist: `name, push_token, unit_number, avatar_url` + v1.1 car profile `car_make, car_model, battery_kwh (10–300), target_percent (50–100)` (null clears).
- (`GET /debug/drivers` was removed 2026-07-11 — it exposed cross-building user emails behind the shared `INGEST_SECRET`; use `POST /chargepoint/reconcile-drivers` for driver diagnostics)

---

## ChargePoint Billing Pipeline ★ READ THIS

This is the most important and complex part of the system.

### Two ways data comes in:
1. **CSV upload** (admin manually downloads from ChargePoint portal and uploads to admin dashboard). Rows carry the real `Driver Account Number` (e.g. `DNACLB...`), `Driver Name`, and numeric `User ID`.
2. **Daily auto-ingest** (`ingestYesterdaysSessions()` pulls from the SOAP API). SOAP `getChargingSessionData` only returns a numeric `userID` — **no name** — so ingest enriches each session via `getUser()` (SOAP `getUsers`) to get the real name + email, and uses a synthetic account number `CP_USER_<userID>`.

Both paths funnel through **`processRows()`** in `apps/api/src/routes/wallet.ts`.

### `processRows()` logic:

```
For each row (CP session):
  1. Look up chargepoint_drivers by driver_account_number
     → If found:
        - refresh driver_name (if row has a real name) + chargepoint_user_id
        - status='mapped' + user_id → use it ✓
        - status='pending' → matchAppUser(email→name), else resolveByCpUserId() → map ✓, else unmatched
     → If NOT found: INSERT new driver; matchAppUser(email→name), else resolveByCpUserId();
        mapped if resolved, else 'pending' + notify admins + unmatched
  2. Check wallet_transactions for existing chargepoint_session_id
     → if exists: increment alreadyBilled, skip (deduplication)
  3. Deduct from wallet:
     - amount_cents = kwh × rate_cents_per_kwh
     - INSERT wallet_transactions (type='charge', chargepoint_session_id=..., rate_cents_per_kwh=...)
     - UPDATE wallets SET balance_cents = balance_cents - amount_cents
     - notifyUser(userId, 'Charging session billed', ...)
  4. Log to report_imports (csv_hash prevents re-processing same CSV file)
```

**Matching priority** (`matchAppUser` then `resolveByCpUserId`): email → exact name → ChargePoint numeric ID. `resolveByCpUserId()` links a SOAP `CP_USER_<id>` phantom to a resident already mapped under their real CSV account (or vice-versa) because both identities share `chargepoint_user_id`. SOAP and CSV driver records are kept as **separate rows** that share the numeric ID — dedup by `chargepoint_session_id` still prevents any double-billing.

### Deduplication:
`wallet_transactions.chargepoint_session_id` has a `UNIQUE` index (where not null). The CSV Plug In Event ID = SOAP sessionId. If both sources ingest the same session, only the first succeeds — the second hits `ON CONFLICT DO NOTHING`. This makes re-running ingest (or running it from multiple triggers) completely safe.

### Electricity rate:
Stored in `settings` table, key `electricity_rate_cents_per_kwh`. Default 18 (= $0.18/kWh). Configurable in admin dashboard Settings tab. The rate used is also stored on each `wallet_transactions` row (`rate_cents_per_kwh`) for auditability.

### Driver mapping:
With `getUser()` enrichment, SOAP-sourced drivers now arrive with real names + emails and **auto-match to app accounts by email** — so new residents normally need no manual mapping. When a driver still can't be resolved, an admin can:
- **Map** them to an existing user via the "ChargePoint Drivers" section in the admin dashboard
- **Create a placeholder** user (button "+ New resident") — creates a real `users` row with `is_placeholder=true` and a dummy email `{slug}.placeholder@2020ev.internal`. The placeholder can be "upgraded" later when the real person joins the app.
- Use `POST /chargepoint/reconcile-drivers` (secret-protected) to bulk-link phantoms by `{ cp_user_id, user_email }`.

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
| `CP_STATION_ID` | Charger EVSE ID (defaults to the 2020 building's `1:19522681`) — set per building |
| `INGEST_SECRET` | Shared secret for `POST /chargepoint/ingest` cron endpoint and `GET /debug/drivers` |
| `OPENAI_API_KEY` | Enables AI features (resident assistant + admin summary) via OpenAI. Optional. |
| `OPENAI_MODEL` | OpenAI model id (default `gpt-4o-mini`). Optional. |
| `ANTHROPIC_API_KEY` | Enables AI features via Claude (`claude-opus-4-8`). Optional. |
| `AI_PROVIDER` | `openai` or `anthropic` — force a provider. If unset, prefers OpenAI when its key is present, else Anthropic. |
| `RESEND_API_KEY` | Enables transactional email (forgot-password) via Resend. Optional — the flow answers generically but sends nothing until set. |
| `EMAIL_FROM` | From-address for email (default `2020EV <support@2020ev.app>`; the domain must be verified in Resend). Optional. |
| `PORTAL_URL` | Base URL for reset links (default `https://2020ev-admin.vercel.app`). Optional. |

**AI provider switch:** the AI layer ([services/assistant.ts](apps/api/src/services/assistant.ts)) is dormant until one of the AI keys is set. With both keys set it uses OpenAI (to burn those credits first); to switch to Claude, set `AI_PROVIDER=anthropic` (or remove `OPENAI_API_KEY`) — no redeploy. `GET /health` reports the active provider in the `ai` field (`openai` / `anthropic` / `disabled`).

Per-building deployments (productization): see [NEW_BUILDING.md](NEW_BUILDING.md) — each building is a clone of this stack with its own env vars. The mobile app reads `EXPO_PUBLIC_API_URL` at build time.

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

3. **ChargePoint driver matching** — SOAP `getChargingSessionData` returns NO name (only numeric `userID`), so ingest enriches via `getUser()` (`getUsers` SOAP method, which carries firstName/lastName + email/unit/vehicle) and auto-matches to app accounts **by email first**, then exact name, then numeric ID (`resolveByCpUserId`). Email matching is what makes new residents map automatically. Pure `LOWER(name)` matching is unreliable (CSV "Jordan Neustadter" vs app "Jordan"); the numeric ID + email links are the robust path. SOAP creates a `CP_USER_<id>` driver row distinct from the CSV's real `DNACLB...` row — both share `chargepoint_user_id`; do NOT "merge" them by renaming (that recreates a new phantom every ingest) and do NOT auto-ignore phantoms (that silently stops SOAP billing).

4. **`chargepoint_session_id` prevents double-billing** — The same session ID from CSV and SOAP API will only bill once. Safe to re-import CSVs.

5. **`csv_hash` prevents re-importing** — The same CSV file won't be processed twice (SHA-256 of file content stored in `report_imports`).

6. **Placeholder users** — When a ChargePoint driver has no app account yet, use "+ New resident" to create a placeholder (`is_placeholder = true`, dummy email `{slug}.placeholder@2020ev.internal`, bcrypt hash of random UUID as password). They can be upgraded to a real account when they join.

7. **Vercel auto-deploy can fail on TypeScript errors** — If GitHub push triggers a bad Vercel build, use `vercel --prod` from the `apps/web` directory to deploy directly. This bypasses GitHub CI.

8. **`api.ts` always points to production** — The mobile app hits the Railway API even during local development. This is intentional (easier for the small team).

9. **Wallet balance accounting** — `balance_cents` is an integer. `UPDATE wallets SET balance_cents = balance_cents - $1` for charges. Negative balance is possible (no floor enforced at DB level).

10. **Socket.io emits per-building, never globally** — sockets join `building:<id>` (resolved server-side from the JWT in `index.ts`; `services/realtime.ts` is the emit registry) and the queue broadcasts `queue:update` there. The legacy global `charger_room` is still joined but nothing tenant-scoped may ever be emitted to it — that would leak one building's activity to another. Mobile listens in HomeScreen (socket.io-client) with the 30s poll as fallback.

11. **Daily ingest always runs in-process** — `scheduleDailyIngest()` in `index.ts` fires at 9 AM server time unconditionally (the old `DISABLE_IN_PROCESS_CRON` gate was removed). Because dedup makes repeat ingests harmless, billing can never silently stop. The app `notifyAdmins()` after each run is your daily billing summary.

12. **Don't rely on Claude-Code-on-web routines to hit the API** — A scheduled remote "billing check" routine runs in a sandbox whose egress allowlist blocks the Railway host, so it always reports FAILED even though billing is fine. That routine is disabled; billing runs in-process on Railway instead. (Re-enabling it requires allowlisting `2020evapi-production.up.railway.app` in the web environment settings.)

13. **Two GitHub accounts** — pushing to `jackofall613/2020ev` requires the active `gh` account to be `jackofall613` (`gh auth switch --user jackofall613`). If it's on `jneu-dev`, push fails with a misleading "Repository not found".

14. **Local docker dev: renew anon volumes after dependency changes** — `docker-compose.yml` bind-mounts `./apps/api` over `/app` but keeps `/app/node_modules` in an anonymous volume. After adding an npm dependency, `docker compose up -d --build api` alone still runs with the OLD node_modules (the volume survives rebuilds) → "Cannot find module". Use `docker compose up -d --build --renew-anon-volumes api`.

15. **The portal is dark-authored, light by default** — components use `text-white/*`, `bg-white/*` etc.; `globals.css` remaps those under `html:not(.dark)` (light is the default theme), and `html.dark` restores the original look (toggle in the headers, stored in `localStorage.theme`). Rules: page chrome reads CSS vars (`--page-bg`, `--header-bg`, `--modal-bg`, `--overlay`) — never hardcode `#0A0F1E` inline; buttons on colored backgrounds must use `text-on-accent` (NOT `text-white`, which light mode remaps to ink); new white-alpha utility variants (e.g. a new `hover:bg-white/7`) need a matching remap line in globals.css.

16. **A session never ended in-app blocks the queue** — `chargerIsFree()` (queue engine) and `POST /sessions/start` both treat an `active` sessions row as occupancy, and sessions never auto-complete. A resident who unplugs and leaves without tapping End leaves a zombie session that blocks every queue offer even while ChargePoint reports AVAILABLE. Known v1.1 limitation (flagged in the pre-merge review); candidate fix: auto-complete a session once CP has reported AVAILABLE for several ticks past its `estimated_end`. Admin workaround: end the session for them (or the resident re-opens the app).

17. **Refresh tokens are stored as SHA-256, never bcrypt** — bcrypt truncates its input at 72 bytes, and every refresh JWT for a user shares a >72-byte prefix (identical header + `userId`/`role`/`buildingId` claims; only `iat`/`exp` differ, past byte 72). Storing `bcrypt(token)` made `bcrypt.compare(anyOldToken, hash(anyNewToken))` return true, so rotation / logout-other-devices / change-password invalidation all silently no-oped. Fixed in `hashRefreshToken()` ([utils/jwt.ts](apps/api/src/utils/jwt.ts)) → SHA-256 hex + exact indexed lookup. Passwords still use bcrypt (they're short + low-entropy; that's correct). Never bcrypt a value that can exceed 72 bytes.

---

## Onboarding a New Resident

1. Add their Apple ID email to TestFlight at App Store Connect → Internal Testers
2. In admin portal → Invite User → enter their email → copy the invite link → send to them
3. They install the TestFlight app → tap the invite link → set a password → they're in
4. Admin tops up their wallet with starting balance via the Resident Wallets section

---

## Current State (as of 2026-07-05)

> **⚡ MULTI-TENANCY SHIPPED (2026-07-05).** The app is no longer single-tenant.
> One shared stack now serves many buildings, with per-building data isolation,
> `super_admin` / `admin` (building) / `member` roles, `building_id` scoping on
> every tenant table/query, per-building encrypted ChargePoint config, a super-admin
> `/buildings` fleet UI, and audit-logged ghost-login. Much of the single-tenant
> detail below (tables, routes, roles) has been extended — **treat
> [docs/multi-tenancy-plan.md](docs/multi-tenancy-plan.md) + README.md §0 as the
> source of truth for the multi-tenant layer**, and [docs/next-session-brief.md](docs/next-session-brief.md)
> for the remaining work. A super-admin (jordan.neustadter@gmail.com) is seeded;
> off-site daily pg_dump backups run via `.github/workflows/db-backup.yml`.

- Build #19 on TestFlight (WalletScreen, DriversScreen, push notifications)
- Railway API at build tag `2026-07-11-v16-appstore-prep`
- **All 5 residents mapped and billing correctly**: Jordan, Michael Leduc (placeholder), Meghan Earley, Brooke, Jonathan Gerrard
- SOAP `CP_USER_<id>` phantoms are mapped to residents by numeric ID; daily auto-ingest now bills them (previously billed $0 because the old strategy ignored phantoms)
- `getUser()` enrichment live — future residents auto-resolve to real name + email and auto-map by email
- Daily auto-ingest runs in-process at 9 AM, always-on (no env gate); admin push notification after each run
- The Claude-Code-on-web "Daily Ingest Check" routine is **disabled** (sandbox can't reach the API; redundant with in-process cron)

**Shipped 2026-07-05 (this session):**
- `POST /auth/change-password` + a "Change password" control in both admin-portal headers.
- Guarded `DELETE /admin/buildings/:id` (super-admin, `confirm_slug`, protects `2020`) + isolation tests (16 total, green).
- **Security fix:** refresh-token revocation now works (SHA-256 storage — see Gotcha #14). All sessions were logged out once on deploy of v15; users re-login.
- **`INGEST_SECRET` ROTATED** in Railway (the old value had leaked into git history). New value lives only in Railway env — never commit it.
- **`CP_CRED_KEY` SET** in Railway (`openssl rand -hex 32`) → per-building ChargePoint creds can now be stored encrypted (AES-256-GCM) via `PATCH /chargepoint/config`. The `2020` building was **left on its `CP_API_*` env fallback** (not migrated — lowest risk to live billing).
- Verified end-to-end against prod via a throwaway "demo-harbor" building (onboarding + isolation + change-password + delete), then torn down.

**Shipped 2026-07-11 (App Store launch prep):**
- **[docs/app-store-launch.md](docs/app-store-launch.md) is the launch runbook** — read it before touching anything App-Store-related. Single multi-building app (login already resolves the building server-side; no picker).
- Hosted **/terms** and **/support** pages added to apps/web (privacy already existed); **store.config.json** (EAS Metadata) added to apps/mobile — listing copy, categories, review notes + demo-account placeholders (never commit real credentials).
- **Removed `GET /debug/drivers`** (leaked cross-building user emails behind `INGEST_SECRET`).
- **Registration password minimum raised 8 → 12** (server zod schema + RegisterScreen), matching change-password. Ships to mobile in build #20.
- API build tag → `2026-07-11-v16-appstore-prep`.
- **Auth decision:** evaluated Clerk, deliberately stayed on in-house JWT auth — it was just security-hardened, is tightly coupled to invites/placeholder users/impersonation, and adding third-party login would newly trigger Apple's Sign-in-with-Apple requirement. Revisit only for SSO/MFA demands.
- Remaining Apple-side steps (demo account, screenshots, nutrition labels, submit) are Jordan-only — checklist in the runbook.

**Shipped 2026-07-12 (App Store launch execution):**
- **`store.config.json` pushed to ASC** — title/subtitle (≤30 chars, "Shared EV charging for condos")/description/keywords/categories/URLs are live in the draft. The `advisory` age-rating block was **written then removed**: `metadata:push` fails on it because the cached eas-cli sends Apple the deprecated `gamblingAndContests` attribute (`unknown attribute 'gamblingAndContests'`). **Age rating is set manually in ASC** (all None → 4+); alt fix is upgrading eas-cli. The **App Review Information block was also removed** on purpose: it holds a reviewer credential + personal phone, so it's entered directly in ASC (paste-ready notes live in [docs/app-store-launch.md](docs/app-store-launch.md)).
- **Demo building seeded in prod** for App Review: "The Palm Residences (Demo)", reviewer login `<demo-login-redacted>` (password NOT in git). Data seeded via API + a few direct `wallet_transactions` inserts (balance, charging history, feed). Doubles as the standing sales-demo tenant.
- **App Store screenshots** prepped from Jordan's real device (live charger + real history beats the demo building): `~/Downloads/2020ev-appstore-screenshots/` (`01-home`…`04-feed`, upscaled to 1290×2796 / 6.9"). Screenshots are the one asset EAS can't push — drag into ASC by hand.
- **Production build #20 started on EAS** (`eas build --profile production`) — headless, reused the stored distribution cert; buildNumber auto-bumped 19→20 in app.json. Also ran `expo install --fix` (minor SDK-54 patch bumps in package.json), which the build uses.
- **Super-admin password reset this session** — the machine-generated original was lost. Reset via a direct bcrypt(hash) UPDATE on the prod `users` row + refresh-token revocation; verified with a live login. First attempt wrote an empty hash (called `bcrypt` instead of the app's `bcryptjs`); a guard caught it before the second write; third attempt correct. **Lesson: this app hashes with `bcryptjs`, not `bcrypt`** — generate hashes inside the API container or with `bcryptjs`.
- **Apple-auth wall (key operational fact):** `eas metadata:push` and `eas submit` require interactive Apple ID + 2FA — they **cannot** run in a headless/agent session. `eas build` is fine headless (cached cert). Options: run those two interactively, or set up an ASC API key (`EXPO_ASC_API_KEY_PATH`/`EXPO_ASC_KEY_ID`/`EXPO_ASC_ISSUER_ID`). See runbook.
- Jordan bought **2020ev.app** (Squarespace) — pending: email forwarding for `support@2020ev.app` + DNS → Vercel. Clerk was again declined; staying on in-house auth.

**Shipped 2026-07-13 (portal + app feature sprint, pre-submission):**
- **Portal light theme, default ON** — see Gotcha #15 for how it works and the rules when adding UI. Toggle (🌙/☀️) in both portal headers.
- **Forgot-password flow, end to end** — `POST /auth/forgot-password` + `POST /auth/reset-password` (tokens SHA-256/single-use/30-min, all sessions revoked on reset), public portal `/reset` page (handles both request + set modes), "Forgot password?" links on portal login AND mobile LoginScreen (opens `/reset`). **Email sending is env-gated on `RESEND_API_KEY`** — dormant until Jordan verifies 2020ev.app in Resend and sets the key in Railway. New `password_reset_tokens` table (Migration 015, self-contained try/catch).
- **Resident report export** — `GET /wallet/me/export` (CSV) + "⬆ Export" button on the app's Wallet screen (expo-file-system/legacy download + expo-sharing share sheet). Ships in build #21.
- **Feed posts now push-notify** the rest of the building (`notifyBuildingMembers`, excludes author, fire-and-forget) — previously the message board was silent unless the app was open.
- **Security/speed:** per-account login throttle (8 fails/15min/email) + separate rate bucket for recovery endpoints; gzip (`compression`); dashboard's 8 secondary fetches hoisted to run concurrently with the blocking trio (removes a full round-trip); hot-path composite indexes (`wallet_transactions(user_id, created_at)`, `feed_messages(building_id, created_at)`); Report History card capped at ~7 rows with scroll.
- Verified: api tsc + 16/16 isolation tests; full reset flow + throttle + CSV export exercised against a local API on the isolation-test DB; portal light/dark verified in-browser (computed styles); mobile tsc green. API tag → `2026-07-13-v17-portal-sprint`.

**Shipped 2026-07-15 (App Store submission + domain/email live):**
- **v1.0 SUBMITTED to App Store review** — build #21 (adds Wallet CSV export + login "Forgot password?"), uploaded via `eas submit` (the cached Apple session from an interactive `eas metadata:push` earlier let submit run without re-login). Copyright / Content Rights / Pricing(Free) were set by Jordan in ASC.
- **`2020ev.app` is live** — apex serves the portal via Vercel (`www` CNAME added); metadata/reset/portal URLs can now be moved onto it (still on `2020ev-admin.vercel.app` as of this commit — a follow-up).
- **Reset emails LIVE** — `RESEND_API_KEY` set in Railway; `2020ev.app` verified in Resend after fixing a stray space in the `resend._domainkey` DKIM value. DMARC is `p=reject; adkim=s` — fine because Resend signs `d=2020ev.app` (aligns). Verified send from the server (no `[email]` rejection in logs).
- **`support@2020ev.app` inbound** — this is **Squarespace Email Forwarding** (runs on Mailgun MX under the hood — those root `mailgun.org` MX/SPF/DMARC/`pic._domainkey` records are Squarespace's managed preset, NOT app cruft; do not delete them). Forwarding rule support@ → Jordan's Gmail is set. The app's own `/wallet/inbound-report` Mailgun webhook is **unused** (0 email-source imports; `MAILGUN_WEBHOOK_SIGNING_KEY` unset) — billing is 100% SOAP auto-ingest.
- **Next release is specced:** [docs/roadmap-v1.1.md](docs/roadmap-v1.1.md) — charger queue ("Next Up"), queue-aware anti-camping escalation (extends the existing `chargerWatch.ts`), car profiles + finish ETA. Feature 1 shipped 2026-07-14 (below); Features 2–3 not started.

**Shipped 2026-07-14 (v1.1 Feature 1 — "Next Up" charger queue):**
- **`charger_queue` table (Migration 016)** + `/queue` routes (`GET /`, `join`, `leave`, `claim`, `pass`) + the offer engine `advanceQueue()` in `chargerWatch.ts`: on session end the front of the queue gets a push + **15-min hold** ("held for you until {time}", building-timezone), pass/expiry auto-advances (5-min tick), DB-enforced invariants (one live entry per user, one offer per building). Queue empty → old priority-day ping still fires. See the Queue routes section + Gotcha #10.
- **Hold enforcement:** `POST /sessions/start` returns 409 for everyone but the hold-holder while a hold is live; the holder starting a session (even without tapping "On my way") resolves their entry to `claimed`. Session-end response carries `queue_notified`.
- **Per-building socket rooms** (`building:<id>`, from the server-verified JWT; `services/realtime.ts`): every queue mutation broadcasts `queue:update`. The spec said `charger_room`, but that room is global/cross-tenant — deliberately deviated (verified cross-building silence with two live socket clients).
- **Mobile:** HomeScreen "Next Up" card (join/leave, position, held-for banner, On my way / Pass), socket.io-client live updates (30s poll fallback), offer push deep-links to Home (`data.type === 'queue_offer'` + notification-response listener in AppMain), SessionScreen "next resident notified" confirmation. `npx tsc --noEmit` green. **Ships in EAS build #22 — rebuild not yet run.**
- **Verified:** api tsc green; isolation suite 28/28 (queue cross-building isolation, full offer flow, expiry auto-advance, delete-cascade incl. `charger_queue`) on `ev2020_test`; live flow exercised against a local API on :3002 (join → offer-on-end → hold-block → claim; socket isolation).

**Shipped 2026-07-14 (v1.1 Features 2+3 — anti-camping escalation + car profiles/ETA, same release):**
- **Feature 2:** `chargerWatch` nudges are queue-aware (copy states how many neighbors wait); one-shot second escalation 20 min after the first nudge while the queue is non-empty (`sessions.idle_escalated_at`, Migration 017). **Opt-in idle fee, OFF by default** (`/settings/idle-fee`, per building, portal Settings block): completed 15-min blocks past grace, only while neighbors queue AND CP confirms idle — never bills when CP is unreachable; `idle_fee_blocks_billed` CAS guard (under-bill-only on races); ledger+balance in one DB transaction; transparent push + wallet line item.
- **Feature 3:** `users.car_make/car_model/battery_kwh/target_percent` (Migration 018) + `PATCH /users/me` whitelist; `GET /chargepoint/load` carries `eta` (see routes section; `utils/eta.ts` with unit tests); ProfileScreen "Your car" section; HomeScreen shows "{Name}'s {model} — free in ~{eta} (est.)" + "car looks done — idle Xm".
- Built partly by parallel subagents (portal Settings block, ProfileScreen section) + an adversarial review agent over the full branch diff before merge.
- **Verified:** tests 28 → 36/36 on `ev2020_test` (idle-fee default-off/isolation/exactly-once, escalation flags, car validation, ETA units); portal block driven live in-browser on :3001→:3002 (light + dark, save + persistence + cross-building values); mobile + web tsc green. Final API tag → `2026-07-14-v19-v1.1`.
- **Pre-merge adversarial review (agent) caught + fixed:** (1) BLOCKER — the spec's idle-fee formula retro-billed gated time as a lump sum (→ prospective `idle_fee_billed_through` metering); (2) claim resolved the entry so the tick re-offered the charger mid-walk (→ claim keeps the hold, plug-in resolves); (3) login payload lacked the car profile → vanished/wiped on re-login (→ login now returns it + avatar_url); plus ended-session billing guard + idle fees now visible in portal Billing Activity. Zombie-session limitation documented as Gotcha #16.
- **DEPLOYED + SHIPPED:** PR #1 merged 2026-07-14; Railway live on `2026-07-14-v19-v1.1` (~60s after merge), portal deployed, `/queue` mounted in prod. **EAS build #22 built AND submitted to ASC headlessly** — `eas submit` no longer needs interactive Apple auth: an ASC API key is stored on EAS servers ("Key Source: EAS servers"), superseding the 2026-07-12 "Apple-auth wall" note for submit. Jordan-only decision remaining: leave v1.0 (build #21) in review and ship v1.1 as an update after approval, or swap build #22 into the pending submission (resets review queue position).

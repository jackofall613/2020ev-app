# 2020EV → Multi-Tenant: Architecture & Migration Plan

> Approved 2026-07-05. Companion to [multi-tenancy-brief.md](multi-tenancy-brief.md).
> This is the source of truth for the multi-tenant rewrite. Each phase is
> independently shippable and deploys green. The existing **2020** building must
> keep working the entire time.

## Goal

Turn 2020EV from a single-tenant app (one DB = one implicit building) into a true
multi-tenant product: one system serving many condo buildings, with a super-admin
(the product operator) who can see all buildings and impersonate any building's
admin for support.

## Confirmed decisions

1. **Role strings** — add `super_admin`; keep `'admin'` as the building admin
   (no rename to `building_admin`). `role IN ('super_admin','admin','member')`.
   Avoids churning every `requireAdmin` check and the mobile app's role handling.
2. **Super-admin identity** — a **dedicated** `super_admin` account with
   `building_id = NULL`, separate from Jordan's 2020 resident/admin account.
3. **Subscription gating** — **soft**: banner + super-admin visibility for
   `past_due`/`canceled`; no hard lockout of resident charging records.
4. **RLS backstop** — **yes**, include Postgres row-level security as
   defense-in-depth (Phase 8) so a forgotten filter cannot leak cross-tenant data.
5. This plan doc is committed to the repo.

## Guiding principles

- **Tenant scoping is server-trusted.** `building_id` always comes from the JWT
  (`req.buildingId`), never from a client-supplied header/param — except a
  `super_admin` may pass an explicit `building_id` (allowed *only* because the
  token says `super_admin`).
- **Email stays globally unique.** Login resolves `email → user → building_id`, so
  neither the mobile app nor the web app needs a building picker. Synthetic emails
  (placeholder/deleted) become building-scoped to avoid collisions.
- **Billing dedup scoped per building.** Two ChargePoint accounts have independent
  session-id / account-number sequences; uniqueness must be per building or one
  building's ingest could false-dedup and silently drop another's billing.
- **Migrations follow the existing inline pattern** in `runMigrations()`
  (`apps/api/src/index.ts`) — idempotent `ALTER … IF NOT EXISTS` /
  `CREATE … IF NOT EXISTS`. The `.sql` files under `src/db/` only run for local
  docker-compose init, not on Railway.

## Baseline (verified in code)

- Tables (none have `building_id`): `users`, `sessions`, `feed_messages`,
  `settings`, `chargepoint_drivers`, `wallets`, `wallet_transactions`,
  `report_imports`, `invite_codes`, `refresh_tokens`.
- JWT = `{ userId, role }`; `requireAdmin` checks `role === 'admin'`.
- SOAP client reads `CP_API_KEY/PASSWORD/STATION_ID` as module constants.
- Global billing indexes: `wallet_transactions_cp_session_unique(chargepoint_session_id)`,
  `report_imports_csv_hash_unique(csv_hash)`, `sessions_single_active(status) WHERE status='active'`,
  `chargepoint_drivers.driver_account_number UNIQUE`.
- Web: token in `localStorage`, `authFetch` wrapper, login gated on `role==='admin'`.
- Mobile: login by email, token+user in SecureStore, one API URL.

## Data model

### `buildings`
```
buildings (
  id UUID PK default gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  cp_station_id TEXT,                    -- plaintext (not secret)
  cp_api_key_enc TEXT,                   -- AES-256-GCM: iv:tag:ciphertext
  cp_api_password_enc TEXT,              -- AES-256-GCM
  plan TEXT NOT NULL DEFAULT 'standard',
  price_cents INTEGER NOT NULL DEFAULT 19900,
  billing_status TEXT NOT NULL DEFAULT 'trial'
      CHECK (billing_status IN ('trial','active','past_due','canceled')),
  -- future Stripe (no code now): stripe_customer_id, stripe_subscription_id
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
```
Default building row: `slug='2020'`.

### `building_id` on tenant tables
`users, sessions, feed_messages, settings, chargepoint_drivers, wallets,
wallet_transactions, report_imports, invite_codes` all get
`building_id UUID REFERENCES buildings(id)`. `refresh_tokens` inherits scope via
its user (no column).

### Unique-index / constraint changes
| Index / constraint | From | To |
|---|---|---|
| `wallet_transactions_cp_session_unique` | `(chargepoint_session_id)` | `(building_id, chargepoint_session_id)` |
| `report_imports_csv_hash_unique` | `(csv_hash)` | `(building_id, csv_hash)` |
| `sessions_single_active` | `(status) WHERE status='active'` | `(building_id) WHERE status='active'` |
| `chargepoint_drivers` | `driver_account_number UNIQUE` | `UNIQUE(building_id, driver_account_number)` |
| `settings` PK | `(key)` | `(building_id, key)` |
| `users.email` | `UNIQUE` | keep global |

## Roles, JWT & middleware

- `users.role` CHECK → `('super_admin','admin','member')`. Existing `'admin'` rows
  stay `'admin'` (building admin). Seed one dedicated `super_admin`.
- JWT → `{ userId, role, buildingId, act? }`; `act = { sub: <superAdminId>, imp: true }`
  for impersonation tokens (RFC 8693 actor style).
- `req.user` → `{ userId, role, buildingId, impersonation?, superAdminId? }`.
- Middleware: `resolveBuilding` (sets `req.buildingId`), `requireSuperAdmin`,
  updated `requireAdmin` (admin **or** super_admin), `requireActiveSubscription`
  (soft — banner data + 402 for past_due/canceled, exempting super_admin).

## Query scoping

Every tenant query filters by `building_id = req.buildingId` (SELECT/UPDATE/DELETE)
or sets it on INSERT. Notable: `feed DELETE` and `users PATCH/DELETE /:id` gain a
building check; `processRows`/`chargeUser`/`matchAppUser`/`resolveByCpUserId`/
`matchSession`/`getRateCents` take `buildingId`; `notifyAdmins(buildingId, …)`
targets only that building's admins.

## Per-building ChargePoint config

- `utils/crypto.ts` — AES-256-GCM with master key env `CP_CRED_KEY` (32 bytes).
  `encryptSecret()/decryptSecret()`. Plaintext creds never logged. Key lives only
  in Railway env.
- SOAP client functions take `CpConfig { username, password, stationId }`.
  `buildingCpConfig(buildingId)` loads + decrypts (env fallback for 2020 during
  transition).
- `ingestYesterdaysSessions()` loops billable buildings with creds; per building
  builds a CP client and calls `processRows(rows, 'auto', …, buildingId, rate)`.
- `chargerWatch` iterates buildings (active session + today-priority resident per
  building).

## Subscription billing (separate from resident wallets)

`buildings.plan / price_cents / billing_status`. Super-admin-only endpoints set
them; no payment processor now (manual invoicing). Soft gating first. Designed so
Stripe columns + a webhook can flip `billing_status` later without model changes.
This fee is what the operator charges the building — it never touches
`wallets`/`wallet_transactions` (residents' electricity money).

## Onboarding (invite-only)

1. Super-admin **Add Building** → creates `buildings` row + a one-time invite
   (`invite_codes` extended with `building_id` + `role='admin'`).
2. Building admin registers via invite → `user.building_id` + `user.role` come from
   the invite (replaces the "first user in empty DB = admin" logic).
3. Building admin sets ChargePoint creds + station id + electricity rate in their
   scoped Settings (creds encrypted on save).
4. Building admin invites residents (`/auth/invite` stamps their `building_id` +
   `role='member'`).

`/auth/bootstrap` is repurposed to seed the first super-admin once. Operator never
touches the database to onboard a building.

## Ghost login / impersonation

- `POST /admin/buildings/:id/impersonate` (`requireSuperAdmin`) → short-lived
  (30 min), **non-refreshable** token with `buildingId=:id`, `role='admin'`,
  `act={ sub: superAdminId, imp:true }`.
- `portal_access_log (id, building_id, super_admin_user_id, started_at,
  expires_at, ip, user_agent, reason)`. Start row on mint; middleware appends
  mutating actions (method+path) made under an `act` token.
- `GET /portal-access-log` (building_admin, scoped to their building) — customer
  can see every operator access.
- Web shows a persistent banner while `act.imp` is present, with countdown + Exit.
- Time-box enforced by token `exp`; no refresh path.

### Privacy + ToS

Add a section to `apps/web/app/privacy/page.tsx`:

> **Support access to building portals.** To provide support, authorized 2020EV
> platform operators may temporarily access a building's administrator portal
> ("view-as"/impersonation). Every such access is time-boxed, shown with a visible
> banner, and recorded in an access log that the building's own administrator can
> review at any time. Operators use this access only to assist the building and
> never to alter residents' financial records without the building's request.

Recommended ToS clause (for the one-page pilot agreement):

> **Operator access & audit.** Customer authorizes 2020EV to access Customer's
> administrator portal solely to provide support and maintain the Service. Such
> access is logged and made available to Customer. 2020EV acts as a data processor
> for resident data, does not sell resident data, and will provide 30 days' notice
> of any change to these terms. Either party may cancel with 30 days' notice.

## Admin UI

- Super-admin: **Buildings** landing (list, status, resident count, MRR),
  **Add Building**, per-building **Manage** / **View as**.
- Building-admin: today's dashboard, scoped via the token's `buildingId` (most
  `authFetch` calls unchanged). New **Portal Access Log** panel.
- Login routes by role: super_admin → Buildings; admin → dashboard; member →
  rejected (web is admin-only).

## Mobile (minimal, phase 1)

One shared API URL; building derived from login. No picker required. Add building
name to the `user` object for display only. Pre-login picker is a later, optional
nicety.

## Migration safety

Inside `runMigrations()`, each step idempotent and deployable alone:
1. `CREATE TABLE buildings`; insert default `'2020'` row (`ON CONFLICT (slug) DO NOTHING`).
2. Add nullable `building_id` to all 9 tables.
3. Backfill each: `UPDATE … SET building_id = (SELECT id FROM buildings WHERE slug='2020') WHERE building_id IS NULL`.
4. Create new composite unique indexes alongside old ones (safe — all rows share
   one building).
5. **After** app writes `building_id` on every INSERT (P2): `SET NOT NULL`, drop
   old global indexes, swap `settings` PK.

## Phase breakdown

Each phase: `cd apps/api && npm run build`, `cd apps/web && npm run build`, bump the
`/health` build tag, `git push` to `main`, `curl …/health` to confirm the tag.

- **P1 — Schema + backfill.** buildings table, default row, nullable building_id +
  backfill, composite indexes, encryption helper + CP-config columns. No behavior change.
- **P2 — Roles + JWT + middleware.** super_admin role, extended JWT,
  resolveBuilding/requireSuperAdmin, invite carries building_id+role, register/login
  set/emit building_id, seed super_admin. Set columns NOT NULL.
- **P3 — Query scoping + isolation tests.** building_id filter on every tenant
  query; scope notifyAdmins; swap unique indexes; settings PK; jest/supertest
  cross-tenant suite.
- **P4 — Per-building CP + ingest/watch loop.** SOAP client per-building creds;
  ingest & chargerWatch per building; 2020 creds into building row (env fallback
  then removed).
- **P5 — Super-admin UI + building CRUD + subscription.** Buildings page, Add
  Building, subscription + soft gating, scoped building-admin dashboard.
- **P6 — Ghost login + disclosure.** impersonation endpoint + token,
  portal_access_log, action logging, banner, customer-visible log, privacy + ToS.
- **P7 — Mobile (minimal).** building name in user object; confirm scoping.
- **P8 — RLS backstop.** per-request `SET LOCAL app.building_id`; RLS policies on
  tenant tables as defense-in-depth. **Delivered as an infra-gated, ready-to-apply
  backstop** (`apps/api/src/db/rls.sql` + [rls-backstop.md](rls-backstop.md)), NOT
  auto-enabled: the app connects to Railway Postgres as the `postgres` superuser,
  and superusers bypass RLS entirely, so activating it requires first switching the
  API to a dedicated non-superuser role. The active isolation guarantee is the
  explicit `building_id` scoping + the passing isolation suite; RLS is the second
  layer to turn on after the role switch.

## Testing (cross-building isolation)

Add a `jest`/`supertest` harness (repo currently has no API tests): seed two
buildings; assert a B1 admin token gets zero B2 rows across `/users`,
`/sessions/*`, `/feed`, `/wallet/*`, `/schedule`, `/settings`; assert the same
`chargepoint_session_id` can exist in both buildings; assert impersonation writes
an audit row and expires.

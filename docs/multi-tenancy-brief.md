# Multi-Tenancy Build Brief (paste into a new session)

Copy everything in the fenced block below into a new Claude Code session started in
the `2020ev` repo. It's written to stand alone.

---

```
You're working in the 2020ev monorepo. Read CLAUDE.md, ROADMAP.md, and
NEW_BUILDING.md first — they describe the app, stack, and current state. Do not
write any code until I approve a plan (see "What I want" below).

## Context

2020EV is a private app for one condo building that shares a single ChargePoint
EV charger: weekday priority scheduling, live charger status, a community feed,
and prepaid wallet billing (electricity auto-billed from ChargePoint session data
at the building's rate). Stack: Express + TypeScript API on Railway (Postgres),
Next.js admin dashboard on Vercel, Expo/React Native iOS app. It is currently
SINGLE-TENANT: one database, one implicit building, two roles ('admin' | 'member').

I'm turning it into a product I can sell to other condo buildings. I need TRUE
MULTI-TENANCY — one system serving many buildings — with:

1. A way to add new buildings in one place.
2. Each customer (a building's manager) gets an admin view scoped to ONLY their
   building's data.
3. A super-admin (me) that can see all buildings AND "ghost-log-in" / view-as any
   customer's portal for support.

## What I want (do this in order)

PHASE 0 — PLAN FIRST. Before editing anything, produce a written architecture +
migration plan and wait for my approval. The plan must cover:

- Data model: a `buildings` table, and `building_id` added to every tenant-scoped
  table (audit the schema — at least: users, sessions, wallets,
  wallet_transactions, chargepoint_drivers, report_imports, feed_messages,
  settings, invite_codes). How every query gets scoped by building_id so no
  building can ever read another's data.
- Roles: `super_admin` (me — all buildings + impersonate), `building_admin`
  (customer manager, scoped to their building), `member` (resident). How this maps
  onto the current `role` column and the JWT (which today carries { userId, role };
  will need building_id + super-admin awareness).
- Per-building ChargePoint config: today the SOAP client uses global env vars
  (CP_STATION_ID, CP_API_KEY, CP_API_PASSWORD). These must become per-building
  (stored per building row, encrypted at rest for the credentials). The daily
  in-process ingest cron and billing pipeline (processRows in
  apps/api/src/routes/wallet.ts) must loop per building.
- Ghost login / impersonation: a super-admin "view as building X" that issues a
  scoped session acting as that building's admin. MUST be audit-logged (who, which
  building, when, what actions), show a persistent "you are impersonating" banner,
  and be time-boxed. Treat it as a sensitive feature over residents' financial
  data — logged and consented, never a silent backdoor.
- Admin UI: a building switcher / building list for super-admin; the existing
  dashboard becomes the building_admin view scoped to one building.
- Mobile app: decide and recommend whether the iOS app stays one-build-per-building
  (via EXPO_PUBLIC_API_URL, already supported) or gains a building/login selector.
  Don't over-scope the mobile change in phase 1.
- Per-building SUBSCRIPTION billing (this is the fee I charge the building, and is
  SEPARATE from the resident electricity wallet — do not conflate them). Design a
  simple model on the buildings table: a plan/price (e.g. $199/mo, $99 founding
  rate) and a billing_status ('active' | 'past_due' | 'trial' | 'canceled') that
  super-admin sets. No payment processor required initially (I invoice manually),
  but design so Stripe or similar could be added later. Optionally gate access when
  past_due.
- Customer-facing signup / onboarding flow: how a new building is created and its
  first building_admin gets in. Super-admin "Add building" provisions the building
  row + generates a one-time admin invite; the building_admin registers via that
  invite, then sets their ChargePoint credentials + station id + electricity rate
  in their own scoped settings. Keep it INVITE-ONLY (no open public signup) for now.
  Recommend the smoothest flow that doesn't require me to touch the database.
- Ghost-login disclosure & customer trust: impersonation touches residents'
  financial data, so it must be (a) disclosed in the customer agreement / terms and
  in the privacy policy, (b) written to an audit log the CUSTOMER can also view
  (a "portal access log" in their admin view), and (c) time-boxed with a visible
  banner. Include updating apps/web/app/privacy/page.tsx and recommend ToS language.
- Migration safety: a step-by-step migration that KEEPS THE EXISTING "2020"
  BUILDING WORKING THE ENTIRE TIME. Specifically: create a default building row,
  backfill building_id on all existing rows to it, make columns NOT NULL only after
  backfill, and roll out in phases that each deploy green. No big-bang cutover.
- A phase breakdown (e.g. schema+backfill → query scoping → roles/JWT → per-building
  CP config + ingest loop → super-admin UI + building CRUD → ghost login → mobile),
  each independently shippable and verifiable.

Then STOP and show me the plan.

PHASE 1+ — after I approve, implement phase by phase. After each phase: build the
API (`cd apps/api && npm run build`) and web (`cd apps/web && npm run build`),
bump the `/health` build tag, deploy via git push to `main` (Railway + Vercel auto-
deploy), and confirm the new build tag is live via
`curl https://2020evapi-production.up.railway.app/health`.

## Important constraints & gotchas (from CLAUDE.md — verify against current code)

- Migrations run in runMigrations() in apps/api/src/index.ts at startup — idempotent
  `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS`. Follow
  that pattern; there is no separate migration tool.
- Billing dedup: wallet_transactions.chargepoint_session_id has a UNIQUE index —
  preserve this; multi-tenancy must not allow session-id collisions across buildings
  to silently drop billing (consider scoping uniqueness per building).
- Daily ingest runs in-process (scheduleDailyIngest) and always-on; the "move your
  car" chargerWatch service polls the active session every 5 min — both must become
  per-building.
- AI layer (services/assistant.ts) is provider-switchable (OpenAI now, Claude via
  AI_PROVIDER=anthropic); keep it working, scope any building-specific data it reads.
- All files must be committed — Railway builds from git. Pushing to
  jackofall613/2020ev requires the active gh account to be jackofall613
  (`gh auth switch --user jackofall613`).
- Deploy/verify: bump the build tag every deploy; the Vercel posttooluse-validate
  hook fires false positives on apps/api (it's Express on Railway, not Vercel
  functions) — ignore it.
- Add tests for cross-building isolation (a building_admin must never see another
  building's users/sessions/wallets/transactions).

Start by reading the code, then give me the Phase 0 plan.
```

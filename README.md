# 2020EV — EV Charger Coordination App

> **Public mirror** of the private development repo (history squashed to one commit) — published for the Devpost submission. Live at [2020ev.app](https://2020ev.app).

Private mobile app for condo residents sharing a Level 2 ChargePoint (CPF50) charger. Coordinates weekday priority scheduling and real-time session tracking.

> **Productization:** see [ROADMAP.md](ROADMAP.md) for the current action items
> (pitching, LLC, App Store) and [NEW_BUILDING.md](NEW_BUILDING.md) for the
> runbook to deploy the stack for a new customer building.

---

## How Codex and GPT-5.6 were used

**Codex** was there before the first commit — it was the pitch partner that got
this project approved in the first place. There was no charger in the building:
the founder bought the hardware and had to win a condo-board vote to install it.
The board had five members with five different vocabularies, and a deck that
spoke only one of them was going to lose. Codex helped build the board pitch
deck and do the homework behind it — what each board member did, what they
cared about — then rebuild one pitch into five dialects (the treasurer got pure
ledger math; the golf lover was told the queue "gives everyone a tee time" and
that camping on the plug is slow play). The vote wasn't close. Codex then stayed
on as a pair-programmer during the build of the stack itself (React Native app,
Node/TypeScript API, Next.js admin portal).

**GPT-5.6** (`gpt-5.6-terra`) powers the product's AI layer in production:

- **Admin billing summary** — one click in the admin portal writes the building's
  billing month in plain English (`POST /wallet/statement/summary`).
- **Resident billing assistant** — `POST /wallet/assistant` answers residents'
  questions ("how much was my last session?") grounded strictly in their own
  wallet ledger; the in-app chat UI for it is next on the roadmap.
- The AI layer ([apps/api/src/services/assistant.ts](apps/api/src/services/assistant.ts))
  is provider-agnostic and env-switchable via `OPENAI_MODEL` — the whole platform
  runs fine with it disabled, and no billing math is ever delegated to a model.

---

## Documentation map — everything, in one place

Engineering / product:
- [CLAUDE.md](CLAUDE.md) — authoritative developer reference (architecture, DB, routes, gotchas).
- [ROADMAP.md](ROADMAP.md) — productization action items, pitch playbook, pricing ($199/mo, $99 founding).
- [docs/multi-tenancy-plan.md](docs/multi-tenancy-plan.md) — **shipped** multi-tenant architecture + phase log.
- [docs/rls-backstop.md](docs/rls-backstop.md) — Postgres row-level-security backstop status.
- [docs/next-session-brief.md](docs/next-session-brief.md) — paste-into-a-new-session prompt for remaining engineering (mobile resident AI chat, waitlist, rebuild).
- [docs/roadmap-v1.1.md](docs/roadmap-v1.1.md) — **next feature release spec** (charger queue "Next Up", queue-aware anti-camping nudges, car profiles + finish ETA). Verbose, execution-ready; grounded in the existing `chargerWatch.ts` / notifications / socket.io.
- [NEW_BUILDING.md](NEW_BUILDING.md) — legacy single-tenant clone runbook (**superseded** by multi-tenancy; kept for history).
- [docs/multi-tenancy-brief.md](docs/multi-tenancy-brief.md) — the original multi-tenancy build prompt (**done/superseded** by the plan above; kept for history).

Sales / go-to-market (each `*-brief.md` is a ready-to-paste prompt for a NEW session):
- [docs/2020EV-one-pager.pdf](docs/2020EV-one-pager.pdf) — the sales one-pager to hand to property managers.
- [docs/market-research-brief.md](docs/market-research-brief.md) — prompt for a **web-enabled** session to size the market (TAM/SAM/SOM) and find real candidate condos in greater Miami.
- [docs/outreach-brief.md](docs/outreach-brief.md) — prompt for a session (with the research report **attached as a file**) to turn that research into a prioritized target list, tailored outreach messages, a CRM tracker, and a 2-week action plan.

GTM workflow: run the **market-research** prompt → save its report → start a new session, attach that report, and run the **outreach** prompt.

---

## Project status & session log — where the last agent left off (2026-07-05)

This section is the handoff note for the next agent/developer. It records what was
done recently, how, and what's still open. Companion docs: [ROADMAP.md](ROADMAP.md)
(action items), [docs/multi-tenancy-plan.md](docs/multi-tenancy-plan.md) (the
**shipped** multi-tenant architecture), [docs/rls-backstop.md](docs/rls-backstop.md)
(RLS backstop status), [docs/next-session-brief.md](docs/next-session-brief.md)
(paste-into-a-new-session prompt for the remaining work), [NEW_BUILDING.md](NEW_BUILDING.md)
(legacy single-tenant clone runbook — now superseded by multi-tenancy),
[docs/2020EV-one-pager.pdf](docs/2020EV-one-pager.pdf) (sales sheet).

**Live state:** API build tag `2026-07-14-v19-v1.1` (verify: `curl https://2020evapi-production.up.railway.app/health`).
The health payload includes an `ai` field (`openai` | `anthropic` | `disabled`).
Everything below is committed and deployed (Railway + Vercel auto-deploy from `main`).

### 0. Multi-tenancy — SHIPPED (2026-07-05)

The app is now **true multi-tenant**: one shared stack (API + DB + admin portal)
serves many buildings, with per-building data isolation, a customer building-admin
view, and a platform super-admin. Delivered in 8 phases, each deployed green with the
original "2020" building intact throughout. Full design + phase log:
[docs/multi-tenancy-plan.md](docs/multi-tenancy-plan.md).

- **Data model** — `buildings` table; `building_id` on every tenant table
  (users, sessions, feed_messages, settings, chargepoint_drivers, wallets,
  wallet_transactions, report_imports, invite_codes), `NOT NULL` except `users`
  (super-admin has none). Composite uniqueness per building, incl. billing dedup
  `(building_id, chargepoint_session_id)`. Migrations 011–014 in `runMigrations()`.
- **Roles + scoping** — JWT carries `{ userId, role, buildingId, act? }`. Roles:
  `super_admin` (all buildings + impersonate), `admin` (building admin),
  `member` (resident). `resolveBuilding` middleware sets a **server-trusted**
  `req.buildingId` (never client-supplied; a super-admin selects via `X-Building-Id`).
  Every tenant query filters by it. Cross-building isolation is covered by a
  jest/supertest suite: [apps/api/src/__tests__/isolation.test.ts](apps/api/src/__tests__/isolation.test.ts)
  (`cd apps/api && DATABASE_URL=<test-db> npm test`).
- **Per-building ChargePoint** — SOAP client takes per-building credentials
  (encrypted at rest, AES-256-GCM, [apps/api/src/utils/crypto.ts](apps/api/src/utils/crypto.ts));
  daily ingest + charger-watch loop over billable buildings. `CP_CRED_KEY` is now
  set in Railway, so new buildings can store encrypted creds; the 2020 building is
  deliberately left on its `CP_API_*` env-var fallback (not migrated — lowest risk).
- **Super-admin UI** — `/buildings` fleet page (list, MRR, **Add building** →
  one-time admin invite, subscription status). Existing `/dashboard` is the scoped
  building-admin view. API: [apps/api/src/routes/admin.ts](apps/api/src/routes/admin.ts),
  [apps/api/src/routes/building.ts](apps/api/src/routes/building.ts).
- **Ghost login** — super-admin "View as" mints a 30-min, non-refreshable token
  (`act` claim); persistent banner + countdown + Exit; every session and mutating
  action is written to `portal_access_log` and shown to the building admin
  (`GET /building/access-log`). Disclosed in [/privacy](apps/web/app/privacy/page.tsx);
  ToS clause in [docs/multi-tenancy-plan.md](docs/multi-tenancy-plan.md).
- **Subscription** — `buildings.plan / price_cents / billing_status`
  (`trial|active|past_due|canceled`), super-admin-set; soft gating (dashboard banner,
  no lockout). No payment processor yet (manual invoicing).
- **Onboarding** — invite-only. Super-admin **Add building** provisions the row +
  admin invite; the building admin registers via the invite, then sets their
  ChargePoint creds + rate. `POST /auth/bootstrap-superadmin` (X-Ingest-Secret)
  seeds the first super-admin.

**Operational (as of this session):**
- Super-admin seeded: `jordan.neustadter@gmail.com` (log in at the admin portal →
  lands on `/buildings`).
- **Backups:** off-site daily `pg_dump` via GitHub Actions is the **primary** backup
  ([.github/workflows/db-backup.yml](.github/workflows/db-backup.yml), 90-day
  artifacts). Each run restores the fresh dump into a throwaway Postgres and asserts
  core tables have data, so an unrestorable dump turns the run red. Railway's
  **native** volume backups + PITR are **Pro-plan only and NOT enabled** (free plan);
  upgrade to Pro if you want in-place/point-in-time restore too. Next backup upgrade
  (no Pro needed): ship the dump to an external bucket (S3 / B2 / R2) for provider
  diversity — needs a bucket + a GitHub secret.

**Shipped later on 2026-07-05 (self-service auth + fleet ops + backup hardening):**
- `POST /auth/change-password` (authenticated; verifies current, `new≥12`, revokes
  all refresh tokens, returns a fresh pair) + a "Change password" modal in both the
  `/buildings` and `/dashboard` headers.
- Guarded `DELETE /admin/buildings/:id` (super-admin; body `confirm_slug` must match;
  `2020` can never be deleted; FK-order cascade in one transaction) + isolation tests
  (16 total, green).
- **Security fix:** refresh-token revocation now actually works. Tokens were stored
  as bcrypt, which truncates at 72 bytes — every refresh JWT for a user shares a
  >72-byte prefix, so rotation / logout-other-devices / change-password invalidation
  all silently no-oped. Now SHA-256 (see CLAUDE.md Gotcha #14). Everyone re-logged-in
  once on deploy.
- `CP_CRED_KEY` **set** and `INGEST_SECRET` **rotated** in Railway.

**App Store launch prep (2026-07-11 → 2026-07-12):** taking the app public as a
single multi-building app (login resolves the building server-side; no picker).
See [docs/app-store-launch.md](docs/app-store-launch.md) — the launch runbook.
- 2026-07-11: hosted `/terms` + `/support` pages (privacy already existed),
  `apps/mobile/store.config.json` (EAS Metadata), removed `GET /debug/drivers`
  (leaked cross-building emails), registration password min 8→12.
- 2026-07-12: `store.config.json` listing **pushed to ASC** (title/subtitle/
  description/keywords/categories/URLs live in the draft). Age-rating block was
  removed after it failed the push — cached eas-cli sends Apple the deprecated
  `gamblingAndContests` attribute; age rating is set manually in ASC (→ 4+).
  App Review Information kept out of git, entered in ASC. Demo building
  "The Palm Residences (Demo)" seeded in prod for App Review;
  App Store screenshots prepped (`~/Downloads/2020ev-appstore-screenshots/`,
  6.9"); **production build #20 started on EAS** (headless — reused stored cert).
  Super-admin password was reset this session (machine-generated original lost).
- **Still Jordan-only** (need interactive Apple login — `eas metadata:push` +
  `eas submit` can't run headless): push the listing, submit the production
  build, fill ASC privacy nutrition labels + App Review Information, set up
  `support@2020ev.app` forwarding, point `2020ev.app` DNS at Vercel. Checklist
  in the runbook. (2026-07-13: metadata pushed ✓, age rating set manually in
  ASC ✓ — submission deliberately held for the feature sprint below; the store
  build is now **#21**, superseding #20.)

**Portal + app feature sprint (2026-07-13, pre-submission):** portal **light
theme** (default; 🌙 toggle in headers — see CLAUDE.md Gotcha #15 before adding
portal UI), **forgot-password** end to end (API + public `/reset` page + links
in portal and app; email dormant until `RESEND_API_KEY` is set), **resident CSV
export** (`GET /wallet/me/export` + Wallet "⬆ Export" in the app, build #21),
**feed posts now push-notify** the building, per-account login throttle, gzip,
dashboard fetch parallelization + hot-path indexes, Report History capped to a
scroller. API tag `2026-07-13-v17-portal-sprint`.

**v1.1 Feature 1 — "Next Up" charger queue (2026-07-14):** the headline feature
from [docs/roadmap-v1.1.md](docs/roadmap-v1.1.md). When the charger's busy,
residents join a live queue; the moment it frees, the front of the line gets a
push — "⚡ Charger's free — held for you until {time}" — with **On my way** /
**Pass** in the app, a 15-minute hold, and automatic advance on pass/expiry.
- **API:** `charger_queue` table (Migration 016; one live entry per user + at
  most one outstanding offer per building, both DB-enforced), `/queue` routes
  (`GET /`, `join`, `leave`, `claim`, `pass`), engine in `chargerWatch.ts`
  (`advanceQueue` — offers on session end, expires + auto-advances on the 5-min
  tick). Session start is blocked for everyone but the hold-holder while a hold
  is live, and the holder plugging in without tapping "On my way" still resolves
  their entry. Queue empty → falls back to the old priority-day ping.
- **Realtime:** sockets now join a per-building room (`building:<id>`, from the
  server-verified JWT); every queue mutation broadcasts `queue:update` there —
  verified cross-building silence with two live socket clients.
- **Mobile (build #22 — rebuild needed):** HomeScreen "Next Up" card (join/leave,
  "You're #N in line", held-for banner, prominent On my way / Pass), live socket
  updates with the 30s poll as fallback, offer push deep-links to Home,
  SessionScreen confirms "the next resident has been notified" after ending.
- Isolation suite extended to 28 tests (queue isolation + full offer-flow +
  expiry auto-advance + delete-cascade).

**v1.1 Features 2+3 — anti-camping + car profiles (2026-07-14, same release):**
- **Queue-aware anti-camping** (extends `chargerWatch.ts`): the "time's up" /
  "car looks done" nudges now say how many neighbors are queued, and a one-shot
  second escalation fires 20 min after the first nudge while the queue is
  non-empty (Migration 017). **Opt-in idle fee, OFF by default** — per-building
  settings `idle_fee_cents_per_15min` (0 = off) + `idle_grace_min`, editable in
  the portal Settings card; bills completed 15-min blocks past grace only while
  neighbors wait AND ChargePoint confirms the car is idle (never bills when CP
  is unreachable; CAS-guarded so races/crashes can only under-bill; transparent
  wallet line item + push).
- **Car profiles + honest finish ETA**: `users.car_make/car_model/battery_kwh/
  target_percent` (Migration 018) via a "Your car" section in the app's Profile
  screen; `GET /chargepoint/load` now returns `{ eta: { car_label,
  estimated_free_at, idle_minutes } }` computed from the live draw
  ([apps/api/src/utils/eta.ts](apps/api/src/utils/eta.ts)); HomeScreen shows
  "{Name}'s {model} — free in ~1h 40m (est.)" and falls back to the user-typed
  estimate when no profile exists. `idle_minutes` surfaces camping to everyone.
- Tests 28 → 36 (idle-fee default-off + isolation + exactly-once accrual,
  escalation flags, car-field validation, ETA units); portal Settings block
  verified live in-browser (light + dark). API tag `2026-07-14-v19-v1.1`.

### 1. Security hardening (done, deployed)
- Constant-time comparison ([apps/api/src/utils/secure.ts](apps/api/src/utils/secure.ts))
  for the `X-Ingest-Secret` checks (ingest, reconcile-drivers, `/debug/drivers`) and
  the Mailgun webhook signature — previously plain `!==` (timing-leak).
- Partial unique index `sessions_single_active` guarantees one active charger
  session (closes a start-session race); the route now returns 409 on the DB conflict.
- Case-insensitive email on login/register/invite; email-less invites now require an
  email at registration (previously created accounts that could never log in).
- Clamp `/sessions/history` limit/offset; validate push-token type/length; expired
  refresh tokens cleaned up on refresh.
- Dependency fixes: high-severity `ws` (via socket.io) and Next.js advisories patched;
  unused `uuid` removed. API + web both at 0 known vulns at time of writing.
- `INGEST_SECRET` had leaked into git history via an old CLAUDE.md line — redacted,
  and now **rotated** in Railway (2026-07-05). The new value lives only in Railway env.

### 2. Productization groundwork (done, deployed)
- `CP_STATION_ID` is now an env var (defaults to the 2020 building's EVSE) so the
  stack can be cloned per building; mobile reads `EXPO_PUBLIC_API_URL` at build time.
- Account deletion: `DELETE /users/me` (scrubs PII/credentials, keeps billing history
  anonymized, blocks sole-admin deletion) + a Delete Account button on the Profile
  screen — required for public App Store.
- Public privacy policy at `/privacy` on the admin site
  ([apps/web/app/privacy/page.tsx](apps/web/app/privacy/page.tsx)).

### 3. Monetization features (built this session, deployed)
- **Monthly statement** — `GET /wallet/statement?month=YYYY-MM`; admin dashboard
  section with CSV export + printable PDF view.
- **"Move your car" reminders** — [apps/api/src/services/chargerWatch.ts](apps/api/src/services/chargerWatch.ts):
  every 5 min checks the active session and pushes on estimated-finish-passed,
  car-appears-done (charger IN_USE but near-zero load), and 6h overstay; session end
  pings today's priority resident that the charger is free.
- **Board insights** — `GET /wallet/insights`; admin dashboard with all-time totals,
  a 6-month CSS bar chart, and top residents.
- **AI layer** — [apps/api/src/services/assistant.ts](apps/api/src/services/assistant.ts):
  `POST /wallet/assistant` (resident asks plain-English billing questions, answered
  from their own transaction data) and `POST /wallet/statement/summary` (admin
  board summary; "✨ AI summary" button on the dashboard). **Provider-switchable:**
  runs on OpenAI (`OPENAI_API_KEY`, model via `OPENAI_MODEL`, default `gpt-4o-mini`)
  or Claude (`ANTHROPIC_API_KEY`, `claude-opus-4-8`). Prefers OpenAI when its key is
  set; force with `AI_PROVIDER=openai|anthropic`. Dormant (503) until a key is set.
  **Currently live on OpenAI.**

### 4. Not started / pending
- **Resident AI chat UI** — the `/wallet/assistant` endpoint is live, but the mobile
  chat box on the wallet screen isn't built. Needs a mobile change + TestFlight rebuild.
- **Waitlist / reservations** — not started; resident-facing, needs mobile screens.
- **Mobile rebuild pending** — Delete Account, `EXPO_PUBLIC_API_URL`, and the above
  reach phones only after `eas build --profile preview --platform ios` + submit.
- **Multi-tenancy** — ✅ SHIPPED (see §0 above). The `docs/multi-tenancy-brief.md`
  plan is now historical.
- **RLS backstop** — deferred, infra-gated: the API connects as the `postgres`
  superuser (bypasses RLS), so activating it requires first switching to a dedicated
  non-superuser DB role. Ready-to-apply SQL + steps in [docs/rls-backstop.md](docs/rls-backstop.md).
- **External off-site backup** — optional next backup upgrade (no Pro): push the
  daily dump to S3 / B2 / R2 for provider diversity (needs a bucket + GitHub secret).
- **Railway native backups / PITR** — needs the Pro plan (~$20/mo); off-site dump
  covers the free plan today.

## Architecture Overview

```
iPhone App (TestFlight)
      ↕
Railway API  ←→  PostgreSQL Database
      ↕
Admin Portal (Vercel)
```

| Piece | What it is | Where it lives |
|-------|-----------|----------------|
| **Mobile app** | React Native + Expo, iOS only | TestFlight (distributed via Apple) |
| **API** | Node.js + Express + TypeScript | Railway — always on |
| **Database** | PostgreSQL | Railway — always on |
| **Admin portal** | Next.js web dashboard | Vercel — always on |

**Live URLs:**
- API: `https://2020evapi-production.up.railway.app`
- Admin portal: `https://2020ev-admin.vercel.app`

---

## Stack

- **Mobile**: React Native + Expo SDK 54 (iOS-first)
- **API**: Node.js + TypeScript + Express + PostgreSQL
- **Admin**: Next.js + Tailwind CSS
- **Infra**: Railway (API + DB), Vercel (admin portal), EAS Build (TestFlight)

---

## Prerequisites

- Node.js **20** (required — Node 25 breaks `npx expo config`)
- Docker Desktop (local dev only)
- Expo Go app on your iPhone (local dev only)
- Apple Developer account ($99/yr) — for TestFlight builds

---

## Local Development

### 1. Clone & install

```bash
git clone https://github.com/jackofall613/2020ev-app.git
cd 2020ev-app
npm install
```

### 2. Start the API + Database

```bash
cd apps/api
cp .env.example .env   # fill in JWT_SECRET (any random string)
cd ../..
docker-compose up -d
```

The API runs at `http://localhost:3000`.

### 3. Bootstrap the first admin user

Only works on an empty database:

```bash
curl -X POST http://localhost:3000/auth/bootstrap
```

Save the `invite_token` from the response.

### 4. Register the admin account

```bash
curl -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"token":"<invite_token>","name":"Your Name","email":"you@example.com","password":"yourpassword"}'
```

### 5. Run the mobile app

Find your Mac's LAN IP:

```bash
ipconfig getifaddr en0
```

Update `apps/mobile/src/constants/api.ts` — set `API_URL` to `http://<your-lan-ip>:3000`. Then:

```bash
cd apps/mobile
npx expo start
```

Scan the QR code with **Expo Go** on your iPhone. Both devices must be on the same Wi-Fi network.

---

## Production Deployments

### API (Railway)

Railway auto-deploys when you push to `main`. To manually deploy:

```bash
cd apps/api
railway up
```

### Admin Portal (Vercel)

Vercel auto-deploys when you push to `main`. No manual steps needed.

To run locally:

```bash
cd apps/web
npm run dev   # http://localhost:3001
```

---

## Inviting New Residents

To onboard a new condo owner you need to do **both** steps:

1. **TestFlight** — Add their Apple ID email at [App Store Connect](https://appstoreconnect.apple.com) → TestFlight → Internal Testers. They get an email from Apple and install the app via the TestFlight app.

2. **App account** — Log into the admin portal → Invite User → enter their email → send them the generated invite link. They tap the link, the app opens, and they set a password.

---

## TestFlight Builds

TestFlight builds expire every **90 days**. A GitHub Actions workflow auto-rebuilds and resubmits every 89 days (Jan 1, Apr 1, Jul 1, Oct 1). You can also trigger it manually at:

**https://github.com/jackofall613/2020ev/actions/workflows/testflight-rebuild.yml**

### Manual build

```bash
export PATH="/opt/homebrew/opt/node@20/bin:$PATH"
cd apps/mobile
~/.npm-global/bin/eas build --platform ios --profile preview
```

### Manual submit

```bash
~/.npm-global/bin/eas submit --platform ios --latest
```

### Required GitHub secret

`EXPO_TOKEN` — generate at https://expo.dev/accounts/jordan_banjo/settings/access-tokens

---

## Project Structure

```
2020ev/
├── .github/
│   └── workflows/
│       ├── testflight-rebuild.yml   # Auto-rebuild every 89 days
│       └── db-backup.yml            # Daily off-site pg_dump → artifact
├── apps/
│   ├── api/                         # Express REST API
│   │   ├── src/
│   │   │   ├── routes/              # auth, sessions, feed, schedule, users,
│   │   │   │                        #   wallet, chargepoint, admin, building
│   │   │   ├── services/            # chargepoint (SOAP), ingest, chargerWatch,
│   │   │   │                        #   notifications, assistant (AI)
│   │   │   ├── db/                  # PostgreSQL client + rls.sql (gated backstop)
│   │   │   ├── middleware/          # JWT auth + resolveBuilding (tenant scope)
│   │   │   ├── utils/               # jwt, crypto (AES-256-GCM), secure, invite
│   │   │   └── __tests__/           # cross-building isolation suite (jest)
│   │   └── Dockerfile
│   ├── mobile/                      # Expo React Native app
│   │   └── src/                     # screens, components, contexts, constants
│   └── web/                         # Next.js admin dashboard
│       └── app/
│           ├── login/               # role-routed login
│           ├── buildings/           # super-admin fleet page
│           ├── dashboard/           # building-admin dashboard (scoped)
│           └── privacy/             # public privacy policy
├── docs/                            # multi-tenancy-plan, rls-backstop, briefs
├── docker-compose.yml
└── package.json
```

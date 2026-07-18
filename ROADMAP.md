# 2020EV — Productization Roadmap

> Living checklist for turning 2020EV from "my building's app" into a product for
> other buildings. Written 2026-07-04 after the security audit + productization
> groundwork shipped (see git log around `8c127e1`). Pick this up from the top —
> items are ordered.
>
> Companion doc: [NEW_BUILDING.md](NEW_BUILDING.md) — the technical runbook for
> onboarding a customer building.

## Status snapshot (2026-07-05)

- ✅ Security audit done, all fixes deployed (0 known vulns)
- ✅ Per-building config shipped: `CP_STATION_ID` env var (API), `EXPO_PUBLIC_API_URL` (mobile)
- ✅ Account deletion (`DELETE /users/me` + Profile screen button) — App Store requirement met
- ✅ Privacy policy live at https://2020ev-admin.vercel.app/privacy
- ✅ Sales one-pager at [docs/2020EV-one-pager.pdf](docs/2020EV-one-pager.pdf)

### Monetization features (built 2026-07-05, API build `2026-07-05-v4`)
- ✅ **Monthly statement** — `GET /wallet/statement`; admin dashboard section with CSV + print/PDF
- ✅ **"Move your car" reminders** — `chargerWatch` service: estimated-finish, car-appears-done (idle load), 6h overstay; + charger-free ping to today's priority resident
- ✅ **Board insights** — `GET /wallet/insights`; admin dashboard with 6-month chart + top residents
- ✅ **AI layer** — `POST /wallet/assistant` (resident billing Q&A) + `POST /wallet/statement/summary` (admin board summary); admin "✨ AI summary" button live. **Dormant until `ANTHROPIC_API_KEY` is set in Railway** (returns 503 without it).

### Still to do
- ⬜ **Activate AI:** set `OPENAI_API_KEY` in Railway to run the AI features on OpenAI now (burns your Codex/OpenAI credits). Later, switch to Claude by setting `AI_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` (or just removing `OPENAI_API_KEY`) — no redeploy. With both keys set it prefers OpenAI. Confirm the active provider anytime via `GET /health` → `ai` field. Both AI endpoints return 503 until a key is set.
- ⬜ **Waitlist / reservations (#4)** — not started; resident-facing, needs mobile screens + rebuild.
- ⬜ **Resident AI chat UI** — the `/wallet/assistant` endpoint is live; the mobile chat UI on WalletScreen is not built yet (needs mobile + rebuild).
- ⬜ **Mobile rebuild** — Delete Account button, `EXPO_PUBLIC_API_URL`, and (when built) the resident AI chat + waitlist all reach phones only after `eas build --profile preview --platform ios` + TestFlight submit.

---

## 1. Rotate `INGEST_SECRET` — 10 minutes, overdue ⚠️

The old value leaked into git history via CLAUDE.md. Generate a new one
(`openssl rand -hex 24`) and replace it in the Railway API service's variables.
Nothing external depends on it (billing cron is in-process), so this can't break
anything.

## 2. Pitch buildings — START HERE, it's the long pole

**Target profile:** buildings that already have a shared ChargePoint charger and
a cost-recovery/fairness headache. Skip buildings with no charger (you'd be
selling hardware installation, a different business) and buildings with per-plug
paid charging already working.

**Channel, in order of warmth:**
1. Your own building's property management company — they likely manage several
   buildings; one warm intro beats ten cold calls. Ask your building manager who
   handles their other properties.
2. Neighboring buildings' HOA board members (door knock / building manager).
3. Local property-manager associations or condo-board Facebook/Nextdoor groups.

**Outreach template (adapt, keep it this short):**
> Subject: How [my building] handles our shared EV charger
>
> Hi [name] — I live at [building] where ~10 residents share one Level 2
> charger. We had constant fights over charger time and the building was eating
> the electricity cost. I built an app that handles scheduling, tracks every
> session automatically from the charger itself, and bills each resident's
> prepaid balance at the actual electricity rate. It's been running for months
> with zero disputes. If [their building] has a shared charger, I'd love to show
> you a 10-minute demo of it running live. — Jordan

**Demo script (10 min, use the real app):**
1. Home screen — live charger status, who's charging right now
2. Schedule — priority weekdays, first-come weekends
3. The killer slide: admin portal → billing activity — every session auto-billed
   from ChargePoint data, per-resident balances, zero manual math
4. Wallet screen — what a resident sees
5. Close: "Setup is about a week, mostly waiting on ChargePoint credentials.
   $X/month, cancel anytime, your data is yours."

**Pricing — comps + recommendation (researched 2026-07-04):**
- Software-only network platforms (AmpUp, ChargeLab, etc.): ~$10–50 per *port*
  per month, and most *also* take a per-kWh markup, transaction fees, or a
  driver-side fee on top.
- Full-service players (EverCharge, Chargie): bundle hardware + install, opaque
  pricing, usually take a cut of charging revenue.
- **2020EV's edge:** flat monthly fee per building, no per-kWh markup, no
  transaction fees, no hardware. Cleaner and cheaper than stitching together a
  network subscription + fees, and does more (scheduling, wallets, feed).
- **Chosen pricing:** **$199/building/month flat**, with a **$99/month founding
  rate** for the first few reference buildings. (~$10/unit/mo at 20 units — still
  trivial per resident, and undercuts network subscription + transaction fees.)
- The one-pager shows $199 with the $99 founding rate stated; no per-kWh markup,
  no transaction fees, no hardware, cancel anytime.

**The moment a building says yes:** their ChargePoint account owner must request
**Web Services API v5.1 credentials** from ChargePoint support — takes days to
weeks, so trigger it immediately. Then follow [NEW_BUILDING.md](NEW_BUILDING.md).

## 3. LLC + terms of service — before the first invoice

- File an LLC at https://dos.fl.gov/sunbiz/ (~$125, can be your own registered agent)
- Free EIN at irs.gov (10 minutes, instant)
- Business checking account (keeps liability shield intact — don't skip)
- First pilots: a signed one-page agreement beats a click-through ToS. Cover:
  what the service does, monthly price, billing is calculated from ChargePoint
  data at the building's set rate, no liability for charger hardware, either
  party can cancel with 30 days notice.
- Lawyer review (~1 hr) before building #3, not before building #1.

## 4. App Store submission — when you know the shape of the business

Prereqs already shipped (account deletion, privacy policy). Remaining:
- Rebuild + submit: `eas build --profile preview --platform ios`, then
  `eas submit --platform ios --latest`
- App Store Connect: privacy policy URL (https://2020ev-admin.vercel.app/privacy),
  App Privacy labels (name, email, usage data — matches the policy), support URL,
  and a demo account for the reviewer (create a throwaway resident via invite)
- Decide listing type: **Unlisted Distribution** (link-only, request during
  submission) if it's a handful of buildings; public listing if it's a real product
- One app serving multiple buildings needs a building-picker at login (resolve
  building code → API URL) — that's part of the multi-tenant milestone below;
  until then it's one TestFlight/unlisted build per building

## 5. Multi-tenant rewrite — ✅ SHIPPED (2026-07-05)

Built and deployed as a single shared stack serving many buildings. See
[docs/multi-tenancy-plan.md](docs/multi-tenancy-plan.md) for the full architecture.
Delivered: `buildings` table + `building_id` scoping on every tenant table and
query (isolation suite in `apps/api/src/__tests__/isolation.test.ts`); roles
`super_admin` / `admin` (building) / `member` with `building_id` in the JWT;
per-building ChargePoint credentials encrypted at rest (AES-256-GCM) with a
per-building daily-ingest + charger-watch loop; per-building billing dedup
`(building_id, chargepoint_session_id)`; super-admin **Buildings** UI (fleet list,
Add Building + one-time admin invite, subscription plan/status); ghost-login
("view as") with a time-boxed token, audit log, customer-visible portal access log,
and a privacy-policy disclosure.

**Pending external actions (owner):**
- **Seed your super-admin:** `POST /auth/bootstrap-superadmin` with `X-Ingest-Secret`
  (body `{email, password}`) — then log into the admin portal to manage the fleet.
- **Set `CP_CRED_KEY`** (Railway API env, `openssl rand -hex 32`) before any building
  stores its own encrypted ChargePoint credentials. The 2020 building keeps working
  via the existing `CP_API_*` env fallback until then.
- **RLS backstop** is infra-gated — see [docs/rls-backstop.md](docs/rls-backstop.md)
  (needs a non-superuser DB role first).
- Still recommended: automated Postgres backups + uptime alerting (Railway settings);
  a mobile building-picker is NOT needed (login resolves the building server-side).

---

*Maintenance note: keep this file updated as items complete — it's the source of
truth for "what's next" on productization.*

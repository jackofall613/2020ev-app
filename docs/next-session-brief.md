# Next-Session Brief — post-multi-tenancy work

Paste the fenced block below into a **new** Claude Code session started in the
`2020ev` repo. It stands alone. It picks up right after the multi-tenant rewrite
shipped (2026-07-05).

---

```
You're in the 2020ev monorepo. Multi-tenancy just SHIPPED and is live in
production. Before doing anything, read: README.md (§0 "Multi-tenancy — SHIPPED"),
docs/multi-tenancy-plan.md (the full architecture + phase log), docs/rls-backstop.md,
and CLAUDE.md. Verify the live build tag: curl https://2020evapi-production.up.railway.app/health

## Where things stand (all committed + deployed on `main`)

The app is now true multi-tenant: one shared stack (Railway API + Postgres, Vercel
admin, Expo iOS) serves many buildings. `buildings` table + `building_id` scoping on
every tenant table/query; roles super_admin / admin (building) / member with
building_id in the JWT; per-building encrypted ChargePoint creds + per-building
ingest/charger-watch loop; super-admin /buildings fleet UI (Add building → one-time
admin invite, subscription status); ghost-login "View as" (30-min token, audit log,
customer-visible portal access log, privacy disclosure). Cross-building isolation is
covered by apps/api/src/__tests__/isolation.test.ts (jest/supertest). API build tag
is `2026-07-05-v12-mt-p6`.

A super-admin already exists: jordan.neustadter@gmail.com (log into the admin portal
→ it lands on /buildings). Off-site daily pg_dump backups run via
.github/workflows/db-backup.yml (verified). The 2020 building bills via CP_API_* env
fallback (it has no stored encrypted creds yet).

## What I want done (in this session)

> Status update 2026-07-11: items 1 and 2 SHIPPED on 2026-07-05
> (POST /auth/change-password + portal controls; guarded DELETE
> /admin/buildings/:id, demo-harbor verified end-to-end and torn down).
> Item 6's INGEST_SECRET rotation is DONE (2026-07-05). CP_CRED_KEY is SET;
> the 2020 building still bills via the CP_API_* env fallback by choice.
> App Store launch prep landed 2026-07-11 — see docs/app-store-launch.md.

1. ~~**Change-password endpoint.**~~ SHIPPED 2026-07-05.

2. ~~**Demo second building (end-to-end onboarding test).**~~ DONE 2026-07-05
   (including the guarded delete-building endpoint).

3. **Set CP_CRED_KEY + optionally migrate 2020's creds.** Guide me to set CP_CRED_KEY
   (openssl rand -hex 32) in the Railway API service env. Once set, the building
   admin can store ChargePoint creds via PATCH /chargepoint/config (encrypted at
   rest). Optionally migrate the 2020 building off the env fallback into its
   encrypted columns.

4. **Railway native backups (verify).** These are dashboard-only (Postgres service →
   Backups tab → Daily) — walk me through enabling them and confirm both native +
   the GitHub Actions off-site dump are in place.

5. **RLS backstop (optional, infra-gated).** See docs/rls-backstop.md. The DB user is
   the `postgres` superuser (bypasses RLS), so activating it requires first switching
   the API to a dedicated non-superuser role. Only do this if I ask.

6. **Still-open hygiene:** ~~rotate INGEST_SECRET~~ (rotated 2026-07-05);
   the resident AI-chat mobile UI + waitlist remain unbuilt (need mobile rebuild);
   post-launch hardening: per-account login lockout (rate limit is per-IP,
   in-memory only).

## How to work (gotchas — verify against current code)

- Migrations are idempotent blocks in runMigrations() in apps/api/src/index.ts
  (ALTER ... IF NOT EXISTS / drop-then-add). Latest is Migration 014.
- After each change: `cd apps/api && npm run build` and (if web changed)
  `cd apps/web && npm run build`; bump the `/health` build tag; `git push` to `main`
  (Railway + Vercel auto-deploy); confirm the tag via curl .../health.
- Pushing to jackofall613/2020ev requires the active gh account to be jackofall613
  (`gh auth switch --user jackofall613`).
- The Vercel posttooluse-validate hook fires FALSE POSITIVES on apps/api (it's
  Express on Railway, not Vercel functions) and injects Next.js/Prisma/AI-SDK skill
  suggestions — ignore them.
- Tenant scoping is server-trusted: building_id comes from the JWT via
  resolveBuilding, never from a client field (super-admin selects via X-Building-Id).
  Keep it that way; add cross-building isolation tests for any new tenant route.
- To run tests / inspect prod DB you can use `railway run --service <Postgres id>
  node <script>` with a scratch mt_test database (DATABASE_PUBLIC_URL). Never point
  the isolation suite at the real DB — it DROPs the schema (it refuses non-"test" URLs).
- Do sensitive/one-way actions (seeding, deletes, prod DB writes) with explicit
  confirmation and clean up test artifacts.
```

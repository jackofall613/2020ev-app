# RLS backstop (P8) — status & activation path

> Defense-in-depth for multi-tenancy. **Deferred, not inert-shipped**, for a
> concrete reason found during implementation. Ready-to-apply SQL lives in
> [apps/api/src/db/rls.sql](../apps/api/src/db/rls.sql).

## The finding

The API connects to Railway Postgres as `postgres`, which is a **superuser**
(`is_superuser = on`), and the tables are owned by `postgres`. **Postgres
superusers bypass Row-Level Security entirely** — even `FORCE ROW LEVEL SECURITY`
does not apply to a superuser. So enabling RLS while the app connects as
`postgres` would:

- provide **zero** actual protection,
- be **unverifiable** (the superuser connection can't observe the policy), and
- create a false sense of security.

Enabling it inertly would be worse than not shipping it. So P8 is delivered as a
**ready-to-apply, infra-gated backstop** rather than an active migration.

## What actually guarantees isolation today (the primary control)

RLS was always the *second* layer. The active guarantee is:

1. **Explicit `building_id = $n` scoping on every tenant query**, sourced from the
   JWT via `resolveBuilding` (never client-supplied). A null building matches zero
   rows (fail-safe).
2. **The supertest isolation suite** (`apps/api/src/__tests__/isolation.test.ts`,
   12 tests) — proves a building-A admin can't read/mutate building-B data through
   the real routers + middleware. Ran green against a throwaway Postgres.
3. **Composite unique indexes** `(building_id, chargepoint_session_id)` etc., and a
   rolled-back production probe confirming cross-building data is invisible and
   billing dedup is per-building.

## Activating RLS (when you want the second layer)

Three steps, in order (details + SQL in `rls.sql`):

1. **Create a non-superuser app role** `app_rw` (LOGIN, table DML grants, default
   privileges) and repoint the API's `DATABASE_URL` at it instead of `postgres`.
   This is the unlock — `app_rw` is subject to RLS.
2. **Apply the policies** in `rls.sql` (ENABLE + FORCE RLS + a fail-open
   `tenant_isolation` policy keyed to the `app.building_id` GUC). Fail-open when
   the GUC is unset keeps admin/maintenance and super-admin (all-building) paths
   working; it restricts only when a request has bound a building.
3. **Bind `app.building_id` per request.** Wire an `AsyncLocalStorage`-scoped
   pooled client: on a tenant request, check out a client, `set_config(
   'app.building_id', req.buildingId, true)` inside a transaction, store it in ALS
   for the request, and have `db.query()` prefer that client (falling back to the
   pool when absent). Gate the rollout behind an `ENABLE_RLS` env flag and verify
   with the existing isolation suite (which exercises the real routers) before
   turning it on in production.

## Risk notes

- Step 3 touches the DB hot path of a **live billing system**; a connection-release
  bug can exhaust the pool. Do it behind the flag, verify with the isolation
  suite + a scratch DB, and roll out during a low-traffic window.
- Keep the explicit filters even after RLS is on — RLS is the backstop, not a
  replacement.

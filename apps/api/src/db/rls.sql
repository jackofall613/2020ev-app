-- ============================================================================
-- Row-Level Security backstop (defense-in-depth) — NOT auto-applied.
-- ============================================================================
-- This is the P8 multi-tenancy backstop. It is intentionally NOT run by
-- runMigrations(), because it only becomes effective after an infra change.
--
-- WHY IT IS GATED:
--   The app currently connects to Postgres as `postgres` (is_superuser = on).
--   Superusers BYPASS RLS entirely — even with FORCE ROW LEVEL SECURITY — so
--   applying these policies while connected as `postgres` would provide ZERO
--   protection and would be misleading. RLS only helps once the app connects as
--   a NON-superuser, non-table-owner role.
--
-- The ACTIVE cross-tenant guarantee today is the explicit `building_id = $n`
-- scoping on every query (enforced in code) + the supertest isolation suite
-- (apps/api/src/__tests__/isolation.test.ts) + the composite unique indexes.
-- RLS is a second layer that catches a *forgotten* filter — see docs/rls-backstop.md.
--
-- ----------------------------------------------------------------------------
-- STEP 1 — create a dedicated non-superuser application role (run as postgres):
-- ----------------------------------------------------------------------------
--   CREATE ROLE app_rw LOGIN PASSWORD '<generate-a-strong-password>';
--   GRANT CONNECT ON DATABASE railway TO app_rw;
--   GRANT USAGE ON SCHEMA public TO app_rw;
--   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rw;
--   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_rw;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_rw;
-- Then point the API's DATABASE_URL at app_rw (NOT postgres). app_rw is not a
-- table owner and not a superuser, so it IS subject to the policies below.
--
-- ----------------------------------------------------------------------------
-- STEP 2 — enable RLS + policies (safe: policies are fail-OPEN when the
-- app.building_id GUC is unset, so unscoped/admin maintenance still works; they
-- restrict only when the request has bound a building). Super-admin requests set
-- no GUC and therefore see all buildings, as intended.
-- ----------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sessions','feed_messages','settings','chargepoint_drivers',
                           'wallets','wallet_transactions','report_imports','invite_codes','users']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING (
          nullif(current_setting('app.building_id', true), '') IS NULL
          OR building_id::text = current_setting('app.building_id', true)
        )
        WITH CHECK (
          nullif(current_setting('app.building_id', true), '') IS NULL
          OR building_id::text = current_setting('app.building_id', true)
        )
    $f$, t);
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- STEP 3 — bind app.building_id per request (application code). Each tenant
-- request must run its queries on a connection that has:
--     SELECT set_config('app.building_id', '<building uuid>', true);   -- txn-local
-- set from req.buildingId (see resolveBuilding). The cleanest wiring is an
-- AsyncLocalStorage-scoped pooled client whose GUC is set on checkout and reset
-- on release; the db.query() helper prefers that client when present, else falls
-- back to the pool (GUC unset -> fail-open). Gate rollout behind an ENABLE_RLS
-- env flag. See docs/rls-backstop.md for the full pattern.

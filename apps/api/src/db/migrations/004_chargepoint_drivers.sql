-- Phase 4: ChargePoint Driver Mapping & Report Ingestion

-- Maps ChargePoint driver identifiers to app users.
-- Rows are created automatically when a new driver appears in a report.
-- user_id is null (status='pending') until admin maps them to an app user.
CREATE TABLE IF NOT EXISTS chargepoint_drivers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_account_number TEXT UNIQUE NOT NULL,  -- e.g. DNACLBDA20663E78C51 (RFID credential)
  chargepoint_user_id TEXT,                    -- e.g. 74269661 (numeric CP user ID)
  driver_name TEXT NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'mapped')),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Allow deduplication of charges by ChargePoint session (Plug In Event ID)
ALTER TABLE wallet_transactions
  ADD COLUMN IF NOT EXISTS chargepoint_session_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS wallet_transactions_cp_session_unique
  ON wallet_transactions(chargepoint_session_id)
  WHERE chargepoint_session_id IS NOT NULL;

-- Track which CSV was imported and whether it had unknown drivers
ALTER TABLE report_imports
  ADD COLUMN IF NOT EXISTS csv_hash TEXT,
  ADD COLUMN IF NOT EXISTS rows_unmatched INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unknown_drivers TEXT[];

CREATE UNIQUE INDEX IF NOT EXISTS report_imports_csv_hash_unique
  ON report_imports(csv_hash)
  WHERE csv_hash IS NOT NULL;

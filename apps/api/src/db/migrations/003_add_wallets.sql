-- Phase 3: Wallet & Billing System

CREATE TABLE IF NOT EXISTS wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  balance_cents INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id)
);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  type VARCHAR(20) NOT NULL CHECK (type IN ('credit', 'charge')),
  description TEXT NOT NULL,
  session_id UUID REFERENCES sessions(id),
  kwh NUMERIC(8,3),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS report_imports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source VARCHAR(50) NOT NULL DEFAULT 'email',
  filename TEXT,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rows_total INTEGER NOT NULL DEFAULT 0,
  rows_matched INTEGER NOT NULL DEFAULT 0,
  total_deducted_cents INTEGER NOT NULL DEFAULT 0,
  raw_csv TEXT,
  notes TEXT
);

-- Create wallets for all existing users
INSERT INTO wallets (user_id, balance_cents)
SELECT id, 0 FROM users
ON CONFLICT (user_id) DO NOTHING;

-- Seed electricity rate (18 cents = $0.18/kWh)
INSERT INTO settings (key, value) VALUES ('electricity_rate_cents_per_kwh', '18'::jsonb)
ON CONFLICT (key) DO NOTHING;

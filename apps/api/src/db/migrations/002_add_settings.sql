CREATE TABLE IF NOT EXISTS settings (
  key VARCHAR(100) PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed default rules if not already present
INSERT INTO settings (key, value)
VALUES ('rules', '[
  {"icon": "⏱", "text": "Soft target: 2–4 hours"},
  {"icon": "🔴", "text": "Hard cap: 6 hours max"},
  {"icon": "📋", "text": "Announce in feed when plugging in"},
  {"icon": "🚗", "text": "Move car promptly when done"}
]'::jsonb)
ON CONFLICT (key) DO NOTHING;

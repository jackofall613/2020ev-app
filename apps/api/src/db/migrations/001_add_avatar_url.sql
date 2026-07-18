-- Migration: add avatar_url to users table
-- Run this once on the production Railway database:
--   psql $DATABASE_URL -f apps/api/src/db/migrations/001_add_avatar_url.sql

ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;

-- Up Migration
-- ============================================================
-- 004 — Hardening: optimistic locking, refresh tokens,
-- webhook retry tracking. Run after migration-003-users.sql
-- ============================================================

-- Optimistic locking: concurrent edits are detected, not silently overwritten
ALTER TABLE products ADD COLUMN version int NOT NULL DEFAULT 1;

-- Refresh tokens: short-lived access tokens + revocable long-lived refresh.
-- Only the SHA-256 hash is stored; the raw token never touches the database.
CREATE TABLE refresh_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX idx_refresh_user ON refresh_tokens(user_id);

-- Webhook deliveries now record retry attempts
ALTER TABLE webhook_deliveries ADD COLUMN attempt int NOT NULL DEFAULT 1;

-- Better full-text search: language stemming for name/description
-- ("hazy beers" now matches "hazy beer"); SKUs stay exact-match.
ALTER TABLE products DROP COLUMN search;
ALTER TABLE products ADD COLUMN search tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('english', coalesce(name,'')), 'A') ||
  setweight(to_tsvector('simple',  coalesce(sku,'')),  'A') ||
  setweight(to_tsvector('english', coalesce(description,'')), 'B')
) STORED;
CREATE INDEX idx_products_search2 ON products USING gin (search);

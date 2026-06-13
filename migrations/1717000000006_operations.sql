-- Up Migration
-- ============================================================
-- 006 — Operations: soft deletes, idempotency keys, auth audit,
-- TOTP 2FA, password reset, persistent rate limiting, job status.
-- Run after migration-005-pimcore-parity.sql
-- (pg-boss creates its own 'pgboss' schema automatically)
-- ============================================================

-- Soft deletes: catalog data is never hard-deleted via the API
ALTER TABLE products ADD COLUMN deleted_at timestamptz;
CREATE INDEX idx_products_deleted ON products(deleted_at) WHERE deleted_at IS NOT NULL;

-- Idempotency keys: retried POSTs replay the stored response
CREATE TABLE idempotency_keys (
  key         text PRIMARY KEY,            -- userId:path:client-key
  status_code int NOT NULL,
  response    jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Persistent login rate limiting (multi-instance safe, survives restarts)
CREATE TABLE login_attempts (
  rate_key     text NOT NULL,              -- ip:email
  attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_login_attempts ON login_attempts(rate_key, attempted_at);

-- Auth audit log
CREATE TABLE auth_audit (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    uuid,
  email      text,
  event      text NOT NULL,   -- login_success, login_failure, login_rate_limited,
                              -- totp_required, totp_failure, logout, logout_all,
                              -- password_reset_requested, password_reset_completed,
                              -- totp_enabled, user_created, user_deactivated,
                              -- user_reactivated, roles_changed, scopes_changed
  ip         text,
  detail     jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_auth_audit_user ON auth_audit(user_id, created_at);

-- TOTP 2FA
ALTER TABLE users ADD COLUMN totp_secret text;          -- base32; set during setup
ALTER TABLE users ADD COLUMN totp_enabled boolean NOT NULL DEFAULT false;

-- Password reset (token hash only; 1h TTL; single use)
CREATE TABLE password_resets (
  token_hash text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);

-- Async import jobs get a lifecycle
ALTER TABLE import_jobs ADD COLUMN status text NOT NULL DEFAULT 'completed';
-- status: pending | running | completed | failed

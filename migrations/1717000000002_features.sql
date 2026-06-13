-- Up Migration
-- ============================================================
-- 002 — Feature expansion: workflows, scheduling, sharing,
-- webhooks, review comments. Run after schema.sql.
-- ============================================================

-- Seasonal / limited editions: publish windows
ALTER TABLE products
  ADD COLUMN publish_from  timestamptz,
  ADD COLUMN publish_until timestamptz;

-- Approval workflow: review threads on products
CREATE TABLE review_comments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  author      text NOT NULL,
  body        text NOT NULL,
  decision    text CHECK (decision IN ('approve', 'request_changes')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_review_product ON review_comments(product_id);

-- Webhooks: notify downstream systems (ERP, e-commerce) on changes
CREATE TABLE webhooks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url         text NOT NULL,
  events      text[] NOT NULL DEFAULT '{product.updated,product.published}',
  secret      text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  webhook_id  uuid NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event       text NOT NULL,
  payload     jsonb NOT NULL,
  status_code int,
  delivered_at timestamptz NOT NULL DEFAULT now()
);

-- Public asset portal: shareable, expiring links for distributors
CREATE TABLE share_links (
  token       text PRIMARY KEY,                 -- random url-safe token
  product_id  uuid REFERENCES products(id) ON DELETE CASCADE,
  brand_id    uuid REFERENCES brands(id)   ON DELETE CASCADE,
  expires_at  timestamptz,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (product_id IS NOT NULL OR brand_id IS NOT NULL)
);

-- GTIN uniqueness across variants
CREATE UNIQUE INDEX uq_variants_gtin ON product_variants(gtin) WHERE gtin IS NOT NULL;

-- Import jobs: track bulk CSV imports with their reports
CREATE TABLE import_jobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename    text NOT NULL,
  total_rows  int NOT NULL DEFAULT 0,
  created_ct  int NOT NULL DEFAULT 0,
  updated_ct  int NOT NULL DEFAULT 0,
  error_ct    int NOT NULL DEFAULT 0,
  report      jsonb NOT NULL DEFAULT '[]'::jsonb,  -- per-row issues
  created_at  timestamptz NOT NULL DEFAULT now()
);

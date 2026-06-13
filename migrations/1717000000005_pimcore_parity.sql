-- Up Migration
-- ============================================================
-- 005 — Pimcore-parity: versioning, workflows, inheritance,
-- relations, calculated attributes, workspaces, locale
-- fallbacks, DAM folders/focal points.
-- Run after migration-004-hardening.sql
-- ============================================================

-- Product hierarchy: children inherit attribute values from parents
-- (Pimcore: object tree + inherited values)
ALTER TABLE products ADD COLUMN parent_id uuid REFERENCES products(id) ON DELETE SET NULL;
CREATE INDEX idx_products_parent ON products(parent_id);

-- Full version snapshots with restore (Pimcore: versions)
CREATE TABLE product_versions (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  version     int NOT NULL,
  snapshot    jsonb NOT NULL,            -- full product record at that version
  created_by  text,
  label       text,                      -- optional: 'pre-launch baseline'
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, version)
);

-- Typed product relations (Pimcore: relation fields)
CREATE TYPE relation_type AS ENUM ('related', 'cross_sell', 'up_sell', 'accessory', 'replacement');
CREATE TABLE product_relations (
  source_id   uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  target_id   uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  relation    relation_type NOT NULL,
  sort_order  int NOT NULL DEFAULT 0,
  PRIMARY KEY (source_id, target_id, relation),
  CHECK (source_id != target_id)
);

-- Configurable workflows (Pimcore: workflow engine)
-- definition: {"states": [...], "transitions": [{"from","to","permission","requires_complete"}]}
CREATE TABLE workflows (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL UNIQUE,
  name            text NOT NULL,
  product_type_id uuid REFERENCES product_types(id) ON DELETE CASCADE,  -- NULL = default
  definition      jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

INSERT INTO workflows (code, name, product_type_id, definition) VALUES
('default', 'Default product workflow', NULL, '{
  "states": ["draft", "in_review", "published", "archived"],
  "transitions": [
    {"from": "draft",     "to": "in_review", "permission": "product.edit",    "requires_complete": true},
    {"from": "in_review", "to": "published", "permission": "review.approve",  "requires_complete": true},
    {"from": "in_review", "to": "draft",     "permission": "review.approve"},
    {"from": "draft",     "to": "published", "permission": "product.publish", "requires_complete": true},
    {"from": "published", "to": "archived",  "permission": "product.publish"},
    {"from": "published", "to": "draft",     "permission": "product.publish"},
    {"from": "archived",  "to": "draft",     "permission": "product.edit"}
  ]
}'::jsonb);

-- Calculated attributes (Pimcore: calculated values)
-- Formula references other attribute codes: 'sugar_g_100ml * volume_ml / 100'
ALTER TABLE attributes ADD COLUMN formula text;
INSERT INTO attributes (code, label, data_type, unit, formula) VALUES
  ('sugar_per_container', 'Sugar per container', 'number', 'g', 'round(sugar_g_100ml * volume_ml / 100, 1)');
INSERT INTO product_type_attributes (product_type_id, attribute_id, group_name, is_required, sort_order)
SELECT pt.id, a.id, 'Nutrition', false, 99
FROM product_types pt, attributes a
WHERE pt.code IN ('soft_drink', 'juice') AND a.code = 'sugar_per_container';

-- Locale fallback chains (Pimcore: localized fields with fallback)
CREATE TABLE locales (
  code     text PRIMARY KEY,             -- 'de-AT'
  name     text NOT NULL,
  fallback text REFERENCES locales(code) -- de-AT → de → (base)
);
INSERT INTO locales (code, name, fallback) VALUES
  ('en', 'English', NULL),
  ('de', 'German', NULL),
  ('fr', 'French', NULL),
  ('de-AT', 'German (Austria)', 'de'),
  ('de-CH', 'German (Switzerland)', 'de'),
  ('fr-CH', 'French (Switzerland)', 'fr');

-- Workspaces: scope a user's access to brands and/or category subtrees
-- (Pimcore: workspaces / object-level permissions)
CREATE TABLE user_scopes (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brand_id    uuid REFERENCES brands(id) ON DELETE CASCADE,
  category_id uuid REFERENCES categories(id) ON DELETE CASCADE,
  CHECK (brand_id IS NOT NULL OR category_id IS NOT NULL)
);
CREATE INDEX idx_scopes_user ON user_scopes(user_id);

-- DAM: folders, focal point for smart cropping (Pimcore: asset tree, focal point)
ALTER TABLE assets ADD COLUMN folder text NOT NULL DEFAULT '/';
ALTER TABLE assets ADD COLUMN focal_x real CHECK (focal_x BETWEEN 0 AND 1);
ALTER TABLE assets ADD COLUMN focal_y real CHECK (focal_y BETWEEN 0 AND 1);
CREATE INDEX idx_assets_folder ON assets(folder);

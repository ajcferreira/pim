-- Up Migration
-- ============================================================
-- PIM/DAM — Dynamic product model for beverage catalogs
-- PostgreSQL 14+
-- Hybrid model: fixed columns for universal fields,
-- JSONB for type-specific attributes, validated against
-- attribute definitions per product type.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- fuzzy search

-- ---------- Enumerations ----------
CREATE TYPE product_status AS ENUM ('draft', 'in_review', 'published', 'archived');
CREATE TYPE attribute_type AS ENUM ('text', 'long_text', 'number', 'boolean', 'select', 'multiselect', 'date');
CREATE TYPE asset_role     AS ENUM ('hero', 'packshot', 'label', 'lifestyle', 'document', 'video', 'other');

-- ---------- Reference data ----------
CREATE TABLE brands (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id   uuid REFERENCES categories(id) ON DELETE SET NULL,
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE,
  sort_order  int  NOT NULL DEFAULT 0
);

-- ---------- Dynamic model core ----------
-- A product type = an attribute set (beer, wine, soft drink, spirit, water...)
CREATE TABLE product_types (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,          -- 'beer', 'wine', 'soft_drink'
  name        text NOT NULL,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Reusable attribute definitions (the "schema of the schema")
CREATE TABLE attributes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,        -- 'abv', 'volume_ml', 'sugar_g_per_100ml'
  label         text NOT NULL,
  data_type     attribute_type NOT NULL,
  unit          text,                        -- '%', 'ml', 'g/100ml', 'IBU'
  options       jsonb,                       -- for select/multiselect: ["Lager","IPA","Stout"]
  validation    jsonb,                       -- {"min":0,"max":100,"pattern":"...","maxLength":500}
  is_localizable boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Which attributes belong to which product type, grouped & ordered
CREATE TABLE product_type_attributes (
  product_type_id uuid NOT NULL REFERENCES product_types(id) ON DELETE CASCADE,
  attribute_id    uuid NOT NULL REFERENCES attributes(id)    ON DELETE CASCADE,
  group_name      text NOT NULL DEFAULT 'General',           -- 'Composition', 'Packaging', 'Regulatory'
  is_required     boolean NOT NULL DEFAULT false,
  sort_order      int NOT NULL DEFAULT 0,
  PRIMARY KEY (product_type_id, attribute_id)
);

-- ---------- Products ----------
CREATE TABLE products (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku             text NOT NULL UNIQUE,
  name            text NOT NULL,
  product_type_id uuid NOT NULL REFERENCES product_types(id),
  brand_id        uuid REFERENCES brands(id),
  status          product_status NOT NULL DEFAULT 'draft',
  description     text,
  -- Dynamic attribute values keyed by attribute code:
  -- {"abv": 5.2, "style": "IPA", "volume_ml": 330, "allergens": ["barley"]}
  attributes      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Localized overrides: {"fr": {"name": "...", "description": "..."}}
  i18n            jsonb NOT NULL DEFAULT '{}'::jsonb,
  search          tsvector GENERATED ALWAYS AS (
                    setweight(to_tsvector('simple', coalesce(name,'')), 'A') ||
                    setweight(to_tsvector('simple', coalesce(sku,'')),  'A') ||
                    setweight(to_tsvector('simple', coalesce(description,'')), 'B')
                  ) STORED,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_products_type     ON products(product_type_id);
CREATE INDEX idx_products_status   ON products(status);
CREATE INDEX idx_products_attrs    ON products USING gin (attributes jsonb_path_ops);
CREATE INDEX idx_products_search   ON products USING gin (search);
CREATE INDEX idx_products_name_trgm ON products USING gin (name gin_trgm_ops);

CREATE TABLE product_categories (
  product_id  uuid NOT NULL REFERENCES products(id)   ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, category_id)
);

-- Variants: same product, different packaging (330ml can, 750ml bottle, 6-pack)
CREATE TABLE product_variants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku         text NOT NULL UNIQUE,
  name        text NOT NULL,                 -- '330ml Can', '750ml Bottle'
  gtin        text,                          -- EAN/UPC barcode
  attributes  jsonb NOT NULL DEFAULT '{}'::jsonb,  -- packaging-level overrides
  sort_order  int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_variants_product ON product_variants(product_id);

-- ---------- DAM ----------
CREATE TABLE assets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename    text NOT NULL,
  mime_type   text NOT NULL,
  byte_size   bigint NOT NULL,
  storage_key text NOT NULL UNIQUE,          -- S3/MinIO object key
  checksum    text,                          -- sha256, dedupe uploads
  width       int,
  height      int,
  alt_text    text,
  tags        text[] NOT NULL DEFAULT '{}',
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,  -- EXIF, color profile, renditions
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_assets_tags ON assets USING gin (tags);

CREATE TABLE product_assets (
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  asset_id    uuid NOT NULL REFERENCES assets(id)   ON DELETE CASCADE,
  role        asset_role NOT NULL DEFAULT 'other',
  sort_order  int NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, asset_id, role)
);

-- ---------- Audit ----------
CREATE TABLE product_history (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id  uuid NOT NULL,
  changed_at  timestamptz NOT NULL DEFAULT now(),
  changed_by  text,
  diff        jsonb NOT NULL                 -- {"before": {...}, "after": {...}}
);

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_products_touch BEFORE UPDATE ON products
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ============================================================
-- Seed: beverage attribute sets
-- ============================================================
INSERT INTO product_types (code, name) VALUES
  ('beer', 'Beer'), ('wine', 'Wine'), ('soft_drink', 'Soft Drink'),
  ('spirit', 'Spirit'), ('water', 'Water'), ('juice', 'Juice');

INSERT INTO attributes (code, label, data_type, unit, options, validation) VALUES
  ('abv',            'Alcohol by volume',   'number', '%',        NULL, '{"min":0,"max":96}'),
  ('volume_ml',      'Volume',              'number', 'ml',       NULL, '{"min":1}'),
  ('ibu',            'Bitterness',          'number', 'IBU',      NULL, '{"min":0,"max":120}'),
  ('beer_style',     'Style',               'select', NULL,       '["Lager","Pilsner","IPA","Pale Ale","Stout","Wheat","Sour"]', NULL),
  ('grape_variety',  'Grape variety',       'multiselect', NULL,  '["Chardonnay","Merlot","Cabernet Sauvignon","Pinot Noir","Riesling","Tempranillo"]', NULL),
  ('vintage',        'Vintage',             'number', NULL,       NULL, '{"min":1900,"max":2100}'),
  ('sugar_g_100ml',  'Sugar',               'number', 'g/100ml',  NULL, '{"min":0,"max":100}'),
  ('caffeine_mg',    'Caffeine',            'number', 'mg/100ml', NULL, '{"min":0}'),
  ('carbonated',     'Carbonated',          'boolean', NULL,      NULL, NULL),
  ('allergens',      'Allergens',           'multiselect', NULL,  '["Barley","Wheat","Sulphites","None"]', NULL),
  ('country_origin', 'Country of origin',   'text',   NULL,       NULL, '{"maxLength":80}'),
  ('serving_temp_c', 'Serving temperature', 'number', '°C',       NULL, '{"min":-5,"max":25}'),
  ('organic',        'Organic certified',   'boolean', NULL,      NULL, NULL),
  ('best_before_months','Shelf life',       'number', 'months',   NULL, '{"min":1}');

-- Attach attributes to types
WITH t AS (SELECT id, code FROM product_types), a AS (SELECT id, code FROM attributes)
INSERT INTO product_type_attributes (product_type_id, attribute_id, group_name, is_required, sort_order)
SELECT t.id, a.id, v.grp, v.req, v.ord
FROM (VALUES
  -- beer
  ('beer','abv','Composition',true,1), ('beer','ibu','Composition',false,2),
  ('beer','beer_style','Composition',true,3), ('beer','volume_ml','Packaging',true,4),
  ('beer','allergens','Regulatory',true,5), ('beer','serving_temp_c','Serving',false,6),
  -- wine
  ('wine','abv','Composition',true,1), ('wine','grape_variety','Composition',true,2),
  ('wine','vintage','Composition',false,3), ('wine','volume_ml','Packaging',true,4),
  ('wine','country_origin','Provenance',true,5), ('wine','allergens','Regulatory',true,6),
  -- soft drink
  ('soft_drink','sugar_g_100ml','Nutrition',true,1), ('soft_drink','caffeine_mg','Nutrition',false,2),
  ('soft_drink','carbonated','Composition',true,3), ('soft_drink','volume_ml','Packaging',true,4),
  ('soft_drink','best_before_months','Regulatory',false,5),
  -- spirit
  ('spirit','abv','Composition',true,1), ('spirit','volume_ml','Packaging',true,2),
  ('spirit','country_origin','Provenance',false,3),
  -- water
  ('water','carbonated','Composition',true,1), ('water','volume_ml','Packaging',true,2),
  ('water','country_origin','Provenance',false,3),
  -- juice
  ('juice','sugar_g_100ml','Nutrition',true,1), ('juice','organic','Regulatory',false,2),
  ('juice','volume_ml','Packaging',true,3), ('juice','best_before_months','Regulatory',false,4)
) AS v(type_code, attr_code, grp, req, ord)
JOIN t ON t.code = v.type_code
JOIN a ON a.code = v.attr_code;

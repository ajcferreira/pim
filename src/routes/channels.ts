import { Router } from "express";
import { query } from "../db.js";
import { taxCategory } from "../lib/compliance.js";

export const channels = Router();

type Row = {
  id: string; sku: string; name: string; description: string | null;
  attributes: Record<string, any>; i18n: Record<string, any>;
  type_code: string; brand: string | null;
  variants: { sku: string; name: string; gtin: string | null }[];
  hero: string | null;
};

async function publishedProducts(typeFilter?: string): Promise<Row[]> {
  return query<Row>(
    `SELECT p.id, p.sku, p.name, p.description, p.attributes, p.i18n,
            pt.code AS type_code, b.name AS brand,
            coalesce(json_agg(DISTINCT jsonb_build_object('sku', v.sku, 'name', v.name, 'gtin', v.gtin))
                     FILTER (WHERE v.id IS NOT NULL), '[]') AS variants,
            (SELECT a.storage_key FROM product_assets pa JOIN assets a ON a.id = pa.asset_id
             WHERE pa.product_id = p.id AND pa.role = 'hero' LIMIT 1) AS hero
     FROM products p
     JOIN product_types pt ON pt.id = p.product_type_id
     LEFT JOIN brands b ON b.id = p.brand_id
     LEFT JOIN product_variants v ON v.product_id = p.id
     WHERE p.status = 'published' AND p.deleted_at IS NULL
       AND (p.publish_from  IS NULL OR p.publish_from  <= now())
       AND (p.publish_until IS NULL OR p.publish_until >= now())
       AND ($1::text IS NULL OR pt.code = $1)
     GROUP BY p.id, pt.code, b.name`,
    [typeFilter ?? null]
  );
}

/** GET /channels/shopify/feed — Shopify product JSON shape */
channels.get("/shopify/feed", async (req, res) => {
  const rows = await publishedProducts(req.query.type as string | undefined);
  res.json(rows.map((p) => ({
    title: p.name,
    body_html: p.description ?? "",
    vendor: p.brand,
    product_type: p.type_code,
    tags: [p.type_code, p.attributes.beer_style, p.attributes.country_origin].filter(Boolean).join(","),
    variants: (p.variants.length ? p.variants : [{ sku: p.sku, name: "Default", gtin: null }]).map((v) => ({
      sku: v.sku, title: v.name, barcode: v.gtin ?? undefined,
    })),
    images: p.hero ? [{ src: `/assets/file/${p.hero}` }] : [],
    metafields: Object.entries(p.attributes).map(([key, value]) => ({
      namespace: "pim", key, value: String(Array.isArray(value) ? value.join(", ") : value),
    })),
  })));
});

/** GET /channels/amazon/feed — flat-file-style records */
channels.get("/amazon/feed", async (req, res) => {
  const rows = await publishedProducts(req.query.type as string | undefined);
  res.json(rows.flatMap((p) =>
    (p.variants.length ? p.variants : [{ sku: p.sku, name: "Default", gtin: null }]).map((v) => ({
      item_sku: v.sku,
      external_product_id: v.gtin ?? "",
      external_product_id_type: v.gtin ? (v.gtin.length === 12 ? "UPC" : "EAN") : "",
      item_name: `${p.brand ?? ""} ${p.name} ${v.name}`.trim(),
      brand_name: p.brand ?? "",
      product_description: p.description ?? "",
      is_adult_product: ["beer", "wine", "spirit"].includes(p.type_code),
      unit_count: p.attributes.volume_ml ?? "",
      unit_count_type: "milliliter",
    }))
  ));
});

/** GET /channels/gs1/feed — GDSN-style trade item records with tax category */
channels.get("/gs1/feed", async (req, res) => {
  const rows = await publishedProducts(req.query.type as string | undefined);
  res.json(rows.flatMap((p) => p.variants.map((v) => ({
    gtin: v.gtin,
    tradeItemDescription: `${p.name} — ${v.name}`,
    brandName: p.brand,
    netContent: { value: p.attributes.volume_ml, unit: "MLT" },
    alcoholPercentage: p.attributes.abv ?? 0,
    exciseCategory: taxCategory(p.type_code, p.attributes.abv),
    allergens: p.attributes.allergens ?? [],
  })).filter((r) => r.gtin)));
});

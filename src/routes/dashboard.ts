import { Router } from "express";
import { query } from "../db.js";
import { getTypeAttributes } from "../validation.js";
import { runComplianceChecks } from "../lib/compliance.js";

export const dashboard = Router();

/** GET /dashboard/completeness — % of required attributes filled, per product, rolled up by type and brand */
dashboard.get("/completeness", async (_req, res) => {
  const products = await query(
    `SELECT p.id, p.sku, p.name, p.status, p.attributes, p.product_type_id,
            pt.code AS type_code, pt.name AS type_name, b.name AS brand
     FROM products p
     JOIN product_types pt ON pt.id = p.product_type_id
     LEFT JOIN brands b ON b.id = p.brand_id
     WHERE p.deleted_at IS NULL`
  );
  const schemaCache = new Map<string, Awaited<ReturnType<typeof getTypeAttributes>>>();
  const rows = [];
  for (const p of products) {
    if (!schemaCache.has(p.product_type_id as string))
      schemaCache.set(p.product_type_id as string, await getTypeAttributes(p.product_type_id as string));
    const required = schemaCache.get(p.product_type_id as string)!.filter((d) => d.is_required);
    const attrs = p.attributes as Record<string, unknown>;
    const missing = required.filter((d) => {
      const v = attrs[d.code];
      return v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);
    });
    rows.push({
      id: p.id, sku: p.sku, name: p.name, status: p.status,
      type: p.type_code, brand: p.brand,
      completeness: required.length ? Math.round(((required.length - missing.length) / required.length) * 100) : 100,
      missing: missing.map((d) => d.code),
    });
  }
  const byType: Record<string, { count: number; avg: number; ready: number }> = {};
  for (const r of rows) {
    byType[r.type] ??= { count: 0, avg: 0, ready: 0 };
    byType[r.type].count++;
    byType[r.type].avg += r.completeness;
    if (r.completeness === 100) byType[r.type].ready++;
  }
  for (const t of Object.values(byType)) t.avg = Math.round(t.avg / t.count);
  res.json({ products: rows, by_type: byType });
});

/** GET /dashboard/compliance?markets=DE,SE — compliance issues across the catalog */
dashboard.get("/compliance", async (req, res) => {
  const markets = String(req.query.markets ?? "EU").split(",").map((s) => s.trim());
  const products = await query(
    `SELECT p.id, p.sku, p.name, p.attributes, p.i18n, pt.code AS type_code,
            coalesce(json_agg(json_build_object('name', v.name, 'gtin', v.gtin))
                     FILTER (WHERE v.id IS NOT NULL), '[]') AS variants
     FROM products p
     JOIN product_types pt ON pt.id = p.product_type_id
     LEFT JOIN product_variants v ON v.product_id = p.id
     WHERE p.status != 'archived' AND p.deleted_at IS NULL
     GROUP BY p.id, pt.code`
  );
  const report = products.map((p) => ({
    id: p.id, sku: p.sku, name: p.name,
    issues: runComplianceChecks(p as never, markets),
  })).filter((r) => r.issues.length);
  res.json({ markets, products_with_issues: report.length, report });
});

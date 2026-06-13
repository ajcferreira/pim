import { Router } from "express";
import { z } from "zod";
import { query, withTransaction } from "../db.js";
import { requirePermission } from "../middleware/auth.js";
import { resolveEffectiveAttributes } from "../lib/objects.js";

export const objects = Router();

/* ============ Versions: history + restore (Pimcore: versions) ============ */

/** GET /objects/products/:id/versions — newest first */
objects.get("/products/:id/versions", async (req, res) => {
  res.json(await query(
    `SELECT id, version, created_by, label, created_at,
            snapshot->>'name' AS name, snapshot->>'status' AS status
     FROM product_versions WHERE product_id = $1 ORDER BY version DESC LIMIT 100`,
    [req.params.id]));
});

/** GET /objects/products/:id/versions/:v — full snapshot */
objects.get("/products/:id/versions/:v", async (req, res) => {
  const [row] = await query(
    `SELECT * FROM product_versions WHERE product_id = $1 AND version = $2`,
    [req.params.id, req.params.v]);
  if (!row) return res.status(404).json({ error: "Version not found" });
  res.json(row);
});

/** POST /objects/products/:id/versions/:v/restore — snapshot current, then restore.
 *  Restored products land in draft so they re-enter the workflow. */
objects.post("/products/:id/versions/:v/restore", requirePermission("product.edit"), async (req, res) => {
  const [target] = await query(
    `SELECT snapshot FROM product_versions WHERE product_id = $1 AND version = $2`,
    [req.params.id, req.params.v]);
  if (!target) return res.status(404).json({ error: "Version not found" });
  const snap = target.snapshot as Record<string, unknown>;

  const restored = await withTransaction(async (q) => {
    const [current] = await q(`SELECT * FROM products WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!current) return null;
    await q(
      `INSERT INTO product_versions (product_id, version, snapshot, created_by, label)
       VALUES ($1, $2, $3::jsonb, $4, $5)`,
      [current.id, current.version, JSON.stringify(current), req.user?.email ?? "api",
       `auto: before restore of v${req.params.v}`]);
    const [row] = await q(
      `UPDATE products SET name = $2, description = $3, attributes = $4::jsonb,
              i18n = $5::jsonb, status = 'draft', version = version + 1
       WHERE id = $1 RETURNING *`,
      [current.id, snap.name, snap.description ?? null,
       JSON.stringify(snap.attributes ?? {}), JSON.stringify(snap.i18n ?? {})]);
    return row;
  });
  if (!restored) return res.status(404).json({ error: "Product not found" });
  res.json({ ...restored, note: `Restored from v${req.params.v}; previous state snapshotted` });
});

/* ============ Relations (Pimcore: relation fields) ============ */

const RELS = ["related", "cross_sell", "up_sell", "accessory", "replacement"] as const;

/** GET /objects/products/:id/relations — grouped by type, both directions */
objects.get("/products/:id/relations", async (req, res) => {
  const rows = await query(
    `SELECT r.relation, r.sort_order, 'out' AS direction,
            p.id, p.sku, p.name, p.status
     FROM product_relations r JOIN products p ON p.id = r.target_id
     WHERE r.source_id = $1
     UNION ALL
     SELECT r.relation, r.sort_order, 'in' AS direction,
            p.id, p.sku, p.name, p.status
     FROM product_relations r JOIN products p ON p.id = r.source_id
     WHERE r.target_id = $1
     ORDER BY relation, sort_order`, [req.params.id]);
  res.json(rows);
});

/** POST /objects/products/:id/relations {target_id, relation, sort_order?} */
objects.post("/products/:id/relations", requirePermission("product.edit"), async (req, res) => {
  const Input = z.object({
    target_id: z.string().uuid(),
    relation: z.enum(RELS),
    sort_order: z.number().int().default(0),
  });
  const parsed = Input.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.flatten() });
  if (parsed.data.target_id === req.params.id)
    return res.status(422).json({ error: "A product can't relate to itself" });
  await query(
    `INSERT INTO product_relations (source_id, target_id, relation, sort_order)
     VALUES ($1,$2,$3::relation_type,$4)
     ON CONFLICT (source_id, target_id, relation) DO UPDATE SET sort_order = $4`,
    [req.params.id, parsed.data.target_id, parsed.data.relation, parsed.data.sort_order]);
  res.status(204).end();
});

objects.delete("/products/:id/relations/:targetId/:relation", requirePermission("product.edit"), async (req, res) => {
  await query(
    `DELETE FROM product_relations WHERE source_id = $1 AND target_id = $2 AND relation = $3::relation_type`,
    [req.params.id, req.params.targetId, req.params.relation]);
  res.status(204).end();
});

/* ============ Categories: tree API (Pimcore: object tree) ============ */

/** GET /objects/categories — full tree with product counts */
objects.get("/categories", async (_req, res) => {
  const rows = await query(
    `SELECT c.*, (SELECT count(*) FROM product_categories pc WHERE pc.category_id = c.id) AS product_count
     FROM categories c ORDER BY c.sort_order, c.name`);
  type Node = (typeof rows)[number] & { children: Node[] };
  const byId = new Map<string, Node>(rows.map((r) => [r.id as string, { ...r, children: [] } as Node]));
  const roots: Node[] = [];
  for (const n of byId.values()) {
    const parent = n.parent_id ? byId.get(n.parent_id as string) : null;
    parent ? parent.children.push(n) : roots.push(n);
  }
  res.json(roots);
});

/** POST /objects/categories {name, slug, parent_id?} */
objects.post("/categories", requirePermission("model.manage"), async (req, res) => {
  const Input = z.object({
    name: z.string().min(1),
    slug: z.string().regex(/^[a-z0-9-]+$/),
    parent_id: z.string().uuid().nullish(),
    sort_order: z.number().int().default(0),
  });
  const parsed = Input.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.flatten() });
  const d = parsed.data;
  const [row] = await query(
    `INSERT INTO categories (name, slug, parent_id, sort_order)
     VALUES ($1,$2,$3,$4) ON CONFLICT (slug) DO NOTHING RETURNING *`,
    [d.name, d.slug, d.parent_id ?? null, d.sort_order]);
  if (!row) return res.status(409).json({ error: "Slug already exists" });
  res.status(201).json(row);
});

/** POST /objects/categories/:id/products {product_id} — assign */
objects.post("/categories/:id/products", requirePermission("product.edit"), async (req, res) => {
  const { product_id } = req.body ?? {};
  if (!product_id) return res.status(400).json({ error: "product_id required" });
  await query(
    `INSERT INTO product_categories (product_id, category_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [product_id, req.params.id]);
  res.status(204).end();
});

objects.delete("/categories/:id/products/:productId", requirePermission("product.edit"), async (req, res) => {
  await query(`DELETE FROM product_categories WHERE category_id = $1 AND product_id = $2`,
    [req.params.id, req.params.productId]);
  res.status(204).end();
});

/* ============ Locale fallback resolution ============ */

/** GET /objects/products/:id/localized?locale=de-AT
 *  Resolves de-AT → de → base fields, reporting which level supplied each field. */
objects.get("/products/:id/localized", async (req, res) => {
  const locale = String(req.query.locale ?? "en");
  const [p] = await query(`SELECT name, description, i18n FROM products WHERE id = $1`, [req.params.id]);
  if (!p) return res.status(404).json({ error: "Not found" });

  // Build the fallback chain from the locales table (max 3 hops), ending at base
  const chain: string[] = [];
  let cur: string | null = locale;
  for (let i = 0; cur && i < 3; i++) {
    chain.push(cur);
    const [l] = await query<{ fallback: string | null }>(
      `SELECT fallback FROM locales WHERE code = $1`, [cur]);
    cur = l?.fallback ?? null;
  }

  const i18n = (p.i18n ?? {}) as Record<string, Record<string, string>>;
  const resolve = (field: "name" | "description") => {
    for (const loc of chain) {
      const v = i18n[loc]?.[field];
      if (v) return { value: v, resolved_from: loc };
    }
    return { value: p[field] ?? null, resolved_from: "base" };
  };
  res.json({
    locale, fallback_chain: [...chain, "base"],
    name: resolve("name"), description: resolve("description"),
  });
});

/* ============ Effective (inherited) attributes ============ */

/** GET /objects/products/:id/effective — merged values up the parent chain */
objects.get("/products/:id/effective", async (req, res) => {
  const [exists] = await query(`SELECT 1 FROM products WHERE id = $1`, [req.params.id]);
  if (!exists) return res.status(404).json({ error: "Not found" });
  res.json(await resolveEffectiveAttributes(req.params.id));
});

/** POST /objects/products/:id/parent {parent_id|null} — place in hierarchy */
objects.post("/products/:id/parent", requirePermission("product.edit"), async (req, res) => {
  const parentId = req.body?.parent_id ?? null;
  if (parentId === req.params.id)
    return res.status(422).json({ error: "A product can't be its own parent" });
  if (parentId) {
    // Reject cycles: the new parent must not be a descendant of this product
    const cycle = await query(
      `WITH RECURSIVE up AS (
         SELECT id, parent_id FROM products WHERE id = $1
         UNION ALL
         SELECT p.id, p.parent_id FROM products p JOIN up ON p.id = up.parent_id
       ) SELECT 1 FROM up WHERE id = $2 LIMIT 1`, [parentId, req.params.id]);
    if (cycle.length) return res.status(422).json({ error: "That would create a cycle in the hierarchy" });
  }
  const [row] = await query(
    `UPDATE products SET parent_id = $2 WHERE id = $1 RETURNING id, sku, parent_id`,
    [req.params.id, parentId]);
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(row);
});

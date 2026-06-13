import { Router } from "express";
import { z } from "zod";
import { query } from "../db.js";
import { getTypeAttributes, validateAttributes } from "../validation.js";
import { loadWorkflow, checkTransition, resolveEffectiveAttributes, loadScope, inScope } from "../lib/objects.js";
import { applyCalculated } from "../lib/calc.js";

export const products = Router();

const ProductInput = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  product_type_id: z.string().uuid(),
  brand_id: z.string().uuid().nullish(),
  status: z.enum(["draft", "in_review", "published", "archived"]).default("draft"),
  description: z.string().nullish(),
  attributes: z.record(z.unknown()).default({}),
});

/**
 * GET /products
 *   ?q=ipa                 full-text + fuzzy search
 *   ?type=beer             filter by product type code
 *   ?status=published
 *   ?attr.beer_style=IPA   filter on any dynamic attribute (JSONB containment)
 *   ?limit=&offset=
 */
products.get("/", async (req, res) => {
  const { q, type, status } = req.query as Record<string, string>;
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;

  const where: string[] = [];
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };

  where.push(`p.deleted_at IS NULL`);
  if (q) where.push(`(p.search @@ plainto_tsquery('english', ${p(q)}) OR p.name % ${p(q)})`);

  // Workspaces: scoped users only see products in their brands/category subtrees
  const scope = await loadScope(req.user!.sub);
  if (scope.scoped) {
    const conds: string[] = [];
    if (scope.brandIds.length) conds.push(`p.brand_id = ANY(${p(scope.brandIds)})`);
    if (scope.categoryIds.length) conds.push(
      `EXISTS (SELECT 1 FROM product_categories pc WHERE pc.product_id = p.id AND pc.category_id = ANY(${p(scope.categoryIds)}))`);
    where.push(conds.length ? `(${conds.join(" OR ")})` : `false`);
  }
  if (type) where.push(`pt.code = ${p(type)}`);
  if (status) where.push(`p.status = ${p(status)}::product_status`);

  // attr.<code>=<value> → JSONB containment, uses the GIN index
  const attrFilter: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(req.query)) {
    if (k.startsWith("attr.")) {
      const num = Number(v);
      attrFilter[k.slice(5)] = Number.isNaN(num) ? v : num;
    }
  }
  if (Object.keys(attrFilter).length)
    where.push(`p.attributes @> ${p(JSON.stringify(attrFilter))}::jsonb`);

  const rows = await query(
    `SELECT p.id, p.sku, p.name, p.status, p.version, p.attributes, p.updated_at,
            pt.code AS type_code, pt.name AS type_name,
            b.name AS brand,
            count(*) OVER() AS _total
     FROM products p
     JOIN product_types pt ON pt.id = p.product_type_id
     LEFT JOIN brands b ON b.id = p.brand_id
     ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY p.updated_at DESC
     LIMIT ${p(limit)} OFFSET ${p(offset)}`,
    params
  );
  const total = rows.length ? Number(rows[0]._total) : 0;
  res.json({ items: rows.map(({ _total, ...r }) => r), total, limit, offset });
});

/** GET /products/:id — full record with variants, assets and the attribute schema for editing UIs */
products.get("/:id", async (req, res) => {
  const [product] = await query(
    `SELECT p.*, pt.code AS type_code, pt.name AS type_name
     FROM products p JOIN product_types pt ON pt.id = p.product_type_id
     WHERE p.id = $1 AND p.deleted_at IS NULL`,
    [req.params.id]
  );
  if (!product) return res.status(404).json({ error: "Not found" });

  const [variants, assets, schema, inheritance] = await Promise.all([
    query(`SELECT * FROM product_variants WHERE product_id = $1 ORDER BY sort_order`, [product.id]),
    query(
      `SELECT a.*, pa.role, pa.sort_order
       FROM product_assets pa JOIN assets a ON a.id = pa.asset_id
       WHERE pa.product_id = $1 ORDER BY pa.sort_order`,
      [product.id]
    ),
    getTypeAttributes(product.product_type_id as string),
    resolveEffectiveAttributes(product.id as string),
  ]);
  // Effective = own values merged over ancestors, then calculated formulas applied
  const effective_attributes = applyCalculated(inheritance.effective, schema);
  res.json({ ...product, variants, assets, attribute_schema: schema,
             effective_attributes, inherited_from: inheritance.inherited_from });
});

/** POST /products — create, validating dynamic attributes against the type */
products.post("/", async (req, res) => {
  const parsed = ProductInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.flatten() });
  const input = parsed.data;

  const defs = await getTypeAttributes(input.product_type_id);
  const issues = validateAttributes(input.attributes as Record<string, unknown>, defs);
  if (issues.length) return res.status(422).json({ attribute_errors: issues });

  const scope = await loadScope(req.user!.sub);
  if (scope.scoped && (!input.brand_id || !scope.brandIds.includes(input.brand_id)))
    return res.status(403).json({ error: "You can only create products for brands in your workspace" });

  const [row] = await query(
    `INSERT INTO products (sku, name, product_type_id, brand_id, status, description, attributes)
     VALUES ($1,$2,$3,$4,$5::product_status,$6,$7::jsonb) RETURNING *`,
    [input.sku, input.name, input.product_type_id, input.brand_id ?? null,
     input.status, input.description ?? null, JSON.stringify(input.attributes)]
  );
  res.status(201).json(row);
});

/** PATCH /products/:id — partial update; attribute merge with validation + audit trail */
products.patch("/:id", async (req, res) => {
  const [existing] = await query(
    `SELECT * FROM products WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
  if (!existing) return res.status(404).json({ error: "Not found" });

  // Workspaces: scoped users can't edit products outside their workspace
  const scope = await loadScope(req.user!.sub);
  if (!(await inScope(scope, existing.id as string)))
    return res.status(403).json({ error: "Product is outside your workspace" });

  const next = { ...existing, ...req.body };
  const defs = await getTypeAttributes(existing.product_type_id as string);

  // Status changes go through the configurable workflow engine
  let fullValidation = false;
  if (req.body.status && req.body.status !== existing.status) {
    const wf = await loadWorkflow(existing.product_type_id as string);
    const check = checkTransition(wf, existing.status as string, req.body.status, req.user!.permissions);
    if (!check.ok) return res.status(check.status).json({ error: check.error, required: check.required });
    fullValidation = check.requires_complete;
  }

  // Calculated attributes are server-computed — clients can't set them
  const calculatedCodes = new Set(defs.filter((d) => (d as { formula?: string }).formula).map((d) => d.code));
  const incoming = Object.fromEntries(
    Object.entries(req.body.attributes ?? {}).filter(([k]) => !calculatedCodes.has(k)));
  const mergedAttrs = { ...(existing.attributes as object), ...incoming };

  const validatableDefs = defs.filter((d) => !calculatedCodes.has(d.code));
  const issues = validateAttributes(mergedAttrs, validatableDefs, { partial: !fullValidation });
  if (issues.length) return res.status(422).json({ attribute_errors: issues });

  // Optimistic locking: the client must echo the version it loaded.
  // A mismatch means someone saved in between — 409, never a silent overwrite.
  if (req.body.version === undefined)
    return res.status(400).json({ error: "version field required (optimistic locking)" });
  const [row] = await query(
    `UPDATE products SET name=$2, brand_id=$3, status=$4::product_status,
            description=$5, attributes=$6::jsonb, version = version + 1
     WHERE id=$1 AND version=$7 RETURNING *`,
    [existing.id, next.name, next.brand_id ?? null, next.status,
     next.description ?? null, JSON.stringify(mergedAttrs), req.body.version]
  );
  if (!row) return res.status(409).json({
    error: "Conflict: product was modified by someone else",
    current_version: existing.version, hint: "Reload the product and reapply your changes",
  });
  await Promise.all([
    query(
      `INSERT INTO product_history (product_id, changed_by, diff) VALUES ($1,$2,$3::jsonb)`,
      [existing.id, req.user?.email ?? "api",
       JSON.stringify({ before: existing.attributes, after: mergedAttrs })]),
    // Pimcore-style versioning: every save snapshots the pre-edit state for restore
    query(
      `INSERT INTO product_versions (product_id, version, snapshot, created_by)
       VALUES ($1,$2,$3::jsonb,$4) ON CONFLICT (product_id, version) DO NOTHING`,
      [existing.id, existing.version, JSON.stringify(existing), req.user?.email ?? "api"]),
  ]);
  res.json(row);
});

/** Soft delete: recoverable for 30 days (see retention pruning) */
products.delete("/:id", async (req, res) => {
  if (!req.user?.permissions.includes("product.publish"))
    return res.status(403).json({ error: "Insufficient permissions", required: ["product.publish"] });
  const [row] = await query(
    `UPDATE products SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
    [req.params.id]);
  if (!row) return res.status(404).json({ error: "Not found" });
  res.status(204).end();
});

/** POST /products/:id/undelete — restore a soft-deleted product */
products.post("/:id/undelete", async (req, res) => {
  if (!req.user?.permissions.includes("product.publish"))
    return res.status(403).json({ error: "Insufficient permissions", required: ["product.publish"] });
  const [row] = await query(
    `UPDATE products SET deleted_at = NULL, status = 'draft' WHERE id = $1 AND deleted_at IS NOT NULL
     RETURNING id, sku, name`, [req.params.id]);
  if (!row) return res.status(404).json({ error: "Not found or not deleted" });
  res.json(row);
});

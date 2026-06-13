import { Router } from "express";
import { randomBytes } from "node:crypto";
import { query } from "../db.js";
import { runComplianceChecks } from "../lib/compliance.js";
import { validateGtin } from "../lib/gtin.js";
import { dispatch } from "../lib/webhooks.js";
import { requirePermission } from "../middleware/auth.js";

export const features = Router();

/* ---------------- Approval workflow ---------------- */

/** GET /features/products/:id/reviews */
features.get("/products/:id/reviews", async (req, res) => {
  res.json(await query(
    `SELECT * FROM review_comments WHERE product_id = $1 ORDER BY created_at`, [req.params.id]));
});

/** POST /features/products/:id/reviews  {author, body, decision?} — approve moves in_review → published */
features.post("/products/:id/reviews", async (req, res) => {
  const { body, decision } = req.body ?? {};
  const author = req.user?.email ?? "reviewer";
  if (decision && !req.user?.permissions.includes("review.approve"))
    return res.status(403).json({ error: "Insufficient permissions", required: ["review.approve"] });
  if (!body) return res.status(400).json({ error: "body required" });
  const [comment] = await query(
    `INSERT INTO review_comments (product_id, author, body, decision)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [req.params.id, author, body, decision ?? null]);

  if (decision === "approve") {
    const [p] = await query(
      `UPDATE products SET status = 'published' WHERE id = $1 AND status = 'in_review' RETURNING *`,
      [req.params.id]);
    if (p) await dispatch("product.published", { id: p.id, sku: p.sku });
  } else if (decision === "request_changes") {
    await query(`UPDATE products SET status = 'draft' WHERE id = $1 AND status = 'in_review'`, [req.params.id]);
  }
  res.status(201).json(comment);
});

/* ---------------- Publish windows (seasonal) ---------------- */

/** POST /features/products/:id/window  {publish_from?, publish_until?} */
features.post("/products/:id/window", requirePermission("product.publish"), async (req, res) => {
  const { publish_from, publish_until } = req.body ?? {};
  const [row] = await query(
    `UPDATE products SET publish_from = $2, publish_until = $3 WHERE id = $1 RETURNING *`,
    [req.params.id, publish_from ?? null, publish_until ?? null]);
  res.json(row);
});

/* ---------------- Compliance ---------------- */

/** GET /features/products/:id/compliance?markets=DE,SE */
features.get("/products/:id/compliance", async (req, res) => {
  const markets = String(req.query.markets ?? "EU").split(",").map((s) => s.trim());
  const [p] = await query(
    `SELECT p.*, pt.code AS type_code,
            coalesce(json_agg(json_build_object('name', v.name, 'gtin', v.gtin))
                     FILTER (WHERE v.id IS NOT NULL), '[]') AS variants
     FROM products p JOIN product_types pt ON pt.id = p.product_type_id
     LEFT JOIN product_variants v ON v.product_id = p.id
     WHERE p.id = $1 GROUP BY p.id, pt.code`, [req.params.id]);
  if (!p) return res.status(404).json({ error: "Not found" });
  res.json({ markets, issues: runComplianceChecks(p as never, markets) });
});

/* ---------------- GTIN ---------------- */

/** POST /features/variants/:id/gtin  {gtin} — validates check digit + uniqueness */
features.post("/variants/:id/gtin", requirePermission("product.edit"), async (req, res) => {
  const { gtin } = req.body ?? {};
  const check = validateGtin(String(gtin ?? ""));
  if (!check.valid) return res.status(422).json({ error: check.reason });
  try {
    const [row] = await query(
      `UPDATE product_variants SET gtin = $2 WHERE id = $1 RETURNING *`, [req.params.id, gtin]);
    res.json(row);
  } catch (e: any) {
    if (e.code === "23505") return res.status(409).json({ error: "GTIN already used by another variant" });
    throw e;
  }
});

/* ---------------- Localization ---------------- */

/** PATCH /features/products/:id/i18n  {locale, name?, description?, legal_text?} */
features.patch("/products/:id/i18n", requirePermission("product.edit"), async (req, res) => {
  const { locale, ...fields } = req.body ?? {};
  if (!locale) return res.status(400).json({ error: "locale required (e.g. 'de', 'fr')" });
  const [row] = await query(
    `UPDATE products
     SET i18n = jsonb_set(i18n, ARRAY[$2], coalesce(i18n->$2, '{}'::jsonb) || $3::jsonb)
     WHERE id = $1 RETURNING i18n`,
    [req.params.id, locale, JSON.stringify(fields)]);
  res.json(row);
});

/* ---------------- AI enrichment (Claude) ---------------- */

/**
 * POST /features/products/:id/enrich  {tasks?: ["description","tasting_notes","alt_text"]}
 * Uses the Anthropic API. Set ANTHROPIC_API_KEY in .env.
 * Output is stored as a draft suggestion, never auto-published.
 */
features.post("/products/:id/enrich", requirePermission("product.edit"), async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(501).json({ error: "Set ANTHROPIC_API_KEY to enable enrichment" });

  const [p] = await query(
    `SELECT p.*, pt.name AS type_name FROM products p
     JOIN product_types pt ON pt.id = p.product_type_id WHERE p.id = $1`, [req.params.id]);
  if (!p) return res.status(404).json({ error: "Not found" });

  const tasks: string[] = req.body?.tasks ?? ["description"];
  const prompt = `You write product copy for a beverage catalog.
Product: ${p.name} (${p.type_name}). Attributes: ${JSON.stringify(p.attributes)}.
Tasks: ${tasks.join(", ")}.
Respond ONLY with JSON: {${tasks.map((t) => `"${t}": "..."`).join(", ")}}.
Keep each under 80 words, factual, grounded in the attributes given. No invented awards or origins.`;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 600, messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) return res.status(502).json({ error: "Enrichment service error" });
  const data = await r.json() as { content: { type: string; text?: string }[] };
  const text = data.content.map((c) => c.text ?? "").join("").replace(/```json|```/g, "").trim();
  let suggestions: Record<string, string>;
  try { suggestions = JSON.parse(text); }
  catch { return res.status(502).json({ error: "Could not parse enrichment output", raw: text }); }

  await query(
    `UPDATE products SET attributes = attributes || jsonb_build_object('_ai_suggestions', $2::jsonb) WHERE id = $1`,
    [p.id, JSON.stringify(suggestions)]);
  res.json({ suggestions, note: "Stored under attributes._ai_suggestions — review before applying" });
});

/* ---------------- Public asset portal ---------------- */

/** POST /features/share  {product_id? , brand_id?, expires_in_days?} → portal URL */
features.post("/share", requirePermission("settings.manage"), async (req, res) => {
  const { product_id, brand_id, expires_in_days } = req.body ?? {};
  if (!product_id && !brand_id) return res.status(400).json({ error: "product_id or brand_id required" });
  const token = randomBytes(16).toString("base64url");
  const expires = expires_in_days ? new Date(Date.now() + expires_in_days * 864e5) : null;
  await query(
    `INSERT INTO share_links (token, product_id, brand_id, expires_at, created_by)
     VALUES ($1,$2,$3,$4,$5)`,
    [token, product_id ?? null, brand_id ?? null, expires, req.header("x-user") ?? "api"]);
  res.status(201).json({ url: `/portal/${token}`, expires_at: expires });
});

/** GET /portal/:token — public, read-only: published product info + approved assets */
export const portal = Router();
portal.get("/:token", async (req, res) => {
  const [link] = await query(
    `SELECT * FROM share_links WHERE token = $1 AND (expires_at IS NULL OR expires_at > now())`,
    [req.params.token]);
  if (!link) return res.status(404).json({ error: "Link expired or not found" });
  const rows = await query(
    `SELECT p.sku, p.name, p.description, p.attributes, b.name AS brand,
            coalesce(json_agg(json_build_object('filename', a.filename, 'role', pa.role, 'key', a.storage_key))
                     FILTER (WHERE a.id IS NOT NULL), '[]') AS assets
     FROM products p
     LEFT JOIN brands b ON b.id = p.brand_id
     LEFT JOIN product_assets pa ON pa.product_id = p.id
     LEFT JOIN assets a ON a.id = pa.asset_id
     WHERE p.status = 'published' AND p.deleted_at IS NULL
       AND (p.id = $1 OR p.brand_id = $2)
     GROUP BY p.id, b.name`,
    [link.product_id, link.brand_id]);
  res.json({ products: rows });
});

/* ---------------- Webhooks admin ---------------- */

features.get("/webhooks", requirePermission("settings.manage"), async (_req, res) => {
  res.json(await query(`SELECT id, url, events, active, created_at FROM webhooks ORDER BY created_at`));
});
features.post("/webhooks", requirePermission("settings.manage"), async (req, res) => {
  const { url, events } = req.body ?? {};
  if (!url) return res.status(400).json({ error: "url required" });
  const secret = randomBytes(24).toString("hex");
  const [row] = await query(
    `INSERT INTO webhooks (url, events, secret) VALUES ($1,$2,$3) RETURNING id, url, events`,
    [url, events ?? ["product.updated", "product.published"], secret]);
  res.status(201).json({ ...row, secret, note: "Store the secret — payloads are HMAC-SHA256 signed (x-signature header)" });
});
features.delete("/webhooks/:id", requirePermission("settings.manage"), async (req, res) => {
  await query(`DELETE FROM webhooks WHERE id = $1`, [req.params.id]);
  res.status(204).end();
});

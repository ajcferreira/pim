import { Router } from "express";
import multer from "multer";
import { createHash } from "node:crypto";
import path from "node:path";
import { query } from "../db.js";
import sharp from "sharp";
import { requirePermission } from "../middleware/auth.js";
import { contentMatchesMime } from "../lib/sniff.js";
import { enqueue } from "../lib/queue.js";
import { storage, safeKey, contentTypeFor } from "../lib/storage.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

export const assets = Router();

/** POST /assets — multipart upload; deduplicates by checksum */
assets.post("/", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "file field required" });
  // Magic-byte check: the content must match the claimed mimetype
  if (!contentMatchesMime(req.file.buffer, req.file.mimetype))
    return res.status(422).json({ error: "File content does not match its declared type" });

  const checksum = createHash("sha256").update(req.file.buffer).digest("hex");
  const key = `${checksum.slice(0, 2)}/${checksum}${path.extname(req.file.originalname)}`;

  const [existing] = await query(`SELECT * FROM assets WHERE checksum = $1`, [checksum]);
  if (existing) return res.json({ ...existing, deduplicated: true });

  await storage.put(key, req.file.buffer, req.file.mimetype);

  const tags = typeof req.body.tags === "string"
    ? req.body.tags.split(",").map((t: string) => t.trim()).filter(Boolean)
    : [];

  // Folder placement (Pimcore: asset tree). Normalized to /a/b/ form.
  const folder = ("/" + String(req.body.folder ?? "").replace(/[^a-zA-Z0-9/_-]/g, "")
    .split("/").filter(Boolean).join("/") + "/").replace(/\/+/g, "/");

  // EXIF/technical metadata extraction for raster images
  let exif: Record<string, unknown> = {};
  let dims: { width?: number; height?: number } = {};
  if (/^image\//.test(req.file.mimetype)) {
    try {
      const m = await sharp(req.file.buffer).metadata();
      dims = { width: m.width, height: m.height };
      exif = { format: m.format, density: m.density, hasAlpha: m.hasAlpha,
               orientation: m.orientation, space: m.space };
    } catch { /* not a readable image */ }
  }

  const [row] = await query(
    `INSERT INTO assets (filename, mime_type, byte_size, storage_key, checksum, alt_text, tags, metadata, folder, width, height)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11) RETURNING *`,
    [req.file.originalname, req.file.mimetype, req.file.size, key, checksum,
     req.body.alt_text ?? null, tags, JSON.stringify({ renditions: [], exif }), folder,
     dims.width ?? null, dims.height ?? null]
  );
  if (/^image\/(png|jpe?g|webp)$/.test(req.file.mimetype))
    await enqueue("renditions", { assetId: row.id, storageKey: key, mime: req.file.mimetype });
  res.status(201).json(row);
});

/** GET /assets?tag=label&q=stout&folder=/labels/ */
assets.get("/", async (req, res) => {
  const { tag, q, folder } = req.query as Record<string, string>;
  const where: string[] = [];
  const params: unknown[] = [];
  if (tag) { params.push(tag); where.push(`$${params.length} = ANY(tags)`); }
  if (folder) { params.push(folder.endsWith("/") ? folder + "%" : folder + "/%");
    where.push(`folder LIKE $${params.length}`); }   // subtree match
  if (q) { params.push(`%${q}%`); where.push(`filename ILIKE $${params.length}`); }
  res.json(await query(
    `SELECT * FROM assets ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY created_at DESC LIMIT 100`, params));
});

/** GET /assets/file/* — serve originals and renditions through the API
 *  (private bucket: RBAC and portal tokens stay the access model) */
assets.get("/file/*", async (req, res) => {
  const key = safeKey((req.params as Record<string, string>)[0] ?? "");
  if (!key) return res.status(400).json({ error: "Invalid path" });
  const buf = await storage.get(key);
  if (!buf) return res.status(404).json({ error: "File not found" });
  res.setHeader("content-type", contentTypeFor(key));
  res.setHeader("cache-control", "public, max-age=31536000, immutable"); // content-addressed = safe to cache forever
  res.send(buf);
});

/** PATCH /assets/:id — focal point for smart cropping (0..1 coords), alt text, folder, tags */
assets.patch("/:id", requirePermission("product.edit"), async (req, res) => {
  const { focal_x, focal_y, alt_text, folder, tags } = req.body ?? {};
  for (const v of [focal_x, focal_y]) {
    if (v !== undefined && v !== null && (typeof v !== "number" || v < 0 || v > 1))
      return res.status(422).json({ error: "focal_x/focal_y must be between 0 and 1" });
  }
  const [row] = await query(
    `UPDATE assets SET focal_x = coalesce($2, focal_x), focal_y = coalesce($3, focal_y),
            alt_text = coalesce($4, alt_text), folder = coalesce($5, folder),
            tags = coalesce($6, tags)
     WHERE id = $1 RETURNING *`,
    [req.params.id, focal_x ?? null, focal_y ?? null, alt_text ?? null, folder ?? null, tags ?? null]);
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(row);
});

assets.delete("/:id", async (req, res) => {
  const [asset] = await query(`SELECT storage_key, metadata FROM assets WHERE id = $1`, [req.params.id]);
  if (!asset) return res.status(404).json({ error: "Not found" });
  // Remove the original and every rendition — no orphaned files
  const keys = [asset.storage_key as string,
    ...(((asset.metadata as { renditions?: { key: string }[] })?.renditions) ?? []).map((r) => r.key)];
  for (const k of keys) {
    const sk = safeKey(k);
    if (sk) await storage.delete(sk).catch(() => {});
  }
  await query(`DELETE FROM assets WHERE id = $1`, [req.params.id]);
  res.status(204).end();
});

/** POST /assets/:id/link — attach an asset to a product with a role */
assets.post("/:id/link", async (req, res) => {
  const { product_id, role = "other", sort_order = 0 } = req.body ?? {};
  if (!product_id) return res.status(400).json({ error: "product_id required" });
  await query(
    `INSERT INTO product_assets (product_id, asset_id, role, sort_order)
     VALUES ($1,$2,$3::asset_role,$4)
     ON CONFLICT (product_id, asset_id, role) DO UPDATE SET sort_order = $4`,
    [product_id, req.params.id, role, sort_order]
  );
  res.status(204).end();
});

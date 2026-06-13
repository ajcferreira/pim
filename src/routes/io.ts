import { Router } from "express";
import multer from "multer";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { query } from "../db.js";
import { storage } from "../lib/storage.js";
import { getTypeAttributes } from "../validation.js";
import { enqueue } from "../lib/queue.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
export const io = Router();

/**
 * GET /io/export.csv?type=beer
 * Fixed columns first, then one column per attribute code of the type.
 */
io.get("/export.csv", async (req, res) => {
  const typeCode = String(req.query.type ?? "");
  const [type] = await query(`SELECT * FROM product_types WHERE code = $1`, [typeCode]);
  if (!type) return res.status(400).json({ error: "type query param required (e.g. ?type=beer)" });

  const defs = await getTypeAttributes(type.id as string);
  const products = await query(
    `SELECT p.sku, p.name, b.name AS brand, p.status, p.attributes
     FROM products p LEFT JOIN brands b ON b.id = p.brand_id
     WHERE p.product_type_id = $1 ORDER BY p.sku`, [type.id]);

  const header = ["sku", "name", "brand", "status", ...defs.map((d) => d.code)];
  const rows = products.map((p) => [
    p.sku, p.name, p.brand ?? "", p.status,
    ...defs.map((d) => {
      const v = (p.attributes as Record<string, unknown>)[d.code];
      return Array.isArray(v) ? v.join("|") : v ?? "";
    }),
  ]);
  res.setHeader("content-type", "text/csv");
  res.setHeader("content-disposition", `attachment; filename="${typeCode}-export.csv"`);
  res.send(stringify([header, ...rows]));
});

/**
 * POST /io/import.csv?type=beer  (multipart: file)
 * Asynchronous: the file is queued for a background worker.
 * Poll GET /io/imports/:id for status and the per-row report.
 */
io.post("/import.csv", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "file field required" });
  const typeCode = String(req.query.type ?? "");
  const [type] = await query(`SELECT id FROM product_types WHERE code = $1`, [typeCode]);
  if (!type) return res.status(400).json({ error: "type query param required" });

  const [job] = await query(
    `INSERT INTO import_jobs (filename, status) VALUES ($1, 'pending') RETURNING id`,
    [req.file.originalname]);

  const storageKey = `imports/${job.id}.csv`;
  await storage.put(storageKey, req.file.buffer, "text/csv");

  await enqueue("csv-import", { importId: job.id, storageKey, typeCode });
  res.status(202).json({ job_id: job.id, status: "pending",
    poll: `/io/imports/${job.id}` });
});

/** GET /io/imports/:id — job status + report when finished */
io.get("/imports/:id", async (req, res) => {
  const [job] = await query(`SELECT * FROM import_jobs WHERE id = $1`, [req.params.id]);
  if (!job) return res.status(404).json({ error: "Not found" });
  res.json(job);
});

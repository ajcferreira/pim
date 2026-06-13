import { parse } from "csv-parse/sync";
import { query, withTransaction } from "../db.js";
import { getTypeAttributes, validateAttributes } from "../validation.js";

/** Process a CSV buffer for a product type; updates the import_jobs row. */
export async function processImportFile(importId: string, buffer: Buffer, typeCode: string): Promise<void> {
  const [type] = await query(`SELECT * FROM product_types WHERE code = $1`, [typeCode]);
  if (!type) throw new Error(`Unknown product type '${typeCode}'`);

  const defs = await getTypeAttributes(type.id as string);
  const byCode = new Map(defs.map((d) => [d.code, d]));
  const calculated = new Set(defs.filter((d) => (d as { formula?: string }).formula).map((d) => d.code));
  const records: Record<string, string>[] = parse(buffer, { columns: true, skip_empty_lines: true, trim: true });

  let created = 0, updated = 0;
  const report: { row: number; sku: string; status: string; issues?: unknown }[] = [];

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (!r.sku || !r.name) { report.push({ row: i + 2, sku: r.sku ?? "", status: "error", issues: ["sku and name required"] }); continue; }

    const attrs: Record<string, unknown> = {};
    for (const [k, raw] of Object.entries(r)) {
      const def = byCode.get(k);
      if (!def || raw === "" || calculated.has(k)) continue;
      attrs[k] =
        def.data_type === "number" ? Number(raw) :
        def.data_type === "boolean" ? ["true", "1", "yes"].includes(raw.toLowerCase()) :
        def.data_type === "multiselect" ? raw.split("|").map((s) => s.trim()) :
        raw;
    }
    const issues = validateAttributes(attrs, defs.filter((d) => !calculated.has(d.code)), { partial: true });
    if (issues.length) { report.push({ row: i + 2, sku: r.sku, status: "error", issues }); continue; }

    try {
      const inserted = await withTransaction(async (q) => {
        let brandId: string | null = null;
        if (r.brand) {
          const [b] = await q(
            `INSERT INTO brands (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = $1 RETURNING id`, [r.brand]);
          brandId = b.id as string;
        }
        const [row] = await q(
          `INSERT INTO products (sku, name, product_type_id, brand_id, attributes)
           VALUES ($1,$2,$3,$4,$5::jsonb)
           ON CONFLICT (sku) DO UPDATE SET
             name = $2, brand_id = coalesce($4, products.brand_id),
             attributes = products.attributes || $5::jsonb,
             version = products.version + 1
           RETURNING (xmax = 0) AS inserted`,
          [r.sku, r.name, type.id, brandId, JSON.stringify(attrs)]);
        return row.inserted as boolean;
      });
      inserted ? created++ : updated++;
      report.push({ row: i + 2, sku: r.sku, status: inserted ? "created" : "updated" });
    } catch (e) {
      report.push({ row: i + 2, sku: r.sku, status: "error", issues: [(e as Error).message] });
    }
  }

  await query(
    `UPDATE import_jobs SET total_rows = $2, created_ct = $3, updated_ct = $4,
            error_ct = $5, report = $6::jsonb WHERE id = $1`,
    [importId, records.length, created, updated,
     report.filter((r) => r.status === "error").length, JSON.stringify(report)]);
}

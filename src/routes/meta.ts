import { Router } from "express";
import { z } from "zod";
import { query } from "../db.js";
import { getTypeAttributes } from "../validation.js";

export const meta = Router();

/** GET /meta/types — all product types with their attribute sets */
meta.get("/types", async (_req, res) => {
  const types = await query(`SELECT * FROM product_types ORDER BY name`);
  const withAttrs = await Promise.all(
    types.map(async (t) => ({ ...t, attributes: await getTypeAttributes(t.id as string) }))
  );
  res.json(withAttrs);
});

/** POST /meta/types — create a new product type (attribute set) */
meta.post("/types", async (req, res) => {
  const Input = z.object({ code: z.string().regex(/^[a-z0-9_]+$/), name: z.string().min(1), description: z.string().nullish() });
  const parsed = Input.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.flatten() });
  const [row] = await query(
    `INSERT INTO product_types (code, name, description) VALUES ($1,$2,$3) RETURNING *`,
    [parsed.data.code, parsed.data.name, parsed.data.description ?? null]
  );
  res.status(201).json(row);
});

/** GET /meta/attributes — the reusable attribute library */
meta.get("/attributes", async (_req, res) => {
  res.json(await query(`SELECT * FROM attributes ORDER BY code`));
});

/** POST /meta/attributes — define a new attribute */
meta.post("/attributes", async (req, res) => {
  const Input = z.object({
    code: z.string().regex(/^[a-z0-9_]+$/),
    label: z.string().min(1),
    data_type: z.enum(["text", "long_text", "number", "boolean", "select", "multiselect", "date"]),
    unit: z.string().nullish(),
    options: z.array(z.string()).nullish(),
    validation: z.record(z.unknown()).nullish(),
  });
  const parsed = Input.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.flatten() });
  const d = parsed.data;
  const [row] = await query(
    `INSERT INTO attributes (code, label, data_type, unit, options, validation)
     VALUES ($1,$2,$3::attribute_type,$4,$5::jsonb,$6::jsonb) RETURNING *`,
    [d.code, d.label, d.data_type, d.unit ?? null,
     d.options ? JSON.stringify(d.options) : null,
     d.validation ? JSON.stringify(d.validation) : null]
  );
  res.status(201).json(row);
});

/** POST /meta/types/:id/attributes — attach an attribute to a type */
meta.post("/types/:id/attributes", async (req, res) => {
  const Input = z.object({
    attribute_id: z.string().uuid(),
    group_name: z.string().default("General"),
    is_required: z.boolean().default(false),
    sort_order: z.number().int().default(0),
  });
  const parsed = Input.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.flatten() });
  const d = parsed.data;
  await query(
    `INSERT INTO product_type_attributes (product_type_id, attribute_id, group_name, is_required, sort_order)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (product_type_id, attribute_id)
     DO UPDATE SET group_name=$3, is_required=$4, sort_order=$5`,
    [req.params.id, d.attribute_id, d.group_name, d.is_required, d.sort_order]
  );
  res.status(204).end();
});

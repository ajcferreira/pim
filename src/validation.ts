import { query } from "./db.js";

export interface AttributeDef {
  code: string;
  label: string;
  data_type:
    | "text"
    | "long_text"
    | "number"
    | "boolean"
    | "select"
    | "multiselect"
    | "date";
  unit: string | null;
  options: string[] | null;
  validation: {
    min?: number;
    max?: number;
    maxLength?: number;
    pattern?: string;
  } | null;
  is_required: boolean;
  group_name: string;
  sort_order: number;
}

/** Load the attribute set for a product type. */
export async function getTypeAttributes(
  productTypeId: string
): Promise<AttributeDef[]> {
  return query<AttributeDef>(
    `SELECT a.code, a.label, a.data_type, a.unit, a.options, a.validation,
            pta.is_required, pta.group_name, pta.sort_order
     FROM product_type_attributes pta
     JOIN attributes a ON a.id = pta.attribute_id
     WHERE pta.product_type_id = $1
     ORDER BY pta.sort_order`,
    [productTypeId]
  );
}

export interface ValidationIssue {
  attribute: string;
  message: string;
}

/**
 * Validate a JSONB attributes payload against the product type's
 * attribute definitions. Returns a list of issues (empty = valid).
 */
export function validateAttributes(
  values: Record<string, unknown>,
  defs: AttributeDef[],
  { partial = false } = {}
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const byCode = new Map(defs.map((d) => [d.code, d]));

  // Unknown keys are rejected — keeps the JSONB clean.
  for (const key of Object.keys(values)) {
    if (!byCode.has(key)) {
      issues.push({ attribute: key, message: "Unknown attribute for this product type" });
    }
  }

  for (const def of defs) {
    const v = values[def.code];
    if (v === undefined || v === null || v === "") {
      if (def.is_required && !partial) {
        issues.push({ attribute: def.code, message: "Required" });
      }
      continue;
    }
    const rule = def.validation ?? {};
    switch (def.data_type) {
      case "number": {
        if (typeof v !== "number" || Number.isNaN(v)) {
          issues.push({ attribute: def.code, message: "Must be a number" });
        } else {
          if (rule.min !== undefined && v < rule.min)
            issues.push({ attribute: def.code, message: `Must be ≥ ${rule.min}` });
          if (rule.max !== undefined && v > rule.max)
            issues.push({ attribute: def.code, message: `Must be ≤ ${rule.max}` });
        }
        break;
      }
      case "boolean":
        if (typeof v !== "boolean")
          issues.push({ attribute: def.code, message: "Must be true or false" });
        break;
      case "text":
      case "long_text": {
        if (typeof v !== "string") {
          issues.push({ attribute: def.code, message: "Must be text" });
        } else {
          if (rule.maxLength && v.length > rule.maxLength)
            issues.push({ attribute: def.code, message: `Max ${rule.maxLength} characters` });
          if (rule.pattern && !new RegExp(rule.pattern).test(v))
            issues.push({ attribute: def.code, message: "Invalid format" });
        }
        break;
      }
      case "select":
        if (typeof v !== "string" || !(def.options ?? []).includes(v))
          issues.push({ attribute: def.code, message: "Not an allowed option" });
        break;
      case "multiselect": {
        const opts = def.options ?? [];
        if (!Array.isArray(v) || v.some((x) => !opts.includes(String(x))))
          issues.push({ attribute: def.code, message: "Contains a non-allowed option" });
        break;
      }
      case "date":
        if (typeof v !== "string" || Number.isNaN(Date.parse(v)))
          issues.push({ attribute: def.code, message: "Must be an ISO date" });
        break;
    }
  }
  return issues;
}

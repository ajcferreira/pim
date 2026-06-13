import { query } from "../db.js";

/* ============ Attribute inheritance (Pimcore: inherited values) ============ */

/**
 * Resolve effective attributes by walking up the parent chain (max 5 levels).
 * Child values override parent values; missing child values fall through.
 * Returns the merged values plus a map of which ancestor supplied each code.
 */
export async function resolveEffectiveAttributes(productId: string): Promise<{
  effective: Record<string, unknown>;
  inherited_from: Record<string, string>;   // attr code → ancestor sku
}> {
  type Node = { sku: string; attributes: Record<string, unknown>; parent_id: string | null };
  const chain: Node[] = [];
  let currentId: string | null = productId;
  for (let depth = 0; currentId && depth < 5; depth++) {
    const rows = await query(
      `SELECT sku, attributes, parent_id FROM products WHERE id = $1`, [currentId]) as Node[];
    const row = rows[0];
    if (!row) break;
    chain.push(row);
    currentId = row.parent_id;
  }
  const effective: Record<string, unknown> = {};
  const inherited_from: Record<string, string> = {};
  // Apply from the root ancestor down to the product itself
  for (const node of [...chain].reverse()) {
    for (const [k, v] of Object.entries(node.attributes ?? {})) {
      effective[k] = v;
      if (node !== chain[0]) inherited_from[k] = node.sku;
      else delete inherited_from[k];        // own value overrides → not inherited
    }
  }
  return { effective, inherited_from };
}

/* ============ Workflow engine (Pimcore: configurable workflows) ============ */

export interface WorkflowTransition {
  from: string;
  to: string;
  permission?: string;
  requires_complete?: boolean;
}
export interface WorkflowDef {
  states: string[];
  transitions: WorkflowTransition[];
}

/** Load the workflow for a product type, falling back to the default. */
export async function loadWorkflow(productTypeId: string): Promise<WorkflowDef> {
  const [row] = await query<{ definition: WorkflowDef }>(
    `SELECT definition FROM workflows
     WHERE product_type_id = $1 OR product_type_id IS NULL
     ORDER BY product_type_id NULLS LAST LIMIT 1`, [productTypeId]);
  return row?.definition ?? { states: [], transitions: [] };
}

export type TransitionCheck =
  | { ok: true; requires_complete: boolean }
  | { ok: false; status: 403 | 422; error: string; required?: string[] };

/** Validate a status transition against the workflow and the user's permissions. */
export function checkTransition(
  wf: WorkflowDef, from: string, to: string, permissions: string[]
): TransitionCheck {
  const t = wf.transitions.find((x) => x.from === from && x.to === to);
  if (!t) return {
    ok: false, status: 422,
    error: `No workflow transition from '${from}' to '${to}'. Allowed: ${
      wf.transitions.filter((x) => x.from === from).map((x) => x.to).join(", ") || "none"}`,
  };
  if (t.permission && !permissions.includes(t.permission))
    return { ok: false, status: 403, error: "Insufficient permissions", required: [t.permission] };
  return { ok: true, requires_complete: !!t.requires_complete };
}

/* ============ Workspaces (Pimcore: object-level permissions) ============ */

export interface UserScope {
  scoped: boolean;            // false = unrestricted
  brandIds: string[];
  categoryIds: string[];      // includes descendants
}

/** Load a user's workspace scope. No rows = unrestricted access. */
export async function loadScope(userId: string): Promise<UserScope> {
  const rows = await query<{ brand_id: string | null; category_id: string | null }>(
    `SELECT brand_id, category_id FROM user_scopes WHERE user_id = $1`, [userId]);
  if (!rows.length) return { scoped: false, brandIds: [], categoryIds: [] };

  const brandIds = rows.map((r) => r.brand_id).filter((x): x is string => !!x);
  const roots = rows.map((r) => r.category_id).filter((x): x is string => !!x);
  let categoryIds: string[] = [];
  if (roots.length) {
    const sub = await query<{ id: string }>(
      `WITH RECURSIVE tree AS (
         SELECT id FROM categories WHERE id = ANY($1)
         UNION ALL
         SELECT c.id FROM categories c JOIN tree t ON c.parent_id = t.id
       ) SELECT id FROM tree`, [roots]);
    categoryIds = sub.map((r) => r.id);
  }
  return { scoped: true, brandIds, categoryIds };
}

/** True if the product (by brand/categories) is inside the user's workspace. */
export async function inScope(scope: UserScope, productId: string): Promise<boolean> {
  if (!scope.scoped) return true;
  const [row] = await query<{ brand_id: string | null; cats: string[] }>(
    `SELECT p.brand_id,
            coalesce(array_agg(pc.category_id) FILTER (WHERE pc.category_id IS NOT NULL), '{}') AS cats
     FROM products p LEFT JOIN product_categories pc ON pc.product_id = p.id
     WHERE p.id = $1 GROUP BY p.id`, [productId]);
  if (!row) return false;
  if (row.brand_id && scope.brandIds.includes(row.brand_id)) return true;
  return row.cats.some((c) => scope.categoryIds.includes(c));
}

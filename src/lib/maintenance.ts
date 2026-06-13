import { withTransaction, query } from "../db.js";
import { logger } from "./logger.js";
import { dispatch } from "./webhooks.js";

/** Run fn only if this instance wins the transaction-scoped advisory lock —
 *  safe with connection pools (lock auto-releases at COMMIT/ROLLBACK). */
async function withLock(key: number, fn: (q: typeof query) => Promise<void>): Promise<boolean> {
  return withTransaction(async (q) => {
    const [r] = await q<{ ok: boolean }>(`SELECT pg_try_advisory_xact_lock($1) AS ok`, [key]);
    if (!r.ok) return false;     // another instance is running this job
    await fn(q);
    return true;
  });
}

/** Archive published products past their publish window. */
export async function sweepPublishWindows(): Promise<void> {
  await withLock(1001, async (q) => {
    const rows = await q(
      `UPDATE products SET status = 'archived'
       WHERE status = 'published' AND publish_until IS NOT NULL AND publish_until < now()
         AND deleted_at IS NULL
       RETURNING id, sku`);
    for (const r of rows) await dispatch("product.archived", r);
    if (rows.length) logger.info({ count: rows.length }, "publish-window sweep archived products");
  });
}

/** Retention: prune unbounded tables on a schedule. */
export async function pruneRetention(): Promise<void> {
  await withLock(1002, async (q) => {
    const [versions] = await q<{ count: string }>(
      `WITH ranked AS (
         SELECT id, row_number() OVER (PARTITION BY product_id ORDER BY version DESC) AS rn
         FROM product_versions)
       DELETE FROM product_versions pv USING ranked
       WHERE pv.id = ranked.id AND ranked.rn > 50
       RETURNING 1 AS count`);
    await q(`DELETE FROM webhook_deliveries WHERE delivered_at < now() - interval '30 days'`);
    await q(`DELETE FROM idempotency_keys WHERE created_at < now() - interval '24 hours'`);
    await q(`DELETE FROM login_attempts WHERE attempted_at < now() - interval '1 hour'`);
    await q(`DELETE FROM refresh_tokens WHERE expires_at < now()`);
    await q(`DELETE FROM password_resets WHERE expires_at < now() OR used_at IS NOT NULL`);
    logger.info({ versions_pruned: versions ? 1 : 0 }, "retention prune complete");
  });
}

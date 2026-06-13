import PgBoss from "pg-boss";
import { createHmac } from "node:crypto";
import { query } from "../db.js";
import { logger } from "./logger.js";
import { generateRenditions } from "./renditions.js";
import { processImportFile } from "./importCsv.js";
import { storage } from "./storage.js";

let boss: PgBoss | null = null;

export async function getBoss(): Promise<PgBoss> {
  if (!boss) {
    boss = new PgBoss({ connectionString: process.env.DATABASE_URL });
    boss.on("error", (e) => logger.error({ err: e }, "pg-boss error"));
    await boss.start();
  }
  return boss;
}

export async function stopBoss(): Promise<void> {
  if (boss) { await boss.stop({ graceful: true }); boss = null; }
}

/** Register background workers. Call once per worker process. */
export async function startWorkers(): Promise<void> {
  const b = await getBoss();

  // Webhook delivery: pg-boss owns retries (3 attempts, exponential backoff)
  await b.createQueue("webhook-deliver");
  await b.work("webhook-deliver", { batchSize: 5 }, async (jobs) => {
    for (const job of jobs) {
      const { webhookId, url, secret, event, payload } = job.data as Record<string, string>;
      const body = JSON.stringify({ event, data: payload, ts: Date.now() });
      const sig = createHmac("sha256", secret).update(body).digest("hex");
      let status = 0;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-signature": `sha256=${sig}` },
          body, signal: AbortSignal.timeout(5000),
        });
        status = res.status;
      } catch { status = 0; }
      await query(
        `INSERT INTO webhook_deliveries (webhook_id, event, payload, status_code, attempt)
         VALUES ($1,$2,$3::jsonb,$4,$5)`,
        [webhookId, event, body, status, (job as { retryCount?: number }).retryCount ?? 0 + 1]);
      if (status < 200 || status >= 300) throw new Error(`Delivery failed (${status})`);
    }
  });

  // CSV imports: heavy row processing off the request path.
  // The file travels through object storage, so any instance can process it.
  await b.createQueue("csv-import");
  await b.work("csv-import", async (jobs) => {
    for (const job of jobs) {
      const { importId, storageKey, typeCode } = job.data as Record<string, string>;
      await query(`UPDATE import_jobs SET status = 'running' WHERE id = $1`, [importId]);
      try {
        const buffer = await storage.get(storageKey);
        if (!buffer) throw new Error("Import file missing from storage");
        await processImportFile(importId, buffer, typeCode);
        await query(`UPDATE import_jobs SET status = 'completed' WHERE id = $1`, [importId]);
      } catch (e) {
        logger.error({ err: e, importId }, "import failed");
        await query(
          `UPDATE import_jobs SET status = 'failed',
                  report = report || $2::jsonb WHERE id = $1`,
          [importId, JSON.stringify([{ status: "error", issues: [(e as Error).message] }])]);
        throw e;
      } finally {
        await storage.delete(storageKey).catch(() => {});
      }
    }
  });

  // Renditions: image processing off the upload path
  await b.createQueue("renditions");
  await b.work("renditions", async (jobs) => {
    for (const job of jobs) {
      const { assetId, storageKey, mime } = job.data as Record<string, string>;
      const buffer = await storage.get(storageKey);
      if (!buffer) throw new Error("Original missing from storage");
      const pending: Promise<void>[] = [];
      const renditions = await generateRenditions(buffer, mime, storageKey, (buf, k) => {
        pending.push(storage.put(k, buf, "image/webp"));
      });
      await Promise.all(pending);
      await query(
        `UPDATE assets SET metadata = jsonb_set(metadata, '{renditions}', $2::jsonb) WHERE id = $1`,
        [assetId, JSON.stringify(renditions)]);
    }
  });

  logger.info("background workers started (webhook-deliver, csv-import, renditions)");
}

export async function enqueue(name: string, data: object, opts?: PgBoss.SendOptions): Promise<string | null> {
  const b = await getBoss();
  return b.send(name, data, { retryLimit: 3, retryBackoff: true, ...opts });
}

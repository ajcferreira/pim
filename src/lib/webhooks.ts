import { query } from "../db.js";
import { enqueue } from "./queue.js";

/** Enqueue an event for all subscribed webhooks. Delivery (with 3 retries
 *  and exponential backoff) happens in the background worker. */
export async function dispatch(event: string, payload: unknown): Promise<void> {
  const hooks = await query(
    `SELECT id, url, secret FROM webhooks WHERE active AND $1 = ANY(events)`, [event]);
  await Promise.allSettled(hooks.map((h) =>
    enqueue("webhook-deliver", { webhookId: h.id, url: h.url, secret: h.secret, event, payload })));
}

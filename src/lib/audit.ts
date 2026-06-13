import { query } from "../db.js";
import { logger } from "./logger.js";

export async function audit(event: string, fields: {
  user_id?: string | null; email?: string | null; ip?: string; detail?: unknown;
} = {}): Promise<void> {
  try {
    await query(
      `INSERT INTO auth_audit (user_id, email, event, ip, detail) VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [fields.user_id ?? null, fields.email ?? null, event, fields.ip ?? null,
       fields.detail ? JSON.stringify(fields.detail) : null]);
  } catch (e) {
    logger.error({ err: e, event }, "audit write failed");   // never block the request
  }
}

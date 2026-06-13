import { query } from "../db.js";

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

/** Returns seconds to wait, or 0 if allowed. Backed by Postgres — shared
 *  across instances and restart-safe. */
export async function loginRateCheck(key: string): Promise<number> {
  const rows = await query<{ attempted_at: Date }>(
    `SELECT attempted_at FROM login_attempts
     WHERE rate_key = $1 AND attempted_at > now() - interval '15 minutes'
     ORDER BY attempted_at ASC`, [key]);
  if (rows.length < MAX_ATTEMPTS) return 0;
  const oldest = rows[0].attempted_at.getTime();
  return Math.max(1, Math.ceil((oldest + WINDOW_MS - Date.now()) / 1000));
}

export async function recordLoginFailure(key: string): Promise<void> {
  await query(`INSERT INTO login_attempts (rate_key) VALUES ($1)`, [key]);
}

export async function clearLoginFailures(key: string): Promise<void> {
  await query(`DELETE FROM login_attempts WHERE rate_key = $1`, [key]);
}

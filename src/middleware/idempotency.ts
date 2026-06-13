import type { Request, Response, NextFunction } from "express";
import { query } from "../db.js";

/** POSTs carrying an Idempotency-Key header replay the stored response on retry. */
export function idempotency() {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "POST") return next();
    const clientKey = req.header("idempotency-key");
    if (!clientKey || clientKey.length > 128) return next();

    const key = `${req.user?.sub ?? "anon"}:${req.baseUrl}${req.path}:${clientKey}`;
    const [hit] = await query(`SELECT status_code, response FROM idempotency_keys WHERE key = $1`, [key]);
    if (hit) {
      res.setHeader("x-idempotent-replay", "true");
      return res.status(hit.status_code as number).json(hit.response);
    }
    const original = res.json.bind(res);
    res.json = (body: unknown) => {
      if (res.statusCode < 500) {
        query(
          `INSERT INTO idempotency_keys (key, status_code, response)
           VALUES ($1,$2,$3::jsonb) ON CONFLICT (key) DO NOTHING`,
          [key, res.statusCode, JSON.stringify(body ?? {})]).catch(() => {});
      }
      return original(body);
    };
    next();
  };
}

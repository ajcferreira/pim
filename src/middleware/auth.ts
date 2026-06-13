import type { Request, Response, NextFunction } from "express";
import { verifyToken, type TokenPayload } from "../lib/auth.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { user?: TokenPayload; }
  }
}

/** Parse Bearer token if present; reject if missing/invalid. */
export function authenticate(req: Request, res: Response, next: NextFunction) {
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Authentication required" });
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: "Invalid or expired token" });
  req.user = payload;
  next();
}

/** Gate a route on a permission code, e.g. requirePermission('product.edit'). */
export function requirePermission(...codes: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: "Authentication required" });
    const has = codes.every((c) => req.user!.permissions.includes(c));
    if (!has) return res.status(403).json({
      error: "Insufficient permissions", required: codes,
    });
    next();
  };
}

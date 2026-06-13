import { pino, type Logger } from "pino";
import { randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: undefined,                       // omit pid/hostname noise
});

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { id: string; log: Logger; }
  }
}

/** Assigns a request ID (honoring inbound x-request-id), logs on completion. */
export function requestLogger() {
  return (req: Request, res: Response, next: NextFunction) => {
    req.id = req.header("x-request-id") ?? randomUUID();
    req.log = logger.child({ req_id: req.id });
    res.setHeader("x-request-id", req.id);
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      req.log[res.statusCode >= 500 ? "error" : "info"]({
        method: req.method, path: req.path, status: res.statusCode,
        ms: Math.round(ms * 10) / 10, user: req.user?.email,
      }, "request");
    });
    next();
  };
}

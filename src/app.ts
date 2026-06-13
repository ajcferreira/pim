import express from "express";
import helmet from "helmet";
import cors from "cors";
import "dotenv/config";
import { products } from "./routes/products.js";
import { meta } from "./routes/meta.js";
import { assets } from "./routes/assets.js";
import { dashboard } from "./routes/dashboard.js";
import { io } from "./routes/io.js";
import { channels } from "./routes/channels.js";
import { features, portal } from "./routes/features.js";
import { auth, users } from "./routes/users.js";
import { objects } from "./routes/objects.js";
import { authenticate, requirePermission } from "./middleware/auth.js";
import { idempotency } from "./middleware/idempotency.js";
import { requestLogger } from "./lib/logger.js";
import { query } from "./db.js";

export function createApp(): express.Express {
  const app = express();
  app.use(helmet());
  app.use(cors({
    origin: process.env.CORS_ORIGIN?.split(",") ?? ["http://localhost:5173"],
    credentials: true,
  }));
  app.use(express.json({ limit: "2mb" }));
  app.use(requestLogger());

  /* Health: liveness (process up) and readiness (DB reachable) */
  app.get("/health/live", (_req, res) => res.json({ ok: true }));
  app.get("/health/ready", async (_req, res) => {
    try { await query("SELECT 1"); res.json({ ok: true, db: "up" }); }
    catch { res.status(503).json({ ok: false, db: "down" }); }
  });
  app.get("/health", (_req, res) => res.redirect(307, "/health/ready"));

  /* Public */
  app.use("/auth", auth);
  app.use("/portal", portal);

  /* Authenticated, permission-gated; idempotency available on all POSTs */
  app.use("/users", users);
  app.use("/products", authenticate, requirePermission("product.view"), idempotency(), products);
  app.use("/meta", authenticate, requirePermission("model.manage"), meta);
  app.use("/assets", authenticate, requirePermission("product.view"), assets);
  app.use("/dashboard", authenticate, requirePermission("product.view"), dashboard);
  app.use("/io", authenticate, requirePermission("import.run"), idempotency(), io);
  app.use("/channels", authenticate, requirePermission("product.view"), channels);
  app.use("/features", authenticate, idempotency(), features);
  app.use("/objects", authenticate, requirePermission("product.view"), objects);

  app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    (req.log ?? console).error({ err }, "unhandled error");
    res.status(500).json({ error: "Internal error", request_id: req.id });
  });
  return app;
}

import { Router } from "express";
import { z } from "zod";
import { query, withTransaction } from "../db.js";
import { hashPassword, verifyPassword, signToken, newRefreshToken, hashRefreshToken } from "../lib/auth.js";
import { loginRateCheck, recordLoginFailure, clearLoginFailures } from "../lib/rateLimit.js";
import { generateTotpSecret, otpauthUrl, verifyTotp } from "../lib/totp.js";
import { audit } from "../lib/audit.js";
import { createHash, randomBytes } from "node:crypto";
import { authenticate, requirePermission } from "../middleware/auth.js";

/* ================= /auth ================= */
export const auth = Router();

async function loadPermissions(userId: string): Promise<string[]> {
  const rows = await query<{ code: string }>(
    `SELECT DISTINCT rp.permission_code AS code
     FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
     WHERE ur.user_id = $1`, [userId]);
  return rows.map((r) => r.code);
}

/** POST /auth/login {email, password} → {access_token, refresh_token, user}
 *  Rate-limited: 5 failed attempts per identity per 15 minutes. */
auth.post("/login", async (req, res) => {
  const { email, password } = req.body ?? {};
  const rateKey = `${req.ip}:${String(email ?? "").toLowerCase()}`;
  const wait = await loginRateCheck(rateKey);
  if (wait > 0) {
    await audit("login_rate_limited", { email, ip: req.ip });
    res.setHeader("retry-after", String(wait));
    return res.status(429).json({ error: `Too many attempts — try again in ${wait}s` });
  }

  const [user] = await query(`SELECT * FROM users WHERE email = $1 AND active`, [email ?? ""]);
  // Same response for unknown email and wrong password — no account enumeration.
  if (!user || !verifyPassword(String(password ?? ""), user.password_hash as string)) {
    await recordLoginFailure(rateKey);
    await audit("login_failure", { email, ip: req.ip });
    return res.status(401).json({ error: "Invalid credentials" });
  }

  // Second factor when enabled: same failure shape, code attempts are rate-limited too
  if (user.totp_enabled) {
    const code = String(req.body?.totp_code ?? "");
    if (!code) return res.status(401).json({ error: "totp_required" });
    if (!verifyTotp(user.totp_secret as string, code)) {
      await recordLoginFailure(rateKey);
      await audit("totp_failure", { user_id: user.id as string, email, ip: req.ip });
      return res.status(401).json({ error: "Invalid credentials" });
    }
  }
  await clearLoginFailures(rateKey);
  await audit("login_success", { user_id: user.id as string, email, ip: req.ip });

  const permissions = await loadPermissions(user.id as string);
  const refresh = newRefreshToken();
  await withTransaction(async (q) => {
    await q(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
    await q(`INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1,$2,$3)`,
      [user.id, refresh.hash, refresh.expiresAt]);
  });
  const access = signToken({ sub: user.id as string, email: user.email as string, permissions });
  res.json({
    access_token: access, refresh_token: refresh.raw, expires_in: 3600,
    user: { id: user.id, email: user.email, name: user.name, permissions },
  });
});

/** POST /auth/refresh {refresh_token} → new access + rotated refresh token */
auth.post("/refresh", async (req, res) => {
  const raw = String(req.body?.refresh_token ?? "");
  if (!raw) return res.status(400).json({ error: "refresh_token required" });
  const [row] = await query(
    `SELECT rt.*, u.email, u.active FROM refresh_tokens rt
     JOIN users u ON u.id = rt.user_id
     WHERE rt.token_hash = $1 AND rt.expires_at > now()`, [hashRefreshToken(raw)]);
  if (!row || !row.active) return res.status(401).json({ error: "Invalid or expired refresh token" });

  const permissions = await loadPermissions(row.user_id as string);
  const next = newRefreshToken();
  await withTransaction(async (q) => {
    // Rotation: the old token is single-use — replay of a stolen token fails.
    await q(`DELETE FROM refresh_tokens WHERE id = $1`, [row.id]);
    await q(`INSERT INTO refresh_tokens (user_id, token_hash, expires_at, last_used_at)
             VALUES ($1,$2,$3, now())`, [row.user_id, next.hash, next.expiresAt]);
  });
  const access = signToken({ sub: row.user_id as string, email: row.email as string, permissions });
  res.json({ access_token: access, refresh_token: next.raw, expires_in: 3600 });
});

/** POST /auth/logout {refresh_token} — revoke this session */
auth.post("/logout", async (req, res) => {
  const raw = String(req.body?.refresh_token ?? "");
  if (raw) await query(`DELETE FROM refresh_tokens WHERE token_hash = $1`, [hashRefreshToken(raw)]);
  res.status(204).end();
});

/** POST /auth/logout-all — revoke every session for the current user (e.g. lost device) */
auth.post("/logout-all", authenticate, async (req, res) => {
  await query(`DELETE FROM refresh_tokens WHERE user_id = $1`, [req.user!.sub]);
  await audit("logout_all", { user_id: req.user!.sub, email: req.user!.email, ip: req.ip });
  res.status(204).end();
});

/* ---------------- Password reset ---------------- */

/** POST /auth/forgot {email} — always 204 (no account enumeration).
 *  In production, deliver resetUrl by email; it is logged here for dev. */
auth.post("/forgot", async (req, res) => {
  const email = String(req.body?.email ?? "").toLowerCase();
  const [user] = await query(`SELECT id FROM users WHERE email = $1 AND active`, [email]);
  if (user) {
    const raw = randomBytes(32).toString("base64url");
    await query(
      `INSERT INTO password_resets (token_hash, user_id, expires_at)
       VALUES ($1,$2, now() + interval '1 hour')`,
      [createHash("sha256").update(raw).digest("hex"), user.id]);
    await audit("password_reset_requested", { user_id: user.id as string, email, ip: req.ip });
    console.log(`[dev] password reset for ${email}: /reset?token=${raw}`);
  }
  res.status(204).end();
});

/** POST /auth/reset {token, password} — single use, revokes all sessions */
auth.post("/reset", async (req, res) => {
  const { token, password } = req.body ?? {};
  if (!token || typeof password !== "string" || password.length < 10)
    return res.status(400).json({ error: "token and password (10+ chars) required" });
  const hash = createHash("sha256").update(String(token)).digest("hex");
  const [row] = await query(
    `UPDATE password_resets SET used_at = now()
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING user_id`, [hash]);
  if (!row) return res.status(401).json({ error: "Invalid or expired reset token" });
  await withTransaction(async (q) => {
    await q(`UPDATE users SET password_hash = $2 WHERE id = $1`, [row.user_id, hashPassword(password)]);
    await q(`DELETE FROM refresh_tokens WHERE user_id = $1`, [row.user_id]);
  });
  await audit("password_reset_completed", { user_id: row.user_id as string, ip: req.ip });
  res.status(204).end();
});

/* ---------------- TOTP 2FA ---------------- */

/** POST /auth/totp/setup — returns secret + otpauth URL for the authenticator app */
auth.post("/totp/setup", authenticate, async (req, res) => {
  const secret = generateTotpSecret();
  await query(`UPDATE users SET totp_secret = $2, totp_enabled = false WHERE id = $1`,
    [req.user!.sub, secret]);
  res.json({ secret, otpauth_url: otpauthUrl(secret, req.user!.email),
    note: "Scan in your authenticator app, then confirm with POST /auth/totp/enable {code}" });
});

/** POST /auth/totp/enable {code} — verifies a live code before enforcing 2FA */
auth.post("/totp/enable", authenticate, async (req, res) => {
  const [user] = await query(`SELECT totp_secret FROM users WHERE id = $1`, [req.user!.sub]);
  if (!user?.totp_secret) return res.status(400).json({ error: "Run /auth/totp/setup first" });
  if (!verifyTotp(user.totp_secret as string, String(req.body?.code ?? "")))
    return res.status(422).json({ error: "Code didn't match — check device clock and retry" });
  await query(`UPDATE users SET totp_enabled = true WHERE id = $1`, [req.user!.sub]);
  await audit("totp_enabled", { user_id: req.user!.sub, email: req.user!.email, ip: req.ip });
  res.json({ enabled: true });
});

/** GET /auth/me — current identity + permissions */
auth.get("/me", authenticate, async (req, res) => {
  const [user] = await query(
    `SELECT u.id, u.email, u.name, u.active,
            coalesce(json_agg(r.code) FILTER (WHERE r.id IS NOT NULL), '[]') AS roles
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id
     WHERE u.id = $1 GROUP BY u.id`, [req.user!.sub]);
  res.json({ ...user, permissions: req.user!.permissions });
});

/* ================= /users (admin) ================= */
export const users = Router();
users.use(authenticate, requirePermission("user.manage"));

/** GET /users — list with roles */
users.get("/", async (_req, res) => {
  res.json(await query(
    `SELECT u.id, u.email, u.name, u.active, u.last_login_at, u.created_at,
            coalesce(json_agg(json_build_object('id', r.id, 'code', r.code, 'name', r.name))
                     FILTER (WHERE r.id IS NOT NULL), '[]') AS roles
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id
     GROUP BY u.id ORDER BY u.created_at`));
});

/** POST /users {email, name, password, role_codes[]} */
users.post("/", async (req, res) => {
  const Input = z.object({
    email: z.string().email(),
    name: z.string().min(1),
    password: z.string().min(10, "Password must be at least 10 characters"),
    role_codes: z.array(z.string()).default(["viewer"]),
  });
  const parsed = Input.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.flatten() });
  const d = parsed.data;

  const user = await withTransaction(async (q) => {
    const [u] = await q(
      `INSERT INTO users (email, name, password_hash) VALUES ($1,$2,$3)
       ON CONFLICT (email) DO NOTHING RETURNING id, email, name`,
      [d.email.toLowerCase(), d.name, hashPassword(d.password)]);
    if (!u) return null;
    await q(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT $1, id FROM roles WHERE code = ANY($2)`, [u.id, d.role_codes]);
    return u;
  });
  if (!user) return res.status(409).json({ error: "Email already registered" });
  await audit("user_created", { user_id: user.id as string, email: user.email as string,
    ip: req.ip, detail: { by: req.user!.email, roles: d.role_codes } });
  res.status(201).json(user);
});

/** PATCH /users/:id {name?, active?, role_codes?, password?} */
users.patch("/:id", async (req, res) => {
  const { name, active, role_codes, password } = req.body ?? {};
  const [existing] = await query(`SELECT * FROM users WHERE id = $1`, [req.params.id]);
  if (!existing) return res.status(404).json({ error: "Not found" });

  // Safety: an admin cannot deactivate themselves or strip their own user.manage.
  const isSelf = req.user!.sub === req.params.id;
  if (isSelf && active === false)
    return res.status(422).json({ error: "You can't deactivate your own account" });

  await query(
    `UPDATE users SET name = coalesce($2, name), active = coalesce($3, active),
            password_hash = coalesce($4, password_hash)
     WHERE id = $1`,
    [req.params.id, name ?? null, active ?? null, password ? hashPassword(password) : null]);
  // Deactivation or password change revokes all sessions immediately
  if (active === false || password)
    await query(`DELETE FROM refresh_tokens WHERE user_id = $1`, [req.params.id]);
  if (active === false) await audit("user_deactivated", { user_id: req.params.id, ip: req.ip, detail: { by: req.user!.email } });
  if (active === true)  await audit("user_reactivated", { user_id: req.params.id, ip: req.ip, detail: { by: req.user!.email } });

  if (Array.isArray(role_codes)) {
    if (isSelf && !role_codes.includes("admin") && req.user!.permissions.includes("user.manage")) {
      const stillManages = await query(
        `SELECT 1 FROM roles r JOIN role_permissions rp ON rp.role_id = r.id
         WHERE r.code = ANY($1) AND rp.permission_code = 'user.manage' LIMIT 1`, [role_codes]);
      if (!stillManages.length)
        return res.status(422).json({ error: "You can't remove your own user-management role" });
    }
    await query(`DELETE FROM user_roles WHERE user_id = $1`, [req.params.id]);
    await query(
      `INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = ANY($2)`,
      [req.params.id, role_codes]);
    await audit("roles_changed", { user_id: req.params.id, ip: req.ip,
      detail: { by: req.user!.email, roles: role_codes } });
  }
  res.json({ ok: true });
});

/** POST /users/:id/scopes — set workspace: [{brand_id?} | {category_id?}]; empty array = unrestricted */
users.post("/:id/scopes", async (req, res) => {
  const Input = z.array(z.object({
    brand_id: z.string().uuid().optional(),
    category_id: z.string().uuid().optional(),
  }).refine((s) => s.brand_id || s.category_id, "brand_id or category_id required"));
  const parsed = Input.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.flatten() });
  await withTransaction(async (q) => {
    await q(`DELETE FROM user_scopes WHERE user_id = $1`, [req.params.id]);
    for (const s of parsed.data)
      await q(`INSERT INTO user_scopes (user_id, brand_id, category_id) VALUES ($1,$2,$3)`,
        [req.params.id, s.brand_id ?? null, s.category_id ?? null]);
  });
  await audit("scopes_changed", { user_id: req.params.id, ip: req.ip,
    detail: { by: req.user!.email, scopes: parsed.data } });
  res.json({ ok: true, scoped: parsed.data.length > 0 });
});

/** GET /users/roles — role catalog with permissions (for the admin UI) */
users.get("/roles", async (_req, res) => {
  res.json(await query(
    `SELECT r.id, r.code, r.name, r.is_system,
            coalesce(json_agg(rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL), '[]') AS permissions
     FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
     GROUP BY r.id ORDER BY r.code`));
});

/** POST /users/roles {code, name, permissions[]} — custom roles */
users.post("/roles", async (req, res) => {
  const Input = z.object({
    code: z.string().regex(/^[a-z0-9_]+$/),
    name: z.string().min(1),
    permissions: z.array(z.string()).min(1),
  });
  const parsed = Input.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.flatten() });
  const d = parsed.data;
  const [role] = await query(
    `INSERT INTO roles (code, name) VALUES ($1,$2) ON CONFLICT (code) DO NOTHING RETURNING *`,
    [d.code, d.name]);
  if (!role) return res.status(409).json({ error: "Role code already exists" });
  await query(
    `INSERT INTO role_permissions (role_id, permission_code)
     SELECT $1, code FROM permissions WHERE code = ANY($2)`, [role.id, d.permissions]);
  res.status(201).json(role);
});

import { scryptSync, randomBytes, timingSafeEqual, createHmac, createHash } from "node:crypto";

const SECRET = process.env.AUTH_SECRET ?? "dev-secret-change-in-production";
export const ACCESS_TTL_S = 60 * 60;            // 1h access tokens
export const REFRESH_TTL_DAYS = 30;             // 30d revocable refresh tokens

/** Hard-fail in production if the secret was not configured. */
export function assertAuthConfig(): void {
  if (process.env.NODE_ENV === "production" &&
      (!process.env.AUTH_SECRET || process.env.AUTH_SECRET.length < 32)) {
    throw new Error("AUTH_SECRET must be set (32+ chars) in production");
  }
}

/* ---------- Passwords (scrypt, no native deps) ---------- */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  return timingSafeEqual(candidate, Buffer.from(hash, "hex"));
}

/* ---------- Access tokens (compact HMAC-SHA256 signed JSON) ---------- */
export interface TokenPayload {
  sub: string;
  email: string;
  permissions: string[];
  exp: number;
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function signToken(payload: Omit<TokenPayload, "exp">): string {
  const body = b64u(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ACCESS_TTL_S }));
  const sig = createHmac("sha256", SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyToken(token: string): TokenPayload | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", SECRET).update(body).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as TokenPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

/* ---------- Refresh tokens (random, only the hash is stored) ---------- */
export function newRefreshToken(): { raw: string; hash: string; expiresAt: Date } {
  const raw = randomBytes(32).toString("base64url");
  return {
    raw,
    hash: createHash("sha256").update(raw).digest("hex"),
    expiresAt: new Date(Date.now() + REFRESH_TTL_DAYS * 864e5),
  };
}
export const hashRefreshToken = (raw: string) =>
  createHash("sha256").update(raw).digest("hex");

/* ---------- Login rate limiting (in-memory sliding window) ---------- */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const attempts = new Map<string, number[]>();

/** Returns seconds to wait, or 0 if allowed. Call recordFailure on bad logins. */
export function loginRateCheck(key: string): number {
  const now = Date.now();
  const list = (attempts.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  attempts.set(key, list);
  if (list.length < MAX_ATTEMPTS) return 0;
  return Math.ceil((list[0] + WINDOW_MS - now) / 1000);
}
export function recordLoginFailure(key: string): void {
  const list = attempts.get(key) ?? [];
  list.push(Date.now());
  attempts.set(key, list);
}
export function clearLoginFailures(key: string): void { attempts.delete(key); }

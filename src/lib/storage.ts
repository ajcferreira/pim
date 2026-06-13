/**
 * Object storage abstraction. Driver selected by STORAGE_DRIVER:
 *   local    — files under ASSET_DIR (default; for development)
 *   supabase — Supabase Storage via its REST API (service-role key, no SDK)
 *
 * Supabase env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_BUCKET (default 'assets')
 * The bucket stays private; the API proxies/authorizes all reads, so the
 * existing RBAC + portal-token access model is unchanged.
 */
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import path from "node:path";

export interface Storage {
  put(key: string, data: Buffer, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

/* ---------- Shared key hygiene ---------- */
export function safeKey(key: string): string | null {
  const norm = key.replace(/\\/g, "/").split("/").filter(Boolean);
  if (norm.some((p) => p === "." || p === "..")) return null;
  if (!norm.length || norm.join("/").length > 512) return null;
  return norm.join("/");
}

/* ---------- Local disk (dev) ---------- */
function localDriver(): Storage {
  const ROOT = path.resolve(process.env.ASSET_DIR ?? "./storage");
  const full = (key: string) => path.join(ROOT, key);
  return {
    async put(key, data) {
      mkdirSync(path.dirname(full(key)), { recursive: true });
      writeFileSync(full(key), data);
    },
    async get(key) {
      return existsSync(full(key)) ? readFileSync(full(key)) : null;
    },
    async delete(key) {
      try { unlinkSync(full(key)); } catch { /* already gone */ }
    },
  };
}

/* ---------- Supabase Storage (production) ---------- */
function supabaseDriver(): Storage {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const bucket = process.env.SUPABASE_BUCKET ?? "assets";
  if (!url || !serviceKey)
    throw new Error("STORAGE_DRIVER=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");

  const objectUrl = (key: string) =>
    `${url.replace(/\/$/, "")}/storage/v1/object/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
  const headers = { authorization: `Bearer ${serviceKey}` };

  return {
    async put(key, data, contentType = "application/octet-stream") {
      const res = await fetch(objectUrl(key), {
        method: "POST",
        headers: { ...headers, "content-type": contentType, "x-upsert": "true" },
        body: new Uint8Array(data),
      });
      if (!res.ok) throw new Error(`Storage put failed (${res.status}): ${await res.text()}`);
    },
    async get(key) {
      const res = await fetch(objectUrl(key), { headers });
      if (res.status === 404 || res.status === 400) return null;
      if (!res.ok) throw new Error(`Storage get failed (${res.status})`);
      return Buffer.from(await res.arrayBuffer());
    },
    async delete(key) {
      const res = await fetch(objectUrl(key), { method: "DELETE", headers });
      if (!res.ok && res.status !== 404)
        throw new Error(`Storage delete failed (${res.status})`);
    },
  };
}

export const storage: Storage =
  process.env.STORAGE_DRIVER === "supabase" ? supabaseDriver() : localDriver();

/** Content types for serving by extension (renditions are .webp, originals vary) */
export function contentTypeFor(key: string): string {
  const ext = path.extname(key).toLowerCase();
  return {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".webp": "image/webp", ".gif": "image/gif", ".pdf": "application/pdf",
    ".svg": "image/svg+xml", ".mp4": "video/mp4", ".csv": "text/csv",
  }[ext] ?? "application/octet-stream";
}

/**
 * Typed API client for the PIM/DAM backend.
 * Drop this into any frontend (React, Vue, plain TS).
 *
 * Handles: token storage callbacks, automatic refresh-token rotation on 401,
 * optimistic-locking conflicts surfaced as ConflictError.
 *
 *   const api = createClient({ baseUrl: "http://localhost:3000",
 *     getTokens: () => store.tokens, setTokens: (t) => store.save(t) });
 *   await api.login("ada@acme.com", "secret");
 *   const { items, total } = await api.products.list({ type: "beer", "attr.beer_style": "IPA" });
 */

export interface Tokens { access_token: string; refresh_token: string; }

export class ApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`API ${status}`);
  }
}
export class ConflictError extends ApiError {
  constructor(body: { current_version?: number }) { super(409, body); }
}

export interface ClientOptions {
  baseUrl: string;
  getTokens: () => Tokens | null;
  setTokens: (t: Tokens | null) => void;
}

export function createClient(opts: ClientOptions) {
  let refreshing: Promise<boolean> | null = null;

  async function tryRefresh(): Promise<boolean> {
    refreshing ??= (async () => {
      const t = opts.getTokens();
      if (!t?.refresh_token) return false;
      const res = await fetch(`${opts.baseUrl}/auth/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: t.refresh_token }),
      });
      if (!res.ok) { opts.setTokens(null); return false; }
      const next = await res.json() as Tokens;
      opts.setTokens(next);
      return true;
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  async function request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    const tokens = opts.getTokens();
    const res = await fetch(`${opts.baseUrl}${path}`, {
      method,
      headers: {
        ...(body instanceof FormData ? {} : { "content-type": "application/json" }),
        ...(tokens ? { authorization: `Bearer ${tokens.access_token}` } : {}),
      },
      body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && !retried && await tryRefresh())
      return request<T>(method, path, body, true);
    if (res.status === 204) return undefined as T;
    const data = await res.json().catch(() => ({}));
    if (res.status === 409) throw new ConflictError(data);
    if (!res.ok) throw new ApiError(res.status, data);
    return data as T;
  }

  const qs = (params?: Record<string, string | number | undefined>) => {
    if (!params) return "";
    const entries = Object.entries(params).filter(([, v]) => v !== undefined);
    return entries.length ? "?" + new URLSearchParams(entries as [string, string][]).toString() : "";
  };

  return {
    async login(email: string, password: string) {
      const data = await request<Tokens & { user: unknown }>("POST", "/auth/login", { email, password });
      opts.setTokens({ access_token: data.access_token, refresh_token: data.refresh_token });
      return data.user;
    },
    async logout() {
      const t = opts.getTokens();
      if (t) await request("POST", "/auth/logout", { refresh_token: t.refresh_token }).catch(() => {});
      opts.setTokens(null);
    },
    me: () => request("GET", "/auth/me"),

    products: {
      list: (params?: Record<string, string | number | undefined>) =>
        request<{ items: unknown[]; total: number; limit: number; offset: number }>("GET", `/products${qs(params)}`),
      get: (id: string) => request("GET", `/products/${id}`),
      create: (body: unknown) => request("POST", "/products", body),
      /** Pass the version you loaded — a ConflictError means reload + reapply. */
      update: (id: string, version: number, patch: Record<string, unknown>) =>
        request("PATCH", `/products/${id}`, { ...patch, version }),
      compliance: (id: string, markets?: string) =>
        request("GET", `/features/products/${id}/compliance${qs({ markets })}`),
      review: (id: string, body: string, decision?: "approve" | "request_changes") =>
        request("POST", `/features/products/${id}/reviews`, { body, decision }),
      setWindow: (id: string, publish_from?: string, publish_until?: string) =>
        request("POST", `/features/products/${id}/window`, { publish_from, publish_until }),
      setI18n: (id: string, locale: string, fields: Record<string, string>) =>
        request("PATCH", `/features/products/${id}/i18n`, { locale, ...fields }),
      enrich: (id: string, tasks?: string[]) =>
        request("POST", `/features/products/${id}/enrich`, { tasks }),
    },

    assets: {
      upload: (file: File, fields?: { alt_text?: string; tags?: string }) => {
        const fd = new FormData();
        fd.append("file", file);
        if (fields?.alt_text) fd.append("alt_text", fields.alt_text);
        if (fields?.tags) fd.append("tags", fields.tags);
        return request("POST", "/assets", fd);
      },
      link: (assetId: string, productId: string, role = "other") =>
        request("POST", `/assets/${assetId}/link`, { product_id: productId, role }),
      fileUrl: (key: string) => `${opts.baseUrl}/assets/file/${key}`,
    },

    dashboard: {
      completeness: () => request("GET", "/dashboard/completeness"),
      compliance: (markets?: string) => request("GET", `/dashboard/compliance${qs({ markets })}`),
    },

    meta: {
      types: () => request("GET", "/meta/types"),
      createAttribute: (body: unknown) => request("POST", "/meta/attributes", body),
    },

    users: {
      list: () => request("GET", "/users"),
      create: (body: unknown) => request("POST", "/users", body),
      update: (id: string, body: unknown) => request("PATCH", `/users/${id}`, body),
      roles: () => request("GET", "/users/roles"),
    },

    variants: {
      setGtin: (id: string, gtin: string) => request("POST", `/features/variants/${id}/gtin`, { gtin }),
    },
  };
}

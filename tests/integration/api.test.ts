/**
 * Integration tests against a real Postgres + the real Express app.
 * Skipped unless TEST_DATABASE_URL is set. CI runs them with a service DB
 * after applying migrations (see .github/workflows/ci.yml).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const DB = process.env.TEST_DATABASE_URL;
if (!DB) {
  test("integration (skipped — set TEST_DATABASE_URL)", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = DB;
  process.env.AUTH_SECRET = "integration-test-secret-0123456789abcdef";

  const { createApp } = await import("../../src/app.js");
  const { pool, query } = await import("../../src/db.js");
  const { hashPassword } = await import("../../src/lib/auth.js");

  const app = createApp();
  const server = app.listen(0);
  const base = () => `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const api = async (method: string, path: string, body?: unknown, token?: string) => {
    const res = await fetch(base() + path, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  let adminToken = "", editorToken = "", beerTypeId = "";

  before(async () => {
    // seed an admin + an editor
    for (const [email, role] of [["it-admin@test.x", "admin"], ["it-editor@test.x", "editor"]] as const) {
      const [u] = await query(
        `INSERT INTO users (email, name, password_hash) VALUES ($1,$2,$3)
         ON CONFLICT (email) DO UPDATE SET password_hash = $3 RETURNING id`,
        [email, email, hashPassword("integration-pass-123")]);
      await query(`DELETE FROM user_roles WHERE user_id = $1`, [u.id]);
      await query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2`, [u.id, role]);
    }
    const a = await api("POST", "/auth/login", { email: "it-admin@test.x", password: "integration-pass-123" });
    const e = await api("POST", "/auth/login", { email: "it-editor@test.x", password: "integration-pass-123" });
    adminToken = a.body.access_token; editorToken = e.body.access_token;
    const [t] = await query(`SELECT id FROM product_types WHERE code = 'beer'`);
    beerTypeId = t.id as string;
  });

  after(async () => { server.close(); await pool.end(); });

  test("login returns tokens; bad password 401; unauthenticated request 401", async () => {
    assert.ok(adminToken && editorToken);
    const bad = await api("POST", "/auth/login", { email: "it-admin@test.x", password: "wrong-password" });
    assert.equal(bad.status, 401);
    const anon = await api("GET", "/products");
    assert.equal(anon.status, 401);
  });

  test("product lifecycle: create, validate, optimistic lock, workflow", async () => {
    const sku = `IT-${Date.now()}`;
    const bad = await api("POST", "/products",
      { sku, name: "IT Beer", product_type_id: beerTypeId, attributes: { abv: 200 } }, adminToken);
    assert.equal(bad.status, 422);                       // abv > 96 rejected

    const created = await api("POST", "/products",
      { sku, name: "IT Beer", product_type_id: beerTypeId,
        attributes: { abv: 5, beer_style: "IPA", volume_ml: 330, allergens: ["Barley"] } }, adminToken);
    assert.equal(created.status, 201);
    const id = created.body.id, v = created.body.version;

    const noVersion = await api("PATCH", `/products/${id}`, { name: "Renamed" }, adminToken);
    assert.equal(noVersion.status, 400);                 // version required

    const ok = await api("PATCH", `/products/${id}`, { name: "Renamed", version: v }, adminToken);
    assert.equal(ok.status, 200);

    const stale = await api("PATCH", `/products/${id}`, { name: "Stale", version: v }, adminToken);
    assert.equal(stale.status, 409);                     // conflict detected

    const badFlow = await api("PATCH", `/products/${id}`,
      { status: "archived", version: ok.body.version }, adminToken);
    assert.equal(badFlow.status, 422);                   // draft→archived not in workflow

    const editorPublish = await api("PATCH", `/products/${id}`,
      { status: "published", version: ok.body.version }, editorToken);
    assert.equal(editorPublish.status, 403);             // RBAC: editor can't publish
  });

  test("login rate limiting blocks the 6th failure", async () => {
    const email = `rl-${Date.now()}@test.x`;             // unique key per run
    let last = 0;
    for (let i = 0; i < 6; i++) {
      const r = await api("POST", "/auth/login", { email, password: "nope-nope-1" });
      last = r.status;
    }
    assert.equal(last, 429);
  });

  test("soft delete hides the product; undelete restores it", async () => {
    const sku = `IT-DEL-${Date.now()}`;
    const created = await api("POST", "/products",
      { sku, name: "Doomed", product_type_id: beerTypeId,
        attributes: { abv: 5, beer_style: "Lager", volume_ml: 500, allergens: ["None"] } }, adminToken);
    const id = created.body.id;
    assert.equal((await api("DELETE", `/products/${id}`, undefined, adminToken)).status, 204);
    assert.equal((await api("GET", `/products/${id}`, undefined, adminToken)).status, 404);
    assert.equal((await api("POST", `/products/${id}/undelete`, {}, adminToken)).status, 200);
    assert.equal((await api("GET", `/products/${id}`, undefined, adminToken)).status, 200);
  });
}

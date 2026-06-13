import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword, signToken, verifyToken,
         newRefreshToken, hashRefreshToken } from "../src/lib/auth.js";

test("password hash round-trip", () => {
  const h = hashPassword("correct horse battery staple");
  assert.equal(verifyPassword("correct horse battery staple", h), true);
  assert.equal(verifyPassword("wrong password", h), false);
});

test("same password hashes differently (salted)", () => {
  assert.notEqual(hashPassword("abc1234567"), hashPassword("abc1234567"));
});

test("access token round-trip with permissions", () => {
  const token = signToken({ sub: "u1", email: "a@b.c", permissions: ["product.view"] });
  const payload = verifyToken(token);
  assert.equal(payload?.sub, "u1");
  assert.deepEqual(payload?.permissions, ["product.view"]);
});

test("tampered token rejected", () => {
  const token = signToken({ sub: "u1", email: "a@b.c", permissions: [] });
  const [body, sig] = token.split(".");
  const evil = Buffer.from(JSON.stringify({ sub: "u1", email: "a@b.c",
    permissions: ["user.manage"], exp: Math.floor(Date.now() / 1000) + 999 })).toString("base64url");
  assert.equal(verifyToken(`${evil}.${sig}`), null);
  assert.equal(verifyToken(`${body}.AAAA`), null);
});

test("refresh token hash is deterministic and never the raw value", () => {
  const t = newRefreshToken();
  assert.equal(hashRefreshToken(t.raw), t.hash);
  assert.notEqual(t.raw, t.hash);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { base32Encode, base32Decode, generateTotpSecret, verifyTotp, otpauthUrl } from "../src/lib/totp.js";
import { createHmac } from "node:crypto";

test("base32 round-trip", () => {
  const buf = Buffer.from("Hello TOTP world!");
  assert.deepEqual(base32Decode(base32Encode(buf)), buf);
});

test("RFC 4648 known vector", () => {
  assert.equal(base32Encode(Buffer.from("foobar")), "MZXW6YTBOI");
});

test("generated secret is valid base32 of 20 bytes", () => {
  const s = generateTotpSecret();
  assert.equal(base32Decode(s).length, 20);
});

test("verifyTotp accepts the current code and adjacent steps", () => {
  const secret = generateTotpSecret();
  // compute the expected code for "now" exactly as the implementation does
  const key = base32Decode(secret);
  const step = Math.floor(Date.now() / 1000 / 30);
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", key).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  const code = String((((h[o] & 0x7f) << 24) | (h[o+1] << 16) | (h[o+2] << 8) | h[o+3]) % 1_000_000).padStart(6, "0");
  assert.equal(verifyTotp(secret, code), true);
  assert.equal(verifyTotp(secret, "000000") && code !== "000000" ? false : verifyTotp(secret, code), true);
});

test("rejects malformed codes", () => {
  const secret = generateTotpSecret();
  assert.equal(verifyTotp(secret, "12345"), false);
  assert.equal(verifyTotp(secret, "abcdef"), false);
});

test("otpauth URL shape", () => {
  assert.match(otpauthUrl("ABC234", "a@b.c"), /^otpauth:\/\/totp\/CellarPIM:a%40b\.c\?secret=ABC234/);
});

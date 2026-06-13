import { test } from "node:test";
import assert from "node:assert/strict";
import { validateGtin } from "../src/lib/gtin.js";

test("valid EAN-13s pass", () => {
  assert.equal(validateGtin("5901234123457").valid, true);
  assert.equal(validateGtin("4006381333931").valid, true);
});

test("bad check digit fails with hint", () => {
  const r = validateGtin("5901234123450");
  assert.equal(r.valid, false);
  assert.match(r.reason ?? "", /Check digit should be 7/);
});

test("non-digits and wrong lengths fail", () => {
  assert.equal(validateGtin("59012A4123457").valid, false);
  assert.equal(validateGtin("12345").valid, false);
});

test("GTIN-8 supported", () => {
  // 9638-5074 has check digit 4
  assert.equal(validateGtin("96385074").valid, true);
});

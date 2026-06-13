import { test } from "node:test";
import assert from "node:assert/strict";
import { contentMatchesMime } from "../src/lib/sniff.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const PDF = Buffer.from("%PDF-1.7\n...");

test("genuine files pass", () => {
  assert.equal(contentMatchesMime(PNG, "image/png"), true);
  assert.equal(contentMatchesMime(JPEG, "image/jpeg"), true);
  assert.equal(contentMatchesMime(PDF, "application/pdf"), true);
});

test("mislabeled content is rejected", () => {
  assert.equal(contentMatchesMime(PDF, "image/png"), false);       // PDF claiming to be PNG
  assert.equal(contentMatchesMime(PNG, "application/pdf"), false); // PNG claiming to be PDF
  assert.equal(contentMatchesMime(Buffer.from("<script>"), "image/jpeg"), false);
});

test("unknown types pass through", () => {
  assert.equal(contentMatchesMime(Buffer.from("a,b,c"), "text/csv"), true);
});

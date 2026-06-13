import { test } from "node:test";
import assert from "node:assert/strict";
import { runComplianceChecks, taxCategory, depositScheme } from "../src/lib/compliance.js";

const base = { name: "Test", i18n: {}, variants: [] };

test("beer without allergens is a blocker", () => {
  const issues = runComplianceChecks({ ...base, type_code: "beer", attributes: { abv: 5 } });
  assert.ok(issues.some((i) => i.rule === "allergens" && i.severity === "error"));
});

test("high caffeine triggers statement requirement", () => {
  const issues = runComplianceChecks({ ...base, type_code: "soft_drink",
    attributes: { sugar_g_100ml: 10, caffeine_mg: 32 } });
  assert.ok(issues.some((i) => i.rule === "caffeine_warning"));
});

test("caffeine at threshold does not trigger", () => {
  const issues = runComplianceChecks({ ...base, type_code: "soft_drink",
    attributes: { sugar_g_100ml: 10, caffeine_mg: 15 } });
  assert.ok(!issues.some((i) => i.rule === "caffeine_warning"));
});

test("variant without GTIN is a warning", () => {
  const issues = runComplianceChecks({ ...base, type_code: "water",
    attributes: { carbonated: true }, variants: [{ name: "Bottle", gtin: null }] });
  assert.ok(issues.some((i) => i.rule === "gtin" && i.severity === "warning"));
});

test("missing locale flagged per market", () => {
  const issues = runComplianceChecks({ ...base, type_code: "water",
    attributes: { carbonated: true } }, ["DE"]);
  assert.ok(issues.some((i) => i.rule === "i18n" && i.message.startsWith("DE")));
});

test("tax categories", () => {
  assert.equal(taxCategory("beer", 0.4), "non_alcoholic");
  assert.equal(taxCategory("beer", 2.5), "beer_reduced");
  assert.equal(taxCategory("beer", 5.0), "beer_standard");
  assert.equal(taxCategory("wine", 13), "still_wine");
  assert.equal(taxCategory("wine", 18), "fortified_wine");
  assert.equal(taxCategory("spirit", 40), "spirits");
});

test("deposit schemes", () => {
  assert.equal(depositScheme("DE"), "Pfand (DPG)");
  assert.equal(depositScheme("FR"), null);
});

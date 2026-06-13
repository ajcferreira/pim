import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAttributes, type AttributeDef } from "../src/validation.js";

const defs: AttributeDef[] = [
  { code: "abv", label: "ABV", data_type: "number", unit: "%", options: null,
    validation: { min: 0, max: 96 }, is_required: true, group_name: "G", sort_order: 1 },
  { code: "style", label: "Style", data_type: "select", unit: null,
    options: ["IPA", "Lager"], validation: null, is_required: true, group_name: "G", sort_order: 2 },
  { code: "allergens", label: "Allergens", data_type: "multiselect", unit: null,
    options: ["Barley", "Wheat"], validation: null, is_required: false, group_name: "G", sort_order: 3 },
  { code: "organic", label: "Organic", data_type: "boolean", unit: null,
    options: null, validation: null, is_required: false, group_name: "G", sort_order: 4 },
];

test("valid payload passes", () => {
  assert.deepEqual(validateAttributes({ abv: 5.2, style: "IPA" }, defs), []);
});

test("number out of range fails", () => {
  const issues = validateAttributes({ abv: 120, style: "IPA" }, defs);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].attribute, "abv");
});

test("wrong primitive type fails", () => {
  const issues = validateAttributes({ abv: "five", style: "IPA" }, defs);
  assert.ok(issues.some((i) => i.attribute === "abv" && i.message === "Must be a number"));
});

test("select value must be an allowed option", () => {
  const issues = validateAttributes({ abv: 5, style: "Stout" }, defs);
  assert.ok(issues.some((i) => i.attribute === "style"));
});

test("multiselect rejects non-allowed entries", () => {
  const issues = validateAttributes({ abv: 5, style: "IPA", allergens: ["Barley", "Peanuts"] }, defs);
  assert.ok(issues.some((i) => i.attribute === "allergens"));
});

test("unknown attribute is rejected", () => {
  const issues = validateAttributes({ abv: 5, style: "IPA", bogus: 1 }, defs);
  assert.ok(issues.some((i) => i.attribute === "bogus"));
});

test("required enforced on full validation, not partial", () => {
  assert.ok(validateAttributes({}, defs).some((i) => i.attribute === "abv" && i.message === "Required"));
  assert.deepEqual(validateAttributes({}, defs, { partial: true }), []);
});

test("boolean type check", () => {
  const issues = validateAttributes({ abv: 5, style: "IPA", organic: "yes" }, defs);
  assert.ok(issues.some((i) => i.attribute === "organic"));
});

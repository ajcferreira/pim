import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, applyCalculated } from "../src/lib/calc.js";

test("basic arithmetic with precedence", () => {
  assert.equal(evaluate("2 + 3 * 4", {}), 14);
  assert.equal(evaluate("(2 + 3) * 4", {}), 20);
  assert.equal(evaluate("-5 + 10", {}), 5);
});

test("attribute references", () => {
  assert.equal(evaluate("sugar_g_100ml * volume_ml / 100", { sugar_g_100ml: 11, volume_ml: 250 }), 27.5);
});

test("round with digits", () => {
  assert.equal(evaluate("round(10 / 3, 2)", {}), 3.33);
  assert.equal(evaluate("round(2.7)", {}), 3);
});

test("missing or non-numeric variable yields null", () => {
  assert.equal(evaluate("abv * 2", {}), null);
  assert.equal(evaluate("abv * 2", { abv: "five" }), null);
});

test("division by zero yields null, not Infinity", () => {
  assert.equal(evaluate("1 / 0", {}), null);
  assert.equal(evaluate("volume_ml / servings", { volume_ml: 750, servings: 0 }), null);
});

test("no code execution — illegal tokens rejected", () => {
  assert.equal(evaluate("process.exit(1)", {}), null);
  assert.equal(evaluate("1; 2", {}), null);
  assert.equal(evaluate("a`b`", { a: 1 }), null);
});

test("applyCalculated fills computable values and skips others", () => {
  const defs = [
    { code: "sugar_per_container", formula: "round(sugar_g_100ml * volume_ml / 100, 1)" },
    { code: "abv", formula: null },
  ];
  const out = applyCalculated({ sugar_g_100ml: 8.9, volume_ml: 1000, abv: 0 }, defs);
  assert.equal(out.sugar_per_container, 89);
  const out2 = applyCalculated({ volume_ml: 1000 }, defs);
  assert.equal("sugar_per_container" in out2, false);
});

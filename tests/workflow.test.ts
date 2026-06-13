import { test } from "node:test";
import assert from "node:assert/strict";
import { checkTransition, type WorkflowDef } from "../src/lib/objects.js";

const wf: WorkflowDef = {
  states: ["draft", "in_review", "published", "archived"],
  transitions: [
    { from: "draft", to: "in_review", permission: "product.edit", requires_complete: true },
    { from: "in_review", to: "published", permission: "review.approve", requires_complete: true },
    { from: "published", to: "archived", permission: "product.publish" },
  ],
};

test("allowed transition with permission passes", () => {
  const r = checkTransition(wf, "draft", "in_review", ["product.edit"]);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.requires_complete, true);
});

test("undefined transition is a 422 listing alternatives", () => {
  const r = checkTransition(wf, "draft", "archived", ["product.publish"]);
  assert.equal(r.ok, false);
  if (!r.ok) { assert.equal(r.status, 422); assert.match(r.error, /in_review/); }
});

test("missing permission is a 403 naming the requirement", () => {
  const r = checkTransition(wf, "in_review", "published", ["product.edit"]);
  assert.equal(r.ok, false);
  if (!r.ok) { assert.equal(r.status, 403); assert.deepEqual(r.required, ["review.approve"]); }
});

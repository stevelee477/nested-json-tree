import assert from "node:assert/strict";
import test from "node:test";
import { shouldAutoExpand } from "../treeOptions";

test("auto-expands JSON at or below the configured node count", () => {
  const value = { user: { id: 7 }, tags: ["a", "b"] };
  assert.equal(shouldAutoExpand(value, 6), true);
});

test("keeps JSON collapsed when it exceeds the configured node count", () => {
  const value = { user: { id: 7 }, tags: ["a", "b"] };
  assert.equal(shouldAutoExpand(value, 5), false);
});

test("zero disables automatic descendant expansion", () => {
  assert.equal(shouldAutoExpand({ small: true }, 0), false);
});

test("counts deeply nested JSON without recursive traversal", () => {
  let value: unknown = null;
  for (let index = 0; index < 20_000; index += 1) {
    value = [value];
  }
  assert.equal(shouldAutoExpand(value as never, 100), false);
});

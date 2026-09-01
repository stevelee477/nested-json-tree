import assert from "node:assert/strict";
import test from "node:test";
import { parseTree } from "jsonc-parser";
import { buildJsonTree } from "../jsonTree";
import {
  MAX_EXPAND_ALL_NODES,
  isNodeCountWithinLimit,
  isTreeNodeCountWithinLimit,
  shouldAutoExpand,
  shouldAutoExpandTree,
} from "../treeOptions";

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

test("enforces the expand-all hard node limit", () => {
  assert.equal(isNodeCountWithinLimit(Array(MAX_EXPAND_ALL_NODES - 1).fill(null), MAX_EXPAND_ALL_NODES), true);
  assert.equal(isNodeCountWithinLimit(Array(MAX_EXPAND_ALL_NODES).fill(null), MAX_EXPAND_ALL_NODES), false);
});

test("rejects very wide containers without queuing every child", () => {
  assert.equal(isNodeCountWithinLimit(Array(1_000_000).fill(null), MAX_EXPAND_ALL_NODES), false);
});

test("counts lossless tree nodes without mistaking user id/type fields for metadata", () => {
  const source = '{"id":1,"type":"object","nested":{"ok":true}}';
  const syntaxTree = parseTree(source);
  assert.ok(syntaxTree);
  const tree = buildJsonTree(syntaxTree, source);
  assert.equal(shouldAutoExpandTree(tree, 5), true);
  assert.equal(shouldAutoExpandTree(tree, 4), false);
  assert.equal(isTreeNodeCountWithinLimit(tree, MAX_EXPAND_ALL_NODES), true);
  assert.equal(shouldAutoExpand({ id: 1, type: "object", nested: { ok: true } }, 5), true);
});

import assert from "node:assert/strict";
import test from "node:test";
import { parseTree } from "jsonc-parser";
import { JsonTreeNode, buildJsonTree } from "../jsonTree";
import {
  MAX_EXPAND_ALL_NODES,
  isTreeNodeCountWithinLimit,
  shouldAutoExpandTree,
} from "../treeOptions";

function lossless(source: string): JsonTreeNode {
  const syntaxTree = parseTree(source);
  assert.ok(syntaxTree);
  return buildJsonTree(syntaxTree, source);
}

const sample = lossless('{"user":{"id":7},"tags":["a","b"]}');

test("auto-expands JSON at or below the configured node count", () => {
  assert.equal(shouldAutoExpandTree(sample, 6), true);
});

test("keeps JSON collapsed when it exceeds the configured node count", () => {
  assert.equal(shouldAutoExpandTree(sample, 5), false);
});

test("zero disables automatic descendant expansion", () => {
  assert.equal(shouldAutoExpandTree(lossless('{"small":true}'), 0), false);
});

test("counts deeply nested trees without recursive traversal", () => {
  let root: JsonTreeNode = { id: 0, type: "null", raw: "null", value: null };
  for (let id = 1; id < 20_000; id += 1) root = { id, type: "array", children: [{ key: 0, value: root }] };
  assert.equal(shouldAutoExpandTree(root, 100), false);
});

test("enforces the expand-all hard node limit", () => {
  const nulls = (count: number) => lossless(`[${Array(count).fill("null").join(",")}]`);
  assert.equal(isTreeNodeCountWithinLimit(nulls(MAX_EXPAND_ALL_NODES - 1), MAX_EXPAND_ALL_NODES), true);
  assert.equal(isTreeNodeCountWithinLimit(nulls(MAX_EXPAND_ALL_NODES), MAX_EXPAND_ALL_NODES), false);
});

test("rejects very wide containers without queuing every child", () => {
  const children = Array.from({ length: 1_000_000 }, (_, index) => ({
    key: index,
    value: { id: index + 1, type: "null" as const, raw: "null", value: null },
  }));
  assert.equal(isTreeNodeCountWithinLimit({ id: 0, type: "array", children }, MAX_EXPAND_ALL_NODES), false);
});

test("counts lossless tree nodes without mistaking user id/type fields for metadata", () => {
  const tree = lossless('{"id":1,"type":"object","nested":{"ok":true}}');
  assert.equal(shouldAutoExpandTree(tree, 5), true);
  assert.equal(shouldAutoExpandTree(tree, 4), false);
  assert.equal(isTreeNodeCountWithinLimit(tree, MAX_EXPAND_ALL_NODES), true);
});

import assert from "node:assert/strict";
import test from "node:test";
import { parseTree } from "jsonc-parser";
import { JsonTreeNode, buildJsonTree } from "../jsonTree";
import { advanceJsonTreeSearch, createJsonTreeSearchState } from "../search";

function lossless(source: string): JsonTreeNode {
  const syntaxTree = parseTree(source);
  assert.ok(syntaxTree);
  return buildJsonTree(syntaxTree, source);
}

function search(root: JsonTreeNode, query: string, maxMatches?: number, chunk = 1) {
  const state = createJsonTreeSearchState(root, query, maxMatches);
  let chunks = 0;
  while (!advanceJsonTreeSearch(state, chunk)) chunks += 1;
  return { state, chunks };
}

const sample = lossless(JSON.stringify({
  users: [
    { id: 7, displayName: "Ada Lovelace", active: true },
    { id: 8, displayName: "Grace Hopper", active: false },
  ],
  note: null,
}));
const users = sample.children![0].value.children!;
const field = (user: number, index: number) => users[user].value.children![index].value.id;

test("searches keys case-insensitively in tree order", () => {
  assert.deepEqual(search(sample, "DISPLAY").state.matches, [field(0, 1), field(1, 1)]);
});

test("searches string, number, boolean, and null values", () => {
  assert.deepEqual(search(sample, "hopper").state.matches, [field(1, 1)]);
  assert.deepEqual(search(sample, "8").state.matches, [field(1, 0)]);
  assert.deepEqual(search(sample, "false").state.matches, [field(1, 2)]);
  assert.deepEqual(search(sample, "null").state.matches, [sample.children![1].value.id]);
});

test("empty and whitespace-only searches return no matches", () => {
  assert.deepEqual(search(sample, "  ").state.matches, []);
});

test("caps large result sets and reports truncation", () => {
  const { state } = search(lossless('["match","match","match"]'), "match", 2);
  assert.equal(state.matches.length, 2);
  assert.equal(state.truncated, true);
});

test("incremental search preserves stable results and marks ancestors to expand", () => {
  const { state, chunks } = search(sample, "display");
  assert.ok(chunks > 1);
  assert.deepEqual(state.matches, [field(0, 1), field(1, 1)]);
  assert.equal(state.truncated, false);
  assert.deepEqual([...state.expandIds].sort(), [sample.id, sample.children![0].value.id, users[0].value.id, users[1].value.id].sort());
});

test("incremental search handles deeply nested trees without recursion", () => {
  let root: JsonTreeNode = { id: 0, type: "string", raw: '"needle"', value: "needle" };
  for (let id = 1; id <= 50_000; id += 1) {
    root = { id, type: "object", children: [{ key: "child", rawKey: '"child"', value: root }] };
  }
  const { state } = search(root, "needle", undefined, 512);
  assert.deepEqual(state.matches, [0]);
  assert.equal(state.expandIds.size, 50_000);
});

test("lossless-tree search uses raw numbers and distinguishes duplicate-key nodes", () => {
  const tree = lossless('{"same":1,"same":9007199254740993,"escaped":"\\u0061"}');
  const numberResult = search(tree, "9007199254740993").state;
  assert.deepEqual(numberResult.matches, [tree.children?.[1].value.id]);
  assert.equal(numberResult.expandIds.has(tree.id), true);
  assert.deepEqual(search(tree, "\\u0061").state.matches, [tree.children?.[2].value.id]);
});

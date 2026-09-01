import assert from "node:assert/strict";
import test from "node:test";
import { parseTree } from "jsonc-parser";
import { buildJsonTree } from "../jsonTree";
import {
  advanceJsonSearch,
  advanceJsonTreeSearch,
  createJsonSearchState,
  createJsonTreeSearchState,
  jsonTreePrimitiveSearchText,
  searchJson,
} from "../search";

const sample = {
  users: [
    { id: 7, displayName: "Ada Lovelace", active: true },
    { id: 8, displayName: "Grace Hopper", active: false },
  ],
  note: null,
};

test("searches keys case-insensitively in tree order", () => {
  assert.deepEqual(searchJson(sample, "DISPLAY").paths, [
    ["users", 0, "displayName"],
    ["users", 1, "displayName"],
  ]);
});

test("searches string, number, boolean, and null values", () => {
  assert.deepEqual(searchJson(sample, "hopper").paths, [["users", 1, "displayName"]]);
  assert.deepEqual(searchJson(sample, "8").paths, [["users", 1, "id"]]);
  assert.deepEqual(searchJson(sample, "false").paths, [["users", 1, "active"]]);
  assert.deepEqual(searchJson(sample, "null").paths, [["note"]]);
});

test("empty and whitespace-only searches return no matches", () => {
  assert.deepEqual(searchJson(sample, "  ").paths, []);
});

test("caps large result sets and reports truncation", () => {
  const result = searchJson(["match", "match", "match"], "match", 2);
  assert.equal(result.paths.length, 2);
  assert.equal(result.truncated, true);
});

test("incremental search preserves stable results across small chunks", () => {
  const state = createJsonSearchState(sample, "display", 5_000);
  let chunks = 0;
  while (!advanceJsonSearch(state, 1)) {
    chunks += 1;
  }
  assert.ok(chunks > 1);
  assert.deepEqual(state.paths, [
    ["users", 0, "displayName"],
    ["users", 1, "displayName"],
  ]);
  assert.equal(state.truncated, false);
});

test("incremental search handles deeply nested JSON without recursion", () => {
  let value: unknown = "needle";
  for (let index = 0; index < 50_000; index += 1) {
    value = { child: value };
  }

  const state = createJsonSearchState(value as never, "needle");
  while (!advanceJsonSearch(state, 512)) {
    // Consume the same bounded chunks used by the Webview runtime.
  }
  assert.equal(state.paths.length, 1);
  assert.equal(state.paths[0].length, 50_000);
});

test("lossless-tree search uses raw numbers and distinguishes duplicate-key nodes", () => {
  const source = '{"same":1,"same":9007199254740993,"escaped":"\\u0061"}';
  const syntaxTree = parseTree(source);
  assert.ok(syntaxTree);
  const tree = buildJsonTree(syntaxTree, source);

  const numberState = createJsonTreeSearchState(tree, "9007199254740993");
  while (!advanceJsonTreeSearch(numberState, 1)) {
    // Exercise the incremental path.
  }
  assert.deepEqual(numberState.matches, [tree.children?.[1].value.id]);
  assert.equal(numberState.expandIds.has(tree.id), true);

  const escapeState = createJsonTreeSearchState(tree, "\\u0061");
  while (!advanceJsonTreeSearch(escapeState, 1)) {
    // Exercise the incremental path.
  }
  assert.deepEqual(escapeState.matches, [tree.children?.[2].value.id]);
});

test("lossless search helpers remain self-contained when embedded in the Webview", () => {
  const runtime = [
    `const createJsonTreeSearchState = ${createJsonTreeSearchState.toString()};`,
    `const jsonTreePrimitiveSearchText = ${jsonTreePrimitiveSearchText.toString()};`,
    `const advanceJsonTreeSearch = ${advanceJsonTreeSearch.toString()};`,
    "return { createJsonTreeSearchState, advanceJsonTreeSearch };",
  ].join("\n");
  const embedded = new Function(runtime)() as {
    createJsonTreeSearchState: typeof createJsonTreeSearchState;
    advanceJsonTreeSearch: typeof advanceJsonTreeSearch;
  };
  const source = '{"big":9007199254740993}';
  const syntaxTree = parseTree(source);
  assert.ok(syntaxTree);
  const tree = buildJsonTree(syntaxTree, source);
  const state = embedded.createJsonTreeSearchState(tree, "9007199254740993");
  assert.equal(embedded.advanceJsonTreeSearch(state, 10), true);
  assert.deepEqual(state.matches, [tree.children?.[0].value.id]);
});

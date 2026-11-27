import assert from "node:assert/strict";
import test from "node:test";
import { parseTree } from "jsonc-parser";
import { JsonTreeNode, buildJsonTree } from "../jsonTree";
import {
  JsonTreeSearchOptions,
  advanceJsonTreeSearch,
  createJsonTreeSearchState,
} from "../search";

function lossless(source: string): JsonTreeNode {
  const syntaxTree = parseTree(source);
  assert.ok(syntaxTree);
  return buildJsonTree(syntaxTree, source);
}

function search(
  root: JsonTreeNode,
  query: string,
  maxMatches?: number,
  chunk = 1,
  options?: JsonTreeSearchOptions,
) {
  const state = createJsonTreeSearchState(root, query, maxMatches, options);
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
  assert.deepEqual(
    [...state.expandIds].sort(),
    [sample.id, sample.children![0].value.id, users[0].value.id, users[1].value.id].sort(),
  );
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

test("search covers decoded JSON and marks its string owner for expansion", () => {
  const tree = lossless('{"payload": "{\\"secret\\": 1}"}');
  const owner = tree.children![0].value;
  owner.decoded = {
    root: {
      id: 99,
      type: "object",
      children: [
        { key: "secret", rawKey: '"secret"', value: { id: 100, type: "number", raw: "1" } },
      ],
    },
    unwrapDepth: 0,
  };
  const { state } = search(tree, "secret");
  // The escaped string itself matches too; the decoded key is found separately.
  assert.deepEqual(state.matches, [owner.id, 100]);
  assert.equal(state.expandIds.has(owner.id), true);
  assert.equal(state.expandIds.has(99), true);
});

test("caseSensitive option distinguishes upper and lower case in keys and values", () => {
  assert.deepEqual(
    search(sample, "DISPLAY", undefined, 2, { caseSensitive: true }).state.matches,
    [],
  );
  assert.deepEqual(
    search(sample, "displayName", undefined, 2, { caseSensitive: true }).state.matches,
    [field(0, 1), field(1, 1)],
  );
  assert.deepEqual(
    search(sample, "grace", undefined, 2, { caseSensitive: true }).state.matches,
    [],
  );
  assert.deepEqual(
    search(sample, "Grace", undefined, 2, { caseSensitive: true }).state.matches,
    [field(1, 1)],
  );
});

test("scope option restricts search to keys, values, or all", () => {
  const tree = lossless(JSON.stringify({ alpha: "beta", gamma: "alpha" }));
  const firstId = tree.children![0].value.id;
  const secondId = tree.children![1].value.id;

  assert.deepEqual(search(tree, "alpha", undefined, 1, { scope: "keys" }).state.matches, [firstId]);
  assert.deepEqual(search(tree, "alpha", undefined, 1, { scope: "values" }).state.matches, [secondId]);
  assert.deepEqual(search(tree, "alpha", undefined, 1, { scope: "all" }).state.matches, [firstId, secondId]);
});

test("regex option supports valid patterns, case sensitivity, invalidRegex reporting, and huge strings", () => {
  assert.deepEqual(
    search(sample, "^ada\\s+lovelace$", undefined, 2, { regex: true }).state.matches,
    [field(0, 1)],
  );
  assert.deepEqual(
    search(sample, "^ada\\s+lovelace$", undefined, 2, { regex: true, caseSensitive: true }).state.matches,
    [],
  );
  assert.deepEqual(
    search(sample, "^displayName$", undefined, 2, { regex: true, scope: "keys", caseSensitive: true }).state.matches,
    [field(0, 1), field(1, 1)],
  );

  const invalid = createJsonTreeSearchState(sample, "[unterminated", 5_000, { regex: true });
  assert.equal(invalid.done, true);
  assert.deepEqual(invalid.matches, []);
  assert.equal(typeof invalid.invalidRegex, "string");
  assert.ok((invalid.invalidRegex ?? "").length > 0);
  assert.equal(advanceJsonTreeSearch(invalid), true);

  const hugeValue = "prefix-token-" + "x".repeat(200_000);
  const hugeTree: JsonTreeNode = {
    id: 0,
    type: "object",
    children: [
      { key: "blob", rawKey: '"blob"', value: { id: 1, type: "string", value: hugeValue, raw: `"${hugeValue}"` } },
    ],
  };
  assert.deepEqual(
    search(hugeTree, "^prefix-token-x+", undefined, 10, { regex: true, scope: "values" }).state.matches,
    [1],
  );
  // Nested quantifier against a 200k string stays bounded and fast.
  const redosValue = "a".repeat(200_000) + "!";
  const redosTree: JsonTreeNode = {
    id: 0,
    type: "object",
    children: [
      { key: "s", rawKey: '"s"', value: { id: 1, type: "string", value: redosValue, raw: `"${redosValue}"` } },
    ],
  };
  assert.deepEqual(
    search(redosTree, "(a+)+b", undefined, 10, { regex: true }).state.matches,
    [],
  );
});

test("structured comparison queries filter by field path, operators, and lossless BigInt/decimals", () => {
  const tree = lossless(
    '{' +
      '"requests":[' +
        '{"status":200,"latency":120.5,"count":15,"env":"prod","id":9007199254740992,"user":{"role":"viewer"}},' +
        '{"status":404,"latency":500.25,"count":10,"env":"staging","id":9007199254740993,"user":{"role":"admin"}},' +
        '{"status":503,"latency":850,"count":3,"env":"dev","id":9007199254740994,"user":{"role":"ADMIN"}}' +
      ']' +
    '}',
  );
  const reqs = tree.children![0].value.children!;
  const prop = (reqIdx: number, propIdx: number) => reqs[reqIdx].value.children![propIdx].value;

  assert.deepEqual(search(tree, "status>=400").state.matches, [prop(1, 0).id, prop(2, 0).id]);
  assert.deepEqual(search(tree, "latency>500.1").state.matches, [prop(1, 1).id, prop(2, 1).id]);
  assert.deepEqual(search(tree, "count<=10").state.matches, [prop(1, 2).id, prop(2, 2).id]);
  assert.deepEqual(search(tree, "count<10").state.matches, [prop(2, 2).id]);
  assert.deepEqual(search(tree, "env!=prod").state.matches, [prop(1, 3).id, prop(2, 3).id]);
  assert.deepEqual(
    search(tree, "id>9007199254740992").state.matches,
    [prop(1, 4).id, prop(2, 4).id],
  );
  assert.deepEqual(
    search(tree, "user.role=admin").state.matches,
    [prop(1, 5).children![0].value.id, prop(2, 5).children![0].value.id],
  );
  assert.deepEqual(
    search(tree, "user.role=admin", undefined, 2, { caseSensitive: true }).state.matches,
    [prop(1, 5).children![0].value.id],
  );
});

test("multi-term structured queries match records satisfying all terms and support quoted values", () => {
  const tree = lossless(JSON.stringify({
    logs: [
      { level: "info", latency: 250, user: { name: "Ada Lovelace" } },
      { level: "error", latency: 50, user: { name: "Ada Lovelace" } },
      { level: "error", latency: 180, user: { name: "Grace Hopper" } },
      { level: "error", latency: 320, user: { name: "Ada Lovelace" } },
    ],
  }));
  const logs = tree.children![0].value.children!;
  const logField = (idx: number, fieldIdx: number) => logs[idx].value.children![fieldIdx].value;

  const twoTerm = search(tree, "level=error latency>100").state;
  assert.deepEqual(twoTerm.matches, [
    logField(2, 0).id,
    logField(2, 1).id,
    logField(3, 0).id,
    logField(3, 1).id,
  ]);
  assert.equal(twoTerm.expandIds.has(logs[0].value.id), false);
  assert.equal(twoTerm.expandIds.has(logs[1].value.id), false);
  assert.equal(twoTerm.expandIds.has(logs[2].value.id), true);
  assert.equal(twoTerm.expandIds.has(logs[3].value.id), true);

  const quotedTerm = search(tree, 'level=error latency>100 user.name="Ada Lovelace"').state;
  assert.deepEqual(quotedTerm.matches, [
    logField(3, 0).id,
    logField(3, 1).id,
    logField(3, 2).children![0].value.id,
  ]);

  const rangeSameField = search(tree, "latency>=150 latency<=260").state;
  assert.deepEqual(rangeSameField.matches, [logField(0, 1).id, logField(2, 1).id]);
});

test("single key=value query still matches literal substrings in strings and keys without regression", () => {
  const tree = lossless(JSON.stringify({
    url: "https://example.com/callback?a=b&c=d",
    "a=b": 123,
    nested: { a: "b", other: "c" },
  }));
  const urlId = tree.children![0].value.id;
  const literalKeyId = tree.children![1].value.id;
  const structuredValId = tree.children![2].value.children![0].value.id;

  assert.deepEqual(search(tree, "a=b").state.matches, [urlId, literalKeyId, structuredValId]);
});

test("structured queries handle negative/scientific decimals, dotted keys, booleans, null, and decoded subtrees", () => {
  const tree = lossless(JSON.stringify({
    "http.status": 502,
    temp: -12.5,
    score: 150,
    active: false,
    err: null,
    payload: '{"inner":{"code":504}}',
  }));
  const payloadNode = tree.children![5].value;
  payloadNode.decoded = {
    root: lossless('{"inner":{"code":504}}'),
    unwrapDepth: 0,
  };
  payloadNode.decoded.root.id = 500;
  payloadNode.decoded.root.children![0].value.id = 501;
  payloadNode.decoded.root.children![0].value.children![0].value.id = 502;

  assert.deepEqual(search(tree, "http.status>=500").state.matches, [tree.children![0].value.id]);
  assert.deepEqual(search(tree, "temp<-5.5").state.matches, [tree.children![1].value.id]);
  assert.deepEqual(search(tree, "score=1.5e2").state.matches, [tree.children![2].value.id]);
  assert.deepEqual(search(tree, "active=false").state.matches, [tree.children![3].value.id]);
  assert.deepEqual(search(tree, "err=null").state.matches, [tree.children![4].value.id]);
  assert.deepEqual(search(tree, "inner.code>=500").state.matches, [502]);
});

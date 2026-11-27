import assert from "node:assert/strict";
import test from "node:test";
import { parseTree } from "jsonc-parser";
import {
  JsonTreeNode,
  buildJsonTree,
  buildJsonTreeContextIndex,
  createJsonTreeWebviewModel,
  stringifyJsonTree,
  walkJsonTree,
} from "../jsonTree";
import { JsonValueNodeLimitError } from "../parser";
import { diffJsonTrees } from "../treeDiff";

function parseLosslessly(source: string): JsonTreeNode {
  const errors: unknown[] = [];
  const root = parseTree(source, errors as never[], { allowTrailingComma: true });
  assert.ok(root);
  assert.deepEqual(errors, []);
  return buildJsonTree(root, source);
}

function assertValidDiffInvariants(result: ReturnType<typeof diffJsonTrees>): void {
  const seenIds = new Set<number>();
  walkJsonTree(result.root, (node) => {
    assert.equal(seenIds.has(node.id), false, `duplicate id ${node.id}`);
    assert.ok(node.id >= 0 && node.id < result.nodeCount, `out-of-range id ${node.id}`);
    seenIds.add(node.id);
  });
  assert.equal(seenIds.size, result.nodeCount);
  assert.equal(result.root.id, 0);

  const index = buildJsonTreeContextIndex(result.root);
  assert.equal(index.size, result.nodeCount);

  const totalSummary =
    result.summary.added +
    result.summary.removed +
    result.summary.changed +
    result.summary.unchanged;
  assert.equal(totalSummary, result.nodeCount);

  const annotatedIds = Object.keys(result.annotations).map(Number);
  assert.equal(
    annotatedIds.length,
    result.summary.added + result.summary.removed + result.summary.changed,
  );

  // Ensure Webview model and lossless serializer accept the diff tree cleanly.
  const webviewModel = createJsonTreeWebviewModel(result.root);
  assert.equal(webviewModel.root.id, 0);
  assert.ok(stringifyJsonTree(result.root, 0).length > 0);
}

test("diffJsonTrees marks identical trees as unchanged with sequential fresh IDs", () => {
  const left = parseLosslessly('{"id":9007199254740993,"escaped":"\\u0061","tags":[true,null]}');
  const right = parseLosslessly('{"id":9007199254740993,"escaped":"a","tags":[true,null]}');
  // Mutate input IDs to ensure fresh sequential IDs are assigned
  left.id = 500;
  right.id = 900;

  const diff = diffJsonTrees(left, right);
  assertValidDiffInvariants(diff);
  assert.deepEqual(diff.annotations, {});
  assert.deepEqual(diff.summary, {
    added: 0,
    removed: 0,
    changed: 0,
    unchanged: 6,
  });
});

test("diffJsonTrees preserves left object key order followed by added right keys and annotates subtrees", () => {
  const left = parseLosslessly(
    '{"keep":1,"removedObj":{"nested":[10,20]},"changedKey":"before"}',
  );
  const right = parseLosslessly(
    '{"addedFirst":true,"changedKey":"after","keep":1,"addedLast":{"x":2}}',
  );

  const diff = diffJsonTrees(left, right);
  assertValidDiffInvariants(diff);

  const keys = diff.root.children!.map((c) => c.key);
  assert.deepEqual(keys, ["keep", "removedObj", "changedKey", "addedFirst", "addedLast"]);

  // keep -> unchanged
  const keepNode = diff.root.children![0].value;
  assert.equal(diff.annotations[keepNode.id], undefined);

  // removedObj + nested + 10 + 20 -> all 4 marked removed
  const removedObj = diff.root.children![1].value;
  walkJsonTree(removedObj, (node) => {
    assert.deepEqual(diff.annotations[node.id], { status: "removed" });
  });

  // changedKey -> changed with oldRaw
  const changedNode = diff.root.children![2].value;
  assert.equal(changedNode.value, "after");
  assert.deepEqual(diff.annotations[changedNode.id], {
    status: "changed",
    oldRaw: '"before"',
  });

  // addedFirst & addedLast subtree -> all marked added
  const addedFirst = diff.root.children![3].value;
  assert.deepEqual(diff.annotations[addedFirst.id], { status: "added" });
  const addedLast = diff.root.children![4].value;
  walkJsonTree(addedLast, (node) => {
    assert.deepEqual(diff.annotations[node.id], { status: "added" });
  });

  assert.deepEqual(diff.summary, {
    added: 3, // addedFirst, addedLast, x:2
    removed: 4, // removedObj, nested, 10, 20
    changed: 1, // changedKey
    unchanged: 2, // root object, keep
  });
});

test("diffJsonTrees matches duplicate object keys by occurrence index and handles __proto__ safely", () => {
  const left = parseLosslessly('{"__proto__":1,"dup":10,"dup":20,"dup":30}');
  const right = parseLosslessly('{"dup":10,"dup":25,"__proto__":2}');

  const diff = diffJsonTrees(left, right);
  assertValidDiffInvariants(diff);

  const children = diff.root.children!;
  assert.deepEqual(
    children.map((c) => c.key),
    ["__proto__", "dup", "dup", "dup"],
  );
  assert.deepEqual(diff.annotations[children[0].value.id], {
    status: "changed",
    oldRaw: "1",
  });
  assert.equal(diff.annotations[children[1].value.id], undefined);
  assert.deepEqual(diff.annotations[children[2].value.id], {
    status: "changed",
    oldRaw: "20",
  });
  assert.deepEqual(diff.annotations[children[3].value.id], {
    status: "removed",
  });
});

test("diffJsonTrees aligns arrays by index for added, removed, and changed items", () => {
  const left = parseLosslessly("[1, 2, 3, 4]");
  const right = parseLosslessly("[1, 22]");

  const shrunk = diffJsonTrees(left, right);
  assertValidDiffInvariants(shrunk);
  assert.equal(shrunk.root.children!.length, 4);
  assert.equal(shrunk.annotations[shrunk.root.children![0].value.id], undefined);
  assert.deepEqual(shrunk.annotations[shrunk.root.children![1].value.id], {
    status: "changed",
    oldRaw: "2",
  });
  assert.deepEqual(shrunk.annotations[shrunk.root.children![2].value.id], { status: "removed" });
  assert.deepEqual(shrunk.annotations[shrunk.root.children![3].value.id], { status: "removed" });

  const grown = diffJsonTrees(right, left);
  assertValidDiffInvariants(grown);
  assert.equal(grown.root.children!.length, 4);
  assert.deepEqual(grown.annotations[grown.root.children![1].value.id], {
    status: "changed",
    oldRaw: "22",
  });
  assert.deepEqual(grown.annotations[grown.root.children![2].value.id], { status: "added" });
  assert.deepEqual(grown.annotations[grown.root.children![3].value.id], { status: "added" });
});

test("diffJsonTrees compares lossless number tokens and handles type mismatches and missing raw fallback", () => {
  const left = parseLosslessly(
    '{"snowflake":9007199254740992,"scale":1,"objToPrim":{"a":1},"primToArr":false}',
  );
  const right = parseLosslessly(
    '{"snowflake":9007199254740993,"scale":1.0,"objToPrim":null,"primToArr":[7,8]}',
  );

  const diff = diffJsonTrees(left, right);
  assertValidDiffInvariants(diff);

  const [snowflake, scale, objToPrim, primToArr] = diff.root.children!.map((c) => c.value);
  assert.deepEqual(diff.annotations[snowflake.id], {
    status: "changed",
    oldRaw: "9007199254740992",
  });
  assert.deepEqual(diff.annotations[scale.id], {
    status: "changed",
    oldRaw: "1",
  });
  assert.deepEqual(diff.annotations[objToPrim.id], {
    status: "changed",
    oldRaw: '{"a":1}',
  });
  assert.deepEqual(diff.annotations[primToArr.id], {
    status: "changed",
    oldRaw: "false",
  });
  assert.deepEqual(diff.annotations[primToArr.children![0].value.id], { status: "added" });
  assert.deepEqual(diff.annotations[primToArr.children![1].value.id], { status: "added" });

  // Synthetic string node without .raw falls back to JSON.stringify(left.value)
  const syntheticLeft: JsonTreeNode = { id: 0, type: "string", value: "alpha" };
  const syntheticRight: JsonTreeNode = { id: 0, type: "string", raw: '"beta"', value: "beta" };
  const syntheticDiff = diffJsonTrees(syntheticLeft, syntheticRight);
  assertValidDiffInvariants(syntheticDiff);
  assert.deepEqual(syntheticDiff.annotations[syntheticDiff.root.id], {
    status: "changed",
    oldRaw: '"alpha"',
  });
});

test("cross-decoded diff attaches inner structural diff for escaped, double-encoded, and pre-decoded JSON strings", () => {
  const left = parseLosslessly(
    JSON.stringify({
      payload: JSON.stringify({ user: { id: 1, role: "viewer" }, removedFlag: true }),
      doubleEncoded: JSON.stringify(JSON.stringify([10, 20])),
      embeddedLog: 'event: {"code":200,"msg":"ok"}',
      plain: "hello",
    }),
  );
  const right = parseLosslessly(
    JSON.stringify({
      payload: JSON.stringify({ user: { id: 1, role: "admin" }, addedFlag: "yes" }),
      doubleEncoded: JSON.stringify(JSON.stringify([10, 99, 30])),
      embeddedLog: 'event: {"code":500,"msg":"ok"}',
      plain: "world",
    }),
  );

  const diff = diffJsonTrees(left, right);
  assertValidDiffInvariants(diff);

  const payloadNode = diff.root.children![0].value;
  assert.equal(diff.annotations[payloadNode.id]?.status, "changed");
  assert.ok(payloadNode.decoded, "expected payload string to carry cross-decoded inner diff");
  assert.equal(payloadNode.decoded.unwrapDepth, 0);
  assert.equal(payloadNode.decoded.embedded, undefined);

  const innerPayload = payloadNode.decoded.root;
  assert.deepEqual(
    innerPayload.children!.map((c) => c.key),
    ["user", "removedFlag", "addedFlag"],
  );
  const innerUser = innerPayload.children![0].value;
  const innerId = innerUser.children![0].value;
  const innerRole = innerUser.children![1].value;
  const removedFlag = innerPayload.children![1].value;
  const addedFlag = innerPayload.children![2].value;

  assert.equal(diff.annotations[innerId.id], undefined);
  assert.deepEqual(diff.annotations[innerRole.id], {
    status: "changed",
    oldRaw: '"viewer"',
  });
  assert.deepEqual(diff.annotations[removedFlag.id], { status: "removed" });
  assert.deepEqual(diff.annotations[addedFlag.id], { status: "added" });

  // Double-encoded string preserves unwrapDepth: 1
  const doubleNode = diff.root.children![1].value;
  assert.ok(doubleNode.decoded);
  assert.equal(doubleNode.decoded.unwrapDepth, 1);
  assert.equal(doubleNode.decoded.root.children!.length, 3);
  assert.deepEqual(diff.annotations[doubleNode.decoded.root.children![1].value.id], {
    status: "changed",
    oldRaw: "20",
  });
  assert.deepEqual(diff.annotations[doubleNode.decoded.root.children![2].value.id], {
    status: "added",
  });

  // Embedded JSON inside surrounding log text sets embedded: true
  const embeddedNode = diff.root.children![2].value;
  assert.ok(embeddedNode.decoded);
  assert.equal(embeddedNode.decoded.embedded, true);
  assert.deepEqual(diff.annotations[embeddedNode.decoded.root.children![0].value.id], {
    status: "changed",
    oldRaw: "200",
  });

  // Plain string does not attach decoded
  const plainNode = diff.root.children![3].value;
  assert.equal(plainNode.decoded, undefined);

  // Disabling decodeEmbeddedJson omits inner decoded diff
  const disabledDiff = diffJsonTrees(left, right, { decodeEmbeddedJson: false });
  assertValidDiffInvariants(disabledDiff);
  assert.equal(disabledDiff.root.children![0].value.decoded, undefined);
});

test("cross-decoded diff works when left.decoded or right.decoded already exists", () => {
  const left = parseLosslessly('{"token":"opaque-left"}');
  const right = parseLosslessly('{"token":"opaque-right"}');
  buildJsonTreeContextIndex(left).attachDecoded(left.children![0].value.id, {
    root: parseLosslessly('{"sub":"u1","exp":100}'),
    unwrapDepth: 0,
    kind: "jwt",
  });
  buildJsonTreeContextIndex(right).attachDecoded(right.children![0].value.id, {
    root: parseLosslessly('{"sub":"u1","exp":200}'),
    unwrapDepth: 0,
    kind: "jwt",
  });

  const diff = diffJsonTrees(left, right);
  assertValidDiffInvariants(diff);
  const tokenNode = diff.root.children![0].value;
  assert.equal(tokenNode.decoded?.kind, "jwt");
  const expNode = tokenNode.decoded!.root.children![1].value;
  assert.deepEqual(diff.annotations[expNode.id], { status: "changed", oldRaw: "100" });
});

test("diffJsonTrees is stack-safe on 15,000-level deep trees and enforces maxNodes", () => {
  const buildDeep = (leafRaw: string): JsonTreeNode => {
    let current: JsonTreeNode = { id: 0, type: "number", raw: leafRaw };
    for (let i = 0; i < 15_000; i += 1) {
      current = { id: i + 1, type: "array", children: [{ key: 0, value: current }] };
    }
    return current;
  };

  const deepLeft = buildDeep("1");
  const deepRight = buildDeep("2");
  const diff = diffJsonTrees(deepLeft, deepRight);
  assert.equal(diff.nodeCount, 15_001);
  assert.equal(diff.summary.unchanged, 15_000);
  assert.equal(diff.summary.changed, 1);

  assert.throws(
    () => diffJsonTrees(deepLeft, deepRight, { maxNodes: 100 }),
    JsonValueNodeLimitError,
  );
});

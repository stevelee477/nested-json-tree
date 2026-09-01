import assert from "node:assert/strict";
import test from "node:test";
import { parseTree } from "jsonc-parser";
import {
  JsonTreeNode,
  JsonTreeOutputTooLargeError,
  assertTransferTextSize,
  buildJsonTree,
  buildJsonTreeContextIndex,
  countJsonTreeNodes,
  createJsonTreeWebviewModel,
  findJsonTreeNode,
  isValidJsonTreeNodeId,
  jsonTreeToValue,
  materializeJsonTreePath,
  measureJsonTreeString,
  stringifyJsonTree,
  stringifyJsonTreeForTransfer,
} from "../jsonTree";

function parseLosslessly(source: string): JsonTreeNode {
  const errors: unknown[] = [];
  const root = parseTree(source, errors as never[], { allowTrailingComma: true });
  assert.ok(root);
  assert.deepEqual(errors, []);
  return buildJsonTree(root, source);
}

test("preserves exact string and number tokens", () => {
  const root = parseLosslessly('{"big":9007199254740993,"unicode":"\\u0061","slash":"\\/"}');
  assert.equal(root.children?.[0].value.raw, "9007199254740993");
  assert.equal(root.children?.[1].value.raw, '"\\u0061"');
  assert.equal(root.children?.[1].value.value, "a");
  assert.equal(root.children?.[2].value.raw, '"\\/"');
  assert.equal(root.children?.[2].value.value, "/");
});

test("formats strict JSON without losing comments, trailing-comma values, escapes, or duplicate keys", () => {
  const root = parseLosslessly(`{
    // preserve the data, not JSONC trivia
    "\\u0061": 9007199254740993,
    "a": "\\/",
  }`);
  assert.equal(
    stringifyJsonTree(root),
    '{\n  "\\u0061": 9007199254740993,\n  "a": "\\/"\n}',
  );

  const duplicateRoot = parseLosslessly('{"same":1,"same":2}');
  assert.equal(stringifyJsonTree(duplicateRoot, 0), '{"same":1,"same":2}');
});

test("finds node IDs and counts with an early-exit ceiling", () => {
  const root = parseLosslessly('{"items":[1,2,3]}');
  const second = root.children?.[0].value.children?.[1].value;
  assert.ok(second);
  assert.equal(findJsonTreeNode(root, second.id), second);
  assert.equal(findJsonTreeNode(root, 10_000), undefined);
  assert.equal(countJsonTreeNodes(root), 5);
  assert.equal(countJsonTreeNodes(root, 2), 3);
});

test("indexes trusted node contexts and materializes object/array paths", () => {
  const root = parseLosslessly('{"users":[{"name":"Ada"}]}');
  const contexts = buildJsonTreeContextIndex(root);
  const name = root.children?.[0].value.children?.[0].value.children?.[0].value;
  assert.ok(name);
  const context = contexts.get(name.id);
  assert.ok(context);
  assert.equal(context.node, name);
  assert.deepEqual(materializeJsonTreePath(context), ["users", 0, "name"]);
  assert.equal(context.hasDuplicateKeyInPath, false);
  const rootContext = contexts.get(root.id);
  assert.ok(rootContext);
  assert.deepEqual(materializeJsonTreePath(rootContext), []);
});

test("marks duplicate-key paths and descendants as ambiguous", () => {
  const root = parseLosslessly('{"same":{"x":1},"same":{"x":2},"unique":3}');
  const contexts = buildJsonTreeContextIndex(root);
  const firstSame = root.children?.[0].value;
  const secondSame = root.children?.[1].value;
  const unique = root.children?.[2].value;
  assert.ok(firstSame && secondSame && unique);

  for (const node of [
    firstSame,
    firstSame.children?.[0].value,
    secondSame,
    secondSame.children?.[0].value,
  ]) {
    assert.ok(node);
    assert.equal(contexts.get(node.id)?.hasDuplicateKeyInPath, true);
  }
  assert.equal(contexts.get(unique.id)?.hasDuplicateKeyInPath, false);
});

test("retains decoded and exact raw key tokens in host contexts", () => {
  const root = parseLosslessly('{"\\u0061":"x"}');
  const child = root.children?.[0].value;
  assert.ok(child);
  const context = buildJsonTreeContextIndex(root).get(child.id);
  assert.ok(context);
  assert.equal(context.key, "a");
  assert.equal(context.rawKey, '"\\u0061"');
});

test("validates Webview node IDs as non-negative safe integers", () => {
  assert.equal(isValidJsonTreeNodeId(0), true);
  assert.equal(isValidJsonTreeNodeId(Number.MAX_SAFE_INTEGER), true);
  for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, "1", null]) {
    assert.equal(isValidJsonTreeNodeId(value), false, `expected ${String(value)} to be rejected`);
  }
});

test("bounds Webview fields while preserving complete host tokens", () => {
  const source = '{"abcdefghijk":"0123456789abcdef"}';
  const root = parseLosslessly(source);
  const originalChild = root.children?.[0];
  assert.ok(originalChild);
  const display = createJsonTreeWebviewModel(root, 8);
  const child = display.root.children?.[0];
  assert.ok(child);

  assert.equal(typeof child.key, "string");
  assert.equal((child.key as string).length, 8);
  assert.equal(child.keyTruncated, true);
  assert.equal(child.keyLength, 11);
  assert.equal(child.rawKey?.length, 8);
  assert.equal(child.rawKeyTruncated, true);
  assert.equal(child.rawKeyLength, 13);
  assert.equal(child.value.raw?.length, 8);
  assert.equal(child.value.rawTruncated, true);
  assert.equal(child.value.rawLength, 18);
  assert.equal((child.value.value as string).length, 8);
  assert.equal(child.value.valueTruncated, true);
  assert.equal(child.value.valueLength, 16);
  assert.equal(display.truncatedFieldCount, 4);
  assert.equal(originalChild.key, "abcdefghijk");
  assert.equal(originalChild.rawKey, '"abcdefghijk"');
  assert.equal(originalChild.value.raw, '"0123456789abcdef"');
  assert.equal(originalChild.value.value, "0123456789abcdef");
});

test("creates compatibility values iteratively and handles __proto__ as data", () => {
  const root = parseLosslessly('{"__proto__":{"safe":true},"same":1,"same":2}');
  const value = jsonTreeToValue(root) as Record<string, unknown>;
  assert.equal(Object.prototype.hasOwnProperty.call(value, "__proto__"), true);
  assert.deepEqual(value.__proto__, { safe: true });
  assert.equal(value.same, 2);
});

test("serializes deeply nested trees without recursive calls", () => {
  let root: JsonTreeNode = { id: 20_000, type: "number", raw: "1" };
  for (let depth = 19_999; depth >= 0; depth -= 1) {
    root = { id: depth, type: "array", children: [{ key: 0, value: root }] };
  }
  const compact = stringifyJsonTree(root, 0);
  assert.equal(compact.length, 40_001);
  assert.equal(compact.slice(0, 4), "[[[[");
  assert.equal(compact.slice(-4), "]]]]");
});

test("measures pretty output and falls back to compact JSON before allocating it", () => {
  let root: JsonTreeNode = { id: 4_096, type: "number", raw: "1" };
  for (let depth = 4_095; depth >= 0; depth -= 1) {
    root = { id: depth, type: "array", children: [{ key: 0, value: root }] };
  }

  assert.ok(measureJsonTreeString(root) > 16 * 1024 * 1024);
  const serialized = stringifyJsonTreeForTransfer(root);
  assert.equal(serialized.compacted, true);
  assert.equal(serialized.text.length, 8_193);
});

test("rejects serialized and raw transfer text above the absolute output limit", () => {
  const root: JsonTreeNode = { id: 0, type: "string", raw: '"123456789"', value: "123456789" };
  assert.throws(() => stringifyJsonTreeForTransfer(root, 5, 8), JsonTreeOutputTooLargeError);
  assert.throws(() => assertTransferTextSize("123456789", 8), JsonTreeOutputTooLargeError);
});

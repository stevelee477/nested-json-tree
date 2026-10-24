import assert from "node:assert/strict";
import test from "node:test";
import { parseTree } from "jsonc-parser";
import {
  JsonTreeNode,
  JsonTreeOutputTooLargeError,
  assertTransferTextSize,
  buildJsonTree,
  buildJsonTreeContextIndex,
  createJsonTreeWebviewModel,
  isValidJsonTreeNodeId,
  jsonTreeToValue,
  looksLikeEmbeddedJson,
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

test("node index resolves every node ID and rejects unknown ones", () => {
  const root = parseLosslessly('{"items":[1,2,3]}');
  const second = root.children?.[0].value.children?.[1].value;
  assert.ok(second);
  const index = buildJsonTreeContextIndex(root);
  assert.equal(index.get(second.id)?.node, second);
  assert.deepEqual(materializeJsonTreePath(index.get(second.id)!), ["items", 1]);
  assert.equal(index.get(10_000), undefined);
  assert.equal(index.get(-1), undefined);
  assert.equal(index.get(1.5), undefined);
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

// --- Source offsets, inline decoded JSON, and structural paths ---------------

function decodedFrom(source: string) {
  return { root: parseLosslessly(source), unwrapDepth: 0 };
}

test("records source ranges for values and object keys", () => {
  const source = '{"a": [1, {"b": "x"}]}';
  const root = parseLosslessly(source);
  const array = root.children![0];
  assert.equal(source.slice(array.keyOffset, array.keyOffset! + 3), '"a"');
  assert.equal(source.slice(array.value.offset, array.value.offset! + array.value.length!), '[1, {"b": "x"}]');
  const x = array.value.children![1].value.children![0].value;
  assert.equal(source.slice(x.offset, x.offset! + x.length!), '"x"');
});

test("finds the deepest node at a source offset, treating keys as part of their property", () => {
  const source = '{"user": {"id": 7, "tags": ["a", "b"]}, "ok": true}';
  const root = parseLosslessly(source);
  const index = buildJsonTreeContextIndex(root);
  const at = (needle: string, delta = 0) => index.nodeAtOffset(source.indexOf(needle) + delta);
  assert.equal(at("7")?.raw, "7");
  assert.equal(at('"id"', 1)?.raw, "7", "a key resolves to its value");
  assert.equal(at('"b"')?.raw, '"b"');
  assert.equal(at('["a"')?.type, "array");
  assert.equal(at(", \"ok\"")?.type, "object", "separators resolve to the enclosing container");
  assert.equal(at("true")?.raw, "true");
  assert.equal(index.nodeAtOffset(-1), undefined);
  assert.equal(index.nodeAtOffset(source.length), undefined);
});

test("attaches decoded JSON with fresh IDs, parent links, and decode path segments", () => {
  const root = parseLosslessly('{"payload": "{\\"user\\": {\\"id\\": 7}}", "same": 1, "same": 2}');
  const index = buildJsonTreeContextIndex(root);
  const payload = root.children![0].value;
  const firstFreeId = index.nextId;
  const decoded = decodedFrom('{"user": {"id": 7}}');
  index.attachDecoded(payload.id, decoded);

  assert.equal(payload.decoded, decoded);
  assert.equal(decoded.root.id, firstFreeId);
  assert.equal(decoded.root.offset, undefined, "decoded content has no source range");
  const id = decoded.root.children![0].value.children![0].value;
  const context = index.get(id.id)!;
  assert.deepEqual(materializeJsonTreePath(context), ["payload", { decode: 1 }, "user", "id"]);
  assert.equal(index.get(decoded.root.id)?.decodedFrom, decoded);
  assert.equal(context.hasDuplicateKeyInPath, false);
  assert.deepEqual(index.ancestry(id.id), [root.id, payload.id, decoded.root.id, decoded.root.children![0].value.id, id.id]);
  assert.throws(() => index.attachDecoded(payload.id, decodedFrom("[1]")), /already decoded/);
  assert.throws(() => index.attachDecoded(root.id, decodedFrom("[1]")), /not a string/);
});

test("structural paths survive re-parsing and cross decoded boundaries", () => {
  const source = '{"a": 1, "payload": "[10, 20]"}';
  const first = parseLosslessly(source);
  const firstIndex = buildJsonTreeContextIndex(first);
  firstIndex.attachDecoded(first.children![1].value.id, decodedFrom("[10, 20]"));
  const twenty = first.children![1].value.decoded!.root.children![1].value;
  const path = firstIndex.structuralPath(twenty.id)!;

  const second = parseLosslessly(source);
  const secondIndex = buildJsonTreeContextIndex(second);
  assert.equal(secondIndex.resolveStructuralPath(path), undefined, "not decoded yet");
  secondIndex.attachDecoded(second.children![1].value.id, decodedFrom("[10, 20]"));
  assert.equal(secondIndex.resolveStructuralPath(path)?.raw, "20");
});

test("rebuilding an index includes previously attached decoded content", () => {
  const root = parseLosslessly('{"payload": "[1]"}');
  buildJsonTreeContextIndex(root).attachDecoded(root.children![0].value.id, decodedFrom("[1]"));
  const rebuilt = buildJsonTreeContextIndex(root);
  const one = root.children![0].value.decoded!.root.children![0].value;
  assert.equal(rebuilt.get(one.id)?.node, one);
  assert.equal(rebuilt.size, 4);
});

test("Webview models flag decodable strings and carry decoded content", () => {
  const root = parseLosslessly('{"a": "{\\"x\\":1}", "b": " [1] ", "c": "\\"{\\\\\\"y\\\\\\":2}\\"", "d": "{x", "e": "plain"}');
  const model = createJsonTreeWebviewModel(root).root;
  assert.deepEqual(model.children!.map((child) => child.value.decodable === true), [true, true, true, false, false]);
  buildJsonTreeContextIndex(root).attachDecoded(root.children![0].value.id, decodedFrom('{"x":1}'));
  const decodedModel = createJsonTreeWebviewModel(root).root.children![0].value;
  assert.equal(decodedModel.decodable, undefined);
  assert.equal(decodedModel.decoded?.root.children?.[0].key, "x");
  // Copy/serialize output is unaffected by attached decoded content.
  assert.equal(stringifyJsonTree(root, 0), '{"a":"{\\"x\\":1}","b":" [1] ","c":"\\"{\\\\\\"y\\\\\\":2}\\"","d":"{x","e":"plain"}');
});

test("embedded JSON detection is a cheap whole-value bracket check", () => {
  assert.equal(looksLikeEmbeddedJson('{"a":1}'), true);
  assert.equal(looksLikeEmbeddedJson("\n [1, 2] \t"), true);
  assert.equal(looksLikeEmbeddedJson('"{\\"a\\":1}"'), true);
  assert.equal(looksLikeEmbeddedJson("{}"), true);
  for (const value of ["", "{", "[1", "text {1}", '"plain"', "1", "{x} y"]) {
    assert.equal(looksLikeEmbeddedJson(value), false, value);
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { deflateRawSync, deflateSync, gzipSync } from "node:zlib";
import { decodeBase64Bytes, detectDecodableKind, isLikelyPlainWordOrHash } from "../decodable";
import { decodeInlineString } from "../inlineDecoder";
import {
  MAX_WEBVIEW_FULL_SNIFF_STRINGS,
  cachedDetectDecodableKind,
  createJsonTreeWebviewModel,
  jsonTreeToValue,
  type JsonTreeNode,
} from "../jsonTree";

const pickFirst = async <T>(items: T[]): Promise<T | undefined> => items[0];

function toBase64Url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

test("detects and decodes JWT tokens into header, payload, and signature", async () => {
  const jwt = [
    toBase64Url(JSON.stringify({ alg: "HS256", typ: "JWT" })),
    toBase64Url(JSON.stringify({ sub: "user_42", iat: 1767225600, exp: 1767229200 })),
    "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
  ].join(".");

  assert.equal(detectDecodableKind(jwt), "jwt");
  const decoded = await decodeInlineString(jwt, 10_000, pickFirst);
  assert.ok(decoded);
  assert.equal(decoded.kind, "jwt");
  assert.deepEqual(jsonTreeToValue(decoded.root), {
    header: { alg: "HS256", typ: "JWT" },
    payload: { sub: "user_42", iat: 1767225600, exp: 1767229200 },
    signature: "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
  });
});

test("detects and decodes URLs with query strings while ignoring plain links", async () => {
  assert.equal(detectDecodableKind("https://example.com/docs"), undefined);
  assert.equal(detectDecodableKind("https://example.com/a"), undefined);

  const url = "https://api.example.com/v1/search?q=hello+world&filter=%7B%22ok%22%3Atrue%7D&tag=a&tag=b#top";
  assert.equal(detectDecodableKind(url), "url");
  const decoded = await decodeInlineString(url, 10_000, pickFirst);
  assert.ok(decoded);
  assert.equal(decoded.kind, "url");
  const params = decoded.root.children?.find((child) => child.key === "params")?.value;
  assert.ok(params?.children);
  assert.deepEqual(
    params.children.map((child) => [child.key, child.value.value]),
    [
      ["q", "hello world"],
      ["filter", '{"ok":true}'],
      ["tag", "a"],
      ["tag", "b"],
    ],
  );
  // The JSON value inside the query parameter is itself flagged as decodable.
  assert.equal(detectDecodableKind(params.children[1].value.value as string), "json");
});

test("detects and decodes Base64 and Base64URL JSON payloads", async () => {
  const payload = '{"event":"order.created","id":9007199254740993}';
  const std = Buffer.from(payload, "utf8").toString("base64");
  const urlSafe = Buffer.from(payload, "utf8").toString("base64url");

  for (const encoded of [std, urlSafe]) {
    assert.equal(detectDecodableKind(encoded), "base64");
    const decoded = await decodeInlineString(encoded, 10_000, pickFirst);
    assert.ok(decoded);
    assert.equal(decoded.kind, "base64-json");
    assert.equal(decoded.root.children?.[0].value.value, "order.created");
    assert.equal(decoded.root.children?.[1].value.raw, "9007199254740993");
  }
});

test("detects and decodes Base64-encoded Protobuf messages into field numbers and values", async () => {
  // field 1 (string) = "alice" -> 0a 05 61 6c 69 63 65
  // field 2 (varint) = 30      -> 10 1e
  // field 3 (nested) = { 1: 1, 2: "meta" } -> 1a 08 08 01 12 04 6d 65 74 61
  const pbBytes = Buffer.from([
    0x0a, 0x05, 0x61, 0x6c, 0x69, 0x63, 0x65,
    0x10, 0x1e,
    0x1a, 0x08, 0x08, 0x01, 0x12, 0x04, 0x6d, 0x65, 0x74, 0x61,
  ]);
  const b64 = pbBytes.toString("base64");
  const b64Url = pbBytes.toString("base64url");

  for (const encoded of [b64, b64Url]) {
    assert.equal(detectDecodableKind(encoded), "base64");
    const decoded = await decodeInlineString(encoded, 10_000, pickFirst);
    assert.ok(decoded);
    assert.equal(decoded.kind, "base64-protobuf");
    assert.deepEqual(jsonTreeToValue(decoded.root), {
      "1": "alice",
      "2": 30,
      "3": { "1": 1, "2": "meta" },
    });
  }

  // Padded varint-only protobuf: field 1 = 150, field 2 = 1 -> 08 96 01 10 01 -> "CJYBEAE="
  const paddedVarintPb = Buffer.from([0x08, 0x96, 0x01, 0x10, 0x01]).toString("base64");
  assert.equal(paddedVarintPb, "CJYBEAE=");
  assert.equal(detectDecodableKind(paddedVarintPb), "base64");
  const decodedVarints = await decodeInlineString(paddedVarintPb, 10_000, pickFirst);
  assert.ok(decodedVarints);
  assert.equal(decodedVarints.kind, "base64-protobuf");
  assert.deepEqual(jsonTreeToValue(decodedVarints.root), { "1": 150, "2": 1 });
});

test("detects and decodes Base64 readable text strings", async () => {
  const b64 = Buffer.from("Hello, Nested JSON Tree!", "utf8").toString("base64");
  assert.equal(detectDecodableKind(b64), "base64");
  const decoded = await decodeInlineString(b64, 10_000, pickFirst);
  assert.ok(decoded);
  assert.equal(decoded.kind, "base64-text");
  assert.equal(decoded.root.type, "string");
  assert.equal(decoded.root.value, "Hello, Nested JSON Tree!");
});

test("avoids false positives on ordinary words, identifiers, acronyms, and hex hashes", () => {
  const ordinaryStrings = [
    "",
    "a",
    "abc",
    "plain",
    "test",
    "true",
    "null",
    "hello",
    "username",
    "password",
    "metadata",
    "requestId",
    "req_demo_4096",
    "Ada Lovelace",
    "INFO",
    "WARN",
    "ERROR",
    "DEBUG",
    "CORE",
    "INIT",
    "OPEN",
    "UINT",
    "ENUM",
    "IPV4",
    "IPV6",
    "CORS",
    "CONSUMER",
    "COMPILER",
    "HTTP",
    "JSON",
    "DATA",
    "CODE",
    "NAME",
    "TYPE",
    "TEXT",
    "UserInfo",
    "OrderLog",
    "JsonTree",
    "CamelCase",
    "UserName",
    "PassWord",
    "MetaData",
    "my-service-name",
    "order-v2-prod",
    "12345678",
    "1767225600000",
    "550e8400e29b41d4a716446655440000",
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "https://example.com/docs",
    "1.2.3",
    "a.b.c",
  ];
  for (const sample of ordinaryStrings) {
    assert.equal(detectDecodableKind(sample), undefined, `unexpectedly flagged as decodable: ${sample}`);
  }
});

test("decodeBase64Bytes validates trailing bits, padding, and alphabet strictly", () => {
  assert.equal(Buffer.from(decodeBase64Bytes("SGVsbG8=") ?? []).toString("utf8"), "Hello");
  assert.equal(Buffer.from(decodeBase64Bytes("SGVsbG8") ?? []).toString("utf8"), "Hello");
  assert.equal(Buffer.from(decodeBase64Bytes("e30") ?? []).toString("utf8"), "{}");
  assert.equal(Buffer.from(decodeBase64Bytes("QQ==") ?? []).toString("utf8"), "A");
  // Non-canonical trailing unused bits
  assert.equal(decodeBase64Bytes("QR=="), undefined);
  assert.equal(decodeBase64Bytes("SGVsbG9"), undefined);
  // Mixed standard/URL alphabets, internal '=', or invalid characters
  assert.equal(decodeBase64Bytes("ab+d-f=="), undefined);
  assert.equal(decodeBase64Bytes("AA=A"), undefined);
  assert.equal(decodeBase64Bytes("A==="), undefined);
  assert.equal(isLikelyPlainWordOrHash("my-service-name"), true);
});

test("detects and decodes Base64 and Base64URL Gzip, Zlib, and Deflate payloads", async () => {
  const jsonPayload = '{"service":"billing","traceId":9007199254740993,"ok":true}';
  const gzipB64 = gzipSync(jsonPayload).toString("base64");
  const gzipB64Url = gzipSync(jsonPayload).toString("base64url");
  const zlibB64 = deflateSync(jsonPayload).toString("base64");
  const rawDeflateB64 = deflateRawSync(jsonPayload).toString("base64");

  for (const encoded of [gzipB64, gzipB64Url, zlibB64, rawDeflateB64]) {
    assert.equal(detectDecodableKind(encoded), "base64");
    const decoded = await decodeInlineString(encoded, 10_000, pickFirst);
    assert.ok(decoded);
    assert.equal(decoded.kind, "base64-gzip-json");
    assert.equal(decoded.root.children?.[0].value.value, "billing");
    assert.equal(decoded.root.children?.[1].value.raw, "9007199254740993");
  }

  // Compressed Protobuf wire format (gzip + zlib)
  const pbBytes = new Uint8Array([
    0x0a, 0x05, 0x61, 0x6c, 0x69, 0x63, 0x65,
    0x10, 0x2a,
  ]);
  for (const compressed of [gzipSync(pbBytes).toString("base64"), deflateSync(pbBytes).toString("base64url")]) {
    assert.equal(detectDecodableKind(compressed), "base64");
    const decoded = await decodeInlineString(compressed, 10_000, pickFirst);
    assert.ok(decoded);
    assert.equal(decoded.kind, "base64-protobuf");
    assert.deepEqual(jsonTreeToValue(decoded.root), { "1": "alice", "2": 42 });
  }

  // Compressed UTF-8 plain text (gzip + zlib + raw deflate)
  const textSample =
    "Compressed multi-line log message\nline two: all systems nominal. Repeated message: all systems nominal!";
  for (const compressed of [
    gzipSync(textSample).toString("base64"),
    deflateSync(textSample).toString("base64"),
    deflateRawSync(textSample).toString("base64"),
  ]) {
    assert.equal(detectDecodableKind(compressed), "base64");
    const decoded = await decodeInlineString(compressed, 10_000, pickFirst);
    assert.ok(decoded);
    assert.equal(decoded.kind, "base64-text");
    assert.equal(decoded.root.value, textSample);
  }
});

test("blocks Gzip and Zlib zip bombs exceeding 4 MiB output limit and rejects corrupt gzip headers", async () => {
  const oversized = new Uint8Array(4 * 1024 * 1024 + 1024).fill(0x61);
  const gzipBomb = gzipSync(oversized).toString("base64");
  const zlibBomb = deflateSync(oversized).toString("base64");

  for (const bomb of [gzipBomb, zlibBomb]) {
    assert.equal(detectDecodableKind(bomb), undefined);
    assert.equal(await decodeInlineString(bomb, 10_000, pickFirst), null);
  }

  const corruptGzip = Buffer.from([0x1f, 0x8b, 0x08, 0, 1, 2, 3, 4, 5, 6, 7, 8]).toString("base64");
  assert.equal(detectDecodableKind(corruptGzip), undefined);
  assert.equal(await decodeInlineString(corruptGzip, 10_000, pickFirst), null);
});

test("supports relative URLs, custom URI schemes, standalone query strings, and percent-encoded JSON", async () => {
  // 1. Relative URL with query string
  const relUrl = "/api/v1/items?page=2&limit=50&filter=active#results";
  assert.equal(detectDecodableKind(relUrl), "url");
  const decodedRel = await decodeInlineString(relUrl, 10_000, pickFirst);
  assert.ok(decodedRel);
  assert.equal(decodedRel.kind, "url");
  assert.deepEqual(jsonTreeToValue(decodedRel.root), {
    pathname: "/api/v1/items",
    params: { page: "2", limit: "50", filter: "active" },
    hash: "#results",
  });

  // 2. Custom URI schemes (ws://, wss://, grpc://, app://)
  const grpcUrl = "grpc://auth.internal:50051/v1.Auth/Check?timeout=5s&retry=2";
  assert.equal(detectDecodableKind(grpcUrl), "url");
  const decodedGrpc = await decodeInlineString(grpcUrl, 10_000, pickFirst);
  assert.ok(decodedGrpc);
  assert.deepEqual(jsonTreeToValue(decodedGrpc.root), {
    origin: "grpc://auth.internal:50051",
    pathname: "/v1.Auth/Check",
    params: { timeout: "5s", retry: "2" },
  });

  for (const customUrl of [
    "ws://localhost:8080/events?channel=orders",
    "wss://realtime.example.com/socket?v=2&compress=1",
    "app://deep/screen?tab=settings&id=7",
  ]) {
    assert.equal(detectDecodableKind(customUrl), "url");
    assert.ok(await decodeInlineString(customUrl, 10_000, pickFirst));
  }

  // 3. Standalone query/form strings
  const queryStr = "a=1&b=hello+world&c=3";
  assert.equal(detectDecodableKind(queryStr), "url");
  const decodedQuery = await decodeInlineString(queryStr, 10_000, pickFirst);
  assert.ok(decodedQuery);
  assert.equal(decodedQuery.kind, "url");
  assert.deepEqual(jsonTreeToValue(decodedQuery.root), { a: "1", b: "hello world", c: "3" });

  const singleEscapedQuery = "payload=%7B%22ok%22%3Atrue%7D";
  assert.equal(detectDecodableKind(singleEscapedQuery), "url");
  const decodedSingleQuery = await decodeInlineString(singleEscapedQuery, 10_000, pickFirst);
  assert.ok(decodedSingleQuery);
  assert.deepEqual(jsonTreeToValue(decodedSingleQuery.root), { payload: '{"ok":true}' });

  // 4. URL percent-encoded JSON containers
  const pctObj = encodeURIComponent('{"event":"signup","id":9007199254740993}');
  assert.equal(detectDecodableKind(pctObj), "url");
  const decodedPctObj = await decodeInlineString(pctObj, 10_000, pickFirst);
  assert.ok(decodedPctObj);
  assert.equal(decodedPctObj.kind, "url-json");
  assert.equal(decodedPctObj.root.children?.[0].value.value, "signup");
  assert.equal(decodedPctObj.root.children?.[1].value.raw, "9007199254740993");

  const pctArr = "%5B%7B%22msg%22%3A%22hello+world%22%7D%2C2%5D";
  assert.equal(detectDecodableKind(pctArr), "url");
  const decodedPctArr = await decodeInlineString(pctArr, 10_000, pickFirst);
  assert.ok(decodedPctArr);
  assert.equal(decodedPctArr.kind, "url-json");
  assert.deepEqual(jsonTreeToValue(decodedPctArr.root), [{ msg: "hello+world" }, 2]);

  // False-positive checks on prose, regexes, paths without query, and single key=val
  for (const nonUrl of [
    "/api/v1/items",
    "/^foo?bar$/",
    "env=prod",
    "status = 200 & ok = true",
    "a=1 and b=2",
    "R&D=team",
  ]) {
    assert.equal(detectDecodableKind(nonUrl), undefined, `unexpected URL match: ${nonUrl}`);
  }
});

test("createJsonTreeWebviewModel skips expensive Base64 sniffing past 5,000 strings while keeping cheap checks and cache integrity", () => {
  const b64Sample = Buffer.from('{"hidden":"in-base64"}', "utf8").toString("base64");
  const children: NonNullable<JsonTreeNode["children"]> = [];
  let nextId = 1;
  for (let i = 0; i < MAX_WEBVIEW_FULL_SNIFF_STRINGS; i += 1) {
    const val = `item_${i}`;
    children.push({
      key: i,
      value: { id: nextId++, type: "string", raw: JSON.stringify(val), value: val },
    });
  }
  const lateBase64Node: JsonTreeNode = {
    id: nextId++,
    type: "string",
    raw: JSON.stringify(b64Sample),
    value: b64Sample,
  };
  const lateJsonNode: JsonTreeNode = {
    id: nextId++,
    type: "string",
    raw: '"{\\"fast\\":true}"',
    value: '{"fast":true}',
  };
  const lateUrlNode: JsonTreeNode = {
    id: nextId,
    type: "string",
    raw: '"/api/items?a=1&b=2"',
    value: "/api/items?a=1&b=2",
  };
  children.push(
    { key: children.length, value: lateBase64Node },
    { key: children.length + 1, value: lateJsonNode },
    { key: children.length + 2, value: lateUrlNode },
  );

  const root: JsonTreeNode = { id: 0, type: "array", children };
  const model = createJsonTreeWebviewModel(root);
  const outChildren = model.root.children!;

  // Past the 5,000-string full-sniff budget, expensive Base64 sniffing is skipped...
  assert.equal(outChildren[MAX_WEBVIEW_FULL_SNIFF_STRINGS].value.decodable, undefined);
  // ...while cheap JSON and URL prefix checks still work...
  assert.equal(outChildren[MAX_WEBVIEW_FULL_SNIFF_STRINGS + 1].value.decodable, true);
  assert.equal(outChildren[MAX_WEBVIEW_FULL_SNIFF_STRINGS + 2].value.decodable, true);
  assert.equal(outChildren[MAX_WEBVIEW_FULL_SNIFF_STRINGS + 2].value.decodableKind, "url");
  // ...and direct cachedDetectDecodableKind on the skipped node was NOT poisoned with null!
  assert.equal(cachedDetectDecodableKind(lateBase64Node), "base64");
});

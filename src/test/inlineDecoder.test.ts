import assert from "node:assert/strict";
import test from "node:test";
import { decodeBase64Bytes, detectDecodableKind, isLikelyPlainWordOrHash } from "../decodable";
import { decodeInlineString } from "../inlineDecoder";
import { jsonTreeToValue } from "../jsonTree";

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

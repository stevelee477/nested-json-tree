import assert from "node:assert/strict";
import test from "node:test";
import { jsonTreeToValue } from "../jsonTree";
import { decodeProtobufMessage } from "../protobuf";

/** Helper to encode a varint into bytes. */
function encodeVarint(value: bigint): number[] {
  let remaining = value < 0n ? (value + (1n << 64n)) : value;
  const out: number[] = [];
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining !== 0n) byte |= 0x80;
    out.push(byte);
  } while (remaining !== 0n);
  return out;
}

function encodeTag(fieldNumber: number, wireType: number): number[] {
  return encodeVarint((BigInt(fieldNumber) << 3n) | BigInt(wireType));
}

function encodeVarintField(fieldNumber: number, value: bigint | number): number[] {
  return [...encodeTag(fieldNumber, 0), ...encodeVarint(BigInt(value))];
}

function encodeLenField(fieldNumber: number, payload: Uint8Array | number[] | string): number[] {
  const bytes = typeof payload === "string"
    ? [...Buffer.from(payload, "utf8")]
    : [...payload];
  return [...encodeTag(fieldNumber, 2), ...encodeVarint(BigInt(bytes.length)), ...bytes];
}

function encodeFixed32Field(fieldNumber: number, value: number, asFloat = false): number[] {
  const buf = Buffer.alloc(4);
  if (asFloat) buf.writeFloatLE(value, 0);
  else buf.writeUInt32LE(value >>> 0, 0);
  return [...encodeTag(fieldNumber, 5), ...buf];
}

function encodeFixed64Field(fieldNumber: number, value: bigint | number, asDouble = false): number[] {
  const buf = Buffer.alloc(8);
  if (asDouble) buf.writeDoubleLE(Number(value), 0);
  else buf.writeBigUInt64LE(BigInt(value), 0);
  return [...encodeTag(fieldNumber, 1), ...buf];
}

test("decodes scalar varint, string, and nested protobuf fields by field number", () => {
  const nested = [
    ...encodeVarintField(1, 7),
    ...encodeLenField(2, "metadata"),
  ];
  const message = Uint8Array.from([
    ...encodeLenField(1, "alice"),
    ...encodeVarintField(2, 30),
    ...encodeLenField(3, nested),
  ]);

  const decoded = decodeProtobufMessage(message);
  assert.ok(decoded);
  assert.deepEqual(jsonTreeToValue(decoded.root), {
    "1": "alice",
    "2": 30,
    "3": {
      "1": 7,
      "2": "metadata",
    },
  });
});

test("preserves 64-bit unsigned varints losslessly and shows signed int64 for negative varints", () => {
  const big = 9007199254740993n; // 2^53 + 1
  const message = Uint8Array.from([
    ...encodeVarintField(1, big),
    ...encodeVarintField(2, -1n),
  ]);

  const decoded = decodeProtobufMessage(message);
  assert.ok(decoded);
  const field1 = decoded.root.children?.[0];
  assert.equal(field1?.key, "1");
  assert.equal(field1?.value.raw, "9007199254740993");

  const field2 = decoded.root.children?.[1];
  assert.equal(field2?.key, "2");
  assert.equal(field2?.value.children?.[0].key, "int64");
  assert.equal(field2?.value.children?.[0].value.raw, "-1");
  assert.equal(field2?.value.children?.[1].key, "uint64");
  assert.equal(field2?.value.children?.[1].value.raw, "18446744073709551615");
});

test("groups repeated field numbers into arrays while preserving first-seen order", () => {
  const message = Uint8Array.from([
    ...encodeLenField(1, "first"),
    ...encodeVarintField(2, 10),
    ...encodeLenField(1, "second"),
    ...encodeVarintField(2, 20),
    ...encodeVarintField(3, 99),
  ]);

  const decoded = decodeProtobufMessage(message);
  assert.ok(decoded);
  assert.deepEqual(jsonTreeToValue(decoded.root), {
    "1": ["first", "second"],
    "2": [10, 20],
    "3": 99,
  });
});

test("decodes 32-bit and 64-bit fixed and floating-point fields", () => {
  const message = Uint8Array.from([
    ...encodeFixed32Field(1, 42, false),
    ...encodeFixed32Field(2, 3.5, true),
    ...encodeFixed64Field(3, 1767225600n, false),
    ...encodeFixed64Field(4, 12.25, true),
  ]);

  const decoded = decodeProtobufMessage(message);
  assert.ok(decoded);
  assert.deepEqual(jsonTreeToValue(decoded.root), {
    "1": 42,
    "2": { float: 3.5, fixed32: 1080033280 },
    "3": 1767225600,
    "4": { double: 12.25, fixed64: Number(4623085754984169472n) },
  });
  // Verify exact lossless 64-bit integer token for field 4's fixed64 view.
  const field4 = decoded.root.children?.[3]?.value;
  assert.equal(field4?.children?.[1]?.key, "fixed64");
  assert.equal(field4?.children?.[1]?.value.raw, "4623085754984169472");
});

test("formats opaque non-UTF-8 binary bytes fields as hex strings", () => {
  const message = Uint8Array.from([
    ...encodeLenField(4, [0xde, 0xad, 0xbe, 0xef]),
    ...encodeLenField(5, ""),
  ]);

  const decoded = decodeProtobufMessage(message);
  assert.ok(decoded);
  assert.deepEqual(jsonTreeToValue(decoded.root), {
    "4": "0xdeadbeef",
    "5": "",
  });
});

test("supports deprecated start/end group wire types and rejects mismatched groups", () => {
  const validGroup = Uint8Array.from([
    ...encodeTag(2, 3),
    ...encodeVarintField(1, 42),
    ...encodeTag(2, 4),
  ]);
  const decoded = decodeProtobufMessage(validGroup);
  assert.ok(decoded);
  assert.deepEqual(jsonTreeToValue(decoded.root), { "2": { "1": 42 } });

  const mismatchedGroup = Uint8Array.from([
    ...encodeTag(2, 3),
    ...encodeVarintField(1, 42),
    ...encodeTag(3, 4),
  ]);
  assert.equal(decodeProtobufMessage(mismatchedGroup), undefined);
});

test("rejects invalid wire types, field 0, reserved fields, non-canonical varints, and truncated input", () => {
  // Invalid wire type 6
  assert.equal(decodeProtobufMessage(Uint8Array.from([0x0e, 0x01])), undefined);
  // Field number 0
  assert.equal(decodeProtobufMessage(Uint8Array.from([0x00, 0x01])), undefined);
  // Reserved field number 19000
  assert.equal(decodeProtobufMessage(Uint8Array.from(encodeVarintField(19000, 1))), undefined);
  // Truncated length-delimited payload
  assert.equal(decodeProtobufMessage(Uint8Array.from([0x0a, 0x05, 0x61, 0x62])), undefined);
  // Non-canonical overlong varint (redundant trailing 0x00)
  assert.equal(decodeProtobufMessage(Uint8Array.from([0x08, 0x81, 0x00])), undefined);
  // Truncated fixed64
  assert.equal(decodeProtobufMessage(Uint8Array.from([0x09, 1, 2, 3, 4])), undefined);
});

test("enforces maxValueNodes and maxDepth budgets safely without recursion overflow", () => {
  const manyFields: number[] = [];
  for (let i = 1; i <= 50; i += 1) manyFields.push(...encodeVarintField(i, i));
  assert.equal(decodeProtobufMessage(Uint8Array.from(manyFields), { maxValueNodes: 10 }), undefined);

  let nested = Uint8Array.from(encodeVarintField(1, 1));
  for (let depth = 0; depth < 12; depth += 1) {
    nested = Uint8Array.from(encodeLenField(1, nested));
  }
  assert.ok(decodeProtobufMessage(nested, { maxDepth: 20 }));
  // When depth exceeds maxDepth, inner bytes are kept as hex rather than crashing.
  const shallow = decodeProtobufMessage(nested, { maxDepth: 2 });
  assert.ok(shallow);
});

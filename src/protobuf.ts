import type { JsonTreeChild, JsonTreeNode } from "./jsonTree";

const MAX_PROTOBUF_DEPTH = 64;
const MAX_PROTOBUF_FIELD_NUMBER = 0x1fff_ffff; // 2^29 - 1
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export interface ProtobufDecodeOptions {
  /** Maximum number of JSON tree value nodes to produce. */
  maxValueNodes?: number;
  /** Maximum nested message depth. */
  maxDepth?: number;
}

export interface ProtobufDecodeResult {
  root: JsonTreeNode;
  nodeCount: number;
  fieldCount: number;
  maxTopLevelFieldNumber: number;
  minTopLevelFieldNumber: number;
  hasStructuredContent: boolean;
}

interface ParsedField {
  fieldNumber: number;
  value: JsonTreeNode;
}

interface GroupFrame {
  kind: "group";
  groupFieldNumber: number;
  fields: ParsedField[];
}

interface MessageFrame {
  kind: "message";
  bytes: Uint8Array;
  offset: number;
  end: number;
  depth: number;
  targetField?: ParsedField;
  fields: ParsedField[];
  groupStack: GroupFrame[];
}

/**
 * Decodes a Protobuf binary wire-format message into a lossless JsonTreeNode
 * whose object keys are field numbers (e.g. "1", "2") and values are the
 * decoded field contents. Iterative (stack-safe) and budget-bounded.
 *
 * Returns undefined if the bytes are not a valid complete Protobuf message or
 * exceed the node/depth budget.
 */
export function decodeProtobufMessage(
  bytes: Uint8Array,
  options: ProtobufDecodeOptions = {},
): ProtobufDecodeResult | undefined {
  if (bytes.length < 2) return undefined;
  const maxNodes = options.maxValueNodes !== undefined && Number.isFinite(options.maxValueNodes)
    ? Math.max(1, Math.trunc(options.maxValueNodes))
    : 500_000;
  const maxDepth = options.maxDepth ?? MAX_PROTOBUF_DEPTH;

  let nextId = 0;
  let nodeCount = 0;

  const allocNode = (partial: Omit<JsonTreeNode, "id">): JsonTreeNode | undefined => {
    nodeCount += 1;
    if (nodeCount > maxNodes) return undefined;
    const node: JsonTreeNode = { id: nextId, ...partial };
    nextId += 1;
    return node;
  };

  const makeNumberNode = (raw: string): JsonTreeNode | undefined =>
    allocNode({ type: "number", raw });

  const makeStringNode = (value: string): JsonTreeNode | undefined =>
    allocNode({ type: "string", raw: JSON.stringify(value), value });

  const makeObjectNode = (entries: Array<{ key: string; value: JsonTreeNode }>): JsonTreeNode | undefined => {
    const children: JsonTreeChild[] = entries.map((entry) => ({
      key: entry.key,
      rawKey: JSON.stringify(entry.key),
      value: entry.value,
    }));
    return allocNode({ type: "object", children });
  };

  const buildMessageNode = (fields: ParsedField[]): JsonTreeNode | undefined => {
    if (fields.length === 0) return undefined;
    // Group repeated field numbers into arrays while preserving first-seen order.
    const order: number[] = [];
    const grouped = new Map<number, JsonTreeNode[]>();
    for (const field of fields) {
      let list = grouped.get(field.fieldNumber);
      if (list === undefined) {
        list = [];
        grouped.set(field.fieldNumber, list);
        order.push(field.fieldNumber);
      }
      list.push(field.value);
    }

    const children: JsonTreeChild[] = [];
    for (const fieldNumber of order) {
      const values = grouped.get(fieldNumber)!;
      const key = String(fieldNumber);
      const rawKey = JSON.stringify(key);
      if (values.length === 1) {
        children.push({ key, rawKey, value: values[0] });
      } else {
        const arrayNode = allocNode({
          type: "array",
          children: values.map((value, index) => ({ key: index, value })),
        });
        if (arrayNode === undefined) return undefined;
        children.push({ key, rawKey, value: arrayNode });
      }
    }
    return allocNode({ type: "object", children });
  };

  const result = parseMessageIterative(bytes, maxDepth, allocNode, makeNumberNode, makeStringNode, makeObjectNode, buildMessageNode);
  if (result === undefined) return undefined;
  return {
    root: result.node,
    nodeCount,
    fieldCount: result.fieldCount,
    maxTopLevelFieldNumber: result.maxFieldNumber,
    minTopLevelFieldNumber: result.minFieldNumber,
    hasStructuredContent: result.hasStructuredContent,
  };
}

interface InternalParseResult {
  node: JsonTreeNode;
  fieldCount: number;
  maxFieldNumber: number;
  minFieldNumber: number;
  hasStructuredContent: boolean;
}

function parseMessageIterative(
  rootBytes: Uint8Array,
  maxDepth: number,
  allocNode: (partial: Omit<JsonTreeNode, "id">) => JsonTreeNode | undefined,
  makeNumberNode: (raw: string) => JsonTreeNode | undefined,
  makeStringNode: (value: string) => JsonTreeNode | undefined,
  makeObjectNode: (entries: Array<{ key: string; value: JsonTreeNode }>) => JsonTreeNode | undefined,
  buildMessageNode: (fields: ParsedField[]) => JsonTreeNode | undefined,
): InternalParseResult | undefined {
  const stack: MessageFrame[] = [
    {
      kind: "message",
      bytes: rootBytes,
      offset: 0,
      end: rootBytes.length,
      depth: 0,
      fields: [],
      groupStack: [],
    },
  ];
  let rootResult: InternalParseResult | undefined;
  let hasStructuredContent = false;

  const currentFields = (frame: MessageFrame): ParsedField[] =>
    frame.groupStack.length > 0 ? frame.groupStack[frame.groupStack.length - 1].fields : frame.fields;

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.offset === frame.end) {
      if (frame.groupStack.length > 0 || frame.fields.length === 0) return undefined;
      const node = buildMessageNode(frame.fields);
      if (node === undefined) return undefined;
      stack.pop();
      if (frame.targetField !== undefined) {
        frame.targetField.value = node;
        hasStructuredContent = true;
      } else {
        let minFieldNumber = Number.POSITIVE_INFINITY;
        let maxFieldNumber = 0;
        for (const field of frame.fields) {
          if (field.fieldNumber < minFieldNumber) minFieldNumber = field.fieldNumber;
          if (field.fieldNumber > maxFieldNumber) maxFieldNumber = field.fieldNumber;
        }
        rootResult = {
          node,
          fieldCount: frame.fields.length,
          minFieldNumber,
          maxFieldNumber,
          hasStructuredContent,
        };
      }
      continue;
    }

    const tagRead = readVarint(frame.bytes, frame.offset, frame.end);
    if (tagRead === undefined) return undefined;
    frame.offset = tagRead.nextOffset;
    if (tagRead.value > 0xffff_ffffn) return undefined;

    const wireType = Number(tagRead.value & 7n);
    const fieldNumber = Number(tagRead.value >> 3n);
    if (
      fieldNumber < 1 ||
      fieldNumber > MAX_PROTOBUF_FIELD_NUMBER ||
      (fieldNumber >= 19_000 && fieldNumber <= 19_999)
    ) {
      return undefined;
    }

    if (wireType === 0) {
      // Varint
      const valRead = readVarint(frame.bytes, frame.offset, frame.end);
      if (valRead === undefined) return undefined;
      frame.offset = valRead.nextOffset;
      const node = buildVarintNode(valRead.value, makeNumberNode, makeObjectNode);
      if (node === undefined) return undefined;
      currentFields(frame).push({ fieldNumber, value: node });
    } else if (wireType === 1) {
      // 64-bit (fixed64 / sfixed64 / double)
      if (frame.offset + 8 > frame.end) return undefined;
      const node = buildFixed64Node(frame.bytes, frame.offset, makeNumberNode, makeObjectNode);
      frame.offset += 8;
      if (node === undefined) return undefined;
      currentFields(frame).push({ fieldNumber, value: node });
    } else if (wireType === 2) {
      // Length-delimited (string / bytes / embedded message)
      const lenRead = readVarint(frame.bytes, frame.offset, frame.end);
      if (lenRead === undefined || lenRead.value > BigInt(frame.end - lenRead.nextOffset)) {
        return undefined;
      }
      const length = Number(lenRead.value);
      const start = lenRead.nextOffset;
      const end = start + length;
      frame.offset = end;
      const slice = frame.bytes.subarray(start, end);

      if (length === 0) {
        const empty = makeStringNode("");
        if (empty === undefined) return undefined;
        currentFields(frame).push({ fieldNumber, value: empty });
        continue;
      }

      const printable = decodePrintableUtf8(slice);
      // Plain printable UTF-8 text (that doesn't begin with a wire-tag-like
      // control char such as \n / \t / \r) should stay a string so short words
      // like "hi" (0x68 0x69) aren't shattered into bogus nested messages.
      const startsWithControlWhitespace = slice[0] === 0x09 || slice[0] === 0x0a || slice[0] === 0x0d;
      if (printable !== undefined && !startsWithControlWhitespace) {
        const strNode = makeStringNode(printable);
        if (strNode === undefined) return undefined;
        hasStructuredContent = true;
        currentFields(frame).push({ fieldNumber, value: strNode });
        continue;
      }

      // Check whether this length-delimited payload is a valid nested message.
      if (frame.depth + 1 <= maxDepth && slice.length >= 2 && isValidWireMessage(slice, maxDepth - frame.depth - 1)) {
        const placeholder: ParsedField = {
          fieldNumber,
          value: { id: -1, type: "null", raw: "null", value: null },
        };
        currentFields(frame).push(placeholder);
        stack.push({
          kind: "message",
          bytes: slice,
          offset: 0,
          end: slice.length,
          depth: frame.depth + 1,
          targetField: placeholder,
          fields: [],
          groupStack: [],
        });
        continue;
      }

      if (printable !== undefined) {
        const strNode = makeStringNode(printable);
        if (strNode === undefined) return undefined;
        hasStructuredContent = true;
        currentFields(frame).push({ fieldNumber, value: strNode });
        continue;
      }

      const hexNode = makeStringNode(formatHexBytes(slice));
      if (hexNode === undefined) return undefined;
      currentFields(frame).push({ fieldNumber, value: hexNode });
    } else if (wireType === 3) {
      // Deprecated start-group (SGROUP)
      if (frame.depth + frame.groupStack.length + 1 > maxDepth) return undefined;
      frame.groupStack.push({ kind: "group", groupFieldNumber: fieldNumber, fields: [] });
    } else if (wireType === 4) {
      // Deprecated end-group (EGROUP)
      const group = frame.groupStack.pop();
      if (group === undefined || group.groupFieldNumber !== fieldNumber || group.fields.length === 0) {
        return undefined;
      }
      const groupNode = buildMessageNode(group.fields);
      if (groupNode === undefined) return undefined;
      hasStructuredContent = true;
      currentFields(frame).push({ fieldNumber, value: groupNode });
    } else if (wireType === 5) {
      // 32-bit (fixed32 / sfixed32 / float)
      if (frame.offset + 4 > frame.end) return undefined;
      const node = buildFixed32Node(frame.bytes, frame.offset, makeNumberNode, makeObjectNode);
      frame.offset += 4;
      if (node === undefined) return undefined;
      currentFields(frame).push({ fieldNumber, value: node });
    } else {
      // Wire types 6 and 7 are invalid.
      return undefined;
    }
  }

  // Keep allocNode referenced cleanly in case of future extensions.
  void allocNode;
  return rootResult;
}

/** Fast structural validator for nested wire-format messages without building nodes. */
function isValidWireMessage(bytes: Uint8Array, remainingDepth: number): boolean {
  if (bytes.length < 2) return false;
  let offset = 0;
  const end = bytes.length;
  let fields = 0;
  const groups: number[] = [];

  while (offset < end) {
    const tag = readVarint(bytes, offset, end);
    if (tag === undefined || tag.value > 0xffff_ffffn) return false;
    offset = tag.nextOffset;
    const wireType = Number(tag.value & 7n);
    const fieldNumber = Number(tag.value >> 3n);
    if (
      fieldNumber < 1 ||
      fieldNumber > MAX_PROTOBUF_FIELD_NUMBER ||
      (fieldNumber >= 19_000 && fieldNumber <= 19_999)
    ) {
      return false;
    }

    if (wireType === 0) {
      const value = readVarint(bytes, offset, end);
      if (value === undefined) return false;
      offset = value.nextOffset;
    } else if (wireType === 1) {
      if (offset + 8 > end) return false;
      offset += 8;
    } else if (wireType === 2) {
      const length = readVarint(bytes, offset, end);
      if (length === undefined || length.value > BigInt(end - length.nextOffset)) return false;
      offset = length.nextOffset + Number(length.value);
    } else if (wireType === 3) {
      if (groups.length + 1 > remainingDepth) return false;
      groups.push(fieldNumber);
    } else if (wireType === 4) {
      if (groups.pop() !== fieldNumber) return false;
    } else if (wireType === 5) {
      if (offset + 4 > end) return false;
      offset += 4;
    } else {
      return false;
    }
    fields += 1;
  }

  return offset === end && groups.length === 0 && fields > 0;
}

function readVarint(
  bytes: Uint8Array,
  start: number,
  end: number,
): { value: bigint; nextOffset: number } | undefined {
  let result = 0n;
  let shift = 0n;
  let offset = start;
  while (offset < end) {
    const byte = bytes[offset];
    offset += 1;
    const count = offset - start;
    if (count === 10) {
      // 64-bit varint: the 10th byte may only carry bit 63 (0x01) and must terminate.
      if (byte !== 0x01) return undefined;
      result |= 1n << 63n;
      return { value: result, nextOffset: offset };
    }
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      // Reject non-canonical overlong varints (redundant trailing 0x00 byte).
      if (count > 1 && byte === 0) return undefined;
      return { value: result, nextOffset: offset };
    }
    shift += 7n;
  }
  return undefined;
}

function buildVarintNode(
  value: bigint,
  makeNumberNode: (raw: string) => JsonTreeNode | undefined,
  makeObjectNode: (entries: Array<{ key: string; value: JsonTreeNode }>) => JsonTreeNode | undefined,
): JsonTreeNode | undefined {
  if (value >= 0x8000_0000_0000_0000n) {
    const signed = value - 0x1_0000_0000_0000_0000n;
    const int64Node = makeNumberNode(signed.toString());
    const uint64Node = makeNumberNode(value.toString());
    if (!int64Node || !uint64Node) return undefined;
    return makeObjectNode([
      { key: "int64", value: int64Node },
      { key: "uint64", value: uint64Node },
    ]);
  }
  return makeNumberNode(value.toString());
}

function buildFixed64Node(
  bytes: Uint8Array,
  offset: number,
  makeNumberNode: (raw: string) => JsonTreeNode | undefined,
  makeObjectNode: (entries: Array<{ key: string; value: JsonTreeNode }>) => JsonTreeNode | undefined,
): JsonTreeNode | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
  const uint64 = view.getBigUint64(0, true);
  if (uint64 === 0n) return makeNumberNode("0");
  const doubleVal = view.getFloat64(0, true);
  const sfixed64 = view.getBigInt64(0, true);
  const plausibleDouble =
    Number.isFinite(doubleVal) &&
    doubleVal !== 0 &&
    Math.abs(doubleVal) >= 1e-12 &&
    Math.abs(doubleVal) <= 1e15;
  if (plausibleDouble) {
    const doubleNode = makeNumberNode(String(doubleVal));
    const fixedNode = makeNumberNode(uint64.toString());
    if (!doubleNode || !fixedNode) return undefined;
    return makeObjectNode([
      { key: "double", value: doubleNode },
      { key: "fixed64", value: fixedNode },
    ]);
  }
  if (sfixed64 < 0n) {
    const signedNode = makeNumberNode(sfixed64.toString());
    const unsignedNode = makeNumberNode(uint64.toString());
    if (!signedNode || !unsignedNode) return undefined;
    return makeObjectNode([
      { key: "sfixed64", value: signedNode },
      { key: "fixed64", value: unsignedNode },
    ]);
  }
  return makeNumberNode(uint64.toString());
}

function buildFixed32Node(
  bytes: Uint8Array,
  offset: number,
  makeNumberNode: (raw: string) => JsonTreeNode | undefined,
  makeObjectNode: (entries: Array<{ key: string; value: JsonTreeNode }>) => JsonTreeNode | undefined,
): JsonTreeNode | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
  const uint32 = view.getUint32(0, true);
  if (uint32 === 0) return makeNumberNode("0");
  const floatVal = view.getFloat32(0, true);
  const int32 = view.getInt32(0, true);
  const plausibleFloat =
    Number.isFinite(floatVal) &&
    floatVal !== 0 &&
    Math.abs(floatVal) >= 1e-6 &&
    Math.abs(floatVal) <= 1e10;
  if (plausibleFloat) {
    const floatNode = makeNumberNode(String(Number(floatVal.toPrecision(7))));
    const fixedNode = makeNumberNode(String(uint32));
    if (!floatNode || !fixedNode) return undefined;
    return makeObjectNode([
      { key: "float", value: floatNode },
      { key: "fixed32", value: fixedNode },
    ]);
  }
  if (int32 < 0) {
    const signedNode = makeNumberNode(String(int32));
    const unsignedNode = makeNumberNode(String(uint32));
    if (!signedNode || !unsignedNode) return undefined;
    return makeObjectNode([
      { key: "sfixed32", value: signedNode },
      { key: "fixed32", value: unsignedNode },
    ]);
  }
  return makeNumberNode(String(uint32));
}

/**
 * Decodes bytes as printable UTF-8 text, returning undefined if invalid UTF-8
 * or if any non-whitespace control character is present.
 */
export function decodePrintableUtf8(bytes: Uint8Array): string | undefined {
  let text: string;
  try {
    text = utf8Decoder.decode(bytes);
  } catch {
    return undefined;
  }
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      code === 0x7f ||
      (code >= 0x80 && code <= 0x9f) ||
      code === 0xfffd
    ) {
      return undefined;
    }
  }
  return text;
}

function formatHexBytes(bytes: Uint8Array): string {
  const parts: string[] = new Array(bytes.length);
  for (let index = 0; index < bytes.length; index += 1) {
    parts[index] = bytes[index].toString(16).padStart(2, "0");
  }
  return `0x${parts.join("")}`;
}

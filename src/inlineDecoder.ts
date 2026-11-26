import {
  MAX_INLINE_BASE64_CHARS,
  decodeBase64Bytes,
  decodePercentEncodedJsonText,
  hasGzipMagic,
  isPlausibleBase64Text,
  isPlausibleProtobufResult,
  isPrintableDecodedText,
  isValidBase64Syntax,
  looksLikeEmbeddedJson,
  looksLikeJwt,
  looksLikePercentEncodedJson,
  looksLikeStandaloneQueryString,
  looksLikeUrlWithQuery,
  looksLikeWholeJsonContainer,
  startsWithPbTagWhitespace,
  tryDecompressHeaderBytes,
  tryDecompressRawDeflateBytes,
} from "./decodable";
import type { JsonTreeChild, JsonTreeDecoded, JsonTreeDecodedKind, JsonTreeNode } from "./jsonTree";
import {
  JsonCandidate,
  JsonValueNodeLimitError,
  parseJsonCandidates,
  parseNestedJsonCandidates,
} from "./parser";
import { decodePrintableUtf8, decodeProtobufMessage } from "./protobuf";

/**
 * Decodes an inline-expandable string into a JsonTreeDecoded payload.
 * Supports embedded JSON (including multi-layer and text-wrapped), JWT,
 * URLs (standard/custom schemes, relative URLs, standalone query strings,
 * percent-encoded JSON), and Base64/Base64URL (raw or Gzip/Zlib/Deflate
 * compressed JSON, Protobuf wire format, or UTF-8 text).
 *
 * Returns:
 * - `JsonTreeDecoded` on success
 * - `undefined` when the user dismissed a multi-candidate picker
 * - `null` when the string cannot be decoded into a structured value
 */
export async function decodeInlineString(
  value: string,
  maxValueNodes: number,
  pick: (candidates: JsonCandidate[]) => Promise<JsonCandidate | undefined>,
): Promise<JsonTreeDecoded | null | undefined> {
  if (maxValueNodes < 1) throw new JsonValueNodeLimitError(Math.max(0, maxValueNodes));

  if (looksLikeEmbeddedJson(value)) {
    const jsonDecoded = await decodeEmbeddedJson(value, maxValueNodes, pick);
    if (jsonDecoded !== null) return jsonDecoded;
  }

  const trimmed = value.trim();
  if (looksLikeJwt(trimmed)) {
    const jwt = decodeJwt(trimmed, maxValueNodes);
    if (jwt !== undefined) return jwt;
  }

  if (looksLikePercentEncodedJson(trimmed)) {
    const urlJson = decodePercentEncodedJson(trimmed, maxValueNodes);
    if (urlJson !== undefined) return urlJson;
  }

  if (looksLikeUrlWithQuery(trimmed)) {
    const url = decodeUrlQuery(trimmed, maxValueNodes);
    if (url !== undefined) return url;
  }

  const base64 = decodeBase64Payload(trimmed, maxValueNodes);
  if (base64 !== undefined) return base64;

  return null;
}

async function decodeEmbeddedJson(
  value: string,
  maxValueNodes: number,
  pick: (candidates: JsonCandidate[]) => Promise<JsonCandidate | undefined>,
): Promise<JsonTreeDecoded | null | undefined> {
  const candidates = parseNestedJsonCandidates(
    value,
    Number.isFinite(maxValueNodes) ? { maxValueNodes } : {},
  );
  if (candidates.length === 0) return null;
  const selected = candidates.length === 1 ? candidates[0] : await pick(candidates);
  if (selected === undefined) return undefined;
  if (selected.tree.type !== "object" && selected.tree.type !== "array") return null;
  const decoded: JsonTreeDecoded = {
    root: selected.tree,
    unwrapDepth: selected.unwrapDepth,
    kind: "json",
    recovery: selected.recovery,
  };
  if (!isWholeDecodedValue(value, selected)) decoded.embedded = true;
  return decoded;
}

/** True when `fromjson`, applied once per layer, yields exactly this candidate. */
function isWholeDecodedValue(value: string, candidate: JsonCandidate): boolean {
  let layer = value;
  for (let depth = 0; depth < candidate.unwrapDepth; depth += 1) {
    try {
      const parsed: unknown = JSON.parse(layer);
      if (typeof parsed !== "string") return false;
      layer = parsed;
    } catch {
      return false;
    }
  }
  return layer.trim() === candidate.raw;
}

function decodeJwt(trimmed: string, maxValueNodes: number): JsonTreeDecoded | undefined {
  const parts = trimmed.split(".");
  if (parts.length !== 3) return undefined;
  const headerBytes = decodeBase64Bytes(parts[0]);
  const payloadBytes = decodeBase64Bytes(parts[1]);
  if (!headerBytes || !payloadBytes) return undefined;
  const headerText = decodePrintableUtf8(headerBytes);
  const payloadText = decodePrintableUtf8(payloadBytes);
  if (!headerText || !payloadText) return undefined;

  const limit = Number.isFinite(maxValueNodes) ? { maxValueNodes, allowPartial: false } : { allowPartial: false };
  const headerCandidates = parseJsonCandidates(headerText, limit);
  if (headerCandidates.length !== 1 || headerCandidates[0].tree.type !== "object") return undefined;

  const remaining = Number.isFinite(maxValueNodes)
    ? Math.max(0, maxValueNodes - headerCandidates[0].nodeCount - 2)
    : Number.POSITIVE_INFINITY;
  if (remaining < 1) throw new JsonValueNodeLimitError(Math.max(0, maxValueNodes));

  let payloadNode: JsonTreeNode;
  const payloadCandidates = parseJsonCandidates(
    payloadText,
    Number.isFinite(remaining) ? { maxValueNodes: remaining, allowPartial: false } : { allowPartial: false },
  );
  if (payloadCandidates.length === 1) {
    payloadNode = payloadCandidates[0].tree;
  } else {
    payloadNode = { id: 0, type: "string", raw: JSON.stringify(payloadText), value: payloadText };
  }

  const signatureNode: JsonTreeNode = {
    id: 0,
    type: "string",
    raw: JSON.stringify(parts[2]),
    value: parts[2],
  };

  const root: JsonTreeNode = {
    id: 0,
    type: "object",
    children: [
      { key: "header", rawKey: '"header"', value: headerCandidates[0].tree },
      { key: "payload", rawKey: '"payload"', value: payloadNode },
      { key: "signature", rawKey: '"signature"', value: signatureNode },
    ],
  };
  return { root, unwrapDepth: 0, kind: "jwt" };
}

function decodePercentEncodedJson(trimmed: string, maxValueNodes: number): JsonTreeDecoded | undefined {
  const decodedText = decodePercentEncodedJsonText(trimmed);
  if (decodedText === undefined) return undefined;
  const candidates = parseJsonCandidates(
    decodedText,
    Number.isFinite(maxValueNodes) ? { maxValueNodes, allowPartial: false } : { allowPartial: false },
  );
  if (candidates.length !== 1) return undefined;
  const tree = candidates[0].tree;
  if (tree.type !== "object" && tree.type !== "array") return undefined;
  return { root: tree, unwrapDepth: 0, kind: "url-json" };
}

function stringNode(text: string): JsonTreeNode {
  return {
    id: 0,
    type: "string",
    raw: JSON.stringify(text),
    value: text,
  };
}

function buildParamsObjectNode(entries: Array<[string, string]>): JsonTreeNode {
  return {
    id: 0,
    type: "object",
    children: entries.map(([key, val]) => ({
      key,
      rawKey: JSON.stringify(key),
      value: stringNode(val),
    })),
  };
}

function decodeUrlQuery(trimmed: string, maxValueNodes: number): JsonTreeDecoded | undefined {
  // 1. Standalone query/form string (`a=1&b=2&c=3` or `?a=1&b=2#hash`)
  if (looksLikeStandaloneQueryString(trimmed)) {
    const withoutQuestion = trimmed.startsWith("?") ? trimmed.slice(1) : trimmed;
    const hashIndex = withoutQuestion.indexOf("#");
    const queryPart = hashIndex >= 0 ? withoutQuestion.slice(0, hashIndex) : withoutQuestion;
    const hash = hashIndex >= 0 ? withoutQuestion.slice(hashIndex) : "";
    const entries = [...new URLSearchParams(queryPart).entries()];
    if (entries.length === 0) return undefined;

    if (hash.length === 0) {
      const estimatedNodes = 1 + entries.length;
      if (estimatedNodes > maxValueNodes) throw new JsonValueNodeLimitError(Math.max(0, maxValueNodes));
      return {
        root: buildParamsObjectNode(entries),
        unwrapDepth: 0,
        kind: "url",
      };
    }

    const estimatedNodes = 3 + entries.length;
    if (estimatedNodes > maxValueNodes) throw new JsonValueNodeLimitError(Math.max(0, maxValueNodes));
    return {
      root: {
        id: 0,
        type: "object",
        children: [
          { key: "params", rawKey: '"params"', value: buildParamsObjectNode(entries) },
          { key: "hash", rawKey: '"hash"', value: stringNode(hash) },
        ],
      },
      unwrapDepth: 0,
      kind: "url",
    };
  }

  // 2. Relative URL with query string (`/api/v1/items?a=1&b=2#top`)
  if (trimmed.startsWith("/") || trimmed.startsWith("./") || trimmed.startsWith("../")) {
    const questionIndex = trimmed.indexOf("?");
    if (questionIndex < 1) return undefined;
    const pathname = trimmed.slice(0, questionIndex);
    const afterQuestion = trimmed.slice(questionIndex + 1);
    const hashIndex = afterQuestion.indexOf("#");
    const queryPart = hashIndex >= 0 ? afterQuestion.slice(0, hashIndex) : afterQuestion;
    const hash = hashIndex >= 0 ? afterQuestion.slice(hashIndex) : "";
    const entries = [...new URLSearchParams(queryPart).entries()];
    if (entries.length === 0) return undefined;

    const estimatedNodes = 3 + entries.length + (hash.length > 0 ? 1 : 0);
    if (estimatedNodes > maxValueNodes) throw new JsonValueNodeLimitError(Math.max(0, maxValueNodes));

    const children: JsonTreeChild[] = [
      { key: "pathname", rawKey: '"pathname"', value: stringNode(pathname) },
      { key: "params", rawKey: '"params"', value: buildParamsObjectNode(entries) },
    ];
    if (hash.length > 0) {
      children.push({ key: "hash", rawKey: '"hash"', value: stringNode(hash) });
    }
    return {
      root: { id: 0, type: "object", children },
      unwrapDepth: 0,
      kind: "url",
    };
  }

  // 3. Full URL with standard or custom URI scheme (`https://`, `ws://`, `grpc://`, `app://`)
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  const paramEntries = [...url.searchParams.entries()];
  if (paramEntries.length === 0) return undefined;

  const estimatedNodes = 4 + paramEntries.length + (url.hash ? 1 : 0);
  if (estimatedNodes > maxValueNodes) throw new JsonValueNodeLimitError(Math.max(0, maxValueNodes));

  // WHATWG URL returns `"null"` as origin for custom schemes (`grpc://`, `app://`).
  const originText = url.origin !== "null"
    ? url.origin
    : `${url.protocol}//${url.host}`;

  const children: JsonTreeChild[] = [
    { key: "origin", rawKey: '"origin"', value: stringNode(originText) },
    { key: "pathname", rawKey: '"pathname"', value: stringNode(url.pathname) },
    { key: "params", rawKey: '"params"', value: buildParamsObjectNode(paramEntries) },
  ];
  if (url.hash.length > 0) {
    children.push({ key: "hash", rawKey: '"hash"', value: stringNode(url.hash) });
  }

  return {
    root: { id: 0, type: "object", children },
    unwrapDepth: 0,
    kind: "url",
  };
}

function decodeInnerBytes(
  trimmed: string,
  innerBytes: Uint8Array,
  maxValueNodes: number,
  options: { compressed: boolean; checksumVerified: boolean },
): JsonTreeDecoded | undefined {
  const jsonKind: JsonTreeDecodedKind = options.compressed ? "base64-gzip-json" : "base64-json";
  const printable = decodePrintableUtf8(innerBytes);
  if (printable !== undefined) {
    // 1. JSON container
    if (looksLikeWholeJsonContainer(printable)) {
      const candidates = parseJsonCandidates(
        printable,
        Number.isFinite(maxValueNodes) ? { maxValueNodes, allowPartial: false } : { allowPartial: false },
      );
      if (candidates.length === 1 && (candidates[0].tree.type === "object" || candidates[0].tree.type === "array")) {
        return { root: candidates[0].tree, unwrapDepth: 0, kind: jsonKind };
      }
    }

    // 2. Protobuf if starting with a tag-like whitespace byte (0x09 / 0x0A / 0x0D)
    if (startsWithPbTagWhitespace(innerBytes)) {
      const pb = decodeProtobufMessage(innerBytes, { maxValueNodes });
      if (pb !== undefined && isPlausibleProtobufResult(trimmed, innerBytes, pb)) {
        return { root: pb.root, unwrapDepth: 0, kind: "base64-protobuf" };
      }
    }

    // 3. Readable UTF-8 text
    const textOk = options.checksumVerified
      ? isPrintableDecodedText(printable, 1)
      : isPlausibleBase64Text(trimmed, printable);
    if (textOk) {
      return { root: stringNode(printable), unwrapDepth: 0, kind: "base64-text" };
    }
  }

  // 4. Protobuf wire format
  const pb = decodeProtobufMessage(innerBytes, { maxValueNodes });
  if (
    pb !== undefined &&
    (options.checksumVerified
      ? pb.fieldCount > 0 && pb.minTopLevelFieldNumber <= 1024
      : isPlausibleProtobufResult(trimmed, innerBytes, pb))
  ) {
    return { root: pb.root, unwrapDepth: 0, kind: "base64-protobuf" };
  }

  return undefined;
}

function decodeBase64Payload(trimmed: string, maxValueNodes: number): JsonTreeDecoded | undefined {
  if (trimmed.length < 4 || trimmed.length > MAX_INLINE_BASE64_CHARS) return undefined;
  if (!isValidBase64Syntax(trimmed)) return undefined;
  const bytes = decodeBase64Bytes(trimmed);
  if (!bytes || bytes.length < 2) return undefined;

  // 1. Gzip / Zlib compressed Base64
  const decompressed = tryDecompressHeaderBytes(bytes);
  if (decompressed !== undefined) {
    return decodeInnerBytes(trimmed, decompressed.bytes, maxValueNodes, {
      compressed: true,
      checksumVerified: true,
    });
  }
  if (hasGzipMagic(bytes)) return undefined;

  // 2. Uncompressed Base64
  const direct = decodeInnerBytes(trimmed, bytes, maxValueNodes, {
    compressed: false,
    checksumVerified: false,
  });
  if (direct !== undefined) return direct;

  // 3. Raw DEFLATE fallback
  const rawInflated = tryDecompressRawDeflateBytes(bytes);
  if (rawInflated !== undefined) {
    const printable = decodePrintableUtf8(rawInflated);
    if (printable !== undefined) {
      if (looksLikeWholeJsonContainer(printable)) {
        const candidates = parseJsonCandidates(
          printable,
          Number.isFinite(maxValueNodes) ? { maxValueNodes, allowPartial: false } : { allowPartial: false },
        );
        if (candidates.length === 1 && (candidates[0].tree.type === "object" || candidates[0].tree.type === "array")) {
          return { root: candidates[0].tree, unwrapDepth: 0, kind: "base64-gzip-json" };
        }
      }
      if (rawInflated.length > bytes.length && printable.trim().length >= 8 && isPlausibleBase64Text(trimmed, printable)) {
        return { root: stringNode(printable), unwrapDepth: 0, kind: "base64-text" };
      }
    }
  }

  return undefined;
}

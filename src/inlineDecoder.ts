import {
  MAX_INLINE_BASE64_CHARS,
  decodeBase64Bytes,
  isPlausibleBase64Text,
  isPlausibleProtobufResult,
  isValidBase64Syntax,
  looksLikeEmbeddedJson,
  looksLikeJwt,
  looksLikeUrlWithQuery,
  looksLikeWholeJsonContainer,
  startsWithPbTagWhitespace,
} from "./decodable";
import type { JsonTreeChild, JsonTreeDecoded, JsonTreeNode } from "./jsonTree";
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
 * URL query strings, and Base64/Base64URL (JSON, Protobuf wire format, or text).
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

function decodeUrlQuery(trimmed: string, maxValueNodes: number): JsonTreeDecoded | undefined {
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

  const stringNode = (text: string): JsonTreeNode => ({
    id: 0,
    type: "string",
    raw: JSON.stringify(text),
    value: text,
  });

  const paramsNode: JsonTreeNode = {
    id: 0,
    type: "object",
    children: paramEntries.map(([key, val]) => ({
      key,
      rawKey: JSON.stringify(key),
      value: stringNode(val),
    })),
  };

  const children: JsonTreeChild[] = [
    { key: "origin", rawKey: '"origin"', value: stringNode(url.origin) },
    { key: "pathname", rawKey: '"pathname"', value: stringNode(url.pathname) },
    { key: "params", rawKey: '"params"', value: paramsNode },
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

function decodeBase64Payload(trimmed: string, maxValueNodes: number): JsonTreeDecoded | undefined {
  if (trimmed.length < 4 || trimmed.length > MAX_INLINE_BASE64_CHARS) return undefined;
  if (!isValidBase64Syntax(trimmed)) return undefined;
  const bytes = decodeBase64Bytes(trimmed);
  if (!bytes || bytes.length < 2) return undefined;

  const printable = decodePrintableUtf8(bytes);
  if (printable !== undefined) {
    // 1. Base64 -> JSON
    if (looksLikeWholeJsonContainer(printable)) {
      const candidates = parseJsonCandidates(
        printable,
        Number.isFinite(maxValueNodes) ? { maxValueNodes, allowPartial: false } : { allowPartial: false },
      );
      if (candidates.length === 1 && (candidates[0].tree.type === "object" || candidates[0].tree.type === "array")) {
        return { root: candidates[0].tree, unwrapDepth: 0, kind: "base64-json" };
      }
    }

    // 2. Base64 -> Protobuf if starting with a tag-like whitespace byte (0x09 / 0x0A / 0x0D)
    if (startsWithPbTagWhitespace(bytes)) {
      const pb = decodeProtobufMessage(bytes, { maxValueNodes });
      if (pb !== undefined && isPlausibleProtobufResult(trimmed, bytes, pb)) {
        return { root: pb.root, unwrapDepth: 0, kind: "base64-protobuf" };
      }
    }

    // 3. Base64 -> Readable UTF-8 text
    if (isPlausibleBase64Text(trimmed, printable)) {
      const textNode: JsonTreeNode = {
        id: 0,
        type: "string",
        raw: JSON.stringify(printable),
        value: printable,
      };
      return { root: textNode, unwrapDepth: 0, kind: "base64-text" };
    }
  }

  // 4. Base64 -> Protobuf wire format
  const pb = decodeProtobufMessage(bytes, { maxValueNodes });
  if (pb !== undefined && isPlausibleProtobufResult(trimmed, bytes, pb)) {
    return { root: pb.root, unwrapDepth: 0, kind: "base64-protobuf" };
  }

  return undefined;
}

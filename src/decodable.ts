import type { JsonTreeDecodableKind, JsonTreeDecodedKind } from "./jsonTree";
import { decodePrintableUtf8, decodeProtobufMessage } from "./protobuf";

export const MAX_INLINE_BASE64_CHARS = 2 * 1024 * 1024;
export const MAX_INLINE_JWT_CHARS = 64 * 1024;
export const MAX_INLINE_URL_CHARS = 64 * 1024;

/**
 * Cheap pre-check: does a decoded string value hold a JSON container, either
 * as the whole value or inside surrounding text such as `data: {"id": 1}`? The
 * surrounding-text form needs a strong signal (an object key or an array of
 * objects/strings) so ordinary prose with brackets is not offered.
 */
export function looksLikeEmbeddedJson(value: string): boolean {
  return looksLikeWholeJson(value) || /\{\s*"[^"\n]{0,200}"\s*:|\[\s*[{"]/.test(value);
}

function looksLikeWholeJson(value: string): boolean {
  let start = 0;
  let end = value.length - 1;
  while (start <= end && isJsonWhitespace(value.charCodeAt(start))) start += 1;
  while (end >= start && isJsonWhitespace(value.charCodeAt(end))) end -= 1;
  if (end - start < 1) return false;
  const first = value[start];
  const last = value[end];
  if ((first === "{" && last === "}") || (first === "[" && last === "]")) return true;
  // Double-encoded JSON: a JSON string literal whose content is a container.
  return first === '"' && last === '"' && end - start >= 3 &&
    (value.startsWith("{", start + 1) || value.startsWith("[", start + 1));
}

function isJsonWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

export function looksLikeWholeJsonContainer(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 2) return false;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  return (first === "{" && last === "}") || (first === "[" && last === "]");
}

export function looksLikeJwt(trimmed: string): boolean {
  if (trimmed.length < 16 || trimmed.length > MAX_INLINE_JWT_CHARS) return false;
  if (!trimmed.startsWith("eyJ")) return false;
  const firstDot = trimmed.indexOf(".");
  if (firstDot < 4) return false;
  const secondDot = trimmed.indexOf(".", firstDot + 1);
  if (secondDot < firstDot + 2) return false;
  if (trimmed.indexOf(".", secondDot + 1) !== -1) return false;
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(trimmed);
}

export function looksLikeUrlWithQuery(trimmed: string): boolean {
  if (trimmed.length < 12 || trimmed.length > MAX_INLINE_URL_CHARS) return false;
  if (!/^https?:\/\/\S+\?\S+$/i.test(trimmed)) return false;
  try {
    const url = new URL(trimmed);
    return url.search.length > 1;
  } catch {
    return false;
  }
}

export function isValidBase64Syntax(text: string): boolean {
  const len = text.length;
  if (len < 4 || len % 4 === 1) return false;
  const hasStd = text.includes("+") || text.includes("/");
  const hasUrl = text.includes("-") || text.includes("_");
  if (hasStd && hasUrl) return false;
  if (text.includes("=")) {
    // Padded base64 must be a multiple of 4 with 1 or 2 '=' at the very end.
    if (len % 4 !== 0) return false;
    return hasUrl
      ? /^[A-Za-z0-9_-]+={1,2}$/.test(text)
      : /^[A-Za-z0-9+/]+={1,2}$/.test(text);
  }
  return hasUrl ? /^[A-Za-z0-9_-]+$/.test(text) : /^[A-Za-z0-9+/]+$/.test(text);
}

/** Filters out ordinary English words and hex hashes before attempting Base64 decode. */
export function isLikelyPlainWordOrHash(text: string): boolean {
  if (text.endsWith("=")) return false;
  if (/^[a-z]+$/.test(text) || /^\d+$/.test(text)) return true;
  if (
    (text.length === 16 || text.length === 32 || text.length === 40 || text.length === 64 || text.length === 128) &&
    /^[0-9a-fA-F]+$/.test(text)
  ) {
    return true;
  }
  return false;
}

export function startsWithPbTagWhitespace(bytes: Uint8Array): boolean {
  return bytes[0] === 0x09 || bytes[0] === 0x0a || bytes[0] === 0x0d;
}

export function isPlausibleBase64Text(encoded: string, decoded: string): boolean {
  if (decoded.trim().length < 3) return false;
  const hasPadding = encoded.endsWith("=");
  const hasBase64Punct = /[+/_-]/.test(encoded);
  const hasMixedCaseAndDigits =
    /[A-Z]/.test(encoded) &&
    /[a-z]/.test(encoded) &&
    (/\d/.test(encoded) || encoded.length >= 16);
  if (!hasPadding && !hasBase64Punct && !hasMixedCaseAndDigits) return false;
  for (let index = 0; index < decoded.length; index += 1) {
    const code = decoded.charCodeAt(index);
    if (
      !((code >= 0x20 && code <= 0x7e) ||
        code === 0x09 ||
        code === 0x0a ||
        code === 0x0d ||
        code >= 0xa0)
    ) {
      return false;
    }
  }
  return true;
}

export function isPlausibleProtobufResult(
  encoded: string,
  bytes: Uint8Array,
  pb: {
    fieldCount: number;
    minTopLevelFieldNumber: number;
    maxTopLevelFieldNumber: number;
    hasStructuredContent: boolean;
  },
): boolean {
  if (pb.fieldCount === 0) return false;
  if (pb.minTopLevelFieldNumber > 1024 && !pb.hasStructuredContent) return false;
  if (pb.maxTopLevelFieldNumber > 100_000 && !encoded.endsWith("=") && !pb.hasStructuredContent) return false;
  // Unpadded all-uppercase/digit identifiers (e.g. "INFO", "IPV4", "CONSUMER")
  // can accidentally decode into bare varints; require padding, mixed case,
  // base64 symbols, or structured (string/nested) content.
  if (!pb.hasStructuredContent && !encoded.endsWith("=") && /^[A-Z0-9]+$/.test(encoded)) {
    return false;
  }
  // Short unpadded letter-only words (<= 6 bytes) with only bare varints are
  // usually plain identifiers rather than protobuf payloads.
  if (!pb.hasStructuredContent && !encoded.endsWith("=") && bytes.length <= 6 && /^[A-Za-z]+$/.test(encoded)) {
    return false;
  }
  return true;
}

/** Decodes strict Base64 or Base64URL into bytes, rejecting non-canonical padding/bits. */
export function decodeBase64Bytes(text: string): Uint8Array | undefined {
  if (text.length === 0 || text.length % 4 === 1) return undefined;
  const normalized = text.replace(/-/g, "+").replace(/_/g, "/");
  const remainder = normalized.length % 4;
  const padded = remainder === 0 ? normalized : normalized + "=".repeat(4 - remainder);
  const buf = Buffer.from(padded, "base64");
  if (buf.length === 0) return undefined;
  const expectedNoPad = buf.toString("base64").replace(/=+$/, "");
  const actualNoPad = normalized.replace(/=+$/, "");
  if (expectedNoPad !== actualNoPad) return undefined;
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function looksLikeDecodableBase64(trimmed: string): boolean {
  if (trimmed.length < 4 || trimmed.length > MAX_INLINE_BASE64_CHARS) return false;
  if (!isValidBase64Syntax(trimmed)) return false;
  if (isLikelyPlainWordOrHash(trimmed)) return false;

  const bytes = decodeBase64Bytes(trimmed);
  if (!bytes || bytes.length < 2) return false;

  const printable = decodePrintableUtf8(bytes);
  if (printable !== undefined) {
    if (looksLikeWholeJsonContainer(printable)) {
      if (printable.length > 256_000) return true;
      try {
        const parsed: unknown = JSON.parse(printable);
        if (parsed !== null && typeof parsed === "object") {
          const isEmpty = Array.isArray(parsed)
            ? parsed.length === 0
            : Object.keys(parsed as Record<string, unknown>).length === 0;
          if (!isEmpty) return true;
        }
      } catch {
        // Fall through to protobuf / text checks.
      }
    }
    if (startsWithPbTagWhitespace(bytes)) {
      const pb = decodeProtobufMessage(bytes, { maxValueNodes: 20_000 });
      if (pb !== undefined && isPlausibleProtobufResult(trimmed, bytes, pb)) return true;
    }
    return isPlausibleBase64Text(trimmed, printable);
  }

  const pb = decodeProtobufMessage(bytes, { maxValueNodes: 20_000 });
  return pb !== undefined && isPlausibleProtobufResult(trimmed, bytes, pb);
}

/**
 * Cheap pre-check run while building Webview models to decide whether a string
 * node should offer an inline-expand affordance (JSON, JWT, URL query, Base64/Protobuf).
 */
export function detectDecodableKind(value: string): JsonTreeDecodableKind | undefined {
  if (looksLikeEmbeddedJson(value)) return "json";
  const trimmed = value.trim();
  if (trimmed.length < 4) return undefined;
  if (looksLikeJwt(trimmed)) return "jwt";
  if (looksLikeUrlWithQuery(trimmed)) return "url";
  if (looksLikeDecodableBase64(trimmed)) return "base64";
  return undefined;
}

export function isNonJsonDecodedKind(kind: JsonTreeDecodedKind | undefined): boolean {
  return kind !== undefined && kind !== "json";
}

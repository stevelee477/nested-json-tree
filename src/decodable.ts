import { gunzipSync, inflateRawSync, inflateSync } from "node:zlib";
import type { JsonTreeDecodableKind, JsonTreeDecodedKind } from "./jsonTree";
import { decodePrintableUtf8, inspectProtobufWire } from "./protobuf";

export const MAX_INLINE_BASE64_CHARS = 2 * 1024 * 1024;
export const MAX_DECOMPRESSED_BYTES = 4 * 1024 * 1024;
export const MAX_INLINE_JWT_CHARS = 64 * 1024;
export const MAX_INLINE_URL_CHARS = 64 * 1024;
export const MAX_INLINE_PERCENT_JSON_CHARS = 256 * 1024;

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
  if ((first === "{" && last === "}") || (first === "[" && last === "]")) {
    // Exclude partially percent-encoded JSON like `{%22a%22:1}` so URL decoder handles it.
    if (value.startsWith("%22", start + 1) || value.startsWith("%7B", start + 1) || value.startsWith("%7b", start + 1)) {
      return false;
    }
    return true;
  }
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

/**
 * Decodes a percent-encoded JSON container (`%7B%22...%7D`, `%5B...%5D`, or `{%22...}`)
 * into its decoded JSON text when syntactically valid.
 */
export function decodePercentEncodedJsonText(trimmed: string): string | undefined {
  if (trimmed.length < 6 || trimmed.length > MAX_INLINE_PERCENT_JSON_CHARS) return undefined;
  if (/\s/.test(trimmed)) return undefined;

  const startsObj = trimmed.startsWith("%7B") || trimmed.startsWith("%7b");
  const endsObj = trimmed.endsWith("%7D") || trimmed.endsWith("%7d");
  const startsArr = trimmed.startsWith("%5B") || trimmed.startsWith("%5b");
  const endsArr = trimmed.endsWith("%5D") || trimmed.endsWith("%5d");
  const partialObj = trimmed[0] === "{" && trimmed[trimmed.length - 1] === "}" && /%[0-9A-Fa-f]{2}/.test(trimmed);
  const partialArr = trimmed[0] === "[" && trimmed[trimmed.length - 1] === "]" && /%[0-9A-Fa-f]{2}/.test(trimmed);

  if (!((startsObj && endsObj) || (startsArr && endsArr) || partialObj || partialArr)) {
    return undefined;
  }

  for (const candidate of trimmed.includes("+") ? [trimmed, trimmed.replace(/\+/g, "%20")] : [trimmed]) {
    try {
      const decoded = decodeURIComponent(candidate);
      if (!looksLikeWholeJsonContainer(decoded)) continue;
      if (decoded.length <= 256_000) {
        const parsed: unknown = JSON.parse(decoded);
        if (parsed === null || typeof parsed !== "object") continue;
        const isEmpty = Array.isArray(parsed)
          ? parsed.length === 0
          : Object.keys(parsed as Record<string, unknown>).length === 0;
        if (isEmpty) continue;
      }
      return decoded;
    } catch {
      // Try fallback if applicable.
    }
  }
  return undefined;
}

export function looksLikePercentEncodedJson(trimmed: string): boolean {
  return decodePercentEncodedJsonText(trimmed) !== undefined;
}

function hasValidPercentEncoding(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 0x25 /* % */) {
      if (index + 2 >= text.length) return false;
      if (!isHexCode(text.charCodeAt(index + 1)) || !isHexCode(text.charCodeAt(index + 2))) {
        return false;
      }
      index += 2;
    }
  }
  return true;
}

function isHexCode(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x46) ||
    (code >= 0x61 && code <= 0x66);
}

const SCHEME_URL_WITH_QUERY_RE = /^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:\/\/\S+\?\S+$/;
const RELATIVE_URL_PATH_RE = /^(?:\/(?!\/)|\.{1,2}\/)[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/;
const QUERY_KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_.\-[\]%]{0,127}$/;

function isPlausibleQuerySegment(segment: string): boolean {
  const eq = segment.indexOf("=");
  if (eq < 1) return false;
  const key = segment.slice(0, eq);
  const val = segment.slice(eq + 1);
  if (!QUERY_KEY_RE.test(key)) return false;
  if (/[\s"'<>\\{}]/.test(val)) return false;
  return hasValidPercentEncoding(key) && hasValidPercentEncoding(val);
}

/**
 * Checks whether a trimmed string is a standalone query/form string such as
 * `a=1&b=2&c=3`, `?a=1&b=2`, or `filter=%7B%22ok%22%3Atrue%7D` without matching
 * ordinary prose, identifiers, or padded Base64 strings.
 */
export function looksLikeStandaloneQueryString(trimmed: string): boolean {
  if (trimmed.length < 3 || trimmed.length > MAX_INLINE_URL_CHARS) return false;
  if (/\s/.test(trimmed)) return false;
  if (trimmed.includes("://") || trimmed.startsWith("/")) return false;

  const hasLeadingQuestion = trimmed[0] === "?";
  const withoutQuestion = hasLeadingQuestion ? trimmed.slice(1) : trimmed;
  const hashIndex = withoutQuestion.indexOf("#");
  const queryPart = hashIndex >= 0 ? withoutQuestion.slice(0, hashIndex) : withoutQuestion;
  if (queryPart.length < 2 || !queryPart.includes("=")) return false;

  const segments = queryPart.split("&");
  if (segments.length === 0) return false;
  for (const segment of segments) {
    if (!isPlausibleQuerySegment(segment)) return false;
  }

  if (segments.length >= 2) return true;
  // Single `key=val`: require either leading `?` or a `%XX` percent-escape so
  // plain `env=prod` or padded Base64 (`SGVsbG8=`) is not treated as a URL query.
  return hasLeadingQuestion || /%[0-9A-Fa-f]{2}/.test(queryPart);
}

export function looksLikeUrlWithQuery(trimmed: string): boolean {
  if (trimmed.length < 3 || trimmed.length > MAX_INLINE_URL_CHARS) return false;
  if (/\s/.test(trimmed)) return false;

  // 1. Full URL with standard or custom URI scheme (`https://`, `ws://`, `grpc://`, `app://`, ...)
  if (SCHEME_URL_WITH_QUERY_RE.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (url.search.length <= 1) return false;
      for (const [key] of url.searchParams) {
        if (key.length > 0) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  // 2. Relative URL with query string (`/api/v1/items?a=1&b=2`, `./items?a=1`)
  const questionIndex = trimmed.indexOf("?");
  if (questionIndex > 0 && (trimmed[0] === "/" || trimmed.startsWith("./") || trimmed.startsWith("../"))) {
    const pathPart = trimmed.slice(0, questionIndex);
    if (!RELATIVE_URL_PATH_RE.test(pathPart)) return false;
    const afterQuestion = trimmed.slice(questionIndex + 1);
    const hashIndex = afterQuestion.indexOf("#");
    const queryPart = hashIndex >= 0 ? afterQuestion.slice(0, hashIndex) : afterQuestion;
    if (queryPart.length < 2 || !queryPart.includes("=")) return false;
    const segments = queryPart.split("&").filter((seg) => seg.length > 0);
    return segments.length > 0 && segments.every(isPlausibleQuerySegment);
  }

  // 3. Standalone query/form string (`a=1&b=2&c=3`, `?a=1&b=2`, `payload=%7B...%7D`)
  return looksLikeStandaloneQueryString(trimmed);
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

/** Filters out ordinary English words, lowercase hyphenated slugs, and hex hashes before attempting Base64 decode. */
export function isLikelyPlainWordOrHash(text: string): boolean {
  if (text.endsWith("=")) return false;
  if (/^[a-z]+$/.test(text) || /^\d+$/.test(text) || /^[a-z]+(?:-[a-z0-9]+)+$/.test(text)) return true;
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

export function isPrintableDecodedText(decoded: string, minTrimmedLength = 3): boolean {
  if (decoded.trim().length < minTrimmedLength) return false;
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

export function isPlausibleBase64Text(encoded: string, decoded: string): boolean {
  if (!isPrintableDecodedText(decoded, 3)) return false;
  const hasPadding = encoded.endsWith("=");
  const hasBase64Punct = /[+/_-]/.test(encoded);
  const hasMixedCaseAndDigits =
    /[A-Z]/.test(encoded) &&
    /[a-z]/.test(encoded) &&
    (/\d/.test(encoded) || encoded.length >= 16);
  return hasPadding || hasBase64Punct || hasMixedCaseAndDigits;
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

export type CompressionFormat = "gzip" | "zlib" | "deflate";

export function hasGzipMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 10 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

export function hasZlibHeader(bytes: Uint8Array): boolean {
  if (bytes.length < 6) return false;
  const b0 = bytes[0];
  const b1 = bytes[1];
  // Zlib CMF: CM === 8 (deflate) and CINFO <= 7 (0x78 for standard 32K window), with FCHECK mod 31 === 0.
  return (b0 & 0x0f) === 0x08 && (b0 >> 4) <= 7 && (b0 * 256 + b1) % 31 === 0;
}

/**
 * Safely decompresses Gzip (`0x1f 0x8b`) or Zlib (`0x78` + FCHECK) bytes with a
 * bounded `maxOutputLength` (default 4 MiB) so zip bombs cannot exhaust memory.
 */
export function tryDecompressHeaderBytes(
  bytes: Uint8Array,
  maxOutputLength = MAX_DECOMPRESSED_BYTES,
): { bytes: Uint8Array; format: "gzip" | "zlib" } | undefined {
  if (hasGzipMagic(bytes)) {
    try {
      const out = gunzipSync(bytes, { maxOutputLength });
      return out.length > 0
        ? { bytes: new Uint8Array(out.buffer, out.byteOffset, out.byteLength), format: "gzip" }
        : undefined;
    } catch {
      return undefined;
    }
  }
  if (hasZlibHeader(bytes)) {
    try {
      const out = inflateSync(bytes, { maxOutputLength });
      return out.length > 0
        ? { bytes: new Uint8Array(out.buffer, out.byteOffset, out.byteLength), format: "zlib" }
        : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Fallback raw DEFLATE (`inflateRawSync`) check used only after header-based
 * decompression and uncompressed UTF-8/Protobuf checks do not match.
 */
export function tryDecompressRawDeflateBytes(
  bytes: Uint8Array,
  maxOutputLength = MAX_DECOMPRESSED_BYTES,
): Uint8Array | undefined {
  if (bytes.length < 8 || hasGzipMagic(bytes)) return undefined;
  try {
    const out = inflateRawSync(bytes, { maxOutputLength });
    if (out.length < 2) return undefined;
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  } catch {
    return undefined;
  }
}

function base64Sextet(code: number, allowUrl: boolean, allowStd: boolean): number {
  if (code >= 0x41 && code <= 0x5a) return code - 0x41;
  if (code >= 0x61 && code <= 0x7a) return code - 0x47;
  if (code >= 0x30 && code <= 0x39) return code + 4;
  if ((allowStd && code === 0x2b) || (allowUrl && code === 0x2d)) return 62;
  if ((allowStd && code === 0x2f) || (allowUrl && code === 0x5f)) return 63;
  return -1;
}

/** Decodes strict Base64 or Base64URL into bytes, rejecting non-canonical padding/bits. */
export function decodeBase64Bytes(text: string): Uint8Array | undefined {
  const len = text.length;
  if (len < 2 || len % 4 === 1) return undefined;

  let pad = 0;
  if (text.charCodeAt(len - 1) === 0x3d) {
    if (len % 4 !== 0) return undefined;
    pad = text.charCodeAt(len - 2) === 0x3d ? 2 : 1;
  }
  const unpaddedLen = len - pad;
  if (unpaddedLen < 2 || unpaddedLen % 4 === 1) return undefined;

  let hasStd = false;
  let hasUrl = false;
  let lastSextet = 0;
  for (let index = 0; index < unpaddedLen; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x2b || code === 0x2f) {
      if (hasUrl) return undefined;
      hasStd = true;
    } else if (code === 0x2d || code === 0x5f) {
      if (hasStd) return undefined;
      hasUrl = true;
    }
    const sextet = base64Sextet(code, !hasStd, !hasUrl);
    if (sextet < 0) return undefined;
    lastSextet = sextet;
  }

  const mod = unpaddedLen % 4;
  if (mod === 2 && (lastSextet & 0x0f) !== 0) return undefined;
  if (mod === 3 && (lastSextet & 0x03) !== 0) return undefined;

  const expectedBytes = Math.floor((unpaddedLen * 3) / 4);
  if (expectedBytes === 0) return undefined;

  let buf: Buffer;
  if (hasUrl) {
    buf = Buffer.from(pad === 0 ? text : text.slice(0, unpaddedLen), "base64url");
  } else {
    const padded = mod === 0 ? text : text + "=".repeat(4 - mod);
    buf = Buffer.from(padded, "base64");
  }
  if (buf.length !== expectedBytes) return undefined;
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function isNonEmptyWholeJson(printable: string): boolean {
  if (!looksLikeWholeJsonContainer(printable)) return false;
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
    // Fall through to caller.
  }
  return false;
}

function looksLikeInnerDecodedBytes(
  trimmed: string,
  innerBytes: Uint8Array,
  checksumVerified: boolean,
): boolean {
  const printable = decodePrintableUtf8(innerBytes);
  if (printable !== undefined) {
    if (isNonEmptyWholeJson(printable)) return true;
    if (startsWithPbTagWhitespace(innerBytes)) {
      const pb = inspectProtobufWire(innerBytes, { maxValueNodes: 20_000 });
      if (pb !== undefined && isPlausibleProtobufResult(trimmed, innerBytes, pb)) return true;
    }
    if (checksumVerified) {
      return isPrintableDecodedText(printable, 1);
    }
    return innerBytes.length >= 8 && isPlausibleBase64Text(trimmed, printable);
  }

  const pb = inspectProtobufWire(innerBytes, { maxValueNodes: 20_000 });
  if (pb === undefined) return false;
  return checksumVerified ? pb.fieldCount > 0 && pb.minTopLevelFieldNumber <= 1024 : isPlausibleProtobufResult(trimmed, innerBytes, pb);
}

function looksLikeDecodableBase64(trimmed: string): boolean {
  if (trimmed.length < 4 || trimmed.length > MAX_INLINE_BASE64_CHARS) return false;
  if (!isValidBase64Syntax(trimmed)) return false;
  if (isLikelyPlainWordOrHash(trimmed)) return false;

  const bytes = decodeBase64Bytes(trimmed);
  if (!bytes || bytes.length < 2) return false;

  // 1. Gzip / Zlib compressed Base64 payload
  const decompressed = tryDecompressHeaderBytes(bytes);
  if (decompressed !== undefined) {
    return looksLikeInnerDecodedBytes(trimmed, decompressed.bytes, true);
  }
  // Reject corrupt gzip payloads with gzip magic header instead of misinterpreting them.
  if (hasGzipMagic(bytes)) return false;

  // 2. Uncompressed UTF-8 JSON / Protobuf / text
  const printable = decodePrintableUtf8(bytes);
  if (printable !== undefined) {
    if (isNonEmptyWholeJson(printable)) return true;
    if (startsWithPbTagWhitespace(bytes)) {
      const pb = inspectProtobufWire(bytes, { maxValueNodes: 20_000 });
      if (pb !== undefined && isPlausibleProtobufResult(trimmed, bytes, pb)) return true;
    }
    if (isPlausibleBase64Text(trimmed, printable)) return true;
  } else {
    const pb = inspectProtobufWire(bytes, { maxValueNodes: 20_000 });
    if (pb !== undefined && isPlausibleProtobufResult(trimmed, bytes, pb)) return true;
  }

  // 3. Raw DEFLATE fallback (strictly require valid non-empty JSON container or plausible longer UTF-8 text)
  const rawInflated = tryDecompressRawDeflateBytes(bytes);
  if (rawInflated !== undefined) {
    const inflatedText = decodePrintableUtf8(rawInflated);
    if (inflatedText !== undefined) {
      if (isNonEmptyWholeJson(inflatedText)) return true;
      if (rawInflated.length > bytes.length && inflatedText.trim().length >= 8 && isPlausibleBase64Text(trimmed, inflatedText)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Ultra-cheap prefix/shape detection (JSON, JWT, URL/query/percent-encoded JSON)
 * without allocating Base64 buffers, decompressing, or scanning Protobuf wire bytes.
 */
export function detectCheapDecodableKind(value: string): JsonTreeDecodableKind | undefined {
  if (looksLikeEmbeddedJson(value)) return "json";
  const trimmed = value.trim();
  if (trimmed.length < 3) return undefined;
  if (looksLikeJwt(trimmed)) return "jwt";
  if (looksLikePercentEncodedJson(trimmed)) return "url";
  if (looksLikeUrlWithQuery(trimmed)) return "url";
  return undefined;
}

/**
 * Pre-check run while building Webview models to decide whether a string node
 * should offer an inline-expand affordance (JSON, JWT, URL query, Base64/Gzip/Protobuf).
 */
export function detectDecodableKind(value: string): JsonTreeDecodableKind | undefined {
  const cheap = detectCheapDecodableKind(value);
  if (cheap !== undefined) return cheap;
  const trimmed = value.trim();
  if (trimmed.length < 4) return undefined;
  if (looksLikeDecodableBase64(trimmed)) return "base64";
  return undefined;
}

export function isNonJsonDecodedKind(kind: JsonTreeDecodedKind | undefined): boolean {
  return kind !== undefined && kind !== "json";
}

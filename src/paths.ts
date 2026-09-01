import {
  JsonTreeOutputTooLargeError,
  MAX_TRANSFER_OUTPUT_CHARACTERS,
} from "./jsonTree";

export const MAX_DISPLAY_PATH_CHARACTERS = 10_000;

const PATH_OMISSION_MARKER = "…[path shortened]…";
const KEY_OMISSION_MARKER = "…[key shortened]…";

/** Formats a node path as a jq filter that can be pasted after `jq`. */
export function formatJqPath(path: Array<string | number>): string {
  if (path.length === 0) {
    return ".";
  }

  return path
    .map((segment, index) => {
      if (typeof segment === "number") {
        return `${index === 0 ? "." : ""}[${segment}]`;
      }
      return /^[A-Za-z_][A-Za-z0-9_]*$/.test(segment)
        ? `.${segment}`
        : `${index === 0 ? "." : ""}[${JSON.stringify(segment)}]`;
    })
    .join("");
}

/** Measures before formatting so an oversized escaped key never creates a huge temporary string. */
export function formatJqPathForTransfer(
  path: Array<string | number>,
  outputLimit = MAX_TRANSFER_OUTPUT_CHARACTERS,
): string {
  assertPathOutputWithinLimit(path, "jq", outputLimit);
  return formatJqPath(path);
}

/** Formats a complete JSONPath for trusted Host-side copy operations. */
export function formatJsonPath(path: Array<string | number>): string {
  return `$${path.map(formatJsonPathSegment).join("")}`;
}

/** Measures before formatting so an oversized escaped key never creates a huge temporary string. */
export function formatJsonPathForTransfer(
  path: Array<string | number>,
  outputLimit = MAX_TRANSFER_OUTPUT_CHARACTERS,
): string {
  assertPathOutputWithinLimit(path, "jsonpath", outputLimit);
  return formatJsonPath(path);
}

/**
 * Formats a bounded, explicitly shortened JSONPath for titles, notifications,
 * Quick Picks, and Webview labels. It never stringifies one unbounded key.
 */
export function formatJsonPathForDisplay(
  path: Array<string | number>,
  maxCharacters = MAX_DISPLAY_PATH_CHARACTERS,
): string {
  const limit = normalizeDisplayLimit(maxCharacters);
  if (limit <= 1) return "$".slice(0, limit);

  let prefix = "$";
  let overflowIndex = -1;
  let overflowSegment = "";
  for (let index = 0; index < path.length; index += 1) {
    const segment = formatJsonPathSegmentForDisplay(path[index], limit - 1);
    if (prefix.length + segment.length > limit) {
      overflowIndex = index;
      overflowSegment = segment;
      break;
    }
    prefix += segment;
  }
  if (overflowIndex < 0) return prefix;

  const marker = fitMarker(PATH_OMISSION_MARKER, limit);
  const available = limit - marker.length;
  const prefixBudget = Math.ceil(available / 2);
  const suffixBudget = Math.floor(available / 2);
  const prefixSource = `${prefix}${overflowSegment}`;
  const boundedPrefix = prefixSource.slice(0, prefixBudget);

  let suffix = "";
  for (let index = path.length - 1; index >= overflowIndex; index -= 1) {
    const segment = formatJsonPathSegmentForDisplay(path[index], limit - 1);
    const remaining = suffixBudget - suffix.length;
    if (remaining <= 0) break;
    if (segment.length <= remaining) {
      suffix = `${segment}${suffix}`;
    } else {
      suffix = `${segment.slice(-remaining)}${suffix}`;
      break;
    }
  }
  return `${boundedPrefix}${marker}${suffix}`;
}

function formatJsonPathSegment(segment: string | number): string {
  if (typeof segment === "number") return `[${segment}]`;
  return /^[A-Za-z_$][\w$]*$/.test(segment)
    ? `.${segment}`
    : `[${JSON.stringify(segment)}]`;
}

function assertPathOutputWithinLimit(
  path: Array<string | number>,
  syntax: "jq" | "jsonpath",
  outputLimit: number,
): void {
  const limit = Number.isFinite(outputLimit) ? Math.max(0, Math.trunc(outputLimit)) : 0;
  let length = syntax === "jsonpath" || path.length === 0 ? 1 : 0;
  if (length > limit) throw new JsonTreeOutputTooLargeError(limit);
  if (path.length === 0) return;

  for (let index = 0; index < path.length; index += 1) {
    const segment = path[index];
    let segmentLength: number;
    if (typeof segment === "number") {
      const indexLength = String(segment).length + 2;
      segmentLength = indexLength + (syntax === "jq" && index === 0 ? 1 : 0);
    } else {
      const simple =
        syntax === "jq"
          ? /^[A-Za-z_][A-Za-z0-9_]*$/.test(segment)
          : /^[A-Za-z_$][\w$]*$/.test(segment);
      if (simple) {
        segmentLength = segment.length + 1;
      } else {
        const literalLimit = limit - length - 2;
        if (literalLimit < 2) throw new JsonTreeOutputTooLargeError(limit);
        const literalLength = jsonStringLiteralLength(segment, literalLimit);
        if (literalLength > literalLimit) throw new JsonTreeOutputTooLargeError(limit);
        segmentLength = literalLength + 2 + (syntax === "jq" && index === 0 ? 1 : 0);
      }
    }
    length += segmentLength;
    if (length > limit) throw new JsonTreeOutputTooLargeError(limit);
  }
}

/** Exact modern JSON.stringify string-literal length, with an early-exit ceiling. */
function jsonStringLiteralLength(value: string, stopAfter: number): number {
  let length = 2; // quotes
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
      length += 2;
    } else if (code < 0x20) {
      length += 6;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        length += 2;
        index += 1;
      } else {
        length += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      length += 6;
    } else {
      length += 1;
    }
    if (length > stopAfter) return stopAfter + 1;
  }
  return length;
}

function formatJsonPathSegmentForDisplay(segment: string | number, maxCharacters: number): string {
  if (typeof segment === "number") return boundDisplayText(`[${segment}]`, maxCharacters);

  // JSON escaping can expand one UTF-16 code unit to six characters. Avoid
  // JSON.stringify on an unbounded key by formatting small edge slices only.
  if (segment.length > maxCharacters) {
    const sliceLength = Math.max(1, Math.floor(maxCharacters / 16));
    const head = JSON.stringify(segment.slice(0, sliceLength)).slice(1, -1);
    const tail = JSON.stringify(segment.slice(-sliceLength)).slice(1, -1);
    return boundDisplayText(
      `["${head}${KEY_OMISSION_MARKER}${tail}"]`,
      maxCharacters,
      KEY_OMISSION_MARKER,
    );
  }

  return boundDisplayText(formatJsonPathSegment(segment), maxCharacters, KEY_OMISSION_MARKER);
}

function boundDisplayText(
  text: string,
  maxCharacters: number,
  preferredMarker = PATH_OMISSION_MARKER,
): string {
  const limit = normalizeDisplayLimit(maxCharacters);
  if (text.length <= limit) return text;
  const marker = fitMarker(preferredMarker, limit);
  const available = limit - marker.length;
  const headLength = Math.ceil(available / 2);
  const tailLength = Math.floor(available / 2);
  return `${text.slice(0, headLength)}${marker}${tailLength > 0 ? text.slice(-tailLength) : ""}`;
}

function normalizeDisplayLimit(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : MAX_DISPLAY_PATH_CHARACTERS;
}

function fitMarker(marker: string, maxCharacters: number): string {
  if (marker.length <= maxCharacters) return marker;
  return "…".slice(0, maxCharacters);
}

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface JsonCandidate {
  value: JsonValue;
  raw: string;
  start: number;
  end: number;
  unwrapDepth: number;
}

export const MAX_INPUT_BYTES = 100 * 1024 * 1024;
const MAX_UNWRAP_DEPTH = 10;

export class InputTooLargeError extends Error {
  constructor(public readonly actualBytes: number) {
    super(`Input is ${formatBytes(actualBytes)}; the limit is ${formatBytes(MAX_INPUT_BYTES)}.`);
    this.name = "InputTooLargeError";
  }
}

export function assertInputSize(text: string): void {
  const actualBytes = Buffer.byteLength(text, "utf8");
  if (actualBytes > MAX_INPUT_BYTES) {
    throw new InputTooLargeError(actualBytes);
  }
}

/**
 * Parses an entire JSON value when possible. If the text contains unrelated
 * prefixes/suffixes, it scans for balanced object/array candidates instead.
 */
export function parseJsonCandidates(text: string): JsonCandidate[] {
  const bounds = trimmedBounds(text);
  if (bounds.start < bounds.end) {
    const raw = text.slice(bounds.start, bounds.end);
    const parsed = tryParse(raw);
    if (parsed.ok) {
      return [{ value: parsed.value, raw, start: bounds.start, end: bounds.end, unwrapDepth: 0 }];
    }
  }

  const candidates: JsonCandidate[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char !== "{" && char !== "[") {
      continue;
    }

    const end = findBalancedEnd(text, index);
    if (end === undefined) {
      continue;
    }

    const raw = text.slice(index, end);
    const parsed = tryParse(raw);
    if (parsed.ok) {
      candidates.push({ value: parsed.value, raw, start: index, end, unwrapDepth: 0 });
      index = end - 1;
    }
  }
  return candidates;
}

/**
 * Repeatedly JSON-decodes a string. This handles both already-unescaped JSON
 * strings and values that were encoded more than once.
 */
export function parseNestedJsonCandidates(text: string): JsonCandidate[] {
  let current = text;
  let lastStringCandidate: JsonCandidate | undefined;

  for (let depth = 0; depth <= MAX_UNWRAP_DEPTH; depth += 1) {
    const candidates = parseJsonCandidates(current).map((candidate) => ({
      ...candidate,
      unwrapDepth: depth,
    }));

    if (candidates.length !== 1) {
      return candidates.length > 0 ? candidates : lastStringCandidate ? [lastStringCandidate] : [];
    }

    const candidate = candidates[0];
    if (typeof candidate.value !== "string") {
      return candidates;
    }
    lastStringCandidate = candidate;
    if (candidate.value === current) {
      return [candidate];
    }
    current = candidate.value;
  }

  return lastStringCandidate ? [lastStringCandidate] : [];
}

export function candidatePreview(candidate: JsonCandidate, maxLength = 100): string {
  const compact = candidate.raw.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
}

/** Returns a complete JSON string literal, including quotes and escapes. */
export function encodeJsonStringLiteral(value: string): string {
  return JSON.stringify(value);
}

function trimmedBounds(text: string): { start: number; end: number } {
  let start = 0;
  let end = text.length;
  while (start < end && /\s/.test(text[start])) start += 1;
  while (end > start && /\s/.test(text[end - 1])) end -= 1;
  return { start, end };
}

function findBalancedEnd(text: string, start: number): number | undefined {
  const stack: string[] = [text[start]];
  let inString = false;
  let escaped = false;

  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char);
      continue;
    }
    if (char === "}" || char === "]") {
      const expected = char === "}" ? "{" : "[";
      if (stack.at(-1) !== expected) {
        return undefined;
      }
      stack.pop();
      if (stack.length === 0) {
        return index + 1;
      }
    }
  }
  return undefined;
}

function tryParse(raw: string): { ok: true; value: JsonValue } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(raw) as JsonValue };
  } catch {
    return { ok: false };
  }
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

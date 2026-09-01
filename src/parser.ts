import { ParseError, SyntaxKind, createScanner, parseTree } from "jsonc-parser";
import { JsonTreeNode, buildJsonTree, jsonTreeToValue } from "./jsonTree";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface JsonCandidate {
  value: JsonValue;
  /** Lossless syntax tree used for display, copy, search, and serialization. */
  tree: JsonTreeNode;
  /** Number of value nodes in tree, used for aggregate resource accounting. */
  nodeCount: number;
  /** Exact candidate source; offsets for future lossless tokens are relative to this string. */
  raw: string;
  start: number;
  end: number;
  unwrapDepth: number;
}

export const MAX_INPUT_BYTES = 100 * 1024 * 1024;
export const MAX_JSON_NESTING = 1_024;
export const MAX_JSON_VALUE_NODES = 100_000;
export const MAX_CONTAINER_SPANS = 50_000;
export const MAX_JSON_CANDIDATES = 5_000;
const MAX_UNWRAP_DEPTH = 10;
const MAX_OVERLAPPING_PARSE_FACTOR = 8;

export abstract class JsonProcessingLimitError extends Error {}

export class InputTooLargeError extends JsonProcessingLimitError {
  constructor(public readonly actualBytes: number) {
    super(`Input is ${formatBytes(actualBytes)}; the limit is ${formatBytes(MAX_INPUT_BYTES)}.`);
    this.name = "InputTooLargeError";
  }
}

export class JsonNestingTooDeepError extends JsonProcessingLimitError {
  constructor(public readonly maxDepth = MAX_JSON_NESTING) {
    super(
      `JSON nesting exceeds the safe limit of ${maxDepth.toLocaleString()} levels. ` +
        "Use a less deeply nested value.",
    );
    this.name = "JsonNestingTooDeepError";
  }
}

export class JsonContainerScanLimitError extends JsonProcessingLimitError {
  constructor(public readonly maxSpans = MAX_CONTAINER_SPANS) {
    super(
      `The surrounding text contains more than ${maxSpans.toLocaleString()} potential JSON containers. ` +
        "Use a smaller document or open one JSONL/NDJSON line.",
    );
    this.name = "JsonContainerScanLimitError";
  }
}

export class JsonValueNodeLimitError extends JsonProcessingLimitError {
  constructor(public readonly maxNodes = MAX_JSON_VALUE_NODES) {
    super(
      `JSON data contains more than ${maxNodes.toLocaleString()} value nodes in total, which exceeds the safe limit. ` +
        "Use a smaller value or split the data into JSONL/NDJSON lines.",
    );
    this.name = "JsonValueNodeLimitError";
  }
}

export class JsonCandidateLimitError extends JsonProcessingLimitError {
  constructor(public readonly maxCandidates = MAX_JSON_CANDIDATES) {
    super(
      `More than ${maxCandidates.toLocaleString()} JSON candidates were found. ` +
        "Use a smaller document or open one JSONL/NDJSON line.",
    );
    this.name = "JsonCandidateLimitError";
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
  let attemptedWholeDocument = false;
  if (bounds.start < bounds.end) {
    const raw = text.slice(bounds.start, bounds.end);
    const parsed = tryParse(raw);
    attemptedWholeDocument = true;
    if (parsed.ok) {
      return isEmptyContainer(parsed.tree)
        ? []
        : [{ ...parsed, raw, start: bounds.start, end: bounds.end, unwrapDepth: 0 }];
    }
  }

  const strictScan = scanContainerSpans(text, true);
  const strictCandidates = parseContainerSpans(
    text,
    strictScan.spans,
    bounds,
    attemptedWholeDocument,
  );

  // Prefix text can itself be malformed, for example an unmatched quote or a
  // comment-looking log marker that hides the opener of a multiline value.
  // The recovery view ignores that prefix syntax, then filters candidates
  // wholly contained in balanced strict-view strings/comments.
  let recoveryCandidates: JsonCandidate[];
  try {
    recoveryCandidates = parseContainerSpans(
      text,
      scanContainerSpans(text, false).spans,
      bounds,
      attemptedWholeDocument,
    );
    recoveryCandidates = filterCandidatesInsideRanges(
      recoveryCandidates,
      strictScan.prefixSyntaxRanges,
    );
  } catch (error) {
    // A permissive view of arbitrary prefix text may hit a false structural
    // limit. It must not poison candidates already proven by the strict view.
    if (strictCandidates.length > 0 && error instanceof JsonProcessingLimitError) {
      return strictCandidates;
    }
    throw error;
  }

  if (strictCandidates.length === 0) return recoveryCandidates;
  const merged = mergeCandidateViews(strictCandidates, recoveryCandidates);
  assertCandidateNodeTotal(merged);
  return merged;
}

function filterCandidatesInsideRanges(
  candidates: JsonCandidate[],
  ranges: TextRange[],
): JsonCandidate[] {
  if (candidates.length === 0 || ranges.length === 0) return candidates;
  let rangeIndex = 0;
  return candidates.filter((candidate) => {
    while (rangeIndex < ranges.length && ranges[rangeIndex].end <= candidate.start) {
      rangeIndex += 1;
    }
    const range = ranges[rangeIndex];
    return range === undefined || candidate.start < range.start || candidate.end > range.end;
  });
}

/** Replaces strict inner fragments only when recovery proves one valid outer value. */
function mergeCandidateViews(
  strictCandidates: JsonCandidate[],
  recoveryCandidates: JsonCandidate[],
): JsonCandidate[] {
  const merged = [...strictCandidates];
  for (const recovery of recoveryCandidates) {
    const overlapping = merged.filter(
      (strict) => strict.start < recovery.end && recovery.start < strict.end,
    );
    if (
      overlapping.length === 0 ||
      !overlapping.every(
        (strict) => recovery.start <= strict.start && recovery.end >= strict.end,
      ) ||
      !overlapping.some(
        (strict) => recovery.start < strict.start || recovery.end > strict.end,
      )
    ) {
      continue;
    }

    for (let index = merged.length - 1; index >= 0; index -= 1) {
      if (overlapping.includes(merged[index])) merged.splice(index, 1);
    }
    merged.push(recovery);
  }
  return merged.sort((left, right) => left.start - right.start);
}

function assertCandidateNodeTotal(candidates: JsonCandidate[]): void {
  let total = 0;
  for (const candidate of candidates) {
    total += candidate.nodeCount;
    if (total > MAX_JSON_VALUE_NODES) {
      throw new JsonValueNodeLimitError();
    }
  }
}

function parseContainerSpans(
  text: string,
  spans: ContainerSpan[],
  bounds: { start: number; end: number },
  attemptedWholeDocument: boolean,
): JsonCandidate[] {
  const candidates: JsonCandidate[] = [];
  const skippedSpans: ContainerSpan[] = [];
  let candidateNodeTotal = 0;
  let acceptedEnd = -1;
  // Disjoint candidates total at most the input length. This extra budget
  // permits recovery from several invalid outer containers without allowing
  // deeply nested malformed input to trigger quadratic repeated parsing.
  let remainingParseCharacters = text.length * MAX_OVERLAPPING_PARSE_FACTOR;
  for (const span of spans) {
    if (span.end === undefined || span.start < acceptedEnd) {
      continue;
    }
    if (
      attemptedWholeDocument &&
      span.start === bounds.start &&
      span.end === bounds.end
    ) {
      continue;
    }
    const length = span.end - span.start;
    if (length > remainingParseCharacters) {
      skippedSpans.push(span);
      continue;
    }
    remainingParseCharacters -= length;
    const raw = text.slice(span.start, span.end);
    const parsed = tryParse(raw);
    if (parsed.ok && !isEmptyContainer(parsed.tree)) {
      if (candidates.length >= MAX_JSON_CANDIDATES) {
        throw new JsonCandidateLimitError();
      }
      candidateNodeTotal += parsed.nodeCount;
      if (candidateNodeTotal > MAX_JSON_VALUE_NODES) {
        throw new JsonValueNodeLimitError();
      }
      candidates.push({
        ...parsed,
        raw,
        start: span.start,
        end: span.end,
        unwrapDepth: 0,
      });
      acceptedEnd = span.end;
    }
  }

  // When a malformed outer chain exhausted the main budget, spend one final
  // linear-size budget from the inside out. This preserves recovery of a small
  // valid value buried in bad wrappers without restoring quadratic behavior.
  let rescueCharacters = text.length;
  for (let index = skippedSpans.length - 1; index >= 0; index -= 1) {
    const span = skippedSpans[index];
    const end = span.end as number;
    const length = end - span.start;
    if (
      length > rescueCharacters ||
      candidates.some((candidate) => candidate.start <= span.start && candidate.end >= end)
    ) {
      continue;
    }
    rescueCharacters -= length;
    const raw = text.slice(span.start, end);
    const parsed = tryParse(raw);
    if (!parsed.ok || isEmptyContainer(parsed.tree)) {
      continue;
    }
    for (let candidateIndex = candidates.length - 1; candidateIndex >= 0; candidateIndex -= 1) {
      const candidate = candidates[candidateIndex];
      if (candidate.start >= span.start && candidate.end <= end) {
        candidateNodeTotal -= candidate.nodeCount;
        candidates.splice(candidateIndex, 1);
      }
    }
    if (candidates.length >= MAX_JSON_CANDIDATES) {
      throw new JsonCandidateLimitError();
    }
    candidateNodeTotal += parsed.nodeCount;
    if (candidateNodeTotal > MAX_JSON_VALUE_NODES) {
      throw new JsonValueNodeLimitError();
    }
    candidates.push({ ...parsed, raw, start: span.start, end, unwrapDepth: 0 });
  }
  return candidates.sort((left, right) => left.start - right.start);
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
    if (candidate.tree.type !== "string") {
      return candidates;
    }
    lastStringCandidate = candidate;
    const decoded = candidate.tree.value as string;
    if (decoded === current) {
      return [candidate];
    }
    current = decoded;
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

interface ContainerSpan {
  start: number;
  opener: "{" | "[";
  end?: number;
}

interface TextRange {
  start: number;
  end: number;
}

interface ContainerScanResult {
  spans: ContainerSpan[];
  /** Candidates wholly inside these strict-view ranges are prefix noise. */
  prefixSyntaxRanges: TextRange[];
}

/**
 * Finds balanced containers in one left-to-right pass. The strict view tracks
 * strings and comments in prefix text; the recovery view begins tracking them
 * only after a possible container starts.
 */
function scanContainerSpans(
  text: string,
  trackPrefixSyntax: boolean,
): ContainerScanResult {
  const spans: ContainerSpan[] = [];
  const balancedPrefixRanges: TextRange[] = [];
  const prefixLineCommentRanges: TextRange[] = [];
  const stack: number[] = [];
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;
  let prefixSyntaxStart = -1;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inLineComment) {
      if (char === "\n" || char === "\r") {
        inLineComment = false;
        if (prefixSyntaxStart >= 0) {
          prefixLineCommentRanges.push({ start: prefixSyntaxStart, end: index });
        }
        prefixSyntaxStart = -1;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && text[index + 1] === "/") {
        inBlockComment = false;
        if (prefixSyntaxStart >= 0) {
          balancedPrefixRanges.push({ start: prefixSyntaxStart, end: index + 2 });
          prefixSyntaxStart = -1;
        }
        index += 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
        if (prefixSyntaxStart >= 0) {
          balancedPrefixRanges.push({ start: prefixSyntaxStart, end: index + 1 });
          prefixSyntaxStart = -1;
        }
      }
      continue;
    }

    // Prefix and suffix text are arbitrary log content. Interpret comment
    // markers only after a candidate container has begun, so URLs in a log
    // prefix do not hide a following JSON candidate.
    if (
      (trackPrefixSyntax || stack.length > 0) &&
      char === "/" &&
      text[index + 1] === "/" &&
      !(trackPrefixSyntax && stack.length === 0 && hasUrlSchemeBefore(text, index))
    ) {
      inLineComment = true;
      // Line comments are deliberately not skipped by recovery: an opener at
      // the end of a log marker can belong to a multiline JSON value.
      if (trackPrefixSyntax && stack.length === 0) prefixSyntaxStart = index;
      index += 1;
      continue;
    }
    if ((trackPrefixSyntax || stack.length > 0) && char === "/" && text[index + 1] === "*") {
      inBlockComment = true;
      if (trackPrefixSyntax && stack.length === 0) prefixSyntaxStart = index;
      index += 1;
      continue;
    }
    // Quoting in unrelated prefix/suffix text must not poison the scan. Once
    // a container starts, strings are tracked so their brackets stay inert.
    if ((trackPrefixSyntax || stack.length > 0) && char === '"') {
      inString = true;
      if (trackPrefixSyntax && stack.length === 0) prefixSyntaxStart = index;
      continue;
    }
    if (char === "{" || char === "[") {
      if (stack.length >= MAX_JSON_NESTING) {
        throw new JsonNestingTooDeepError();
      }
      if (spans.length >= MAX_CONTAINER_SPANS) {
        throw new JsonContainerScanLimitError();
      }
      spans.push({ start: index, opener: char });
      stack.push(spans.length - 1);
      continue;
    }
    if (char === "}" || char === "]") {
      const expected = char === "}" ? "{" : "[";
      const spanIndex = stack.at(-1);
      if (spanIndex === undefined || spans[spanIndex].opener !== expected) {
        continue;
      }
      stack.pop();
      spans[spanIndex].end = index + 1;
    }
  }
  if (inLineComment && prefixSyntaxStart >= 0) {
    prefixLineCommentRanges.push({ start: prefixSyntaxStart, end: text.length });
  }
  return {
    spans,
    prefixSyntaxRanges: [...balancedPrefixRanges, ...prefixLineCommentRanges].sort(
      (left, right) => left.start - right.start,
    ),
  };
}

function hasUrlSchemeBefore(text: string, slashIndex: number): boolean {
  const prefix = text.slice(Math.max(0, slashIndex - 32), slashIndex);
  return /(?:^|[^A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*:$/.test(prefix);
}

function tryParse(
  raw: string,
): { ok: true; value: JsonValue; tree: JsonTreeNode; nodeCount: number } | { ok: false } {
  const errors: ParseError[] = [];
  try {
    const nodeCount = assertJsonComplexityWithinLimits(raw);
    const root = parseTree(raw, errors, {
      allowTrailingComma: true,
      disallowComments: false,
    });
    if (root === undefined || errors.length > 0) return { ok: false };
    const tree = buildJsonTree(root, raw);
    return { ok: true, value: jsonTreeToValue(tree), tree, nodeCount };
  } catch (error) {
    // jsonc-parser recursively builds its AST. Never reinterpret an inner
    // fragment when the complete value only failed because the call stack was
    // exhausted: that would silently show different JSON than the input.
    if (error instanceof RangeError) {
      throw new JsonNestingTooDeepError();
    }
    throw error;
  }
}

/** Counts JSONC structure without building an AST or recursing. */
function assertJsonComplexityWithinLimits(raw: string): number {
  const scanner = createScanner(raw, true);
  const containers: Array<"object" | "array"> = [];
  const objectExpectsKey: boolean[] = [];
  let depth = 0;
  let valueNodes = 0;

  const countValueNode = (): void => {
    valueNodes += 1;
    if (valueNodes > MAX_JSON_VALUE_NODES) {
      throw new JsonValueNodeLimitError();
    }
  };

  for (let token = scanner.scan(); token !== SyntaxKind.EOF; token = scanner.scan()) {
    if (token === SyntaxKind.OpenBraceToken || token === SyntaxKind.OpenBracketToken) {
      countValueNode();
      depth += 1;
      if (depth > MAX_JSON_NESTING) {
        throw new JsonNestingTooDeepError();
      }
      const container = token === SyntaxKind.OpenBraceToken ? "object" : "array";
      containers.push(container);
      objectExpectsKey.push(container === "object");
    } else if (
      (token === SyntaxKind.CloseBraceToken || token === SyntaxKind.CloseBracketToken) &&
      depth > 0
    ) {
      depth -= 1;
      containers.pop();
      objectExpectsKey.pop();
    } else if (token === SyntaxKind.CommaToken && containers.at(-1) === "object") {
      objectExpectsKey[objectExpectsKey.length - 1] = true;
    } else if (token === SyntaxKind.StringLiteral) {
      const top = containers.length - 1;
      if (top >= 0 && containers[top] === "object" && objectExpectsKey[top]) {
        objectExpectsKey[top] = false;
      } else {
        countValueNode();
      }
    } else if (
      token === SyntaxKind.NumericLiteral ||
      token === SyntaxKind.TrueKeyword ||
      token === SyntaxKind.FalseKeyword ||
      token === SyntaxKind.NullKeyword
    ) {
      countValueNode();
    }
  }

  return valueNodes;
}

function isEmptyContainer(tree: JsonTreeNode): boolean {
  return (tree.type === "array" || tree.type === "object") && (tree.children?.length ?? 0) === 0;
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

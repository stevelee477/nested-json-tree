import {
  Node as JsoncNode,
  ParseError,
  ParseErrorCode,
  SyntaxKind,
  createScanner,
  parseTree,
  printParseErrorCode,
} from "jsonc-parser";
import { JsonTreeNode, buildJsonTree } from "./jsonTree";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface JsonCandidate {
  /** Lossless syntax tree used for display, copy, search, and serialization. */
  tree: JsonTreeNode;
  /** Number of value nodes in tree, used for aggregate resource accounting. */
  nodeCount: number;
  /** Exact candidate source; offsets for future lossless tokens are relative to this string. */
  raw: string;
  start: number;
  end: number;
  unwrapDepth: number;
  /** Present only for a recovered subset; raw remains the damaged source. */
  recovery?: JsonRecovery;
}

export interface JsonRecovery {
  errorCount: number;
  /** Bounded diagnostics, with offsets relative to candidate.raw. */
  issues: Array<{ code: string; offset: number; length: number }>;
}

export interface JsonParseOptions {
  /** Disable to extract only complete JSON/JSONC values. Defaults to true. */
  allowPartial?: boolean;
  /** Total value nodes allowed across all candidates. Defaults to MAX_JSON_VALUE_NODES. */
  maxValueNodes?: number;
}

export const MAX_INPUT_BYTES = 100 * 1024 * 1024;
export const MAX_JSON_NESTING = 1_024;
export const MAX_JSON_VALUE_NODES = 500_000;
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
export function parseJsonCandidates(text: string, options: JsonParseOptions = {}): JsonCandidate[] {
  const maxValueNodes = normalizeValueNodeLimit(options.maxValueNodes);
  const bounds = trimmedBounds(text);
  let attemptedWholeDocument = false;
  if (bounds.start < bounds.end) {
    const raw = text.slice(bounds.start, bounds.end);
    const parsed = tryParse(raw, maxValueNodes);
    attemptedWholeDocument = true;
    if (parsed.ok) {
      return isEmptyContainer(parsed.tree)
        ? []
        : [{ tree: parsed.tree, nodeCount: parsed.nodeCount, raw, start: bounds.start, end: bounds.end, unwrapDepth: 0 }];
    }
  }

  const strictScan = scanContainerSpans(text, true);
  const strictCandidates = parseContainerSpans(
    text,
    strictScan.spans,
    bounds,
    attemptedWholeDocument,
    maxValueNodes,
  );

  // Prefix text can itself be malformed, for example an unmatched quote or a
  // comment-looking log marker that hides the opener of a multiline value.
  // The recovery view ignores that prefix syntax, then filters candidates
  // wholly contained in balanced strict-view strings/comments.
  let recoveryCandidates: JsonCandidate[];
  let recoverySpans: ContainerSpan[] = [];
  try {
    recoverySpans = scanContainerSpans(text, false).spans;
    recoveryCandidates = parseContainerSpans(
      text,
      recoverySpans,
      bounds,
      attemptedWholeDocument,
      maxValueNodes,
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

  const complete = strictCandidates.length === 0
    ? recoveryCandidates
    : mergeCandidateViews(strictCandidates, recoveryCandidates);
  assertCandidateNodeTotal(complete, maxValueNodes);
  return options.allowPartial === false
    ? complete
    : recoverPartialCandidates(
        text,
        [...strictScan.spans, ...recoverySpans],
        strictScan.prefixSyntaxRanges,
        complete,
        maxValueNodes,
      );
}

/**
 * Recover only explicit syntax-tree fields, never invent values or repair tokens.
 * Recovery is best effort: a span that hits a structural limit is skipped, and
 * recovery stops before the candidate or node budget would be exceeded, so it
 * never discards complete candidates that were already proven.
 */
function recoverPartialCandidates(
  text: string,
  spans: ContainerSpan[],
  prefixRanges: TextRange[],
  complete: JsonCandidate[],
  maxValueNodes: number,
): JsonCandidate[] {
  const ordered = spans.sort((left, right) => left.start - right.start);
  const boundaries = findRecordBoundaries(text, ordered);
  const removed = new Set<JsonCandidate>();
  const recovered: JsonCandidate[] = [];
  let candidateCount = complete.length;
  let nodeTotal = complete.reduce((total, candidate) => total + candidate.nodeCount, 0);
  let lastStart = -1;
  let acceptedEnd = -1;
  let remainingCharacters = text.length * MAX_OVERLAPPING_PARSE_FACTOR;
  let rangeIndex = 0;
  for (const span of ordered) {
    if (span.start === lastStart) continue;
    lastStart = span.start;
    if (span.start < acceptedEnd) continue;
    // An unclosed container never extends past the next log-record opener, so
    // a run of truncated records is recovered record by record instead of the
    // first one swallowing the rest (and re-parsing to EOF for every record).
    let end = span.end ?? boundaries[firstIndexAfter(boundaries, span.start)] ?? text.length;
    while (rangeIndex < prefixRanges.length && prefixRanges[rangeIndex].end <= span.start) rangeIndex += 1;
    const prefixRange = prefixRanges[rangeIndex];
    // Never recover a value from a balanced prefix quote/comment, even if the
    // permissive scanner lost its closing delimiter.
    if (prefixRange && span.start >= prefixRange.start && span.start < prefixRange.end) continue;
    const containing = complete[lastIndexAtOrBefore(complete, span.start)];
    if (containing && !removed.has(containing) && containing.end >= end) continue;
    const parse = (): ReturnType<typeof tryParsePartial> => {
      const length = end - span.start;
      if (length <= 0 || length > remainingCharacters) return undefined;
      remainingCharacters -= length;
      try {
        return tryParsePartial(text.slice(span.start, end), maxValueNodes);
      } catch (error) {
        if (error instanceof JsonProcessingLimitError) return undefined;
        throw error;
      }
    };
    let parsed = parse();
    if (!parsed) continue;
    // A broken outer value must not swallow a later complete record, a later
    // log record, or an inner candidate that the tolerant parser did not
    // actually retain.
    const cut = firstUnretainedStart(span.start, parsed, complete, boundaries);
    if (cut !== undefined) {
      end = cut;
      parsed = parse();
      if (!parsed) continue;
    }
    const candidateEnd = span.start + parsed.length;
    const overlapping: JsonCandidate[] = [];
    let outside = false;
    for (let index = Math.max(0, lastIndexAtOrBefore(complete, span.start)); index < complete.length; index += 1) {
      const item = complete[index];
      if (item.start >= candidateEnd) break;
      if (removed.has(item) || item.end <= span.start) continue;
      if (item.start < span.start || item.end > candidateEnd) outside = true;
      overlapping.push(item);
    }
    if (outside) continue;
    // Recovery must confirm some data of its own; wrapping complete values in
    // damaged prefix brackets would only hide them.
    if (parsed.primitiveCount <= overlapping.reduce((total, item) => total + countPrimitives(item.tree), 0)) continue;
    const nextNodeTotal = nodeTotal + parsed.nodeCount -
      overlapping.reduce((total, item) => total + item.nodeCount, 0);
    const nextCandidateCount = candidateCount + 1 - overlapping.length;
    if (nextNodeTotal > maxValueNodes || nextCandidateCount > MAX_JSON_CANDIDATES) break;
    for (const item of overlapping) removed.add(item);
    recovered.push({
      tree: parsed.tree,
      nodeCount: parsed.nodeCount,
      raw: text.slice(span.start, candidateEnd),
      start: span.start,
      end: candidateEnd,
      unwrapDepth: 0,
      recovery: parsed.recovery,
    });
    nodeTotal = nextNodeTotal;
    candidateCount = nextCandidateCount;
    acceptedEnd = candidateEnd;
  }
  if (recovered.length === 0) return complete;
  return [...complete.filter((candidate) => !removed.has(candidate)), ...recovered]
    .sort((left, right) => left.start - right.start);
}

/** Returns the first complete candidate or log-record opener the partial parse dropped. */
function firstUnretainedStart(
  start: number,
  parsed: NonNullable<ReturnType<typeof tryParsePartial>>,
  complete: JsonCandidate[],
  boundaries: number[],
): number | undefined {
  const end = start + parsed.length;
  const retained = new Map<number, number>();
  for (const range of parsed.containerRanges) retained.set(start + range.start, start + range.end);
  let cut: number | undefined;
  for (let index = lastIndexAtOrBefore(complete, start - 1) + 1; index < complete.length; index += 1) {
    const candidate = complete[index];
    if (candidate.start >= end) break;
    if (retained.get(candidate.start) !== candidate.end) {
      cut = candidate.start;
      break;
    }
  }
  for (let index = firstIndexAfter(boundaries, start); index < boundaries.length; index += 1) {
    const boundary = boundaries[index];
    if (boundary >= end || (cut !== undefined && boundary >= cut)) break;
    if (!retained.has(boundary)) return boundary;
  }
  return cut;
}

/**
 * Container openers that look like the start of a new log record: the opener
 * follows non-JSON text on its line (`ERROR {`), or starts a line after text
 * that cannot continue a JSON value. Pretty-printed JSON never matches because
 * its inner openers follow `:`, `,`, `[`, `{`, or start a line after one.
 */
function findRecordBoundaries(text: string, orderedSpans: ContainerSpan[]): number[] {
  const boundaries: number[] = [];
  let lineStart = 0;
  let scanned = 0;
  let lastStart = -1;
  const isWhitespace = (char: string): boolean => char === " " || char === "\t" || char === "\r" || char === "\n";
  const continuesJson = (char: string): boolean => char === ":" || char === "," || char === "[" || char === "{";
  for (const span of orderedSpans) {
    if (span.start === lastStart) continue;
    lastStart = span.start;
    for (; scanned < span.start; scanned += 1) {
      if (text[scanned] === "\n" || text[scanned] === "\r") lineStart = scanned + 1;
    }
    let index = span.start - 1;
    while (index >= lineStart && isWhitespace(text[index])) index -= 1;
    if (index >= lineStart) {
      if (!continuesJson(text[index])) boundaries.push(span.start);
      continue;
    }
    if (lineStart === 0) continue;
    index = lineStart - 1;
    while (index >= 0 && isWhitespace(text[index])) index -= 1;
    if (index >= 0 && !continuesJson(text[index])) boundaries.push(span.start);
  }
  return boundaries;
}

/** Index of the first sorted value greater than position. */
function firstIndexAfter(values: number[], position: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (values[mid] <= position) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Index of the last start-sorted candidate starting at or before position, or -1. */
function lastIndexAtOrBefore(candidates: JsonCandidate[], position: number): number {
  let low = 0;
  let high = candidates.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (candidates[mid].start <= position) low = mid + 1;
    else high = mid;
  }
  return low - 1;
}

function tryParsePartial(raw: string, maxValueNodes: number): {
  tree: JsonTreeNode;
  nodeCount: number;
  primitiveCount: number;
  length: number;
  recovery: JsonRecovery;
  containerRanges: TextRange[];
} | undefined {
  const errors: ParseError[] = [];
  if (assertJsonComplexityWithinLimits(raw, maxValueNodes) === undefined) return undefined;
  let root: JsoncNode | undefined;
  try {
    root = parseTree(raw, errors, { allowTrailingComma: true, disallowComments: false });
  } catch (error) {
    if (error instanceof RangeError) throw new JsonNestingTooDeepError();
    throw error;
  }
  if (!root || root.offset !== 0 || errors.length === 0 ||
      (root.type !== "object" && root.type !== "array")) return undefined;

  const tokenErrors = errors.filter((error) =>
    error.error === ParseErrorCode.InvalidSymbol ||
    error.error === ParseErrorCode.InvalidNumberFormat ||
    error.error >= ParseErrorCode.UnexpectedEndOfString,
  ).sort((left, right) => left.offset - right.offset);
  const hasTokenError = (start: number, end: number): boolean => {
    // Token errors have non-overlapping source ranges. Binary lookup avoids
    // a fields × errors walk on large damaged records.
    let low = 0;
    let high = tokenErrors.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (tokenErrors[mid].offset + tokenErrors[mid].length <= start) low = mid + 1;
      else high = mid;
    }
    return low < tokenErrors.length && tokenErrors[low].offset < end;
  };
  const isSafePrimitive = (node: JsoncNode): boolean => {
    if (hasTokenError(node.offset, node.offset + node.length)) return false;
    if (node.type === "number") {
      // The scanner splits invalid numbers such as 01 / 12abc / 1.2.3 into
      // several tokens. Require JSON token boundaries, not just ASCII suffix
      // checks, so Unicode and punctuation cannot leave a misleading prefix.
      const boundary = /[ \t\r\n,[\]{}:"]/;
      const start = node.offset;
      if (start > 0 && !boundary.test(raw[start - 1]) &&
          raw.slice(Math.max(0, start - 2), start) !== "*/") return false;
      const end = start + node.length;
      if (end < raw.length && !boundary.test(raw[end]) &&
          raw.slice(end, end + 2) !== "/*" && raw.slice(end, end + 2) !== "//") return false;
    }
    return true;
  };
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop() as JsoncNode;
    if (node.type === "object") {
      const kept = (node.children ?? []).filter((property) => {
        const key = property.children?.[0];
        const value = property.children?.[1];
        if (!key || !value || key.type !== "string") return false;
        // Includes the key and key→value gap: a broken token before a value
        // must not cause the parser to attach an unrelated later container.
        if (hasTokenError(key.offset, value.offset)) return false;
        if (value.type !== "object" && value.type !== "array" &&
            !isSafePrimitive(value)) return false;
        pending.push(value);
        return true;
      });
      if (node.children) {
        node.children.length = 0;
        for (const child of kept) node.children.push(child);
      }
    } else if (node.type === "array") {
      const kept = (node.children ?? []).filter((value) => {
        if (value.type !== "object" && value.type !== "array" &&
            !isSafePrimitive(value)) return false;
        pending.push(value);
        return true;
      });
      if (node.children) {
        node.children.length = 0;
        for (const child of kept) node.children.push(child);
      }
    }
  }
  const tree = buildJsonTree(root, raw);
  if (isEmptyContainer(tree)) return undefined;
  const containerRanges: TextRange[] = [];
  const retained = [root];
  let nodeCount = 0;
  let primitiveCount = 0;
  while (retained.length > 0) {
    const node = retained.pop() as JsoncNode;
    nodeCount += 1;
    if (node.type === "object" || node.type === "array") {
      containerRanges.push({ start: node.offset, end: node.offset + node.length });
      for (const child of node.children ?? []) {
        retained.push(node.type === "object" ? child.children![1] : child);
      }
    } else primitiveCount += 1;
  }
  // A chain of empty damaged wrappers has no confirmed data to recover.
  if (primitiveCount === 0 && nodeCount > 1 && errors.length > 1) return undefined;
  return {
    tree, nodeCount, primitiveCount, length: root.length, containerRanges,
    recovery: {
      errorCount: errors.length,
      issues: errors.slice(0, 20).map((error) => ({
        code: printParseErrorCode(error.error), offset: error.offset, length: error.length,
      })),
    },
  };
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

function assertCandidateNodeTotal(candidates: JsonCandidate[], maxValueNodes: number): void {
  let total = 0;
  for (const candidate of candidates) {
    total += candidate.nodeCount;
    if (total > maxValueNodes) {
      throw new JsonValueNodeLimitError(maxValueNodes);
    }
  }
}

function normalizeValueNodeLimit(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value >= 1
    ? Math.trunc(value)
    : MAX_JSON_VALUE_NODES;
}

function parseContainerSpans(
  text: string,
  spans: ContainerSpan[],
  bounds: { start: number; end: number },
  attemptedWholeDocument: boolean,
  maxValueNodes: number,
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
    const parsed = tryParse(raw, maxValueNodes);
    if (parsed.ok && !isEmptyContainer(parsed.tree)) {
      if (candidates.length >= MAX_JSON_CANDIDATES) {
        throw new JsonCandidateLimitError();
      }
      candidateNodeTotal += parsed.nodeCount;
      if (candidateNodeTotal > maxValueNodes) {
        throw new JsonValueNodeLimitError(maxValueNodes);
      }
      candidates.push({
        tree: parsed.tree,
        nodeCount: parsed.nodeCount,
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
    const parsed = tryParse(raw, maxValueNodes);
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
    if (candidateNodeTotal > maxValueNodes) {
      throw new JsonValueNodeLimitError(maxValueNodes);
    }
    candidates.push({ tree: parsed.tree, nodeCount: parsed.nodeCount, raw, start: span.start, end, unwrapDepth: 0 });
  }
  return candidates.sort((left, right) => left.start - right.start);
}

/**
 * Repeatedly JSON-decodes a string. This handles both already-unescaped JSON
 * strings and values that were encoded more than once.
 */
export function parseNestedJsonCandidates(text: string, options: JsonParseOptions = {}): JsonCandidate[] {
  let current = text;
  let lastStringCandidate: JsonCandidate | undefined;

  for (let depth = 0; depth <= MAX_UNWRAP_DEPTH; depth += 1) {
    const candidates = parseJsonCandidates(current, options).map((candidate) => ({
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
      // Unmatched openers in log text stay on the stack forever, so stack size
      // is not nesting depth. Real nesting is enforced when a span is parsed.
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
  maxValueNodes: number,
): { ok: true; tree: JsonTreeNode; nodeCount: number } | { ok: false } {
  const errors: ParseError[] = [];
  try {
    const nodeCount = assertJsonComplexityWithinLimits(raw, maxValueNodes);
    if (nodeCount === undefined) return { ok: false };
    const root = parseTree(raw, errors, {
      allowTrailingComma: true,
      disallowComments: false,
    });
    if (root === undefined || errors.length > 0) return { ok: false };
    const tree = buildJsonTree(root, raw);
    return { ok: true, tree, nodeCount };
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

/**
 * Counts JSONC structure without building an AST or recursing. Returns
 * undefined when the text nests past the limit but never closes back to depth
 * zero: unmatched log-text openers cannot form one complete value, so they are
 * merely invalid. A balanced over-deep value is rejected with an error instead.
 */
function assertJsonComplexityWithinLimits(raw: string, maxValueNodes: number): number | undefined {
  const scanner = createScanner(raw, true);
  const containers: Array<"object" | "array"> = [];
  const objectExpectsKey: boolean[] = [];
  let depth = 0;
  let valueNodes = 0;
  let exceededNesting = false;

  const countValueNode = (): void => {
    // Past the nesting limit only balance matters: the text is either rejected
    // as too deep or is not a complete value at all.
    if (exceededNesting) return;
    valueNodes += 1;
    if (valueNodes > maxValueNodes) {
      throw new JsonValueNodeLimitError(maxValueNodes);
    }
  };

  for (let token = scanner.scan(); token !== SyntaxKind.EOF; token = scanner.scan()) {
    if (token === SyntaxKind.OpenBraceToken || token === SyntaxKind.OpenBracketToken) {
      countValueNode();
      depth += 1;
      if (depth > MAX_JSON_NESTING) exceededNesting = true;
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

  if (exceededNesting) {
    if (depth === 0) throw new JsonNestingTooDeepError();
    return undefined;
  }
  return valueNodes;
}

function countPrimitives(root: JsonTreeNode): number {
  const pending = [root];
  let count = 0;
  while (pending.length > 0) {
    const node = pending.pop() as JsonTreeNode;
    if (node.children === undefined) count += 1;
    else for (const child of node.children) pending.push(child.value);
  }
  return count;
}

function isEmptyContainer(tree: JsonTreeNode): boolean {
  return (tree.type === "array" || tree.type === "object") && (tree.children?.length ?? 0) === 0;
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

import type { JsonTreeNode } from "./jsonTree";
import {
  JsonCandidate,
  JsonProcessingLimitError,
  assertInputSize,
  candidatePreview,
  parseJsonCandidates,
} from "./parser";

export type JsonlFilterTerm =
  | { kind: "text"; valueLower: string }
  | { kind: "field"; pathLower: string[]; valueLower: string };

export interface JsonlFilterSpec {
  raw: string;
  terms: JsonlFilterTerm[];
}

export interface JsonlLineMatch {
  lineNumber: number;
  preview: string;
  candidateCount: number;
}

export type JsonlSearchResult =
  | { status: "done"; matches: JsonlLineMatch[]; truncated: boolean; scannedLines: number }
  | { status: "cancelled"; matches: JsonlLineMatch[]; truncated: boolean; scannedLines: number };

export interface JsonlLineSource {
  readonly lineCount: number;
  lineAt(lineNumber: number): string;
}

export interface JsonlRecord {
  lineNumber: number;
  candidates: JsonCandidate[];
  skippedLines: number;
}

export type JsonlNavigationResult =
  | { status: "found"; record: JsonlRecord }
  | { status: "not-found"; scannedLines: number }
  | { status: "cancelled"; scannedLines: number };

export interface JsonlNavigationOptions {
  batchSize?: number;
  isCancelled?: () => boolean;
  parseLine?: (text: string) => JsonCandidate[];
  yieldToEventLoop?: () => Promise<void>;
  filter?: JsonlFilterSpec;
}

export interface JsonlSearchOptions extends JsonlNavigationOptions {
  startLine?: number;
  maxMatches?: number;
}

const DEFAULT_SCAN_BATCH_SIZE = 250;

/**
 * Finds one complete or partially recoverable JSONL record without joining or parsing the full document.
 * Empty, unrecoverable, and resource-limited lines are skipped. Work is yielded in
 * bounded batches so a long invalid region does not monopolize the Extension
 * Host event loop.
 */
export async function findJsonlRecord(
  source: JsonlLineSource,
  startLine: number,
  direction: -1 | 1,
  options: JsonlNavigationOptions = {},
): Promise<JsonlNavigationResult> {
  const batchSize = Number.isFinite(options.batchSize)
    ? Math.max(1, Math.trunc(options.batchSize as number))
    : DEFAULT_SCAN_BATCH_SIZE;
  const isCancelled = options.isCancelled ?? (() => false);
  const parseLine = options.parseLine ?? ((text: string) => {
    assertInputSize(text);
    return parseJsonCandidates(text);
  });
  const yieldToEventLoop = options.yieldToEventLoop ?? yieldToExtensionHost;
  const filter = options.filter;
  let scannedLines = 0;
  let lineNumber = startLine;

  while (lineNumber >= 0 && lineNumber < source.lineCount) {
    if (isCancelled()) return { status: "cancelled", scannedLines };

    const lineText = source.lineAt(lineNumber);
    let candidates: JsonCandidate[] = [];
    if (filter === undefined || lineMightMatchFilter(lineText, filter)) {
      try {
        candidates = parseLine(lineText);
        if (filter !== undefined && candidates.length > 0) {
          candidates = candidates.filter((candidate) => candidateMatchesFilter(candidate, filter));
        }
      } catch (error) {
        if (error instanceof JsonProcessingLimitError) candidates = [];
        else throw error;
      }
    }
    scannedLines += 1;
    if (candidates.length > 0) {
      return {
        status: "found",
        record: {
          lineNumber,
          candidates,
          skippedLines: scannedLines - 1,
        },
      };
    }

    lineNumber += direction;
    if (scannedLines % batchSize === 0) {
      await yieldToEventLoop();
    }
  }

  return { status: "not-found", scannedLines };
}

/**
 * Scans lines from startLine forward to collect matching JSONL records,
 * yielding in bounded batches so large files do not freeze the Extension Host.
 */
export async function searchJsonlLines(
  source: JsonlLineSource,
  options: JsonlSearchOptions = {},
): Promise<JsonlSearchResult> {
  const batchSize = Number.isFinite(options.batchSize)
    ? Math.max(1, Math.trunc(options.batchSize as number))
    : DEFAULT_SCAN_BATCH_SIZE;
  const maxMatches = Number.isFinite(options.maxMatches)
    ? Math.max(1, Math.trunc(options.maxMatches as number))
    : 200;
  const startLine = Number.isFinite(options.startLine)
    ? Math.max(0, Math.trunc(options.startLine as number))
    : 0;
  const isCancelled = options.isCancelled ?? (() => false);
  const parseLine = options.parseLine ?? ((text: string) => {
    assertInputSize(text);
    return parseJsonCandidates(text);
  });
  const yieldToEventLoop = options.yieldToEventLoop ?? yieldToExtensionHost;
  const filter = options.filter;

  const matches: JsonlLineMatch[] = [];
  let scannedLines = 0;
  let truncated = false;

  for (let lineNumber = startLine; lineNumber < source.lineCount; lineNumber += 1) {
    if (isCancelled()) return { status: "cancelled", matches, truncated, scannedLines };

    const lineText = source.lineAt(lineNumber);
    let candidates: JsonCandidate[] = [];
    if (filter === undefined || lineMightMatchFilter(lineText, filter)) {
      try {
        candidates = parseLine(lineText);
        if (filter !== undefined && candidates.length > 0) {
          candidates = candidates.filter((candidate) => candidateMatchesFilter(candidate, filter));
        }
      } catch (error) {
        if (error instanceof JsonProcessingLimitError) candidates = [];
        else throw error;
      }
    }
    scannedLines += 1;
    if (candidates.length > 0) {
      if (matches.length >= maxMatches) {
        truncated = true;
        break;
      }
      matches.push({
        lineNumber,
        preview: candidatePreview(candidates[0], 100),
        candidateCount: candidates.length,
      });
    }

    if (scannedLines % batchSize === 0) {
      await yieldToEventLoop();
    }
  }

  return { status: "done", matches, truncated, scannedLines };
}

/** Parses whitespace-separated filter terms supporting quotes and `key=value` / `a.b=value`. */
export function parseJsonlFilter(query: string): JsonlFilterSpec | undefined {
  const trimmed = query.trim();
  if (trimmed.length === 0) return undefined;

  const terms: JsonlFilterTerm[] = [];
  let index = 0;
  while (index < trimmed.length) {
    while (index < trimmed.length && /\s/.test(trimmed[index])) index += 1;
    if (index >= trimmed.length) break;

    const startsQuoted = trimmed[index] === '"' || trimmed[index] === "'";
    let rawToken = "";
    let eqIndex = -1;
    if (startsQuoted) {
      const quote = trimmed[index];
      index += 1;
      while (index < trimmed.length && trimmed[index] !== quote) {
        if (trimmed[index] === "\\" && index + 1 < trimmed.length) {
          index += 1;
        }
        rawToken += trimmed[index];
        index += 1;
      }
      if (index < trimmed.length && trimmed[index] === quote) index += 1;
    } else {
      let inQuote: string | undefined;
      while (index < trimmed.length) {
        const ch = trimmed[index];
        if (inQuote !== undefined) {
          if (ch === "\\" && index + 1 < trimmed.length) {
            index += 1;
            rawToken += trimmed[index];
            index += 1;
            continue;
          }
          if (ch === inQuote) {
            inQuote = undefined;
            index += 1;
            continue;
          }
          rawToken += ch;
          index += 1;
          continue;
        }
        if (/\s/.test(ch)) break;
        if (ch === '"' || ch === "'") {
          inQuote = ch;
          index += 1;
          continue;
        }
        if (ch === "=" && eqIndex < 0) eqIndex = rawToken.length;
        rawToken += ch;
        index += 1;
      }
    }

    if (rawToken.length === 0) continue;
    if (!startsQuoted && eqIndex > 0) {
      const keyPart = rawToken.slice(0, eqIndex);
      const valuePart = rawToken.slice(eqIndex + 1);
      const pathLower = keyPart
        .split(".")
        .map((segment) => segment.trim().toLowerCase())
        .filter((segment) => segment.length > 0);
      if (pathLower.length > 0) {
        terms.push({
          kind: "field",
          pathLower,
          valueLower: valuePart.toLowerCase(),
        });
        continue;
      }
    }
    terms.push({ kind: "text", valueLower: rawToken.toLowerCase() });
  }

  return terms.length > 0 ? { raw: trimmed, terms } : undefined;
}

const JSON_ESCAPE_SPLIT_RE = /["'\\\r\n\t\b\f/]+/;

interface CompiledNeedle {
  full: string;
  chunks: readonly string[];
}

const compiledNeedlesCache = new WeakMap<JsonlFilterSpec, readonly CompiledNeedle[]>();

function compileFilterNeedles(filter: JsonlFilterSpec): readonly CompiledNeedle[] {
  const cached = compiledNeedlesCache.get(filter);
  if (cached !== undefined) return cached;

  const needles: CompiledNeedle[] = [];
  const addNeedle = (valueLower: string): void => {
    if (valueLower.length === 0) return;
    const chunks = valueLower.split(JSON_ESCAPE_SPLIT_RE).filter((chunk) => chunk.length > 0);
    needles.push({ full: valueLower, chunks });
  };

  for (const term of filter.terms) {
    if (term.kind === "text") {
      addNeedle(term.valueLower);
    } else {
      for (const segment of term.pathLower) {
        addNeedle(segment);
      }
      if (term.valueLower.length > 0) {
        addNeedle(term.valueLower);
      }
    }
  }

  compiledNeedlesCache.set(filter, needles);
  return needles;
}

function isBlankLine(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) > 0x20) return false;
  }
  return true;
}

function lowerLineMatchesNeedle(lower: string, hasBackslash: boolean, needle: CompiledNeedle): boolean {
  if (lower.includes(needle.full)) return true;
  if (!hasBackslash) return false;
  let searchFrom = 0;
  for (const chunk of needle.chunks) {
    const found = lower.indexOf(chunk, searchFrom);
    if (found < 0) return false;
    searchFrom = found + chunk.length;
  }
  return true;
}

/**
 * Cheap pre-check before JSON parsing. Lines containing `\u` / `\U` unicode
 * escapes keep bypassing the pre-check, while common escapes (`\"`, `\n`, `\/`,
 * `\\`, `\t`) are handled with 100% recall by matching literal sub-chunks split
 * on JSON escape characters.
 */
export function lineMightMatchFilter(lineText: string, filter: JsonlFilterSpec): boolean {
  if (isBlankLine(lineText)) return false;
  const backslashIndex = lineText.indexOf("\\");
  if (backslashIndex >= 0 && (lineText.includes("\\u", backslashIndex) || lineText.includes("\\U", backslashIndex))) {
    return true;
  }
  const hasBackslash = backslashIndex >= 0;
  const lower = lineText.toLowerCase();
  const needles = compileFilterNeedles(filter);
  for (const needle of needles) {
    if (!lowerLineMatchesNeedle(lower, hasBackslash, needle)) return false;
  }
  return true;
}

export function candidateMatchesFilter(candidate: JsonCandidate, filter: JsonlFilterSpec): boolean {
  for (const term of filter.terms) {
    if (!treeMatchesTerm(candidate.tree, term)) return false;
  }
  return true;
}

function treeMatchesTerm(root: JsonTreeNode, term: JsonlFilterTerm): boolean {
  interface Frame {
    node: JsonTreeNode;
    keyLower?: string;
    pathDepth: number;
  }
  const keyStack: string[] = [];
  const stack: Frame[] = [{ node: root, pathDepth: 0 }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    keyStack.length = frame.pathDepth;
    if (frame.keyLower !== undefined) {
      keyStack.push(frame.keyLower);
    }

    if (term.kind === "text") {
      if (frame.keyLower !== undefined && frame.keyLower.includes(term.valueLower)) return true;
      if (nodePrimitiveMatches(frame.node, term.valueLower, false)) return true;
    } else if (
      frame.keyLower !== undefined &&
      pathEndsWith(keyStack, term.pathLower) &&
      (term.valueLower.length === 0 || nodePrimitiveMatches(frame.node, term.valueLower, true))
    ) {
      return true;
    }

    if (frame.node.decoded !== undefined) {
      stack.push({ node: frame.node.decoded.root, pathDepth: keyStack.length });
    }
    const children = frame.node.children ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      stack.push({
        node: child.value,
        keyLower: typeof child.key === "string" ? child.key.toLowerCase() : undefined,
        pathDepth: keyStack.length,
      });
    }
  }
  return false;
}

function pathEndsWith(actual: readonly string[], suffix: readonly string[]): boolean {
  if (actual.length < suffix.length) return false;
  const offset = actual.length - suffix.length;
  for (let index = 0; index < suffix.length; index += 1) {
    if (actual[offset + index] !== suffix[index]) return false;
  }
  return true;
}

function nodePrimitiveMatches(node: JsonTreeNode, needleLower: string, exactNonString: boolean): boolean {
  if (node.type === "object" || node.type === "array") return false;
  if (node.type === "string") {
    const valLower = (node.value as string).toLowerCase();
    return valLower.includes(needleLower) || (node.raw !== undefined && node.raw.toLowerCase().includes(needleLower));
  }
  const token = (node.raw ?? String(node.value)).toLowerCase();
  return exactNonString ? token === needleLower : token.includes(needleLower);
}

function yieldToExtensionHost(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

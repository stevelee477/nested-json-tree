import type { JsonTreeNode } from "./jsonTree";

export type JsonTreeSearchScope = "all" | "keys" | "values";

export interface JsonTreeSearchOptions {
  caseSensitive?: boolean;
  regex?: boolean;
  scope?: JsonTreeSearchScope;
}

interface LeafCandidate {
  nodeId: number;
  visitOrder: number;
  frame: JsonTreeSearchFrame;
}

interface TermGroup {
  byTerm: Map<number, LeafCandidate[]>;
  failedTerms: Set<number>;
}

interface JsonTreeSearchFrame {
  node: JsonTreeNode;
  key: string | number | undefined;
  rawKey: string | undefined;
  parent: JsonTreeSearchFrame | undefined;
  entered: boolean;
  nextChildIndex: number;
  visitOrder: number;
  ownGroup?: TermGroup;
  arrayGroups?: TermGroup[];
}

export interface JsonTreeSearchState {
  matches: number[];
  expandIds: Set<number>;
  truncated: boolean;
  done: boolean;
  needle: string;
  maxMatches: number;
  stack: JsonTreeSearchFrame[];
  invalidRegex?: string;
}

type ComparisonOperator = "=" | "!=" | ">" | ">=" | "<" | "<=";

type StructuredTerm =
  | {
      kind: "comparison";
      rawField: string;
      pathSegments: string[];
      operator: ComparisonOperator;
      value: string;
      quoted: boolean;
      numericValue: ParsedDecimal | undefined;
    }
  | {
      kind: "text";
      value: string;
    };

interface SearchPlan {
  caseSensitive: boolean;
  scope: JsonTreeSearchScope;
  regex?: RegExp;
  regexMaxChars: number;
  structuredTerms?: StructuredTerm[];
  emittedIds: Set<number>;
  nextVisitOrder: number;
}

interface ParsedDecimal {
  /** -1 for negative, 0 for zero, 1 for positive. */
  sign: -1 | 0 | 1;
  /** Significant digits with leading and trailing zeros stripped (empty when zero). */
  digits: string;
  /** Order of magnitude: digits.length + power-of-10 scale. */
  magnitude: number;
}

const MAX_REGEX_TARGET_CHARS = 32_768;
const MAX_NESTED_QUANTIFIER_TARGET_CHARS = 16;
const NESTED_QUANTIFIER_RE = /(?:\+|\*|\{\d+,?\d*\})\??\s*\)\s*(?:\+|\*|\?|\{\d+)/;
const MAX_ARRAY_CANDIDATE_GROUPS = 2_000;
const PURE_INTEGER_RE = /^[+-]?\d+$/;
const DECIMAL_NUMBER_RE = /^([+-])?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/;

const searchPlans = new WeakMap<JsonTreeSearchState, SearchPlan>();

/** Uses fast ASCII lowercasing when possible and preserves locale folding for Unicode. */
function foldCase(text: string): string {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) > 0x7f) return text.toLocaleLowerCase();
  }
  return text.toLowerCase();
}

function normalizeCase(text: string, caseSensitive: boolean): string {
  return caseSensitive ? text : foldCase(text);
}

/** Creates an incremental, lossless-tree search suitable for the Webview event loop. */
export function createJsonTreeSearchState(
  root: JsonTreeNode,
  query: string,
  maxMatches = 5_000,
  options: JsonTreeSearchOptions = {},
): JsonTreeSearchState {
  const trimmed = query.trim();
  const caseSensitive = options.caseSensitive === true;
  const scope: JsonTreeSearchScope = options.scope ?? "all";
  const needle = normalizeCase(trimmed, caseSensitive);

  let compiledRegex: RegExp | undefined;
  let invalidRegex: string | undefined;
  if (options.regex === true && trimmed.length > 0) {
    try {
      compiledRegex = new RegExp(trimmed, caseSensitive ? "" : "i");
    } catch (error) {
      invalidRegex = error instanceof Error ? error.message : String(error);
    }
  }

  const done = trimmed.length === 0 || maxMatches <= 0 || invalidRegex !== undefined;
  const structuredTerms =
    !done && options.regex !== true && scope === "all"
      ? parseStructuredQuery(trimmed, caseSensitive)
      : undefined;

  const state: JsonTreeSearchState = {
    matches: [],
    expandIds: new Set<number>(),
    truncated: false,
    done,
    needle,
    maxMatches,
    ...(invalidRegex !== undefined ? { invalidRegex } : {}),
    stack: done
      ? []
      : [
          {
            node: root,
            key: undefined,
            rawKey: undefined,
            parent: undefined,
            entered: false,
            nextChildIndex: 0,
            visitOrder: 0,
          },
        ],
  };

  searchPlans.set(state, {
    caseSensitive,
    scope,
    regex: compiledRegex,
    regexMaxChars:
      compiledRegex !== undefined && NESTED_QUANTIFIER_RE.test(trimmed)
        ? MAX_NESTED_QUANTIFIER_TARGET_CHARS
        : MAX_REGEX_TARGET_CHARS,
    structuredTerms,
    emittedIds: new Set<number>(),
    nextVisitOrder: 0,
  });

  return state;
}

/** Advances lossless-tree search by at most maxVisitedNodes nodes. */
export function advanceJsonTreeSearch(
  state: JsonTreeSearchState,
  maxVisitedNodes = 2_000,
): boolean {
  if (state.done || maxVisitedNodes <= 0) return state.done;

  const plan: SearchPlan = searchPlans.get(state) ?? {
    caseSensitive: false,
    scope: "all",
    regexMaxChars: MAX_REGEX_TARGET_CHARS,
    emittedIds: new Set<number>(state.matches),
    nextVisitOrder: 0,
  };
  const terms = plan.structuredTerms;
  const isMultiTerm = terms !== undefined && terms.length > 1;

  let visitedNodes = 0;
  while (state.stack.length > 0 && visitedNodes < maxVisitedNodes) {
    const frame = state.stack[state.stack.length - 1];
    if (!frame.entered) {
      frame.entered = true;
      frame.visitOrder = plan.nextVisitOrder;
      plan.nextVisitOrder += 1;
      visitedNodes += 1;

      if (isMultiTerm && frame.node.type !== "array") {
        frame.ownGroup = createEmptyGroup();
      }

      let directMatch = matchesNodeDirect(frame, state.needle, plan);
      if (!directMatch && terms !== undefined && terms.length === 1) {
        directMatch = evaluateTermOnFrame(frame, terms[0], plan.caseSensitive) === "matched";
      }

      if (directMatch) {
        if (!emitMatch(state, plan, frame)) break;
      } else if (isMultiTerm) {
        const matchedIndices: number[] = [];
        const failedIndices: number[] = [];
        for (let termIndex = 0; termIndex < terms.length; termIndex += 1) {
          const outcome = evaluateTermOnFrame(frame, terms[termIndex], plan.caseSensitive);
          if (outcome === "matched") matchedIndices.push(termIndex);
          else if (outcome === "failed") failedIndices.push(termIndex);
        }

        if (matchedIndices.length === terms.length) {
          if (!emitMatch(state, plan, frame)) break;
        } else if (matchedIndices.length > 0 || failedIndices.length > 0) {
          const targetGroup = ensureFrameGroup(frame);
          const candidate: LeafCandidate = {
            nodeId: frame.node.id,
            visitOrder: frame.visitOrder,
            frame,
          };
          for (const termIndex of matchedIndices) {
            addCandidateToGroup(targetGroup, termIndex, candidate);
          }
          for (const termIndex of failedIndices) {
            targetGroup.failedTerms.add(termIndex);
          }
        }
      }
      continue;
    }

    const children = frame.node.children ?? [];
    if (frame.nextChildIndex < children.length) {
      const child = children[frame.nextChildIndex];
      frame.nextChildIndex += 1;
      state.stack.push({
        node: child.value,
        key: child.key,
        rawKey: child.rawKey,
        parent: frame,
        entered: false,
        nextChildIndex: 0,
        visitOrder: 0,
      });
      continue;
    }
    // JSON decoded from a string is searched as that string's only child.
    if (frame.nextChildIndex === children.length && frame.node.decoded !== undefined) {
      frame.nextChildIndex += 1;
      state.stack.push({
        node: frame.node.decoded.root,
        key: undefined,
        rawKey: undefined,
        parent: frame,
        entered: false,
        nextChildIndex: 0,
        visitOrder: 0,
      });
      continue;
    }

    state.stack.pop();
    if (isMultiTerm && !finalizeMultiTermFrame(state, plan, frame, terms.length)) {
      break;
    }
  }

  if (state.stack.length === 0) state.done = true;
  return state.done;
}

export function jsonTreePrimitiveSearchText(node: JsonTreeNode): string {
  if (node.type === "object" || node.type === "array") return "";
  if (node.type === "string") return `${node.value as string}\n${node.raw ?? ""}`;
  return node.raw ?? String(node.value);
}

function createEmptyGroup(): TermGroup {
  return { byTerm: new Map<number, LeafCandidate[]>(), failedTerms: new Set<number>() };
}

function ensureFrameGroup(frame: JsonTreeSearchFrame): TermGroup {
  if (frame.ownGroup === undefined) {
    frame.ownGroup = createEmptyGroup();
  }
  return frame.ownGroup;
}

function addCandidateToGroup(group: TermGroup, termIndex: number, candidate: LeafCandidate): void {
  const existing = group.byTerm.get(termIndex);
  if (existing !== undefined) {
    existing.push(candidate);
  } else {
    group.byTerm.set(termIndex, [candidate]);
  }
}

function mergeGroupInto(target: TermGroup, source: TermGroup): void {
  for (const [termIndex, candidates] of source.byTerm) {
    const existing = target.byTerm.get(termIndex);
    if (existing !== undefined) {
      for (const item of candidates) existing.push(item);
    } else {
      target.byTerm.set(termIndex, [...candidates]);
    }
  }
}

function hasExplicitContradiction(group: TermGroup): boolean {
  for (const failedIndex of group.failedTerms) {
    if (!group.byTerm.has(failedIndex)) return true;
  }
  return false;
}

function finalizeMultiTermFrame(
  state: JsonTreeSearchState,
  plan: SearchPlan,
  frame: JsonTreeSearchFrame,
  termCount: number,
): boolean {
  const parent = frame.parent;

  if (frame.node.type === "array") {
    if (parent !== undefined && frame.arrayGroups !== undefined && frame.arrayGroups.length > 0) {
      if (parent.node.type === "array") {
        parent.arrayGroups ??= [];
        for (const group of frame.arrayGroups) {
          if (parent.arrayGroups.length >= MAX_ARRAY_CANDIDATE_GROUPS) break;
          parent.arrayGroups.push(group);
        }
      } else {
        parent.arrayGroups ??= [];
        for (const group of frame.arrayGroups) {
          if (parent.arrayGroups.length >= MAX_ARRAY_CANDIDATE_GROUPS) break;
          parent.arrayGroups.push(group);
        }
      }
    }
    return true;
  }

  const own = frame.ownGroup;
  const childArrayGroups = frame.arrayGroups;

  if (own !== undefined && own.byTerm.size === termCount) {
    if (!emitGroupMatches(state, plan, own)) return false;
    own.byTerm.clear();
    own.failedTerms.clear();
  }

  if (childArrayGroups !== undefined && childArrayGroups.length > 0) {
    const remaining: TermGroup[] = [];
    for (const elemGroup of childArrayGroups) {
      if (own !== undefined && own.byTerm.size > 0) {
        const combined = createEmptyGroup();
        mergeGroupInto(combined, own);
        mergeGroupInto(combined, elemGroup);
        if (combined.byTerm.size === termCount) {
          if (!emitGroupMatches(state, plan, combined)) return false;
          continue;
        }
        if (parent !== undefined && !hasExplicitContradiction(combined) && remaining.length < MAX_ARRAY_CANDIDATE_GROUPS) {
          remaining.push(combined);
        }
      } else if (parent !== undefined && remaining.length < MAX_ARRAY_CANDIDATE_GROUPS) {
        remaining.push(elemGroup);
      }
    }
    if (parent !== undefined && remaining.length > 0) {
      parent.arrayGroups ??= [];
      for (const group of remaining) {
        if (parent.arrayGroups.length >= MAX_ARRAY_CANDIDATE_GROUPS) break;
        parent.arrayGroups.push(group);
      }
    }
  }

  if (own === undefined || own.byTerm.size === 0 || parent === undefined) {
    return true;
  }

  // Record objects that explicitly failed another queried field do not leak partial matches to sibling records.
  if (frame.node.type === "object" && hasExplicitContradiction(own)) {
    return true;
  }

  if (parent.node.type === "array") {
    if (frame.node.type === "object") {
      parent.arrayGroups ??= [];
      if (parent.arrayGroups.length < MAX_ARRAY_CANDIDATE_GROUPS) {
        parent.arrayGroups.push(own);
      }
    } else if (parent.parent !== undefined) {
      // Primitive element inside an array (e.g. tags: ["auth", "critical"]) belongs to the enclosing object.
      mergeGroupInto(ensureFrameGroup(parent.parent), own);
    }
  } else {
    mergeGroupInto(ensureFrameGroup(parent), own);
  }
  return true;
}

function emitGroupMatches(
  state: JsonTreeSearchState,
  plan: SearchPlan,
  group: TermGroup,
): boolean {
  const ordered: LeafCandidate[] = [];
  const seen = new Set<number>();
  for (const candidates of group.byTerm.values()) {
    for (const candidate of candidates) {
      if (seen.has(candidate.nodeId)) continue;
      seen.add(candidate.nodeId);
      ordered.push(candidate);
    }
  }
  ordered.sort((left, right) => left.visitOrder - right.visitOrder);
  for (const candidate of ordered) {
    if (!emitMatch(state, plan, candidate.frame)) return false;
  }
  return true;
}

function emitMatch(
  state: JsonTreeSearchState,
  plan: SearchPlan,
  frame: JsonTreeSearchFrame,
): boolean {
  if (plan.emittedIds.has(frame.node.id)) return true;
  if (state.matches.length >= state.maxMatches) {
    state.truncated = true;
    state.done = true;
    state.stack.length = 0;
    return false;
  }
  plan.emittedIds.add(frame.node.id);
  state.matches.push(frame.node.id);
  let ancestor = frame.parent;
  while (ancestor !== undefined) {
    if (state.expandIds.has(ancestor.node.id)) break;
    state.expandIds.add(ancestor.node.id);
    ancestor = ancestor.parent;
  }
  return true;
}

function matchesNodeDirect(
  frame: JsonTreeSearchFrame,
  needle: string,
  plan: SearchPlan,
): boolean {
  if (plan.regex !== undefined) {
    return matchesNodeRegex(frame, plan.regex, plan.scope, plan.regexMaxChars);
  }
  return matchesNodeSubstring(frame, needle, plan.caseSensitive, plan.scope);
}

function testRegexSafe(regex: RegExp, text: string, maxChars: number): boolean {
  const bounded = text.length > maxChars ? text.slice(0, maxChars) : text;
  regex.lastIndex = 0;
  return regex.test(bounded);
}

function matchesNodeRegex(
  frame: JsonTreeSearchFrame,
  regex: RegExp,
  scope: JsonTreeSearchScope,
  maxChars: number,
): boolean {
  if (scope !== "values" && frame.key !== undefined) {
    const keyString = String(frame.key);
    if (testRegexSafe(regex, keyString, maxChars)) return true;
    if (frame.rawKey !== undefined && testRegexSafe(regex, frame.rawKey, maxChars)) return true;
  }
  if (scope !== "keys" && frame.node.type !== "object" && frame.node.type !== "array") {
    if (frame.node.type === "string") {
      if (testRegexSafe(regex, frame.node.value as string, maxChars)) return true;
      if (frame.node.raw !== undefined && testRegexSafe(regex, frame.node.raw, maxChars)) return true;
      return false;
    }
    return testRegexSafe(regex, frame.node.raw ?? String(frame.node.value), maxChars);
  }
  return false;
}

function containsNormalized(haystack: string, needle: string, caseSensitive: boolean): boolean {
  return (caseSensitive ? haystack : foldCase(haystack)).includes(needle);
}

function matchesNodeSubstring(
  frame: JsonTreeSearchFrame,
  needle: string,
  caseSensitive: boolean,
  scope: JsonTreeSearchScope,
): boolean {
  if (scope !== "values" && frame.key !== undefined) {
    const keyString = String(frame.key);
    if (containsNormalized(keyString, needle, caseSensitive)) return true;
    if (frame.rawKey !== undefined && containsNormalized(frame.rawKey, needle, caseSensitive)) {
      return true;
    }
  }
  if (scope !== "keys" && frame.node.type !== "object" && frame.node.type !== "array") {
    if (frame.node.type === "string") {
      if (containsNormalized(frame.node.value as string, needle, caseSensitive)) return true;
      if (
        frame.node.raw !== undefined &&
        containsNormalized(frame.node.raw, needle, caseSensitive)
      ) {
        return true;
      }
      return false;
    }
    const token = frame.node.raw ?? String(frame.node.value);
    return containsNormalized(token, needle, caseSensitive);
  }
  return false;
}

/**
 * Parses space-separated structured comparison queries (e.g. `status>=400`,
 * `level=error latency>100`, `user.name="Ada Lovelace"`). Returns `undefined`
 * when the query contains no structured comparison operators.
 */
function parseStructuredQuery(
  trimmed: string,
  caseSensitive: boolean,
): StructuredTerm[] | undefined {
  const terms: StructuredTerm[] = [];
  let hasComparison = false;
  let index = 0;

  while (index < trimmed.length) {
    while (index < trimmed.length && /\s/.test(trimmed[index])) index += 1;
    if (index >= trimmed.length) break;

    const startsQuoted = trimmed[index] === '"' || trimmed[index] === "'";
    if (startsQuoted) {
      const quote = trimmed[index];
      index += 1;
      let literal = "";
      while (index < trimmed.length && trimmed[index] !== quote) {
        if (trimmed[index] === "\\" && index + 1 < trimmed.length) {
          index += 1;
        }
        literal += trimmed[index];
        index += 1;
      }
      if (index < trimmed.length && trimmed[index] === quote) index += 1;
      if (literal.length > 0) {
        terms.push({ kind: "text", value: normalizeCase(literal, caseSensitive) });
      }
      continue;
    }

    let inQuote: string | undefined;
    let lhs = "";
    let rhs = "";
    let operator: ComparisonOperator | undefined;
    let rhsQuoted = false;
    let rawToken = "";

    while (index < trimmed.length) {
      const ch = trimmed[index];
      if (inQuote !== undefined) {
        if (ch === "\\" && index + 1 < trimmed.length) {
          index += 1;
          const escaped = trimmed[index];
          rawToken += escaped;
          if (operator === undefined) lhs += escaped;
          else rhs += escaped;
          index += 1;
          continue;
        }
        if (ch === inQuote) {
          inQuote = undefined;
          index += 1;
          continue;
        }
        rawToken += ch;
        if (operator === undefined) lhs += ch;
        else rhs += ch;
        index += 1;
        continue;
      }

      if (/\s/.test(ch)) break;

      if (ch === '"' || ch === "'") {
        inQuote = ch;
        if (operator !== undefined && rhs.length === 0) rhsQuoted = true;
        index += 1;
        continue;
      }

      if (operator === undefined) {
        const detected = matchOperatorAt(trimmed, index);
        if (detected !== undefined) {
          operator = detected;
          rawToken += detected;
          index += detected.length;
          continue;
        }
        lhs += ch;
        rawToken += ch;
        index += 1;
      } else {
        rhs += ch;
        rawToken += ch;
        index += 1;
      }
    }

    if (
      operator !== undefined &&
      lhs.length > 0 &&
      !lhs.startsWith(".") &&
      !lhs.endsWith(".") &&
      (rhs.length > 0 || rhsQuoted)
    ) {
      const segments = lhs
        .split(".")
        .map((seg) => seg.trim())
        .filter((seg) => seg.length > 0);
      if (segments.length > 0 && segments.length === lhs.split(".").length) {
        hasComparison = true;
        terms.push({
          kind: "comparison",
          rawField: normalizeCase(lhs, caseSensitive),
          pathSegments: segments.map((seg) => normalizeCase(seg, caseSensitive)),
          operator,
          value: rhs,
          quoted: rhsQuoted,
          numericValue: rhsQuoted ? undefined : parseExactDecimal(rhs.trim()),
        });
        continue;
      }
    }

    if (rawToken.length > 0) {
      terms.push({ kind: "text", value: normalizeCase(rawToken, caseSensitive) });
    }
  }

  return hasComparison && terms.length > 0 ? terms : undefined;
}

function matchOperatorAt(text: string, index: number): ComparisonOperator | undefined {
  const two = text.slice(index, index + 2);
  if (two === ">=" || two === "<=" || two === "!=") return two;
  const one = text[index];
  if (one === "=" || one === ">" || one === "<") return one;
  return undefined;
}

function evaluateTermOnFrame(
  frame: JsonTreeSearchFrame,
  term: StructuredTerm,
  caseSensitive: boolean,
): "matched" | "failed" | "unrelated" {
  if (term.kind === "text") {
    return matchesNodeSubstring(frame, term.value, caseSensitive, "all") ? "matched" : "unrelated";
  }
  if (frame.node.type === "object" || frame.node.type === "array") {
    return "unrelated";
  }
  if (!frameMatchesFieldPath(frame, term.rawField, term.pathSegments, caseSensitive)) {
    return "unrelated";
  }
  return primitiveSatisfiesComparison(frame.node, term, caseSensitive) ? "matched" : "failed";
}

function frameMatchesFieldPath(
  frame: JsonTreeSearchFrame,
  rawField: string,
  pathSegments: readonly string[],
  caseSensitive: boolean,
): boolean {
  if (
    typeof frame.key === "string" &&
    normalizeCase(frame.key, caseSensitive) === rawField
  ) {
    return true;
  }
  if (matchesAncestorKeySuffix(frame, pathSegments, caseSensitive, true)) {
    return true;
  }
  return matchesAncestorKeySuffix(frame, pathSegments, caseSensitive, false);
}

function matchesAncestorKeySuffix(
  frame: JsonTreeSearchFrame,
  suffix: readonly string[],
  caseSensitive: boolean,
  skipNumericIndices: boolean,
): boolean {
  let cursor: JsonTreeSearchFrame | undefined = frame;
  let segIndex = suffix.length - 1;
  let matchedCurrentFrame = false;

  while (cursor !== undefined && segIndex >= 0) {
    if (cursor.key === undefined) {
      cursor = cursor.parent;
      continue;
    }
    if (typeof cursor.key === "number" && skipNumericIndices) {
      cursor = cursor.parent;
      continue;
    }
    const normalized = normalizeCase(String(cursor.key), caseSensitive);
    if (normalized !== suffix[segIndex]) {
      return false;
    }
    matchedCurrentFrame = true;
    segIndex -= 1;
    cursor = cursor.parent;
  }

  return matchedCurrentFrame && segIndex < 0;
}

function primitiveSatisfiesComparison(
  node: JsonTreeNode,
  term: Extract<StructuredTerm, { kind: "comparison" }>,
  caseSensitive: boolean,
): boolean {
  const { operator, value, quoted, numericValue } = term;

  if (operator === "=" || operator === "!=") {
    const equal = primitiveEqualsValue(node, value, quoted, numericValue, caseSensitive);
    return operator === "=" ? equal : !equal;
  }

  const cmp = comparePrimitiveWithTarget(node, value, quoted, numericValue, caseSensitive);
  if (cmp === undefined) return false;
  switch (operator) {
    case ">":
      return cmp > 0;
    case ">=":
      return cmp >= 0;
    case "<":
      return cmp < 0;
    case "<=":
      return cmp <= 0;
  }
}

function primitiveEqualsValue(
  node: JsonTreeNode,
  target: string,
  quoted: boolean,
  targetNumeric: ParsedDecimal | undefined,
  caseSensitive: boolean,
): boolean {
  if (node.type === "string") {
    const actual = node.value as string;
    return normalizeCase(actual, caseSensitive) === normalizeCase(target, caseSensitive);
  }
  if (quoted) {
    return false;
  }
  const raw = node.raw ?? String(node.value);
  if (node.type === "number") {
    if (targetNumeric === undefined) return false;
    return compareNumberTokens(raw, target.trim(), targetNumeric) === 0;
  }
  return normalizeCase(raw, caseSensitive) === normalizeCase(target, caseSensitive);
}

function comparePrimitiveWithTarget(
  node: JsonTreeNode,
  target: string,
  quoted: boolean,
  targetNumeric: ParsedDecimal | undefined,
  caseSensitive: boolean,
): number | undefined {
  if (node.type === "number") {
    if (targetNumeric === undefined) return undefined;
    const raw = node.raw ?? String(node.value);
    return compareNumberTokens(raw, target.trim(), targetNumeric);
  }
  if (node.type === "string") {
    const actual = node.value as string;
    if (!quoted && targetNumeric !== undefined) {
      return compareNumberTokens(actual.trim(), target.trim(), targetNumeric);
    }
    const left = normalizeCase(actual, caseSensitive);
    const right = normalizeCase(target, caseSensitive);
    return left < right ? -1 : left > right ? 1 : 0;
  }
  return undefined;
}

/**
 * Compares two decimal/integer tokens losslessly using BigInt for integers and
 * exact normalized scientific digits for fractional/exponent numbers.
 */
function compareNumberTokens(
  leftRaw: string,
  rightRaw: string,
  rightParsed?: ParsedDecimal,
): number | undefined {
  if (PURE_INTEGER_RE.test(leftRaw) && PURE_INTEGER_RE.test(rightRaw)) {
    const leftBig = BigInt(leftRaw);
    const rightBig = BigInt(rightRaw);
    return leftBig < rightBig ? -1 : leftBig > rightBig ? 1 : 0;
  }
  const leftDec = parseExactDecimal(leftRaw);
  const rightDec = rightParsed ?? parseExactDecimal(rightRaw);
  if (leftDec === undefined || rightDec === undefined) return undefined;
  return compareParsedDecimals(leftDec, rightDec);
}

function parseExactDecimal(text: string): ParsedDecimal | undefined {
  const match = DECIMAL_NUMBER_RE.exec(text);
  if (!match) return undefined;
  const negative = match[1] === "-";
  const intPart = match[2] ?? "";
  const fracPart = match[3] ?? match[4] ?? "";
  const expPart = match[5] !== undefined ? Number(match[5]) : 0;
  if (!Number.isSafeInteger(expPart)) return undefined;

  const combined = (intPart + fracPart).replace(/^0+/, "");
  if (combined.length === 0) {
    return { sign: 0, digits: "", magnitude: 0 };
  }

  let trimEnd = combined.length;
  while (trimEnd > 0 && combined.charCodeAt(trimEnd - 1) === 0x30) {
    trimEnd -= 1;
  }
  const digits = combined.slice(0, trimEnd);
  const trailingZeros = combined.length - trimEnd;
  const scale = expPart - fracPart.length + trailingZeros;
  const magnitude = digits.length + scale;
  return {
    sign: negative ? -1 : 1,
    digits,
    magnitude,
  };
}

function compareParsedDecimals(left: ParsedDecimal, right: ParsedDecimal): number {
  if (left.sign !== right.sign) {
    return left.sign < right.sign ? -1 : 1;
  }
  if (left.sign === 0) return 0;

  let absCmp = 0;
  if (left.magnitude !== right.magnitude) {
    absCmp = left.magnitude < right.magnitude ? -1 : 1;
  } else {
    const maxLen = Math.max(left.digits.length, right.digits.length);
    for (let index = 0; index < maxLen; index += 1) {
      const lc = index < left.digits.length ? left.digits.charCodeAt(index) : 0x30;
      const rc = index < right.digits.length ? right.digits.charCodeAt(index) : 0x30;
      if (lc !== rc) {
        absCmp = lc < rc ? -1 : 1;
        break;
      }
    }
  }
  return left.sign < 0 ? -absCmp : absCmp;
}

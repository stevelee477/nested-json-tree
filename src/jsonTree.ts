import type { Node as JsoncNode } from "jsonc-parser";
import type { JsonRecovery, JsonValue } from "./parser";

export type JsonTreeNodeType = "object" | "array" | "string" | "number" | "boolean" | "null";

export const MAX_PRETTY_OUTPUT_CHARACTERS = 16 * 1024 * 1024;
export const MAX_TRANSFER_OUTPUT_CHARACTERS = 50 * 1024 * 1024;
/** Maximum characters copied into one Webview model field. */
export const MAX_WEBVIEW_FIELD_CHARACTERS = 10_000;

export class JsonTreeOutputTooLargeError extends Error {
  constructor(public readonly maxCharacters = MAX_TRANSFER_OUTPUT_CHARACTERS) {
    super(
      `Output exceeds the safe limit of ${formatCharacterLimit(maxCharacters)}. ` +
        "Use a smaller value or path.",
    );
    this.name = "JsonTreeOutputTooLargeError";
  }
}

export interface SafeJsonTreeString {
  text: string;
  compacted: boolean;
}

export interface JsonTreeChild {
  /** Decoded object key or zero-based array index. */
  key: string | number;
  /** Exact object-key token, including quotes and original escapes. */
  rawKey?: string;
  /** Source offset of the object-key token, relative to the parsed text. */
  keyOffset?: number;
  value: JsonTreeNode;
}

/**
 * A serializable, lossless view of the JSONC syntax tree.
 *
 * Numbers and strings keep their exact source token. Objects use an ordered
 * child list instead of a JavaScript object so duplicate keys remain visible.
 */
export interface JsonTreeNode {
  id: number;
  type: JsonTreeNodeType;
  /** Exact primitive token, including quotes for strings. */
  raw?: string;
  /** Decoded value for strings and booleans; null for a null literal. */
  value?: string | boolean | null;
  children?: JsonTreeChild[];
  /** Source range relative to the parsed text; absent inside decoded string content. */
  offset?: number;
  length?: number;
  /** JSON parsed from this string node's value, attached on demand. */
  decoded?: JsonTreeDecoded;
}

/** JSON embedded in a string value. Never part of copy/serialize output. */
export interface JsonTreeDecoded {
  root: JsonTreeNode;
  /** Extra string-decoding passes beyond the first (double-encoded JSON). */
  unwrapDepth: number;
  recovery?: JsonRecovery;
  /** The JSON was extracted from surrounding text, so `fromjson` cannot reproduce it. */
  embedded?: true;
}

/** Host-owned node/edge context. Webview messages identify only the node ID. */
export interface JsonTreeNodeContext {
  node: JsonTreeNode;
  parent?: JsonTreeNodeContext;
  key?: string | number;
  rawKey?: string;
  /** Set on the root of JSON decoded from the parent string node. */
  decodedFrom?: JsonTreeDecoded;
  /** True when any object-key segment on this path has duplicate siblings. */
  hasDuplicateKeyInPath: boolean;
}

/** A decoded-string boundary inside a path: the value is parsed `passes` times. */
export interface JsonPathDecodeSegment {
  decode: number;
}

export type JsonTreePathSegment = string | number | JsonPathDecodeSegment;

export interface JsonTreeWebviewChild {
  /** Display/search copy only. The host context retains the complete key. */
  key: string | number;
  rawKey?: string;
  keyTruncated?: true;
  keyLength?: number;
  rawKeyTruncated?: true;
  rawKeyLength?: number;
  value: JsonTreeWebviewNode;
}

/** Bounded display/search model sent across the Extension Host/Webview boundary. */
export interface JsonTreeWebviewNode {
  id: number;
  type: JsonTreeNodeType;
  raw?: string;
  value?: string | boolean | null;
  rawTruncated?: true;
  rawLength?: number;
  valueTruncated?: true;
  valueLength?: number;
  children?: JsonTreeWebviewChild[];
  /** The string value looks like embedded JSON and can be decoded inline. */
  decodable?: true;
  decoded?: { root: JsonTreeWebviewNode; unwrapDepth: number; recovered?: true; embedded?: true };
}

export interface JsonTreeWebviewModel {
  root: JsonTreeWebviewNode;
  truncatedFieldCount: number;
}

/** Builds a lossless, Webview-safe tree without recursively walking the AST. */
export function buildJsonTree(root: JsoncNode, source: string): JsonTreeNode {
  let nextId = 0;
  const createNode = (node: JsoncNode): JsonTreeNode => {
    const result: JsonTreeNode = {
      id: nextId,
      type: node.type as JsonTreeNodeType,
      offset: node.offset,
      length: node.length,
    };
    nextId += 1;

    if (node.type === "string") {
      result.raw = source.slice(node.offset, node.offset + node.length);
      result.value = node.value as string;
    } else if (node.type === "number") {
      result.raw = source.slice(node.offset, node.offset + node.length);
    } else if (node.type === "boolean") {
      result.raw = source.slice(node.offset, node.offset + node.length);
      result.value = node.value as boolean;
    } else if (node.type === "null") {
      result.raw = source.slice(node.offset, node.offset + node.length);
      result.value = null;
    } else {
      result.children = [];
    }
    return result;
  };

  const result = createNode(root);
  const pending: Array<{ sourceNode: JsoncNode; targetNode: JsonTreeNode }> = [
    { sourceNode: root, targetNode: result },
  ];

  while (pending.length > 0) {
    const current = pending.pop() as { sourceNode: JsoncNode; targetNode: JsonTreeNode };
    if (current.sourceNode.type === "array") {
      const sourceChildren = current.sourceNode.children ?? [];
      const targetChildren = current.targetNode.children as JsonTreeChild[];
      for (let index = 0; index < sourceChildren.length; index += 1) {
        const sourceChild = sourceChildren[index];
        const targetChild = createNode(sourceChild);
        targetChildren.push({ key: index, value: targetChild });
      }
      for (let index = sourceChildren.length - 1; index >= 0; index -= 1) {
        pending.push({ sourceNode: sourceChildren[index], targetNode: targetChildren[index].value });
      }
      continue;
    }

    if (current.sourceNode.type === "object") {
      const properties = current.sourceNode.children ?? [];
      const targetChildren = current.targetNode.children as JsonTreeChild[];
      const childSources: JsoncNode[] = [];
      for (const property of properties) {
        const keyNode = property.children?.[0];
        const valueNode = property.children?.[1];
        if (!keyNode || !valueNode || keyNode.type !== "string") {
          throw new Error("Unexpected JSONC property node.");
        }
        const targetChild = createNode(valueNode);
        targetChildren.push({
          key: keyNode.value as string,
          rawKey: source.slice(keyNode.offset, keyNode.offset + keyNode.length),
          keyOffset: keyNode.offset,
          value: targetChild,
        });
        childSources.push(valueNode);
      }
      for (let index = childSources.length - 1; index >= 0; index -= 1) {
        pending.push({ sourceNode: childSources[index], targetNode: targetChildren[index].value });
      }
    }
  }

  return result;
}


/** Accepts only IDs that can be used safely as keys in the host-owned node index. */
export function isValidJsonTreeNodeId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Edge marker for the root of JSON decoded from its parent string node. */
const DECODED_EDGE = -2;

/**
 * O(1) node lookup plus parent links for deriving trusted paths. Links live in
 * typed arrays; context objects are materialized only for a requested node, so
 * large trees do not pay for one context object per node. Decoded string
 * content can be attached later and receives IDs after the existing ones.
 */
export class JsonTreeIndex {
  private nodes: Array<JsonTreeNode | undefined> = [];
  private parents = new Int32Array(0);
  private childIndexes = new Int32Array(0);
  private duplicateKeyInPath = new Uint8Array(0);

  constructor(private readonly root: JsonTreeNode) {
    let maxId = root.id;
    walkJsonTree(root, (node) => {
      if (!isValidJsonTreeNodeId(node.id)) throw new Error(`Invalid JSON tree node ID ${node.id}.`);
      if (node.id > maxId) maxId = node.id;
    });
    this.ensureCapacity(maxId + 1);
    this.register(root, -1, -1, false);
  }

  /** First ID that is free for newly attached nodes. */
  get nextId(): number {
    return this.nodes.length;
  }

  /** Total nodes, including attached decoded content. */
  get size(): number {
    let count = 0;
    for (const node of this.nodes) if (node !== undefined) count += 1;
    return count;
  }

  get(id: number): JsonTreeNodeContext | undefined {
    if (!isValidJsonTreeNodeId(id) || id >= this.nodes.length || this.nodes[id] === undefined) {
      return undefined;
    }
    const chain: number[] = [];
    for (let current = id; current >= 0; current = this.parents[current]) chain.push(current);

    let context: JsonTreeNodeContext | undefined;
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      const nodeId = chain[index];
      const node = this.nodes[nodeId] as JsonTreeNode;
      if (context === undefined) {
        context = { node, hasDuplicateKeyInPath: false };
        continue;
      }
      const hasDuplicateKeyInPath = this.duplicateKeyInPath[nodeId] === 1;
      if (this.childIndexes[nodeId] === DECODED_EDGE) {
        context = { node, parent: context, decodedFrom: context.node.decoded, hasDuplicateKeyInPath };
        continue;
      }
      const edge = (context.node.children as JsonTreeChild[])[this.childIndexes[nodeId]];
      context = { node, parent: context, key: edge.key, rawKey: edge.rawKey, hasDuplicateKeyInPath };
    }
    return context;
  }

  /**
   * Attaches JSON decoded from a string node. The decoded tree is renumbered
   * in place so its IDs follow every existing ID.
   */
  attachDecoded(stringNodeId: number, decoded: JsonTreeDecoded): void {
    const owner = this.nodes[stringNodeId];
    if (owner === undefined || owner.type !== "string") throw new Error(`Node ${stringNodeId} is not a string.`);
    if (owner.decoded !== undefined) throw new Error(`Node ${stringNodeId} is already decoded.`);
    let nextId = this.nextId;
    walkJsonTree(decoded.root, (node) => {
      node.id = nextId;
      nextId += 1;
      // Offsets inside decoded content refer to the string value, not the source.
      delete node.offset;
      delete node.length;
      for (const child of node.children ?? []) delete child.keyOffset;
    });
    this.ensureCapacity(nextId);
    owner.decoded = decoded;
    this.register(decoded.root, stringNodeId, DECODED_EDGE, this.duplicateKeyInPath[stringNodeId] === 1);
  }

  /** Child-index path from the root (DECODED_EDGE marks a decoded boundary); survives re-parsing. */
  structuralPath(id: number): number[] | undefined {
    if (this.nodes[id] === undefined) return undefined;
    const path: number[] = [];
    for (let current = id; this.parents[current] >= 0; current = this.parents[current]) {
      path.push(this.childIndexes[current]);
    }
    return path.reverse();
  }

  /** Resolves a structural path produced by another index for the same source. */
  resolveStructuralPath(path: number[]): JsonTreeNode | undefined {
    let node: JsonTreeNode | undefined = this.root;
    for (const step of path) {
      node = step === DECODED_EDGE ? node?.decoded?.root : node?.children?.[step]?.value;
      if (node === undefined) return undefined;
    }
    return node;
  }

  /**
   * Deepest node whose source range contains the offset (relative to the
   * parsed text). Children are offset-ordered, so each level is a binary search.
   */
  nodeAtOffset(offset: number): JsonTreeNode | undefined {
    const end = (node: JsonTreeNode): number => (node.offset ?? 0) + (node.length ?? 0);
    const root = this.root;
    if (root.offset === undefined || offset < root.offset || offset >= end(root)) return undefined;
    let node = root;
    for (;;) {
      // A property spans from its key to the end of its value.
      const children = node.children ?? [];
      const start = (child: JsonTreeChild): number => child.keyOffset ?? child.value.offset ?? 0;
      let low = 0;
      let high = children.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (start(children[mid]) <= offset) low = mid + 1;
        else high = mid;
      }
      const candidate = children[low - 1];
      if (candidate === undefined || candidate.value.offset === undefined || offset >= end(candidate.value)) return node;
      node = candidate.value;
    }
  }

  /** IDs from the root down to the node, inclusive. */
  ancestry(id: number): number[] {
    const ids: number[] = [];
    for (let current = id; current >= 0; current = this.parents[current]) ids.push(current);
    return ids.reverse();
  }

  private ensureCapacity(capacity: number): void {
    if (capacity <= this.parents.length) {
      if (this.nodes.length < capacity) this.nodes.length = capacity;
      return;
    }
    const size = Math.max(capacity, this.parents.length * 2);
    const grow = <T extends Int32Array | Uint8Array>(current: T, next: T, fill?: number): T => {
      if (fill !== undefined) next.fill(fill);
      next.set(current);
      return next;
    };
    this.parents = grow(this.parents, new Int32Array(size), -1);
    this.childIndexes = grow(this.childIndexes, new Int32Array(size), -1);
    this.duplicateKeyInPath = grow(this.duplicateKeyInPath, new Uint8Array(size));
    this.nodes.length = capacity;
  }

  private register(root: JsonTreeNode, parentId: number, edge: number, inheritedDuplicate: boolean): void {
    if (this.nodes[root.id] !== undefined) throw new Error(`Duplicate JSON tree node ID ${root.id}.`);
    this.nodes[root.id] = root;
    this.parents[root.id] = parentId;
    this.childIndexes[root.id] = edge;
    this.duplicateKeyInPath[root.id] = inheritedDuplicate ? 1 : 0;

    const pending = [root];
    while (pending.length > 0) {
      const parent = pending.pop() as JsonTreeNode;
      const children = parent.children ?? [];
      // Duplicate object keys make that segment, and every descendant, ambiguous.
      const duplicateKeys = new Set<string>();
      if (parent.type === "object") {
        const seenKeys = new Set<string>();
        for (const child of children) {
          const key = child.key as string;
          if (seenKeys.has(key)) duplicateKeys.add(key);
          else seenKeys.add(key);
        }
      }
      const parentDuplicate = this.duplicateKeyInPath[parent.id] === 1;
      for (let index = 0; index < children.length; index += 1) {
        const child = children[index];
        const id = child.value.id;
        if (this.nodes[id] !== undefined) throw new Error(`Duplicate JSON tree node ID ${id}.`);
        this.nodes[id] = child.value;
        this.parents[id] = parent.id;
        this.childIndexes[id] = index;
        this.duplicateKeyInPath[id] =
          parentDuplicate || (parent.type === "object" && duplicateKeys.has(child.key as string)) ? 1 : 0;
        pending.push(child.value);
      }
      const decodedRoot = parent.decoded?.root;
      if (decodedRoot !== undefined) {
        if (this.nodes[decodedRoot.id] !== undefined) throw new Error(`Duplicate JSON tree node ID ${decodedRoot.id}.`);
        this.nodes[decodedRoot.id] = decodedRoot;
        this.parents[decodedRoot.id] = parent.id;
        this.childIndexes[decodedRoot.id] = DECODED_EDGE;
        this.duplicateKeyInPath[decodedRoot.id] = parentDuplicate ? 1 : 0;
        pending.push(decodedRoot);
      }
    }
  }
}

export function buildJsonTreeContextIndex(root: JsonTreeNode): JsonTreeIndex {
  return new JsonTreeIndex(root);
}

/** Visits every node, including attached decoded content, without recursion. */
export function walkJsonTree(root: JsonTreeNode, visit: (node: JsonTreeNode) => void): void {
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop() as JsonTreeNode;
    visit(node);
    if (node.decoded !== undefined) pending.push(node.decoded.root);
    const children = node.children ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) pending.push(children[index].value);
  }
}

/**
 * Restores a decoded path from host-owned parent links in O(depth). Decoded
 * string boundaries appear as `{ decode: passes }` segments.
 */
export function materializeJsonTreePath(
  context: JsonTreeNodeContext,
): JsonTreePathSegment[] {
  const path: JsonTreePathSegment[] = [];
  let current: JsonTreeNodeContext | undefined = context;
  while (current.parent !== undefined) {
    path.push(current.decodedFrom !== undefined
      ? { decode: current.decodedFrom.unwrapDepth + 1 }
      : current.key as string | number);
    current = current.parent;
  }
  path.reverse();
  return path;
}

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

/**
 * Creates a bounded copy for Webview rendering and search. Full tokens remain
 * only in the Extension Host for copy/open operations selected by node ID.
 */
export function createJsonTreeWebviewModel(
  root: JsonTreeNode,
  maxFieldCharacters = MAX_WEBVIEW_FIELD_CHARACTERS,
): JsonTreeWebviewModel {
  const limit = Number.isFinite(maxFieldCharacters)
    ? Math.max(1, Math.trunc(maxFieldCharacters))
    : MAX_WEBVIEW_FIELD_CHARACTERS;
  let truncatedFieldCount = 0;

  const bounded = (text: string): { text: string; truncated: boolean; length: number } => {
    if (text.length <= limit) return { text, truncated: false, length: text.length };
    truncatedFieldCount += 1;
    const remaining = limit - 1;
    const headLength = Math.ceil(remaining / 2);
    const tailLength = Math.floor(remaining / 2);
    return {
      text: `${text.slice(0, headLength)}…${tailLength > 0 ? text.slice(-tailLength) : ""}`,
      truncated: true,
      length: text.length,
    };
  };

  const pending: Array<{ source: JsonTreeNode; target: JsonTreeWebviewNode }> = [];
  const copyNode = (node: JsonTreeNode): JsonTreeWebviewNode => {
    const target: JsonTreeWebviewNode = { id: node.id, type: node.type };
    if (node.raw !== undefined) {
      const raw = bounded(node.raw);
      target.raw = raw.text;
      if (raw.truncated) {
        target.rawTruncated = true;
        target.rawLength = raw.length;
      }
    }
    if (typeof node.value === "string") {
      const value = bounded(node.value);
      target.value = value.text;
      if (value.truncated) {
        target.valueTruncated = true;
        target.valueLength = value.length;
      }
      if (node.decoded !== undefined) {
        const decodedRoot = copyNode(node.decoded.root);
        target.decoded = { root: decodedRoot, unwrapDepth: node.decoded.unwrapDepth };
        if (node.decoded.recovery !== undefined) target.decoded.recovered = true;
        if (node.decoded.embedded) target.decoded.embedded = true;
        pending.push({ source: node.decoded.root, target: decodedRoot });
      } else if (looksLikeEmbeddedJson(node.value)) {
        target.decodable = true;
      }
    } else if (node.value !== undefined) {
      target.value = node.value;
    }
    if (node.children !== undefined) target.children = [];
    return target;
  };

  const targetRoot = copyNode(root);
  pending.push({ source: root, target: targetRoot });
  while (pending.length > 0) {
    const current = pending.pop() as { source: JsonTreeNode; target: JsonTreeWebviewNode };
    const sourceChildren = current.source.children ?? [];
    const targetChildren = current.target.children;
    if (targetChildren === undefined) continue;

    for (const child of sourceChildren) {
      const targetChild: JsonTreeWebviewChild = {
        key: child.key,
        value: copyNode(child.value),
      };
      if (typeof child.key === "string") {
        const key = bounded(child.key);
        targetChild.key = key.text;
        if (key.truncated) {
          targetChild.keyTruncated = true;
          targetChild.keyLength = key.length;
        }
      }
      if (child.rawKey !== undefined) {
        const rawKey = bounded(child.rawKey);
        targetChild.rawKey = rawKey.text;
        if (rawKey.truncated) {
          targetChild.rawKeyTruncated = true;
          targetChild.rawKeyLength = rawKey.length;
        }
      }
      targetChildren.push(targetChild);
    }
    for (let index = sourceChildren.length - 1; index >= 0; index -= 1) {
      pending.push({ source: sourceChildren[index].value, target: targetChildren[index].value });
    }
  }

  return { root: targetRoot, truncatedFieldCount };
}


/** Recreates the conventional (potentially number-lossy) compatibility value iteratively. */
export function jsonTreeToValue(root: JsonTreeNode): JsonValue {
  const createValue = (node: JsonTreeNode): JsonValue => {
    if (node.type === "string") return node.value as string;
    if (node.type === "number") return Number(node.raw);
    if (node.type === "boolean") return node.value as boolean;
    if (node.type === "null") return null;
    return node.type === "array" ? [] : {};
  };

  const result = createValue(root);
  const pending: Array<{ source: JsonTreeNode; target: JsonValue }> = [{ source: root, target: result }];
  while (pending.length > 0) {
    const current = pending.pop() as { source: JsonTreeNode; target: JsonValue };
    if (current.source.type === "array") {
      const target = current.target as JsonValue[];
      for (const child of current.source.children ?? []) {
        const childValue = createValue(child.value);
        target[child.key as number] = childValue;
        if (child.value.children !== undefined) {
          pending.push({ source: child.value, target: childValue });
        }
      }
      continue;
    }

    if (current.source.type === "object") {
      const target = current.target as { [key: string]: JsonValue };
      for (const child of current.source.children ?? []) {
        const childValue = createValue(child.value);
        Object.defineProperty(target, child.key, {
          value: childValue,
          enumerable: true,
          configurable: true,
          writable: true,
        });
        if (child.value.children !== undefined) {
          pending.push({ source: child.value, target: childValue });
        }
      }
    }
  }
  return result;
}

/**
 * Serializes strict JSON while preserving number/string/key tokens and
 * duplicate object keys. JSONC comments and trailing commas are intentionally
 * omitted. The task stack prevents deep input from overflowing the call stack.
 */
export function stringifyJsonTree(root: JsonTreeNode, spaces = 2): string {
  const width = Number.isFinite(spaces) ? Math.max(0, Math.min(10, Math.trunc(spaces))) : 2;
  const indentation = " ".repeat(width);
  const pretty = width > 0;
  const output: string[] = [];
  type Task =
    | { kind: "node"; node: JsonTreeNode; depth: number }
    | { kind: "text"; text: string };
  const tasks: Task[] = [{ kind: "node", node: root, depth: 0 }];

  while (tasks.length > 0) {
    const task = tasks.pop() as Task;
    if (task.kind === "text") {
      output.push(task.text);
      continue;
    }

    const { node, depth } = task;
    if (node.type !== "array" && node.type !== "object") {
      if (node.raw === undefined) throw new Error(`Missing raw token for ${node.type} node.`);
      output.push(node.raw);
      continue;
    }

    const children = node.children ?? [];
    const open = node.type === "array" ? "[" : "{";
    const close = node.type === "array" ? "]" : "}";
    output.push(open);
    if (children.length === 0) {
      output.push(close);
      continue;
    }

    tasks.push({ kind: "text", text: pretty ? `\n${indentation.repeat(depth)}${close}` : close });
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      tasks.push({ kind: "node", node: child.value, depth: depth + 1 });
      if (node.type === "object") {
        if (child.rawKey === undefined) throw new Error("Missing raw object-key token.");
        tasks.push({ kind: "text", text: `${child.rawKey}${pretty ? ": " : ":"}` });
      }
      tasks.push({
        kind: "text",
        text: `${index > 0 ? pretty ? ",\n" : "," : pretty ? "\n" : ""}${
          pretty ? indentation.repeat(depth + 1) : ""
        }`,
      });
    }
  }

  return output.join("");
}

/**
 * Produces pretty JSON when it is safe to do so, otherwise falls back to
 * compact JSON. Both paths are measured before allocating the output string.
 */
export function stringifyJsonTreeForTransfer(
  root: JsonTreeNode,
  prettyLimit = MAX_PRETTY_OUTPUT_CHARACTERS,
  outputLimit = MAX_TRANSFER_OUTPUT_CHARACTERS,
): SafeJsonTreeString {
  const prettyLength = measureJsonTreeString(root, 2, prettyLimit);
  if (prettyLength <= prettyLimit) {
    return { text: stringifyJsonTree(root), compacted: false };
  }

  const compactLength = measureJsonTreeString(root, 0, outputLimit);
  if (compactLength > outputLimit) {
    throw new JsonTreeOutputTooLargeError(outputLimit);
  }
  return { text: stringifyJsonTree(root, 0), compacted: true };
}

/** Rejects oversized raw/decoded strings before sending them to the clipboard. */
export function assertTransferTextSize(
  text: string,
  outputLimit = MAX_TRANSFER_OUTPUT_CHARACTERS,
): void {
  if (text.length > outputLimit) {
    throw new JsonTreeOutputTooLargeError(outputLimit);
  }
}

/** Returns one more than stopAfter as soon as the exact result is known to exceed it. */
export function measureJsonTreeString(
  root: JsonTreeNode,
  spaces = 2,
  stopAfter = Number.POSITIVE_INFINITY,
): number {
  const width = Number.isFinite(spaces) ? Math.max(0, Math.min(10, Math.trunc(spaces))) : 2;
  const pending: Array<{ node: JsonTreeNode; depth: number }> = [{ node: root, depth: 0 }];
  let length = 0;

  const add = (amount: number): boolean => {
    length += amount;
    return length > stopAfter;
  };

  while (pending.length > 0) {
    const { node, depth } = pending.pop() as { node: JsonTreeNode; depth: number };
    if (node.type !== "array" && node.type !== "object") {
      if (node.raw === undefined) throw new Error(`Missing raw token for ${node.type} node.`);
      if (add(node.raw.length)) return stopAfter + 1;
      continue;
    }

    const children = node.children ?? [];
    if (add(2)) return stopAfter + 1; // opening and closing delimiters
    if (children.length === 0) continue;

    if (width > 0) {
      // One newline before every child and before the closer, plus commas.
      if (add(children.length * 2)) return stopAfter + 1;
      if (add(width * (children.length * (depth + 1) + depth))) return stopAfter + 1;
    } else if (add(children.length - 1)) {
      return stopAfter + 1;
    }

    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (node.type === "object") {
        if (child.rawKey === undefined) throw new Error("Missing raw object-key token.");
        if (add(child.rawKey.length + (width > 0 ? 2 : 1))) return stopAfter + 1;
      }
      pending.push({ node: child.value, depth: depth + 1 });
    }
  }

  return length;
}

function formatCharacterLimit(characters: number): string {
  return `${characters.toLocaleString()} characters`;
}

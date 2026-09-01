import type { Node as JsoncNode } from "jsonc-parser";
import type { JsonValue } from "./parser";

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
}

/** Host-owned node/edge context. Webview messages identify only the node ID. */
export interface JsonTreeNodeContext {
  node: JsonTreeNode;
  parent?: JsonTreeNodeContext;
  key?: string | number;
  rawKey?: string;
  /** True when any object-key segment on this path has duplicate siblings. */
  hasDuplicateKeyInPath: boolean;
}

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

/** Finds the node selected by a Webview message without trusting its value. */
export function findJsonTreeNode(root: JsonTreeNode, id: number): JsonTreeNode | undefined {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop() as JsonTreeNode;
    if (current.id === id) return current;
    const children = current.children ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push(children[index].value);
    }
  }
  return undefined;
}

/** Accepts only IDs that can be used safely as keys in the host-owned node index. */
export function isValidJsonTreeNodeId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Builds an O(1) node lookup plus parent links for deriving trusted paths.
 * Duplicate object keys make that segment, and every descendant, ambiguous.
 */
export function buildJsonTreeContextIndex(
  root: JsonTreeNode,
): Map<number, JsonTreeNodeContext> {
  const rootContext: JsonTreeNodeContext = { node: root, hasDuplicateKeyInPath: false };
  const contexts = new Map<number, JsonTreeNodeContext>([[root.id, rootContext]]);
  const pending = [rootContext];

  while (pending.length > 0) {
    const parent = pending.pop() as JsonTreeNodeContext;
    const children = parent.node.children ?? [];
    const duplicateKeys = new Set<string>();
    if (parent.node.type === "object") {
      const seenKeys = new Set<string>();
      for (const child of children) {
        const key = child.key as string;
        if (seenKeys.has(key)) duplicateKeys.add(key);
        else seenKeys.add(key);
      }
    }

    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      const context: JsonTreeNodeContext = {
        node: child.value,
        parent,
        key: child.key,
        rawKey: child.rawKey,
        hasDuplicateKeyInPath:
          parent.hasDuplicateKeyInPath ||
          (parent.node.type === "object" && duplicateKeys.has(child.key as string)),
      };
      if (contexts.has(child.value.id)) {
        throw new Error(`Duplicate JSON tree node ID ${child.value.id}.`);
      }
      contexts.set(child.value.id, context);
      pending.push(context);
    }
  }

  return contexts;
}

/** Restores a decoded path from host-owned parent links in O(depth). */
export function materializeJsonTreePath(
  context: JsonTreeNodeContext,
): Array<string | number> {
  const path: Array<string | number> = [];
  let current: JsonTreeNodeContext | undefined = context;
  while (current.parent !== undefined) {
    path.push(current.key as string | number);
    current = current.parent;
  }
  path.reverse();
  return path;
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
    } else if (node.value !== undefined) {
      target.value = node.value;
    }
    if (node.children !== undefined) target.children = [];
    return target;
  };

  const targetRoot = copyNode(root);
  const pending: Array<{ source: JsonTreeNode; target: JsonTreeWebviewNode }> = [
    { source: root, target: targetRoot },
  ];
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

/** Counts nodes with an optional early-exit ceiling. */
export function countJsonTreeNodes(root: JsonTreeNode, stopAfter = Number.POSITIVE_INFINITY): number {
  const pending = [root];
  let count = 0;
  while (pending.length > 0) {
    const current = pending.pop() as JsonTreeNode;
    count += 1;
    if (count > stopAfter) return count;
    for (const child of current.children ?? []) pending.push(child.value);
  }
  return count;
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

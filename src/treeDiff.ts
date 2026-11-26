import type { JsonTreeChild, JsonTreeDecoded, JsonTreeNode } from "./jsonTree";
import {
  JsonCandidate,
  JsonProcessingLimitError,
  JsonValueNodeLimitError,
  MAX_JSON_VALUE_NODES,
  parseNestedJsonCandidates,
} from "./parser";

export type DiffStatus = "added" | "removed" | "changed" | "unchanged";

export interface DiffNodeAnnotation {
  status: Exclude<DiffStatus, "unchanged">;
  oldRaw?: string;
}

export interface JsonTreeDiffSummary {
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
}

export interface JsonTreeDiffOptions {
  /**
   * When enabled (default: true), differing string nodes whose values decode
   * into a JSON object or array attach the inner structural diff on `.decoded`.
   */
  decodeEmbeddedJson?: boolean;
  /** Maximum nodes allowed in the merged diff tree. Defaults to MAX_JSON_VALUE_NODES. */
  maxNodes?: number;
}

export interface JsonTreeDiffResult {
  root: JsonTreeNode;
  nodeCount: number;
  summary: JsonTreeDiffSummary;
  annotations: Record<number, DiffNodeAnnotation>;
}

const MAX_CONTAINER_OLD_RAW_CHARS = 200;

type WorkItem =
  | {
      kind: "diffChildren";
      left: JsonTreeNode;
      right: JsonTreeNode;
      target: JsonTreeNode;
    }
  | {
      kind: "cloneChildren";
      source: JsonTreeNode;
      target: JsonTreeNode;
      status: DiffStatus;
    }
  | {
      kind: "diffDecoded";
      leftNode: JsonTreeNode;
      rightNode: JsonTreeNode;
      targetOwner: JsonTreeNode;
    }
  | {
      kind: "cloneDecoded";
      sourceDecoded: JsonTreeDecoded;
      targetOwner: JsonTreeNode;
      status: DiffStatus;
    };

/**
 * Computes a lossless, stack-safe structural diff between two `JsonTreeNode`
 * trees, assigning fresh sequential IDs (`0..nodeCount-1`) and optionally
 * cross-decoding embedded JSON strings when their string values differ.
 */
export function diffJsonTrees(
  left: JsonTreeNode,
  right: JsonTreeNode,
  options: JsonTreeDiffOptions = {},
): JsonTreeDiffResult {
  const decodeEmbeddedJson = options.decodeEmbeddedJson !== false;
  const maxNodes = normalizeMaxNodes(options.maxNodes);

  let nextId = 0;
  const summary: JsonTreeDiffSummary = {
    added: 0,
    removed: 0,
    changed: 0,
    unchanged: 0,
  };
  const annotations: Record<number, DiffNodeAnnotation> = {};
  const stack: WorkItem[] = [];

  const recordStatus = (id: number, status: DiffStatus, oldRaw?: string): void => {
    if (status === "unchanged") {
      summary.unchanged += 1;
      return;
    }
    summary[status] += 1;
    annotations[id] = oldRaw !== undefined ? { status, oldRaw } : { status };
  };

  const allocateShallowClone = (source: JsonTreeNode, status: DiffStatus, oldRaw?: string): JsonTreeNode => {
    if (nextId >= maxNodes) {
      throw new JsonValueNodeLimitError(maxNodes);
    }
    const id = nextId;
    nextId += 1;
    const node: JsonTreeNode = { id, type: source.type };
    populatePrimitiveTokens(source, node);
    if (source.type === "object" || source.type === "array") {
      node.children = [];
    }
    recordStatus(id, status, oldRaw);
    return node;
  };

  const remainingBudget = (): number => Math.max(1, maxNodes - nextId);

  const instantiatePair = (leftNode: JsonTreeNode, rightNode: JsonTreeNode): JsonTreeNode => {
    // 1. Both objects -> container unchanged, diff properties by (key, occurrence)
    if (leftNode.type === "object" && rightNode.type === "object") {
      const target = allocateShallowClone(rightNode, "unchanged");
      stack.push({ kind: "diffChildren", left: leftNode, right: rightNode, target });
      return target;
    }

    // 2. Both arrays -> container unchanged, align indices 0..max-1
    if (leftNode.type === "array" && rightNode.type === "array") {
      const target = allocateShallowClone(rightNode, "unchanged");
      stack.push({ kind: "diffChildren", left: leftNode, right: rightNode, target });
      return target;
    }

    // 3. Same primitive type
    if (
      leftNode.type === rightNode.type &&
      leftNode.type !== "object" &&
      leftNode.type !== "array"
    ) {
      if (primitivesEqual(leftNode, rightNode)) {
        const target = allocateShallowClone(rightNode, "unchanged");
        const existingDecoded = rightNode.decoded ?? leftNode.decoded;
        if (target.type === "string" && existingDecoded !== undefined) {
          stack.push({
            kind: "cloneDecoded",
            sourceDecoded: existingDecoded,
            targetOwner: target,
            status: "unchanged",
          });
        }
        return target;
      }

      const oldRaw = formatOldRaw(leftNode);
      const target = allocateShallowClone(rightNode, "changed", oldRaw);

      if (leftNode.type === "string" && decodeEmbeddedJson) {
        stack.push({
          kind: "diffDecoded",
          leftNode,
          rightNode,
          targetOwner: target,
        });
      }
      return target;
    }

    // 4. Type mismatch (primitive <-> primitive of different type, container <-> primitive, object <-> array)
    const oldRaw = formatOldRaw(leftNode);
    const target = allocateShallowClone(rightNode, "changed", oldRaw);
    if (rightNode.type === "object" || rightNode.type === "array") {
      stack.push({ kind: "cloneChildren", source: rightNode, target, status: "added" });
    } else if (rightNode.type === "string" && rightNode.decoded !== undefined && decodeEmbeddedJson) {
      stack.push({
        kind: "cloneDecoded",
        sourceDecoded: rightNode.decoded,
        targetOwner: target,
        status: "added",
      });
    }
    return target;
  };

  const instantiateSubtreeClone = (source: JsonTreeNode, status: DiffStatus): JsonTreeNode => {
    const target = allocateShallowClone(source, status);
    if (source.type === "object" || source.type === "array") {
      stack.push({ kind: "cloneChildren", source, target, status });
    }
    if (source.decoded !== undefined) {
      stack.push({
        kind: "cloneDecoded",
        sourceDecoded: source.decoded,
        targetOwner: target,
        status,
      });
    }
    return target;
  };

  const root = instantiatePair(left, right);

  while (stack.length > 0) {
    const item = stack.pop()!;
    if (item.kind === "cloneDecoded") {
      const { sourceDecoded, targetOwner, status } = item;
      const decodedRoot = instantiateSubtreeClone(sourceDecoded.root, status);
      const decoded: JsonTreeDecoded = {
        root: decodedRoot,
        unwrapDepth: sourceDecoded.unwrapDepth,
      };
      if (sourceDecoded.kind !== undefined) decoded.kind = sourceDecoded.kind;
      if (sourceDecoded.recovery !== undefined) decoded.recovery = sourceDecoded.recovery;
      if (sourceDecoded.embedded) decoded.embedded = true;
      targetOwner.decoded = decoded;
      continue;
    }

    if (item.kind === "diffDecoded") {
      const { leftNode, rightNode, targetOwner } = item;
      const leftDecoded = resolveEmbeddedDecoded(leftNode, remainingBudget());
      const rightDecoded =
        leftDecoded !== undefined ? resolveEmbeddedDecoded(rightNode, remainingBudget()) : undefined;
      if (leftDecoded !== undefined && rightDecoded !== undefined) {
        const innerRoot = instantiatePair(leftDecoded.root, rightDecoded.root);
        const decoded: JsonTreeDecoded = {
          root: innerRoot,
          unwrapDepth: rightDecoded.unwrapDepth,
        };
        if (rightDecoded.kind !== undefined) decoded.kind = rightDecoded.kind;
        else if (leftDecoded.kind !== undefined) decoded.kind = leftDecoded.kind;
        if (rightDecoded.recovery !== undefined) decoded.recovery = rightDecoded.recovery;
        if (rightDecoded.embedded) decoded.embedded = true;
        targetOwner.decoded = decoded;
      } else if (rightNode.decoded !== undefined) {
        stack.push({
          kind: "cloneDecoded",
          sourceDecoded: rightNode.decoded,
          targetOwner,
          status: "added",
        });
      }
      continue;
    }

    if (item.kind === "cloneChildren") {
      const sourceChildren = item.source.children ?? [];
      const targetChildren = item.target.children!;
      const stackBase = stack.length;
      const frameSlices: Array<WorkItem[]> = [];
      for (let i = 0; i < sourceChildren.length; i += 1) {
        const srcChild = sourceChildren[i];
        const childNode = instantiateSubtreeClone(srcChild.value, item.status);
        const clonedChild: JsonTreeChild =
          item.source.type === "object"
            ? {
                key: String(srcChild.key),
                rawKey: srcChild.rawKey ?? JSON.stringify(String(srcChild.key)),
                value: childNode,
              }
            : { key: i, value: childNode };
        targetChildren.push(clonedChild);
        if (stack.length > stackBase) {
          frameSlices.push(stack.splice(stackBase));
        }
      }
      for (let i = frameSlices.length - 1; i >= 0; i -= 1) {
        const slice = frameSlices[i];
        for (let j = 0; j < slice.length; j += 1) {
          stack.push(slice[j]);
        }
      }
      continue;
    }

    // item.kind === "diffChildren"
    if (item.left.type === "array" && item.right.type === "array") {
      const leftChildren = item.left.children ?? [];
      const rightChildren = item.right.children ?? [];
      const targetChildren = item.target.children!;
      const maxLen = Math.max(leftChildren.length, rightChildren.length);

      // Push work items recorded per child in reverse order so deep traversal stays pre-order.
      const stackBase = stack.length;
      const frameSlices: Array<WorkItem[]> = [];

      for (let i = 0; i < maxLen; i += 1) {
        let childNode: JsonTreeNode;
        if (i >= leftChildren.length) {
          childNode = instantiateSubtreeClone(rightChildren[i].value, "added");
        } else if (i >= rightChildren.length) {
          childNode = instantiateSubtreeClone(leftChildren[i].value, "removed");
        } else {
          childNode = instantiatePair(leftChildren[i].value, rightChildren[i].value);
        }
        targetChildren.push({ key: i, value: childNode });
        if (stack.length > stackBase) {
          frameSlices.push(stack.splice(stackBase));
        }
      }

      for (let i = frameSlices.length - 1; i >= 0; i -= 1) {
        const slice = frameSlices[i];
        for (let j = 0; j < slice.length; j += 1) {
          stack.push(slice[j]);
        }
      }
      continue;
    }

    if (item.left.type === "object" && item.right.type === "object") {
      const leftChildren = item.left.children ?? [];
      const rightChildren = item.right.children ?? [];
      const targetChildren = item.target.children!;

      const rightByKey = new Map<string, number[]>();
      for (let i = 0; i < rightChildren.length; i += 1) {
        const key = String(rightChildren[i].key);
        let bucket = rightByKey.get(key);
        if (bucket === undefined) {
          bucket = [];
          rightByKey.set(key, bucket);
        }
        bucket.push(i);
      }

      const matchedRight = new Uint8Array(rightChildren.length);
      const leftOccurrence = new Map<string, number>();
      const stackBase = stack.length;
      const frameSlices: Array<WorkItem[]> = [];

      for (let i = 0; i < leftChildren.length; i += 1) {
        const leftChild = leftChildren[i];
        const key = String(leftChild.key);
        const occ = leftOccurrence.get(key) ?? 0;
        leftOccurrence.set(key, occ + 1);

        const rightBucket = rightByKey.get(key);
        const rightIndex = rightBucket !== undefined && occ < rightBucket.length ? rightBucket[occ] : -1;

        if (rightIndex >= 0) {
          matchedRight[rightIndex] = 1;
          const rightChild = rightChildren[rightIndex];
          const childNode = instantiatePair(leftChild.value, rightChild.value);
          targetChildren.push({
            key,
            rawKey: rightChild.rawKey ?? leftChild.rawKey ?? JSON.stringify(key),
            value: childNode,
          });
        } else {
          const childNode = instantiateSubtreeClone(leftChild.value, "removed");
          targetChildren.push({
            key,
            rawKey: leftChild.rawKey ?? JSON.stringify(key),
            value: childNode,
          });
        }

        if (stack.length > stackBase) {
          frameSlices.push(stack.splice(stackBase));
        }
      }

      for (let i = 0; i < rightChildren.length; i += 1) {
        if (matchedRight[i] === 1) continue;
        const rightChild = rightChildren[i];
        const key = String(rightChild.key);
        const childNode = instantiateSubtreeClone(rightChild.value, "added");
        targetChildren.push({
          key,
          rawKey: rightChild.rawKey ?? JSON.stringify(key),
          value: childNode,
        });
        if (stack.length > stackBase) {
          frameSlices.push(stack.splice(stackBase));
        }
      }

      for (let i = frameSlices.length - 1; i >= 0; i -= 1) {
        const slice = frameSlices[i];
        for (let j = 0; j < slice.length; j += 1) {
          stack.push(slice[j]);
        }
      }
    }
  }

  return {
    root,
    nodeCount: nextId,
    summary,
    annotations,
  };
}

function normalizeMaxNodes(maxNodes: number | undefined): number {
  return maxNodes !== undefined && Number.isFinite(maxNodes) && maxNodes >= 1
    ? Math.trunc(maxNodes)
    : MAX_JSON_VALUE_NODES;
}

function populatePrimitiveTokens(source: JsonTreeNode, target: JsonTreeNode): void {
  if (source.type === "string") {
    const val = typeof source.value === "string" ? source.value : "";
    target.value = val;
    target.raw = source.raw ?? JSON.stringify(val);
  } else if (source.type === "number") {
    target.raw = source.raw ?? String(source.value ?? 0);
  } else if (source.type === "boolean") {
    const val = typeof source.value === "boolean" ? source.value : source.raw === "true";
    target.value = val;
    target.raw = source.raw ?? (val ? "true" : "false");
  } else if (source.type === "null") {
    target.value = null;
    target.raw = source.raw ?? "null";
  }
}

function primitivesEqual(left: JsonTreeNode, right: JsonTreeNode): boolean {
  if (left.type !== right.type) return false;
  if (left.type === "string") {
    return (left.value ?? "") === (right.value ?? "");
  }
  if (left.type === "number") {
    return (left.raw ?? String(left.value ?? "")) === (right.raw ?? String(right.value ?? ""));
  }
  if (left.type === "boolean") {
    const lv = typeof left.value === "boolean" ? left.value : left.raw === "true";
    const rv = typeof right.value === "boolean" ? right.value : right.raw === "true";
    return lv === rv;
  }
  return true;
}

function formatOldRaw(left: JsonTreeNode): string {
  if (left.type !== "object" && left.type !== "array") {
    return left.raw ?? JSON.stringify(left.value ?? null);
  }
  return formatBoundedCompactJson(left, MAX_CONTAINER_OLD_RAW_CHARS);
}

/** Iteratively formats a bounded compact JSON preview for replaced container nodes. */
function formatBoundedCompactJson(root: JsonTreeNode, maxChars: number): string {
  const parts: string[] = [];
  let length = 0;
  type TokenTask = { kind: "text"; text: string } | { kind: "node"; node: JsonTreeNode };
  const tasks: TokenTask[] = [{ kind: "node", node: root }];

  const append = (text: string): boolean => {
    const remaining = maxChars - length;
    if (remaining <= 0) return false;
    if (text.length <= remaining) {
      parts.push(text);
      length += text.length;
      return true;
    }
    parts.push(`${text.slice(0, Math.max(0, remaining - 1))}…`);
    length = maxChars;
    return false;
  };

  while (tasks.length > 0) {
    const task = tasks.pop()!;
    if (task.kind === "text") {
      if (!append(task.text)) break;
      continue;
    }
    const { node } = task;
    if (node.type !== "object" && node.type !== "array") {
      const token = node.raw ?? JSON.stringify(node.value ?? null);
      if (!append(token)) break;
      continue;
    }
    const children = node.children ?? [];
    const open = node.type === "array" ? "[" : "{";
    const close = node.type === "array" ? "]" : "}";
    if (!append(open)) break;
    if (children.length === 0) {
      if (!append(close)) break;
      continue;
    }
    tasks.push({ kind: "text", text: close });
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const child = children[i];
      tasks.push({ kind: "node", node: child.value });
      if (node.type === "object") {
        const rawKey = child.rawKey ?? JSON.stringify(String(child.key));
        tasks.push({ kind: "text", text: `${rawKey}:` });
      }
      if (i > 0) {
        tasks.push({ kind: "text", text: "," });
      }
    }
  }
  return parts.join("");
}

function resolveEmbeddedDecoded(
  node: JsonTreeNode,
  maxValueNodes: number,
): JsonTreeDecoded | undefined {
  if (node.decoded !== undefined) {
    return node.decoded;
  }
  if (typeof node.value !== "string") {
    return undefined;
  }
  const value = node.value;
  if (!value.includes("{") && !value.includes("[")) {
    return undefined;
  }
  try {
    const candidates = parseNestedJsonCandidates(
      value,
      Number.isFinite(maxValueNodes)
        ? { maxValueNodes, allowPartial: false }
        : { allowPartial: false },
    );
    if (candidates.length !== 1) {
      return undefined;
    }
    const selected = candidates[0];
    if (selected.tree.type !== "object" && selected.tree.type !== "array") {
      return undefined;
    }
    const decoded: JsonTreeDecoded = {
      root: selected.tree,
      unwrapDepth: selected.unwrapDepth,
      kind: "json",
    };
    if (selected.recovery !== undefined) {
      decoded.recovery = selected.recovery;
    }
    if (!isWholeDecodedValue(value, selected)) {
      decoded.embedded = true;
    }
    return decoded;
  } catch (error) {
    if (error instanceof JsonProcessingLimitError) {
      return undefined;
    }
    throw error;
  }
}

function isWholeDecodedValue(value: string, candidate: JsonCandidate): boolean {
  let layer = value;
  for (let depth = 0; depth < candidate.unwrapDepth; depth += 1) {
    try {
      const parsed: unknown = JSON.parse(layer);
      if (typeof parsed !== "string") return false;
      layer = parsed;
    } catch {
      return false;
    }
  }
  return layer.trim() === candidate.raw;
}

import { JsonValue } from "./parser";
import { JsonTreeNode } from "./jsonTree";

export interface JsonSearchResult {
  paths: Array<Array<string | number>>;
  truncated: boolean;
}

interface SearchPathNode {
  parent: SearchPathNode | undefined;
  segment: string | number;
}

interface JsonSearchFrame {
  value: JsonValue;
  path: SearchPathNode | undefined;
  entered: boolean;
  nextChildIndex: number;
  objectKeys?: string[];
}

export interface JsonSearchState extends JsonSearchResult {
  done: boolean;
  needle: string;
  maxMatches: number;
  stack: JsonSearchFrame[];
}

/** Creates an incremental search that can be advanced in short UI-friendly chunks. */
export function createJsonSearchState(
  value: JsonValue,
  query: string,
  maxMatches = 5_000,
): JsonSearchState {
  const needle = query.trim().toLocaleLowerCase();
  const done = needle.length === 0 || maxMatches <= 0;
  return {
    paths: [],
    truncated: false,
    done,
    needle,
    maxMatches,
    stack: done
      ? []
      : [{ value, path: undefined, entered: false, nextChildIndex: 0 }],
  };
}

/**
 * Advances an incremental search without recursive calls or copying every
 * ancestor path for every visited node. Returns true when the search is done.
 */
export function advanceJsonSearch(state: JsonSearchState, maxVisitedNodes = 2_000): boolean {
  if (state.done || maxVisitedNodes <= 0) {
    return state.done;
  }

  let visitedNodes = 0;
  while (state.stack.length > 0 && visitedNodes < maxVisitedNodes) {
    const frame = state.stack[state.stack.length - 1];
    if (!frame.entered) {
      frame.entered = true;
      visitedNodes += 1;

      const segment = frame.path?.segment;
      const keyText = segment === undefined ? "" : String(segment);
      const primitiveText =
        frame.value === null || typeof frame.value !== "object" ? String(frame.value) : "";
      if (
        keyText.toLocaleLowerCase().includes(state.needle) ||
        primitiveText.toLocaleLowerCase().includes(state.needle)
      ) {
        if (state.paths.length >= state.maxMatches) {
          state.truncated = true;
          state.done = true;
          state.stack.length = 0;
          break;
        }

        const path: Array<string | number> = [];
        let pathNode = frame.path;
        while (pathNode !== undefined) {
          path.push(pathNode.segment);
          pathNode = pathNode.parent;
        }
        path.reverse();
        state.paths.push(path);
      }

      if (frame.value !== null && !Array.isArray(frame.value) && typeof frame.value === "object") {
        frame.objectKeys = Object.keys(frame.value);
      }
      continue;
    }

    if (Array.isArray(frame.value) && frame.nextChildIndex < frame.value.length) {
      const index = frame.nextChildIndex;
      frame.nextChildIndex += 1;
      state.stack.push({
        value: frame.value[index],
        path: { parent: frame.path, segment: index },
        entered: false,
        nextChildIndex: 0,
      });
      continue;
    }

    if (
      frame.value !== null &&
      !Array.isArray(frame.value) &&
      typeof frame.value === "object" &&
      frame.objectKeys !== undefined &&
      frame.nextChildIndex < frame.objectKeys.length
    ) {
      const key = frame.objectKeys[frame.nextChildIndex];
      frame.nextChildIndex += 1;
      state.stack.push({
        value: frame.value[key],
        path: { parent: frame.path, segment: key },
        entered: false,
        nextChildIndex: 0,
      });
      continue;
    }

    state.stack.pop();
  }

  if (state.stack.length === 0) {
    state.done = true;
  }
  return state.done;
}

/** Finds key and primitive-value substring matches in stable tree order. */
export function searchJson(
  value: JsonValue,
  query: string,
  maxMatches = 5_000,
): JsonSearchResult {
  const state = createJsonSearchState(value, query, maxMatches);
  while (!advanceJsonSearch(state, Number.MAX_SAFE_INTEGER)) {
    // The synchronous convenience wrapper intentionally consumes all chunks.
  }
  return { paths: state.paths, truncated: state.truncated };
}

interface JsonTreeSearchFrame {
  node: JsonTreeNode;
  key: string | number | undefined;
  rawKey: string | undefined;
  parent: JsonTreeSearchFrame | undefined;
  entered: boolean;
  nextChildIndex: number;
}

export interface JsonTreeSearchState {
  matches: number[];
  expandIds: Set<number>;
  truncated: boolean;
  done: boolean;
  needle: string;
  maxMatches: number;
  stack: JsonTreeSearchFrame[];
}

/** Creates an incremental, lossless-tree search suitable for the Webview event loop. */
export function createJsonTreeSearchState(
  root: JsonTreeNode,
  query: string,
  maxMatches = 5_000,
): JsonTreeSearchState {
  const needle = query.trim().toLocaleLowerCase();
  const done = needle.length === 0 || maxMatches <= 0;
  return {
    matches: [],
    expandIds: new Set<number>(),
    truncated: false,
    done,
    needle,
    maxMatches,
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
          },
        ],
  };
}

/** Advances lossless-tree search by at most maxVisitedNodes nodes. */
export function advanceJsonTreeSearch(
  state: JsonTreeSearchState,
  maxVisitedNodes = 2_000,
): boolean {
  if (state.done || maxVisitedNodes <= 0) return state.done;

  let visitedNodes = 0;
  while (state.stack.length > 0 && visitedNodes < maxVisitedNodes) {
    const frame = state.stack[state.stack.length - 1];
    if (!frame.entered) {
      frame.entered = true;
      visitedNodes += 1;
      const keyText = frame.key === undefined ? "" : `${String(frame.key)}\n${frame.rawKey ?? ""}`;
      const primitiveText = jsonTreePrimitiveSearchText(frame.node);
      if (
        keyText.toLocaleLowerCase().includes(state.needle) ||
        primitiveText.toLocaleLowerCase().includes(state.needle)
      ) {
        if (state.matches.length >= state.maxMatches) {
          state.truncated = true;
          state.done = true;
          state.stack.length = 0;
          break;
        }
        state.matches.push(frame.node.id);
        let ancestor = frame.parent;
        while (ancestor !== undefined) {
          if (state.expandIds.has(ancestor.node.id)) break;
          state.expandIds.add(ancestor.node.id);
          ancestor = ancestor.parent;
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
      });
      continue;
    }
    state.stack.pop();
  }

  if (state.stack.length === 0) state.done = true;
  return state.done;
}

export function jsonTreePrimitiveSearchText(node: JsonTreeNode): string {
  if (node.type === "object" || node.type === "array") return "";
  if (node.type === "string") return `${node.value as string}\n${node.raw ?? ""}`;
  return node.raw ?? String(node.value);
}

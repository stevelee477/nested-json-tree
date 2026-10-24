import type { JsonTreeNode } from "./jsonTree";

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

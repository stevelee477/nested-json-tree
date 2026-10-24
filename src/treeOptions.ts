import type { JsonTreeNode } from "./jsonTree";

/** Hard safety boundary for materializing every Tree View node at once. */
export const MAX_EXPAND_ALL_NODES = 10_000;

/**
 * Uses an iterative, early-exit count so deeply nested or large JSON values do
 * not consume recursion depth merely to decide their initial expansion state.
 */
export function shouldAutoExpandTree(root: JsonTreeNode, maxNodes: number): boolean {
  return isTreeNodeCountWithinLimit(root, maxNodes);
}

/** Counts lossless-tree nodes only up to the limit and never queues more than the limit. */
export function isTreeNodeCountWithinLimit(root: JsonTreeNode, maxNodes: number): boolean {
  if (!Number.isFinite(maxNodes) || maxNodes <= 0) return false;

  const stack = [root];
  let count = 0;
  while (stack.length > 0) {
    const current = stack.pop() as JsonTreeNode;
    count += 1;
    if (count > maxNodes) return false;
    const children = current.children ?? [];
    const remainingSlots = maxNodes - count - stack.length;
    if (children.length > remainingSlots) return false;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index].value);
    }
  }
  return true;
}

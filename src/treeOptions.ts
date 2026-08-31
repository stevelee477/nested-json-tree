import { JsonValue } from "./parser";

/**
 * Uses an iterative, early-exit count so deeply nested or large JSON values do
 * not consume recursion depth merely to decide their initial expansion state.
 */
export function shouldAutoExpand(value: JsonValue, maxNodes: number): boolean {
  if (!Number.isFinite(maxNodes) || maxNodes <= 0) {
    return false;
  }

  const stack: JsonValue[] = [value];
  let count = 0;
  while (stack.length > 0) {
    const current = stack.pop() as JsonValue;
    count += 1;
    if (count > maxNodes) {
      return false;
    }

    if (Array.isArray(current)) {
      for (const child of current) {
        stack.push(child);
      }
    } else if (current !== null && typeof current === "object") {
      for (const child of Object.values(current)) {
        stack.push(child);
      }
    }
  }
  return true;
}

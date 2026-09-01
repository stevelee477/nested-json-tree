import { JsonValue } from "./parser";

export interface JsonSearchResult {
  paths: Array<Array<string | number>>;
  truncated: boolean;
}

/** Finds key and primitive-value substring matches in stable tree order. */
export function searchJson(
  value: JsonValue,
  query: string,
  maxMatches = 5_000,
): JsonSearchResult {
  const needle = query.trim().toLocaleLowerCase();
  if (needle.length === 0 || maxMatches <= 0) {
    return { paths: [], truncated: false };
  }

  const paths: Array<Array<string | number>> = [];
  const stack: Array<{ value: JsonValue; path: Array<string | number> }> = [{ value, path: [] }];

  while (stack.length > 0) {
    const current = stack.pop() as { value: JsonValue; path: Array<string | number> };
    const segment = current.path.at(-1);
    const keyText = segment === undefined ? "" : String(segment);
    const primitiveText =
      current.value === null || typeof current.value !== "object" ? String(current.value) : "";

    if (
      keyText.toLocaleLowerCase().includes(needle) ||
      primitiveText.toLocaleLowerCase().includes(needle)
    ) {
      paths.push(current.path);
      if (paths.length > maxMatches) {
        return { paths: paths.slice(0, maxMatches), truncated: true };
      }
    }

    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: current.value[index], path: [...current.path, index] });
      }
    } else if (current.value !== null && typeof current.value === "object") {
      const entries = Object.entries(current.value);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [key, child] = entries[index];
        stack.push({ value: child, path: [...current.path, key] });
      }
    }
  }

  return { paths, truncated: false };
}

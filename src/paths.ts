/** Formats a node path as a jq filter that can be pasted after `jq`. */
export function formatJqPath(path: Array<string | number>): string {
  if (path.length === 0) {
    return ".";
  }

  return path
    .map((segment) => {
      if (typeof segment === "number") {
        return `[${segment}]`;
      }
      return /^[A-Za-z_][A-Za-z0-9_]*$/.test(segment)
        ? `.${segment}`
        : `[${JSON.stringify(segment)}]`;
    })
    .join("");
}

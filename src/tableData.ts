import type { JsonTreeNode } from "./jsonTree";

export interface TableRow {
  rowLabel: string;
  targetNodeId?: number;
  targetLineNumber?: number;
  cells: string[];
}

export interface TableBuildOptions {
  maxRows?: number;
  maxColumns?: number;
  flatten?: boolean;
  maxFlattenDepth?: number;
}

export interface TableModel {
  title: string;
  columns: string[];
  rows: TableRow[];
  truncated: boolean;
  truncatedColumns: boolean;
  flattened?: boolean;
  sourceKind: "array" | "jsonl";
}

const DEFAULT_MAX_ROWS = 1_000;
const DEFAULT_MAX_COLUMNS = 60;
const DEFAULT_MAX_FLATTEN_DEPTH = 3;
const DEFAULT_CELL_PREVIEW_CHARS = 120;

/** True when an array holds at least one object item suitable for tabular display. */
export function isTabularArrayNode(node: JsonTreeNode): boolean {
  return (
    node.type === "array" &&
    node.children !== undefined &&
    node.children.length > 0 &&
    node.children.some((child) => child.value.type === "object")
  );
}

export function buildTableFromArrayNode(
  node: JsonTreeNode,
  title: string,
  options?: TableBuildOptions,
): TableModel | undefined;
export function buildTableFromArrayNode(
  node: JsonTreeNode,
  title: string,
  maxRows?: number,
  maxColumns?: number,
  options?: TableBuildOptions,
): TableModel | undefined;
export function buildTableFromArrayNode(
  node: JsonTreeNode,
  title: string,
  maxRowsOrOptions?: number | TableBuildOptions,
  maxColumnsArg?: number,
  extraOptions?: TableBuildOptions,
): TableModel | undefined {
  if (!isTabularArrayNode(node)) return undefined;
  const opts = typeof maxRowsOrOptions === "object" && maxRowsOrOptions !== null
    ? maxRowsOrOptions
    : extraOptions;
  const maxRows = typeof maxRowsOrOptions === "number"
    ? maxRowsOrOptions
    : opts?.maxRows ?? DEFAULT_MAX_ROWS;
  const maxColumns = typeof maxColumnsArg === "number"
    ? maxColumnsArg
    : opts?.maxColumns ?? DEFAULT_MAX_COLUMNS;
  const flatten = opts?.flatten === true;
  const maxFlattenDepth = opts?.maxFlattenDepth ?? DEFAULT_MAX_FLATTEN_DEPTH;

  const children = node.children!;
  const items = children.slice(0, maxRows).map((child, index) => ({
    rowLabel: `[${index}]`,
    targetNodeId: child.value.id,
    tree: child.value,
  }));
  return buildTableModel(
    items,
    title,
    "array",
    children.length > maxRows,
    maxColumns,
    flatten,
    maxFlattenDepth,
  );
}

export function buildTableFromJsonlRecords(
  records: ReadonlyArray<{ lineNumber: number; tree: JsonTreeNode }>,
  title: string,
  options?: TableBuildOptions,
): TableModel;
export function buildTableFromJsonlRecords(
  records: ReadonlyArray<{ lineNumber: number; tree: JsonTreeNode }>,
  title: string,
  truncated?: boolean,
  options?: TableBuildOptions,
): TableModel;
export function buildTableFromJsonlRecords(
  records: ReadonlyArray<{ lineNumber: number; tree: JsonTreeNode }>,
  title: string,
  truncated?: boolean,
  maxColumns?: number,
  options?: TableBuildOptions,
): TableModel;
export function buildTableFromJsonlRecords(
  records: ReadonlyArray<{ lineNumber: number; tree: JsonTreeNode }>,
  title: string,
  truncatedOrOptions: boolean | TableBuildOptions = false,
  maxColumnsOrOptions?: number | TableBuildOptions,
  extraOptions?: TableBuildOptions,
): TableModel {
  let opts: TableBuildOptions | undefined;
  let truncated = false;
  let maxColumns: number | undefined;

  if (typeof truncatedOrOptions === "object" && truncatedOrOptions !== null) {
    opts = truncatedOrOptions;
  } else {
    truncated = truncatedOrOptions;
    if (typeof maxColumnsOrOptions === "object" && maxColumnsOrOptions !== null) {
      opts = maxColumnsOrOptions;
    } else {
      maxColumns = maxColumnsOrOptions;
      opts = extraOptions;
    }
  }

  const effectiveMaxRows = opts?.maxRows;
  const slicedRecords = effectiveMaxRows !== undefined && records.length > effectiveMaxRows
    ? records.slice(0, effectiveMaxRows)
    : records;
  const effectiveTruncated = truncated || slicedRecords.length < records.length;
  const effectiveMaxColumns = maxColumns ?? opts?.maxColumns ?? DEFAULT_MAX_COLUMNS;
  const flatten = opts?.flatten === true;
  const maxFlattenDepth = opts?.maxFlattenDepth ?? DEFAULT_MAX_FLATTEN_DEPTH;

  const items = slicedRecords.map((record) => ({
    rowLabel: String(record.lineNumber + 1),
    targetLineNumber: record.lineNumber,
    tree: record.tree,
  }));
  return buildTableModel(
    items,
    title,
    "jsonl",
    effectiveTruncated,
    effectiveMaxColumns,
    flatten,
    maxFlattenDepth,
  );
}

function buildTableModel(
  items: ReadonlyArray<{ rowLabel: string; targetNodeId?: number; targetLineNumber?: number; tree: JsonTreeNode }>,
  title: string,
  sourceKind: TableModel["sourceKind"],
  truncated: boolean,
  maxColumns: number,
  flatten: boolean,
  maxFlattenDepth: number,
): TableModel {
  const columns: string[] = [];
  const columnSet = new Set<string>();
  let truncatedColumns = false;
  let hasNonObjectRow = false;
  const effectiveMaxDepth = Math.max(0, Math.trunc(maxFlattenDepth));

  const ensureColumn = (name: string): void => {
    if (columnSet.has(name)) return;
    if (columns.length >= maxColumns) {
      truncatedColumns = true;
      return;
    }
    columnSet.add(name);
    columns.push(name);
  };

  const recordCell = (values: Map<string, string>, colName: string, cellNode: JsonTreeNode): void => {
    ensureColumn(colName);
    if (columnSet.has(colName) && !values.has(colName)) {
      values.set(colName, formatTableCell(cellNode));
    }
  };

  const rowMaps: Array<{
    rowLabel: string;
    targetNodeId?: number;
    targetLineNumber?: number;
    values: Map<string, string>;
  }> = [];

  for (const item of items) {
    const values = new Map<string, string>();
    if (item.tree.type === "object") {
      if (!flatten || effectiveMaxDepth === 0) {
        for (const child of item.tree.children ?? []) {
          recordCell(values, String(child.key), child.value);
        }
      } else {
        const topChildren = item.tree.children ?? [];
        const stack: Array<{ prefix: string; node: JsonTreeNode; depth: number }> = [];
        for (let index = topChildren.length - 1; index >= 0; index -= 1) {
          const child = topChildren[index];
          stack.push({ prefix: String(child.key), node: child.value, depth: 0 });
        }
        while (stack.length > 0) {
          const current = stack.pop()!;
          const nestedChildren = current.node.children;
          if (
            current.node.type === "object" &&
            current.depth < effectiveMaxDepth &&
            nestedChildren !== undefined &&
            nestedChildren.length > 0
          ) {
            for (let index = nestedChildren.length - 1; index >= 0; index -= 1) {
              const nested = nestedChildren[index];
              stack.push({
                prefix: `${current.prefix}.${String(nested.key)}`,
                node: nested.value,
                depth: current.depth + 1,
              });
            }
          } else {
            recordCell(values, current.prefix, current.node);
          }
        }
      }
    } else {
      hasNonObjectRow = true;
      recordCell(values, "$value", item.tree);
    }
    rowMaps.push({
      rowLabel: item.rowLabel,
      targetNodeId: item.targetNodeId,
      targetLineNumber: item.targetLineNumber,
      values,
    });
  }

  if (hasNonObjectRow && !columnSet.has("$value") && columns.length === 0) {
    columns.push("$value");
  }

  const rows: TableRow[] = rowMaps.map((entry) => ({
    rowLabel: entry.rowLabel,
    ...(entry.targetNodeId !== undefined ? { targetNodeId: entry.targetNodeId } : {}),
    ...(entry.targetLineNumber !== undefined ? { targetLineNumber: entry.targetLineNumber } : {}),
    cells: columns.map((col) => entry.values.get(col) ?? ""),
  }));

  return {
    title,
    columns,
    rows,
    truncated,
    truncatedColumns,
    flattened: flatten,
    sourceKind,
  };
}

/** Formats a single cell value concisely without ever scanning huge subtrees completely. */
export function formatTableCell(node: JsonTreeNode, maxChars = DEFAULT_CELL_PREVIEW_CHARS): string {
  if (node.type === "string") {
    const value = node.value as string;
    return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
  }
  if (node.type === "number" || node.type === "boolean" || node.type === "null") {
    const raw = node.raw ?? String(node.value);
    return raw.length <= maxChars ? raw : `${raw.slice(0, maxChars - 1)}…`;
  }
  return boundedCompactPreview(node, maxChars);
}

function boundedCompactPreview(root: JsonTreeNode, maxChars: number): string {
  type Task = { kind: "node"; node: JsonTreeNode } | { kind: "text"; text: string };
  const tasks: Task[] = [{ kind: "node", node: root }];
  let out = "";

  while (tasks.length > 0) {
    const task = tasks.pop()!;
    if (task.kind === "text") {
      out += task.text;
    } else {
      const node = task.node;
      if (node.type !== "array" && node.type !== "object") {
        out += node.raw ?? JSON.stringify(node.value);
      } else {
        const children = node.children ?? [];
        const open = node.type === "array" ? "[" : "{";
        const close = node.type === "array" ? "]" : "}";
        if (children.length === 0) {
          out += `${open}${close}`;
        } else {
          out += open;
          tasks.push({ kind: "text", text: close });
          for (let index = children.length - 1; index >= 0; index -= 1) {
            const child = children[index];
            tasks.push({ kind: "node", node: child.value });
            if (node.type === "object") {
              tasks.push({ kind: "text", text: `${child.rawKey ?? JSON.stringify(String(child.key))}:` });
            }
            if (index > 0) tasks.push({ kind: "text", text: "," });
          }
        }
      }
    }
    if (out.length >= maxChars) {
      return `${out.slice(0, maxChars - 1)}…`;
    }
  }
  return out;
}

/** Formats columns and rows as RFC 4180 CSV or TSV. */
export function formatTableAsCsv(
  columns: readonly string[],
  rows: ReadonlyArray<readonly string[]>,
  delimiter: "," | "\t" = ",",
): string {
  const escapeCell = (value: string): string => {
    if (
      value.includes(delimiter) ||
      value.includes('"') ||
      value.includes("\n") ||
      value.includes("\r")
    ) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  };
  const lines: string[] = [columns.map(escapeCell).join(delimiter)];
  for (const row of rows) {
    lines.push(row.map(escapeCell).join(delimiter));
  }
  return lines.join("\n");
}

/** Formats columns and rows as a GitHub-Flavored Markdown table. */
export function formatTableAsMarkdown(
  columns: readonly string[],
  rows: ReadonlyArray<readonly string[]>,
): string {
  if (columns.length === 0) return "";
  const escapeMarkdownCell = (value: string): string =>
    value.replace(/\r\n|\r|\n/g, "<br>").replace(/\|/g, "\\|");

  const headerLine = `| ${columns.map(escapeMarkdownCell).join(" | ")} |`;
  const separatorLine = `| ${columns.map(() => "---").join(" | ")} |`;
  const lines: string[] = [headerLine, separatorLine];
  for (const row of rows) {
    const cells = columns.map((_, index) => escapeMarkdownCell(row[index] ?? ""));
    lines.push(`| ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

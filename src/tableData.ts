import type { JsonTreeNode } from "./jsonTree";

export interface TableRow {
  rowLabel: string;
  targetNodeId?: number;
  targetLineNumber?: number;
  cells: string[];
}

export interface TableModel {
  title: string;
  columns: string[];
  rows: TableRow[];
  truncated: boolean;
  truncatedColumns: boolean;
  sourceKind: "array" | "jsonl";
}

const DEFAULT_MAX_ROWS = 1_000;
const DEFAULT_MAX_COLUMNS = 60;
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
  maxRows = DEFAULT_MAX_ROWS,
  maxColumns = DEFAULT_MAX_COLUMNS,
): TableModel | undefined {
  if (!isTabularArrayNode(node)) return undefined;
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
  );
}

export function buildTableFromJsonlRecords(
  records: ReadonlyArray<{ lineNumber: number; tree: JsonTreeNode }>,
  title: string,
  truncated = false,
  maxColumns = DEFAULT_MAX_COLUMNS,
): TableModel {
  const items = records.map((record) => ({
    rowLabel: String(record.lineNumber + 1),
    targetLineNumber: record.lineNumber,
    tree: record.tree,
  }));
  return buildTableModel(items, title, "jsonl", truncated, maxColumns);
}

function buildTableModel(
  items: ReadonlyArray<{ rowLabel: string; targetNodeId?: number; targetLineNumber?: number; tree: JsonTreeNode }>,
  title: string,
  sourceKind: TableModel["sourceKind"],
  truncated: boolean,
  maxColumns: number,
): TableModel {
  const columns: string[] = [];
  const columnSet = new Set<string>();
  let truncatedColumns = false;
  let hasNonObjectRow = false;

  const ensureColumn = (name: string): void => {
    if (columnSet.has(name)) return;
    if (columns.length >= maxColumns) {
      truncatedColumns = true;
      return;
    }
    columnSet.add(name);
    columns.push(name);
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
      for (const child of item.tree.children ?? []) {
        const key = String(child.key);
        ensureColumn(key);
        if (columnSet.has(key) && !values.has(key)) {
          values.set(key, formatTableCell(child.value));
        }
      }
    } else {
      hasNonObjectRow = true;
      ensureColumn("$value");
      if (columnSet.has("$value")) {
        values.set("$value", formatTableCell(item.tree));
      }
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

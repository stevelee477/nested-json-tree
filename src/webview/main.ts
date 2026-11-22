import type { JsonTreeWebviewChild, JsonTreeWebviewNode } from "../jsonTree";
import type {
  HostToWebviewMessage,
  JsonlViewState,
  NodeAction,
  RenderMessage,
  SourceViewState,
  WebviewToHostMessage,
} from "../protocol";
import { advanceJsonTreeSearch, createJsonTreeSearchState, JsonTreeSearchState } from "../search";
import type { TableModel } from "../tableData";

interface VsCodeApi {
  postMessage(message: WebviewToHostMessage): void;
  getState?(): unknown;
  setState?(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** Survives the Webview being discarded while its tab is hidden. */
interface SavedViewState {
  renderKey: number;
  expanded: number[];
  query: string;
  scrollTop: number;
  searchDecoded?: boolean;
  sortKeys?: boolean;
}

interface EdgeInfo {
  label: string;
  hasKey: boolean;
  hasRawKey: boolean;
  keyTruncated?: true;
  keyLength?: number;
  rawKeyTruncated?: true;
  rawKeyLength?: number;
  /** The node is JSON/structured data decoded from its parent string. */
  decoded?: true;
}

interface VisibleRow {
  id: number;
  level: number;
  label: string;
  model: JsonTreeWebviewNode;
  edge: EdgeInfo | undefined;
}

type WebviewPathStep = number | { key: string; occurrence: number } | "decoded";

const ROW_HEIGHT = 22;
const OVERSCAN_ROWS = 15;
const TREE_OPERATION_CHUNK_SIZE = 500;
const MAX_SUBTREE_EXPAND_NODES = 50_000;

const strings = readL10nBundle();
const vscode = acquireVsCodeApi();
const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const tree = byId<HTMLElement>("tree");
const menu = byId<HTMLDivElement>("menu");
const searchInput = byId<HTMLInputElement>("search-input");
const searchScopeWarning = byId<HTMLElement>("search-scope-warning");
const searchCount = byId<HTMLElement>("search-count");
const previousMatchButton = byId<HTMLButtonElement>("previous-match");
const nextMatchButton = byId<HTMLButtonElement>("next-match");
const clearSearchButton = byId<HTMLButtonElement>("clear-search");
const expandAllButton = byId<HTMLButtonElement>("expand-all");
const collapseAllButton = byId<HTMLButtonElement>("collapse-all");
const expandDepthSelect = byId<HTMLSelectElement>("expand-depth");
const sortKeysButton = byId<HTMLButtonElement>("sort-keys");
const emptySearch = byId<HTMLElement>("empty-search");
const recoveryWarning = byId<HTMLElement>("recovery-warning");
const treeOperationStatus = byId<HTMLElement>("tree-operation-status");
const jsonlBar = byId<HTMLElement>("jsonl-bar");
const previousJsonlButton = byId<HTMLButtonElement>("previous-jsonl");
const nextJsonlButton = byId<HTMLButtonElement>("next-jsonl");
const jsonlLineInput = byId<HTMLInputElement>("jsonl-line");
const jsonlTotal = byId<HTMLElement>("jsonl-total");
const goJsonlButton = byId<HTMLButtonElement>("go-jsonl");
const revealSourceButton = byId<HTMLButtonElement>("reveal-source");
const followCursorInput = byId<HTMLInputElement>("follow-cursor");
const keepViewInput = byId<HTMLInputElement>("keep-view");
const jsonlFilterInput = byId<HTMLInputElement>("jsonl-filter");
const jsonlFilterListButton = byId<HTMLButtonElement>("jsonl-filter-list");
const jsonlTableButton = byId<HTMLButtonElement>("jsonl-table");
const jsonlStatus = byId<HTMLElement>("jsonl-status");
const sourceBar = byId<HTMLElement>("source-bar");
const syncCursorInput = byId<HTMLInputElement>("sync-cursor");
const refreshSourceButton = byId<HTMLButtonElement>("refresh-source");
const sourceStatus = byId<HTMLElement>("source-status");
const searchDecodedButton = byId<HTMLButtonElement>("search-decoded");
const breadcrumbBar = byId<HTMLElement>("breadcrumb-bar");
const breadcrumbSegments = byId<HTMLElement>("breadcrumb-segments");
const breadcrumbCopyJsonPath = byId<HTMLButtonElement>("breadcrumb-copy-jsonpath");
const breadcrumbCopyJq = byId<HTMLButtonElement>("breadcrumb-copy-jq");
const tableView = byId<HTMLElement>("table-view");
const tableTitle = byId<HTMLElement>("table-title");
const tableFilterInput = byId<HTMLInputElement>("table-filter");
const tableCount = byId<HTMLElement>("table-count");
const tableCopyCsvButton = byId<HTMLButtonElement>("table-copy-csv");
const tableExportCsvButton = byId<HTMLButtonElement>("table-export-csv");
const tableCloseButton = byId<HTMLButtonElement>("table-close");
const dataTable = byId<HTMLTableElement>("data-table");

const treeSpacerTop = createSpacer();
const treeRowsContainer = createRowsContainer();
const treeSpacerBottom = createSpacer();
tree.replaceChildren(treeSpacerTop, treeRowsContainer, treeSpacerBottom);

let currentRoot: JsonTreeWebviewNode | undefined;
let renderKey = -1;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let jsonlFilterTimer: ReturnType<typeof setTimeout> | undefined;
let searchActive = false;
let searchApplying = false;
let latestSearchRequest = 0;
let matchIds: number[] = [];
let activeMatchIndex = -1;
let activeMatchNodeId: number | undefined;
let searchTruncated = false;
let expandAllAllowed = false;
let expandAllLimitValue = 100_000;
let activeTreeOperation = 0;
let treeOperationRunning = false;
let focusedNodeId: number | undefined;
let menuOriginId: number | undefined;
let cursorSyncedNodeId: number | undefined;
let pendingReveal: number[] | undefined;
let sourceRevealable = false;
let persistScheduled = false;
let searchDecoded = false;
let sortKeys = false;
let decodeRequestedFor = -1;
let stickyStatus = "";

const modelById = new Map<number, JsonTreeWebviewNode>();
const parentById = new Map<number, number | undefined>();
const edgeById = new Map<number, EdgeInfo | undefined>();
const depthById = new Map<number, number>();
const decodingIds = new Set<number>();
const expandedIds = new Set<number>();
const searchExpandedIds = new Set<number>();
let searchExactIds = new Set<number>();
let searchBranchIds = new Set<number>();
const searchRevealedIds = new Set<number>();
let sortedChildrenCache = new WeakMap<JsonTreeWebviewNode, JsonTreeWebviewChild[]>();

let visibleRows: VisibleRow[] = [];
const rowIndexById = new Map<number, number>();
const renderedRowElements = new Map<number, HTMLElement>();
let renderedStart = -1;
let renderedEnd = -1;

let currentTable: TableModel | undefined;
let tableVisibleRowIndices: number[] = [];
let tableSortColumn = -1;
let tableSortAsc = true;

function createSpacer(): HTMLDivElement {
  const spacer = document.createElement("div");
  spacer.className = "tree-spacer";
  return spacer;
}

function createRowsContainer(): HTMLDivElement {
  const container = document.createElement("div");
  container.setAttribute("role", "presentation");
  return container;
}

window.addEventListener("message", (event: MessageEvent<HostToWebviewMessage>) => {
  const message = event.data;
  switch (message.type) {
    case "jsonlState":
      applyJsonlState(message);
      return;
    case "sourceState":
      applySourceState(message);
      return;
    case "decoded":
      attachDecodedToNode(message.nodeId, message.decoded, true);
      return;
    case "decodeFailed":
      markNodeNotDecodable(message.nodeId, message.cancelled);
      return;
    case "revealNode":
      revealNode(message.ids);
      return;
    case "decodedBatch":
      applyDecodedBatch(message);
      return;
    case "tableData":
      openTableView(message.table);
      return;
    case "render":
      render(message);
      return;
  }
});

/** Formats a message from the Host-provided translations; `{0}` style placeholders. */
function t(message: string, ...args: Array<string | number>): string {
  const template = strings[message] ?? message;
  return template.replace(/\{(\d+)\}/g, (match, index: string) =>
    Number(index) < args.length ? String(args[Number(index)]) : match);
}

function readL10nBundle(): Record<string, string> {
  const element = document.getElementById("l10n-bundle");
  try {
    const parsed: unknown = element?.textContent ? JSON.parse(element.textContent) : {};
    return parsed !== null && typeof parsed === "object" ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
}

function isExpandableModel(model: JsonTreeWebviewNode): boolean {
  return model.type === "object" || model.type === "array" || model.decoded !== undefined;
}

function isDecodableModel(model: JsonTreeWebviewNode): boolean {
  return !isExpandableModel(model) && model.decodable === true;
}

function activeExpansionSet(): Set<number> {
  return searchActive ? searchExpandedIds : expandedIds;
}

function isExpandedId(id: number): boolean {
  return activeExpansionSet().has(id);
}

function indexModelTree(root: JsonTreeWebviewNode): void {
  modelById.clear();
  parentById.clear();
  edgeById.clear();
  depthById.clear();
  sortedChildrenCache = new WeakMap<JsonTreeWebviewNode, JsonTreeWebviewChild[]>();
  indexSubtree(root, undefined, { label: "$", hasKey: false, hasRawKey: false }, 1);
}

function indexSubtree(
  root: JsonTreeWebviewNode,
  rootParentId: number | undefined,
  rootEdge: EdgeInfo | undefined,
  rootDepth: number,
): void {
  const pending: Array<{
    model: JsonTreeWebviewNode;
    parentId: number | undefined;
    edge: EdgeInfo | undefined;
    depth: number;
  }> = [{ model: root, parentId: rootParentId, edge: rootEdge, depth: rootDepth }];

  while (pending.length > 0) {
    const { model, parentId, edge, depth } = pending.pop()!;
    modelById.set(model.id, model);
    parentById.set(model.id, parentId);
    edgeById.set(model.id, edge);
    depthById.set(model.id, depth);

    if (model.decoded !== undefined) {
      pending.push({
        model: model.decoded.root,
        parentId: model.id,
        edge: {
          label: decodedRowLabel(model.decoded),
          hasKey: false,
          hasRawKey: false,
          decoded: true,
        },
        depth: depth + 1,
      });
    }
    const children = model.children ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      pending.push({
        model: child.value,
        parentId: model.id,
        edge: {
          label: String(child.key),
          hasKey: true,
          hasRawKey: child.rawKey !== undefined,
          keyTruncated: child.keyTruncated,
          keyLength: child.keyLength,
          rawKeyTruncated: child.rawKeyTruncated,
          rawKeyLength: child.rawKeyLength,
        },
        depth: depth + 1,
      });
    }
  }
}

function getOrderedChildren(model: JsonTreeWebviewNode): JsonTreeWebviewChild[] {
  const children = model.children ?? [];
  if (!sortKeys || model.type !== "object" || children.length <= 1) return children;
  const cached = sortedChildrenCache.get(model);
  if (cached !== undefined) return cached;
  const sorted = children
    .map((child, index) => ({ child, index, key: String(child.key) }))
    .sort((left, right) => {
      if (left.key < right.key) return -1;
      if (left.key > right.key) return 1;
      return left.index - right.index;
    })
    .map((entry) => entry.child);
  sortedChildrenCache.set(model, sorted);
  return sorted;
}

function render(message: RenderMessage): void {
  const snapshot = message.preserveView && currentRoot !== undefined ? captureViewByStructure() : undefined;
  activeTreeOperation += 1;
  latestSearchRequest += 1;
  treeOperationRunning = false;
  clearTimeout(searchTimer);
  searchActive = false;
  searchApplying = false;
  matchIds = [];
  activeMatchIndex = -1;
  activeMatchNodeId = undefined;
  cursorSyncedNodeId = undefined;
  pendingReveal = undefined;
  stickyStatus = "";
  decodingIds.clear();
  searchExactIds = new Set<number>();
  searchBranchIds = new Set<number>();
  searchExpandedIds.clear();
  searchRevealedIds.clear();
  searchCount.textContent = "";
  previousMatchButton.disabled = true;
  nextMatchButton.disabled = true;
  emptySearch.classList.add("hidden");
  treeOperationStatus.textContent = "";
  hideMenu();
  if (!message.preserveView) closeTableView(false);

  recoveryWarning.classList.toggle("hidden", !message.recovery);
  recoveryWarning.textContent = message.recovery
    ? t("Recovered partial JSON · {0} syntax issue(s). Damaged values omitted; copy/open uses the recovered subset (array indices may differ).", message.recovery.errorCount)
    : "";
  recoveryWarning.title = message.recovery
    ? message.recovery.issues.map((issue) => t("{0} at character {1}", issue.code, issue.offset + 1)).join("; ")
    : "";

  const saved = renderKey === -1 ? loadViewState(message.renderKey) : undefined;
  renderKey = message.renderKey;
  currentRoot = message.root;
  expandAllAllowed = message.canExpandAll;
  expandAllLimitValue = message.expandAllLimit;
  expandedIds.clear();
  indexModelTree(currentRoot);

  byId("title").textContent = message.title;
  byId("path").textContent = message.pathLabel;
  jsonlBar.classList.toggle("hidden", !message.jsonl);
  if (message.jsonl) applyJsonlState(message.jsonl);
  applySourceState(message.source);
  sourceRevealable = message.jsonl !== undefined || message.source !== undefined;

  const hasTruncatedFields = message.truncatedFieldCount > 0;
  searchScopeWarning.classList.toggle("hidden", !hasTruncatedFields);
  searchInput.placeholder = hasTruncatedFields
    ? t("Search displayed text (long values shortened)…")
    : t("Search keys and values…");
  expandAllButton.title = expandAllAllowed
    ? t("Expand every object and array")
    : t("Expand all is unavailable because this tree exceeds {0} nodes", message.expandAllLimit.toLocaleString());

  if (saved?.searchDecoded !== undefined) setSearchDecoded(saved.searchDecoded);
  if (saved?.sortKeys !== undefined) setSortKeys(saved.sortKeys, false);

  const restore = snapshot !== undefined
    ? { query: searchInput.value, expanded: resolveStructuralPaths(snapshot.expandedPaths), scrollTop: snapshot.scrollTop }
    : saved;

  setFocusedNode(currentRoot.id, false);
  tree.scrollTop = 0;

  if (restore) {
    searchInput.value = restore.query;
    for (const id of restore.expanded) {
      const model = modelById.get(id);
      if (model !== undefined && isExpandableModel(model)) expandedIds.add(id);
    }
    rebuildVisibleRows();
    tree.scrollTop = restore.scrollTop;
    renderVirtualWindow(true);
    updateActionButtons();
    if (searchInput.value.trim()) runSearch();
  } else if (searchInput.value.trim()) {
    rebuildVisibleRows();
    updateActionButtons();
    runSearch();
  } else if (message.autoExpand && expandAllAllowed) {
    rebuildVisibleRows();
    runTreeOperation(true);
  } else if (expandAllAllowed) {
    expandedIds.add(currentRoot.id);
    rebuildVisibleRows();
    updateActionButtons();
  } else {
    rebuildVisibleRows();
    updateActionButtons();
  }
}

searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 120);
  schedulePersist();
});
searchInput.addEventListener("keydown", (event: KeyboardEvent) => {
  if (event.key === "Enter") {
    event.preventDefault();
    selectRelativeMatch(event.shiftKey ? -1 : 1);
  } else if (event.key === "Escape") {
    event.preventDefault();
    clearSearch();
  } else if (event.key === "ArrowDown" && focusedNodeId !== undefined) {
    event.preventDefault();
    setFocusedNode(focusedNodeId, true);
  }
});
previousMatchButton.addEventListener("click", () => selectRelativeMatch(-1));
nextMatchButton.addEventListener("click", () => selectRelativeMatch(1));
clearSearchButton.addEventListener("click", clearSearch);

expandAllButton.addEventListener("click", () => runTreeOperation(true));
collapseAllButton.addEventListener("click", () => runTreeOperation(false));
expandDepthSelect?.addEventListener("change", () => {
  const depth = Number(expandDepthSelect.value);
  expandDepthSelect.value = "";
  if (Number.isInteger(depth) && depth >= 1) expandToDepth(depth);
});
sortKeysButton?.addEventListener("click", () => {
  setSortKeys(!sortKeys, true);
  schedulePersist();
});

previousJsonlButton.addEventListener("click", () =>
  vscode.postMessage({ type: "previousJsonl", query: jsonlFilterInput?.value ?? "" }));
nextJsonlButton.addEventListener("click", () =>
  vscode.postMessage({ type: "nextJsonl", query: jsonlFilterInput?.value ?? "" }));
goJsonlButton.addEventListener("click", goToJsonlLine);
jsonlLineInput.addEventListener("keydown", (event: KeyboardEvent) => {
  if (event.key === "Enter") {
    event.preventDefault();
    goToJsonlLine();
  }
});
revealSourceButton.addEventListener("click", () => vscode.postMessage({ type: "revealSource" }));
followCursorInput.addEventListener("change", () =>
  vscode.postMessage({ type: "setFollowCursor", enabled: followCursorInput.checked }));
keepViewInput?.addEventListener("change", () =>
  vscode.postMessage({ type: "setKeepView", enabled: keepViewInput.checked }));
jsonlFilterInput?.addEventListener("input", () => {
  clearTimeout(jsonlFilterTimer);
  jsonlFilterTimer = setTimeout(() => {
    vscode.postMessage({ type: "setJsonlFilter", query: jsonlFilterInput.value });
  }, 200);
});
jsonlFilterInput?.addEventListener("keydown", (event: KeyboardEvent) => {
  if (event.key === "Enter") {
    event.preventDefault();
    clearTimeout(jsonlFilterTimer);
    vscode.postMessage({
      type: event.shiftKey ? "previousJsonl" : "nextJsonl",
      query: jsonlFilterInput.value,
    });
  } else if (event.key === "Escape") {
    event.preventDefault();
    clearTimeout(jsonlFilterTimer);
    jsonlFilterInput.value = "";
    vscode.postMessage({ type: "setJsonlFilter", query: "" });
  }
});
jsonlFilterListButton?.addEventListener("click", () =>
  vscode.postMessage({ type: "listJsonlMatches", query: jsonlFilterInput?.value ?? "" }));
jsonlTableButton?.addEventListener("click", () =>
  vscode.postMessage({ type: "openJsonlTable", query: jsonlFilterInput?.value ?? "" }));

syncCursorInput?.addEventListener("change", () =>
  vscode.postMessage({ type: "setSyncCursor", enabled: syncCursorInput.checked }));
refreshSourceButton?.addEventListener("click", () => vscode.postMessage({ type: "refreshSource" }));
searchDecodedButton?.addEventListener("click", () => {
  setSearchDecoded(!searchDecoded);
  schedulePersist();
  if (searchInput.value.trim()) runSearch();
});

breadcrumbCopyJsonPath?.addEventListener("click", () => {
  if (focusedNodeId !== undefined) postNodeAction("copyJsonPath", focusedNodeId);
});
breadcrumbCopyJq?.addEventListener("click", () => {
  if (focusedNodeId !== undefined) postNodeAction("copyJqPath", focusedNodeId);
});
breadcrumbSegments?.addEventListener("click", (event: Event) => {
  const target = findClosest(event.target, "breadcrumb-segment");
  if (!target) return;
  const nodeId = Number(target.getAttribute("data-node-id"));
  if (!Number.isSafeInteger(nodeId)) return;
  focusNodeById(nodeId);
});

tableFilterInput?.addEventListener("input", () => renderTableRows());
tableCopyCsvButton?.addEventListener("click", () =>
  vscode.postMessage({ type: "exportTable", mode: "copy", rowIndices: tableVisibleRowIndices }));
tableExportCsvButton?.addEventListener("click", () =>
  vscode.postMessage({ type: "exportTable", mode: "open", rowIndices: tableVisibleRowIndices }));
tableCloseButton?.addEventListener("click", () => closeTableView(true));
dataTable?.addEventListener("click", (event: Event) => {
  const th = findClosestTag(event.target, "TH");
  if (th) {
    const colAttr = th.getAttribute("data-col-index");
    if (colAttr === null) return;
    const colIndex = Number(colAttr);
    if (!Number.isInteger(colIndex)) return;
    if (tableSortColumn === colIndex) tableSortAsc = !tableSortAsc;
    else {
      tableSortColumn = colIndex;
      tableSortAsc = true;
    }
    renderTableHeader();
    renderTableRows();
    return;
  }
  const tr = findClosestTag(event.target, "TR");
  if (!tr || !currentTable) return;
  const rowAttr = tr.getAttribute("data-row-index");
  if (rowAttr === null) return;
  const rowIndex = Number(rowAttr);
  const row = currentTable.rows[rowIndex];
  if (!row) return;
  if (row.targetLineNumber !== undefined) {
    closeTableView(true);
    vscode.postMessage({ type: "goToJsonlLine", lineNumber: row.targetLineNumber + 1 });
  } else if (row.targetNodeId !== undefined) {
    closeTableView(true);
    const ids = buildAncestry(row.targetNodeId);
    if (ids.length > 0) revealNode(ids);
  }
});

// Single event delegation on #tree avoids allocating per-row closures and listeners.
tree.addEventListener("click", (event: Event) => {
  const mouse = event as MouseEvent;
  const actionButton = findClosest(event.target, "row-action-btn");
  if (actionButton) {
    mouse.stopPropagation?.();
    const nodeEl = findClosest(actionButton, "node");
    const nodeId = nodeEl ? Number(nodeEl.getAttribute("data-node-id")) : Number.NaN;
    const action = actionButton.getAttribute("data-action");
    if (Number.isSafeInteger(nodeId) && action) {
      handleQuickRowAction(action, nodeId);
    }
    return;
  }

  const linkEl = findClosest(event.target, "link");
  if (linkEl && (mouse.metaKey || mouse.ctrlKey)) {
    mouse.preventDefault?.();
    mouse.stopPropagation?.();
    const nodeEl = findClosest(linkEl, "node");
    const nodeId = nodeEl ? Number(nodeEl.getAttribute("data-node-id")) : Number.NaN;
    if (Number.isSafeInteger(nodeId)) {
      vscode.postMessage({ type: "openLink", nodeId });
    }
    return;
  }

  const rowEl = findClosest(event.target, "row");
  if (!rowEl) return;
  const nodeEl = findClosest(rowEl, "node");
  const nodeId = nodeEl ? Number(nodeEl.getAttribute("data-node-id")) : Number.NaN;
  if (!Number.isSafeInteger(nodeId)) return;
  setFocusedNode(nodeId, false);
  toggleNodeManually(nodeId);
});

tree.addEventListener("contextmenu", (event: Event) => {
  const mouse = event as MouseEvent;
  const rowEl = findClosest(event.target, "row");
  if (!rowEl) return;
  const nodeEl = findClosest(rowEl, "node");
  const nodeId = nodeEl ? Number(nodeEl.getAttribute("data-node-id")) : Number.NaN;
  if (!Number.isSafeInteger(nodeId)) return;
  mouse.preventDefault?.();
  mouse.stopPropagation?.();
  setFocusedNode(nodeId, false);
  showMenu(mouse.clientX ?? 0, mouse.clientY ?? 0, nodeId, false);
});

tree.addEventListener("keydown", handleTreeKeydown);
tree.addEventListener("scroll", () => {
  renderVirtualWindow();
  schedulePersist();
});
menu.addEventListener("keydown", handleMenuKeydown);

document.addEventListener("click", () => hideMenu());
document.addEventListener("scroll", (event: Event) => {
  if (event.target !== tree) hideMenu();
}, true);
document.addEventListener("keydown", (event: KeyboardEvent) => {
  if (event.key === "Escape") {
    if (!menu.classList.contains("hidden")) {
      hideMenu(true);
    } else if (tableView && !tableView.classList.contains("hidden")) {
      closeTableView(true);
    }
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "f") {
    event.preventDefault();
    if (tableView && !tableView.classList.contains("hidden")) {
      tableFilterInput?.focus();
      tableFilterInput?.select();
    } else {
      searchInput.focus();
      searchInput.select();
    }
  }
});

function findClosest(target: EventTarget | null, className: string): HTMLElement | undefined {
  let current = target as HTMLElement | null | undefined;
  while (current) {
    if (current.classList?.contains(className) || current.className?.split?.(" ").includes(className)) {
      return current;
    }
    current = current.parentElement;
  }
  return undefined;
}

function findClosestTag(target: EventTarget | null, tagName: string): HTMLElement | undefined {
  let current = target as HTMLElement | null | undefined;
  const upper = tagName.toUpperCase();
  while (current) {
    if (current.tagName?.toUpperCase() === upper) return current;
    current = current.parentElement;
  }
  return undefined;
}

function rebuildVisibleRows(): void {
  visibleRows = [];
  rowIndexById.clear();
  if (!currentRoot) {
    renderVirtualWindow(true);
    return;
  }

  const expansion = activeExpansionSet();
  const stack: Array<{
    id: number;
    level: number;
    label: string;
    model: JsonTreeWebviewNode;
    edge: EdgeInfo | undefined;
  }> = [{
    id: currentRoot.id,
    level: 1,
    label: "$",
    model: currentRoot,
    edge: edgeById.get(currentRoot.id),
  }];

  while (stack.length > 0) {
    const entry = stack.pop()!;
    if (searchActive) {
      const visibleInSearch =
        searchExactIds.has(entry.id) ||
        searchBranchIds.has(entry.id) ||
        searchRevealedIds.has(entry.id);
      if (!visibleInSearch) continue;
    }

    rowIndexById.set(entry.id, visibleRows.length);
    visibleRows.push(entry);

    if (!isExpandableModel(entry.model) || !expansion.has(entry.id)) continue;

    if (entry.model.decoded !== undefined) {
      const decodedRoot = entry.model.decoded.root;
      if (searchActive && searchRevealedIds.has(entry.id)) {
        searchRevealedIds.add(decodedRoot.id);
      }
      stack.push({
        id: decodedRoot.id,
        level: entry.level + 1,
        label: decodedRowLabel(entry.model.decoded),
        model: decodedRoot,
        edge: edgeById.get(decodedRoot.id),
      });
      continue;
    }

    const children = getOrderedChildren(entry.model);
    const parentRevealed = searchActive && searchRevealedIds.has(entry.id);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (parentRevealed) searchRevealedIds.add(child.value.id);
      stack.push({
        id: child.value.id,
        level: entry.level + 1,
        label: String(child.key),
        model: child.value,
        edge: edgeById.get(child.value.id),
      });
    }
  }

  renderVirtualWindow(true);
}

function wasTreeFocused(): boolean {
  const active = document.activeElement as HTMLElement | null | undefined;
  if (!active) return false;
  if (active === tree) return true;
  if (typeof tree.contains === "function") return tree.contains(active);
  return findClosest(active, "node") !== undefined;
}

function renderVirtualWindow(force = false): void {
  const total = visibleRows.length;
  const viewportHeight = typeof tree.clientHeight === "number" && tree.clientHeight > 0 ? tree.clientHeight : 600;
  const maxScrollTop = Math.max(0, total * ROW_HEIGHT - viewportHeight);
  const rawScrollTop = Math.max(0, tree.scrollTop || 0);
  const scrollTop = Math.min(rawScrollTop, maxScrollTop);
  if (tree.scrollTop > maxScrollTop) {
    tree.scrollTop = maxScrollTop;
  }
  const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
  const visibleCount = Math.max(1, Math.ceil(viewportHeight / ROW_HEIGHT));
  const start = Math.min(total, Math.max(0, firstVisible - OVERSCAN_ROWS));
  const end = Math.min(total, firstVisible + visibleCount + OVERSCAN_ROWS);

  if (!force && start === renderedStart && end === renderedEnd) return;
  const restoreFocus = wasTreeFocused();
  renderedStart = start;
  renderedEnd = end;

  treeSpacerTop.style.height = `${start * ROW_HEIGHT}px`;
  treeSpacerBottom.style.height = `${Math.max(0, total - end) * ROW_HEIGHT}px`;

  renderedRowElements.clear();
  const fragment = document.createDocumentFragment();
  for (let index = start; index < end; index += 1) {
    const row = visibleRows[index];
    const el = createRowElement(row);
    renderedRowElements.set(row.id, el);
    fragment.appendChild(el);
  }
  treeRowsContainer.replaceChildren(fragment);

  if (restoreFocus && focusedNodeId !== undefined) {
    const target = renderedRowElements.get(focusedNodeId);
    if (target) focusWithoutScroll(target);
  }
}

function focusWithoutScroll(element: HTMLElement): void {
  try {
    element.focus({ preventScroll: true });
  } catch {
    element.focus();
  }
}

function ensureRowVisible(rowIndex: number, align: "nearest" | "center" = "nearest"): void {
  if (rowIndex < 0 || rowIndex >= visibleRows.length) return;
  const viewportHeight = typeof tree.clientHeight === "number" && tree.clientHeight > 0 ? tree.clientHeight : 600;
  const rowTop = rowIndex * ROW_HEIGHT;
  const rowBottom = rowTop + ROW_HEIGHT;
  const currentTop = Math.max(0, tree.scrollTop || 0);
  const currentBottom = currentTop + viewportHeight;

  if (align === "center") {
    tree.scrollTop = Math.max(0, rowTop - Math.floor((viewportHeight - ROW_HEIGHT) / 2));
  } else if (rowTop < currentTop) {
    tree.scrollTop = rowTop;
  } else if (rowBottom > currentBottom) {
    tree.scrollTop = rowBottom - viewportHeight;
  }
  renderVirtualWindow(true);
}

function createRowElement(entry: VisibleRow): HTMLDivElement {
  const { id, level, label, model, edge } = entry;
  const node = document.createElement("div");
  node.className = "node";
  node.setAttribute("role", "treeitem");
  node.setAttribute("aria-level", String(level));
  node.setAttribute("aria-label", label + ": " + describeValue(model));
  node.setAttribute("data-node-id", String(id));
  node.tabIndex = id === focusedNodeId ? 0 : -1;

  const expandable = isExpandableModel(model);
  const decodable = isDecodableModel(model);
  const expanded = expandable && isExpandedId(id);
  if (expandable || decodable) {
    node.setAttribute("aria-expanded", String(expanded));
  }

  const row = document.createElement("div");
  row.className = "row";
  if (searchActive && searchExactIds.has(id)) row.classList.add("search-match");
  if (searchActive && activeMatchNodeId === id) row.classList.add("active-match");
  if (cursorSyncedNodeId === id) row.classList.add("cursor-match");
  if (decodingIds.has(id)) row.classList.add("decoding");
  row.title = t(typeLabel(model.type));

  if (level > 1) {
    const guides = document.createElement("span");
    guides.className = "indent-guides";
    for (let depth = 1; depth < level; depth += 1) {
      const guide = document.createElement("span");
      guide.className = "indent-guide";
      guides.appendChild(guide);
    }
    row.appendChild(guides);
  }

  const toggle = document.createElement("span");
  toggle.className = "toggle" + (expandable ? "" : decodable ? " decodable" : " empty");
  toggle.textContent = expandable ? (expanded ? "▾" : "▸") : decodable ? "▸" : "";
  toggle.title = decodable ? decodableToggleTitle(model.decodableKind) : "";
  row.appendChild(toggle);

  const keySpan = document.createElement("span");
  keySpan.className = edge?.decoded ? "key decoded-key" : "key";
  keySpan.textContent = label;
  if (edge?.keyTruncated) {
    keySpan.title = t("Key shortened from {0} characters", (edge.keyLength ?? 0).toLocaleString());
  }
  row.appendChild(keySpan);

  const separator = document.createElement("span");
  separator.className = "separator";
  separator.textContent = ":";
  row.appendChild(separator);

  appendValue(row, model, label, expanded);

  if (edge?.keyTruncated || edge?.rawKeyTruncated || model.rawTruncated || model.valueTruncated) {
    const truncatedBadge = document.createElement("span");
    truncatedBadge.className = "truncated-note";
    const lengths: number[] = [];
    if (edge?.keyTruncated) lengths.push(edge.keyLength ?? 0);
    if (edge?.rawKeyTruncated) lengths.push(edge.rawKeyLength ?? 0);
    if (model.rawTruncated) lengths.push(model.rawLength ?? 0);
    if (model.valueTruncated) lengths.push(model.valueLength ?? 0);
    const longest = Math.max(...lengths);
    truncatedBadge.textContent = t("… {0} chars", longest.toLocaleString());
    truncatedBadge.title = t("Only the beginning and end are displayed and searched. Copy/open actions use the complete value.");
    row.appendChild(truncatedBadge);
  }

  const actions = document.createElement("span");
  actions.className = "row-actions";
  if (decodable) {
    actions.appendChild(createRowActionButton("{}", "expandDecoded", decodableToggleTitle(model.decodableKind)));
  }
  actions.appendChild(createRowActionButton(t("Copy"), "copyQuickValue", t("Copy value (Cmd/Ctrl+C)")));
  actions.appendChild(createRowActionButton("$.", "copyJsonPath", t("Copy JSONPath (Shift+Cmd/Ctrl+C)")));
  if (sourceRevealable) {
    actions.appendChild(createRowActionButton("↗", "revealInSource", t("Reveal in source")));
  }
  row.appendChild(actions);

  node.appendChild(row);
  return node;
}

function createRowActionButton(text: string, action: string, title: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "row-action-btn";
  button.textContent = text;
  button.title = title;
  button.tabIndex = -1;
  button.setAttribute("data-action", action);
  return button;
}

function handleQuickRowAction(action: string, nodeId: number): void {
  const model = modelById.get(nodeId);
  if (!model) return;
  if (action === "expandDecoded") {
    requestDecode(nodeId);
    return;
  }
  if (action === "copyQuickValue") {
    postNodeAction(model.type === "string" ? "copyDecodedString" : "copyValue", nodeId);
    return;
  }
  if (action === "copyJsonPath") {
    postNodeAction("copyJsonPath", nodeId);
    return;
  }
  if (action === "revealInSource") {
    postNodeAction("revealInSource", nodeId);
  }
}

function postNodeAction(type: NodeAction, nodeId: number): void {
  vscode.postMessage({ type, nodeId });
}

function runSearch(): void {
  const query = searchInput.value.trim();
  clearSearchButton.disabled = query.length === 0;
  if (query.length === 0 || !currentRoot) {
    resetSearchView();
    return;
  }
  searchActive = true;
  searchApplying = true;
  activeTreeOperation += 1;
  treeOperationRunning = false;
  const requestId = ++latestSearchRequest;
  searchCount.textContent = t("Searching…");
  previousMatchButton.disabled = true;
  nextMatchButton.disabled = true;
  emptySearch.classList.add("hidden");
  updateActionButtons();
  if (searchDecoded && decodeRequestedFor !== renderKey && hasDecodableString(currentRoot)) {
    decodeRequestedFor = renderKey;
    stickyStatus = t("Decoding embedded JSON for search…");
    vscode.postMessage({ type: "decodeAllForSearch", renderKey });
  }
  const state = createJsonTreeSearchState(currentRoot as never, query);
  const processChunk = (): void => {
    if (requestId !== latestSearchRequest || !searchActive) return;
    if (advanceJsonTreeSearch(state, 2_000)) {
      applySearchResults(state, requestId);
    } else {
      setTimeout(processChunk, 0);
    }
  };
  processChunk();
}

function applySearchResults(result: JsonTreeSearchState, requestId: number): void {
  if (requestId !== latestSearchRequest || !searchActive || !currentRoot) return;
  searchExactIds = new Set(result.matches);
  searchBranchIds = new Set(result.expandIds);
  searchExpandedIds.clear();
  for (const id of result.expandIds) searchExpandedIds.add(id);
  searchRevealedIds.clear();

  searchApplying = false;
  activeMatchIndex = -1;
  activeMatchNodeId = undefined;
  rebuildVisibleRows();

  matchIds = visibleRows
    .filter((row) => searchExactIds.has(row.id))
    .map((row) => row.id);
  const count = result.truncated ? matchIds.length + "+" : String(matchIds.length);
  searchCount.textContent = matchIds.length === 1 ? t("{0} match", count) : t("{0} matches", count);
  const hasMatches = matchIds.length > 0;
  previousMatchButton.disabled = !hasMatches;
  nextMatchButton.disabled = !hasMatches;
  emptySearch.classList.toggle("hidden", hasMatches);
  updateActionButtons();
  if (hasMatches) selectRelativeMatch(1, result.truncated);
}

function selectRelativeMatch(delta: number, truncated = searchTruncated): void {
  if (matchIds.length === 0) return;
  searchTruncated = truncated;
  activeMatchIndex = (activeMatchIndex + delta + matchIds.length) % matchIds.length;
  activeMatchNodeId = matchIds[activeMatchIndex];
  const rowIndex = rowIndexById.get(activeMatchNodeId);
  if (rowIndex !== undefined) {
    ensureRowVisible(rowIndex, "center");
    setFocusedNode(activeMatchNodeId, false);
  }
  const total = truncated ? matchIds.length + "+" : String(matchIds.length);
  searchCount.textContent = t("{0} / {1}", activeMatchIndex + 1, total);
}

function clearSearch(): void {
  searchInput.value = "";
  clearTimeout(searchTimer);
  resetSearchView();
  searchInput.focus();
  schedulePersist();
}

function resetSearchView(): void {
  const wasActive = searchActive;
  latestSearchRequest += 1;
  searchActive = false;
  searchApplying = false;
  matchIds = [];
  activeMatchIndex = -1;
  activeMatchNodeId = undefined;
  searchExactIds = new Set<number>();
  searchBranchIds = new Set<number>();
  searchExpandedIds.clear();
  searchRevealedIds.clear();
  searchCount.textContent = "";
  previousMatchButton.disabled = true;
  nextMatchButton.disabled = true;
  clearSearchButton.disabled = true;
  emptySearch.classList.add("hidden");
  if (wasActive) rebuildVisibleRows();
  updateActionButtons();
}

function runTreeOperation(shouldExpand: boolean): void {
  if (!currentRoot || (shouldExpand && (searchActive || !expandAllAllowed))) return;
  const operationId = ++activeTreeOperation;
  const searchedTree = searchActive;

  if (!shouldExpand) {
    treeOperationRunning = false;
    activeExpansionSet().clear();
    if (!searchedTree) schedulePersist();
    treeOperationStatus.textContent = "";
    rebuildVisibleRows();
    updateActionButtons();
    return;
  }

  treeOperationRunning = true;
  updateActionButtons();
  const pending: JsonTreeWebviewNode[] = [currentRoot];
  let index = 0;
  let count = 0;

  const processChunk = (): void => {
    if (operationId !== activeTreeOperation || searchActive !== searchedTree) return;
    const startedAt = performance.now();
    let processed = 0;
    while (
      index < pending.length &&
      processed < TREE_OPERATION_CHUNK_SIZE &&
      performance.now() - startedAt < 8
    ) {
      const node = pending[index];
      index += 1;
      processed += 1;
      count += 1;
      if (isExpandableModel(node)) {
        expandedIds.add(node.id);
        if (node.decoded !== undefined) {
          pending.push(node.decoded.root);
        } else {
          for (const child of node.children ?? []) {
            pending.push(child.value);
          }
        }
      }
    }
    treeOperationStatus.textContent = t("Expanding… {0} nodes · Collapse all to stop", count.toLocaleString());
    if (index < pending.length) {
      setTimeout(processChunk, 0);
    } else {
      treeOperationRunning = false;
      treeOperationStatus.textContent = "";
      schedulePersist();
      rebuildVisibleRows();
      updateActionButtons();
    }
  };
  processChunk();
}

function expandToDepth(targetDepth: number): void {
  if (!currentRoot || searchActive || treeOperationRunning) return;
  expandedIds.clear();
  const pending: Array<{ model: JsonTreeWebviewNode; depth: number }> = [{ model: currentRoot, depth: 1 }];
  let visited = 0;
  const limit = Math.max(10_000, expandAllLimitValue);
  while (pending.length > 0 && visited < limit) {
    const { model, depth } = pending.pop()!;
    visited += 1;
    if (!isExpandableModel(model) || depth > targetDepth) continue;
    expandedIds.add(model.id);
    if (model.decoded !== undefined) {
      pending.push({ model: model.decoded.root, depth: depth + 1 });
    } else {
      const children = model.children ?? [];
      for (let index = children.length - 1; index >= 0; index -= 1) {
        pending.push({ model: children[index].value, depth: depth + 1 });
      }
    }
  }
  schedulePersist();
  rebuildVisibleRows();
  updateActionButtons();
}

function expandSubtree(nodeId: number): void {
  const root = modelById.get(nodeId);
  if (!root || !isExpandableModel(root)) return;
  const expansion = activeExpansionSet();
  const pending: JsonTreeWebviewNode[] = [root];
  let count = 0;
  while (pending.length > 0 && count < MAX_SUBTREE_EXPAND_NODES) {
    const model = pending.pop()!;
    count += 1;
    if (!isExpandableModel(model)) continue;
    expansion.add(model.id);
    if (searchActive) searchRevealedIds.add(model.id);
    if (model.decoded !== undefined) {
      pending.push(model.decoded.root);
    } else {
      for (const child of model.children ?? []) pending.push(child.value);
    }
  }
  if (!searchActive) schedulePersist();
  rebuildVisibleRows();
}

function collapseSubtree(nodeId: number): void {
  const root = modelById.get(nodeId);
  if (!root) return;
  const expansion = activeExpansionSet();
  const pending: JsonTreeWebviewNode[] = [root];
  while (pending.length > 0) {
    const model = pending.pop()!;
    expansion.delete(model.id);
    if (model.decoded !== undefined) {
      pending.push(model.decoded.root);
    } else {
      for (const child of model.children ?? []) pending.push(child.value);
    }
  }
  if (!searchActive) schedulePersist();
  rebuildVisibleRows();
}

function collapseSiblings(nodeId: number): void {
  const parentId = parentById.get(nodeId);
  if (parentId === undefined) return;
  const parent = modelById.get(parentId);
  if (!parent) return;
  const expansion = activeExpansionSet();
  for (const child of parent.children ?? []) {
    if (child.value.id !== nodeId) expansion.delete(child.value.id);
  }
  if (!searchActive) schedulePersist();
  rebuildVisibleRows();
}

function toggleNodeManually(nodeId: number): void {
  if (treeOperationRunning || searchApplying) return;
  const model = modelById.get(nodeId);
  if (!model) return;
  if (isDecodableModel(model)) {
    requestDecode(nodeId);
    return;
  }
  if (!isExpandableModel(model)) return;
  const expansion = activeExpansionSet();
  if (expansion.has(nodeId)) {
    expansion.delete(nodeId);
  } else {
    expansion.add(nodeId);
    if (searchActive) searchRevealedIds.add(nodeId);
  }
  if (!searchActive) schedulePersist();
  rebuildVisibleRows();
}

function setSearchDecoded(enabled: boolean): void {
  searchDecoded = enabled;
  if (!searchDecodedButton) return;
  searchDecodedButton.classList.toggle("active", enabled);
  searchDecodedButton.setAttribute("aria-pressed", String(enabled));
}

function setSortKeys(enabled: boolean, rerender: boolean): void {
  sortKeys = enabled;
  if (sortKeysButton) {
    sortKeysButton.classList.toggle("active", enabled);
    sortKeysButton.setAttribute("aria-pressed", String(enabled));
  }
  if (rerender && currentRoot !== undefined) {
    rebuildVisibleRows();
  }
}

function hasDecodableString(root: JsonTreeWebviewNode): boolean {
  const pending = [root];
  while (pending.length > 0) {
    const model = pending.pop() as JsonTreeWebviewNode;
    if (model.decodable) return true;
    if (model.decoded) pending.push(model.decoded.root);
    for (const child of model.children || []) pending.push(child.value);
  }
  return false;
}

function attachDecodedToNode(
  nodeId: number,
  decoded: NonNullable<JsonTreeWebviewNode["decoded"]>,
  expand: boolean,
): void {
  decodingIds.delete(nodeId);
  const model = modelById.get(nodeId);
  if (!model || isExpandableModel(model)) return;
  model.decoded = decoded;
  delete model.decodable;
  delete model.decodableKind;
  indexSubtree(
    decoded.root,
    model.id,
    {
      label: decodedRowLabel(decoded),
      hasKey: false,
      hasRawKey: false,
      decoded: true,
    },
    (depthById.get(model.id) ?? 1) + 1,
  );
  if (!expand) return;
  const expansion = activeExpansionSet();
  expansion.add(model.id);
  expansion.add(decoded.root.id);
  if (searchActive) {
    searchRevealedIds.add(model.id);
    searchRevealedIds.add(decoded.root.id);
  } else {
    schedulePersist();
  }
  rebuildVisibleRows();
}

function markNodeNotDecodable(nodeId: number, cancelled = false): void {
  decodingIds.delete(nodeId);
  const model = modelById.get(nodeId);
  if (!cancelled && model) {
    delete model.decodable;
    delete model.decodableKind;
  }
  renderVirtualWindow(true);
}

/** Attaches strings the Host decoded for search, then searches again. */
function applyDecodedBatch(message: Extract<HostToWebviewMessage, { type: "decodedBatch" }>): void {
  if (message.renderKey !== renderKey || currentRoot === undefined) return;
  for (const item of message.items) {
    const model = modelById.get(item.nodeId);
    if (model === undefined || model.decoded !== undefined) continue;
    attachDecodedToNode(item.nodeId, item.decoded, false);
  }
  stickyStatus = message.limited
    ? t("Decoded {0} strings for search (limit reached)", message.decodedCount.toLocaleString())
    : message.decodedCount === 1
      ? t("Decoded 1 string for search")
      : t("Decoded {0} strings for search", message.decodedCount.toLocaleString());
  updateActionButtons();
  if (searchInput.value.trim()) {
    runSearch();
  } else if (message.items.length > 0) {
    renderVirtualWindow(true);
  }
}

/** Asks the Host to parse a string's embedded content; the reply attaches it inline. */
function requestDecode(nodeId: number): void {
  const model = modelById.get(nodeId);
  if (!model || !isDecodableModel(model) || decodingIds.has(nodeId)) return;
  decodingIds.add(nodeId);
  const el = renderedRowElements.get(nodeId);
  el?.children[0]?.classList.add("decoding");
  vscode.postMessage({ type: "expandDecoded", nodeId });
}

function updateActionButtons(): void {
  expandAllButton.disabled = searchActive || treeOperationRunning || !expandAllAllowed;
  if (expandDepthSelect) expandDepthSelect.disabled = searchActive || treeOperationRunning;
  collapseAllButton.disabled = false;
  searchInput.disabled = false;
  if (!treeOperationRunning) {
    treeOperationStatus.textContent = stickyStatus;
    if (pendingReveal !== undefined) revealNode(pendingReveal);
  }
}

function applyJsonlState(state: JsonlViewState): void {
  jsonlLineInput.value = String(state.lineNumber);
  jsonlTotal.textContent = " / " + Number(state.lineCount).toLocaleString();
  followCursorInput.checked = state.followCursor === true;
  if (keepViewInput && state.keepView !== undefined) keepViewInput.checked = state.keepView;
  if (jsonlFilterInput && state.filterQuery !== undefined && document.activeElement !== jsonlFilterInput) {
    jsonlFilterInput.value = state.filterQuery;
  }
  jsonlStatus.textContent = state.status || "";
  const busy = state.busy === true;
  previousJsonlButton.disabled = busy;
  nextJsonlButton.disabled = busy;
  jsonlLineInput.disabled = busy;
  goJsonlButton.disabled = busy;
  if (jsonlFilterListButton) jsonlFilterListButton.disabled = busy;
  if (jsonlTableButton) jsonlTableButton.disabled = busy;
}

function applySourceState(state: SourceViewState | undefined): void {
  if (!sourceBar) return;
  sourceBar.classList.toggle("hidden", state === undefined);
  if (state === undefined) return;
  syncCursorInput.checked = state.syncCursor;
  syncCursorInput.disabled = !state.linked;
  refreshSourceButton.classList.toggle("hidden", !state.canRefresh);
  sourceStatus.textContent = state.status;
}

function goToJsonlLine(): void {
  const lineNumber = Number(jsonlLineInput.value);
  if (!Number.isInteger(lineNumber) || lineNumber < 1) {
    jsonlLineInput.focus();
    return;
  }
  vscode.postMessage({ type: "goToJsonlLine", lineNumber });
}

function decodedRowLabel(decoded: NonNullable<JsonTreeWebviewNode["decoded"]>): string {
  switch (decoded.kind) {
    case "jwt": return t("decoded JWT");
    case "url": return t("decoded URL");
    case "base64-json": return t("decoded JSON (Base64)");
    case "base64-protobuf": return t("decoded Protobuf (Base64)");
    case "base64-text": return t("decoded text (Base64)");
    default:
      return decoded.recovered
        ? t("decoded JSON (recovered)")
        : decoded.embedded ? t("decoded JSON (from text)") : t("decoded JSON");
  }
}

function decodableToggleTitle(kind: JsonTreeWebviewNode["decodableKind"]): string {
  switch (kind) {
    case "jwt": return t("Show decoded JWT");
    case "url": return t("Show decoded URL");
    case "base64": return t("Show decoded Base64");
    default: return t("Show embedded JSON");
  }
}

function decodableMenuLabel(kind: JsonTreeWebviewNode["decodableKind"]): string {
  switch (kind) {
    case "jwt": return t("Show decoded JWT inline");
    case "url": return t("Show decoded URL inline");
    case "base64": return t("Show decoded Base64 inline");
    default: return t("Show embedded JSON inline");
  }
}

function typeLabel(type: JsonTreeWebviewNode["type"]): string {
  switch (type) {
    case "object": return "Object";
    case "array": return "Array";
    case "string": return "String";
    case "number": return "Number";
    case "boolean": return "Boolean";
    default: return "Null";
  }
}

function describeValue(model: JsonTreeWebviewNode): string {
  if (model.type === "array") return t("array, {0} items", (model.children || []).length);
  if (model.type === "object") return t("object, {0} keys", (model.children || []).length);
  return t(typeLabel(model.type)) + " " + (model.raw ?? "");
}

function appendValue(row: HTMLElement, model: JsonTreeWebviewNode, key: string, isExpanded: boolean): void {
  const span = document.createElement("span");
  if (model.type === "object" || model.type === "array") {
    span.className = "summary";
    const children = getOrderedChildren(model);
    span.textContent = model.type === "array" ? "[" + children.length + "]" : "{" + children.length + "}";
    row.appendChild(span);
    if (!isExpanded && children.length > 0 && model.id !== currentRoot?.id) {
      const preview = buildCollapsedPreview(model, children);
      if (preview.length > 0) {
        const previewSpan = document.createElement("span");
        previewSpan.className = "inline-preview";
        previewSpan.textContent = preview;
        row.appendChild(previewSpan);
      }
    }
    return;
  }

  span.className = "value " + model.type;
  span.textContent = model.raw ?? "";
  const titles: string[] = [];
  let hint: { text: string; expired?: boolean } | undefined;
  if (model.rawTruncated) {
    titles.push(t("Value shortened from {0} characters; right-click actions use the complete value", (model.rawLength ?? 0).toLocaleString()));
  }
  if (model.type === "number") {
    const timestamp = describeTimestamp(model.raw ?? "", key);
    if (timestamp !== undefined) {
      titles.push(timestamp.title);
      if (timestamp.hint !== undefined) {
        hint = { text: timestamp.hint, expired: timestamp.expired };
      }
    }
  } else if (model.type === "string") {
    const value = typeof model.value === "string" ? model.value : "";
    const length = model.valueLength ?? Array.from(value).length;
    titles.push(length === 1 ? t("1 character") : t("{0} characters", length.toLocaleString()));
    if (!model.valueTruncated) {
      const trimmed = value.trim();
      const timestamp = describeTimestamp(trimmed, key) ?? describeIsoTimestamp(trimmed, key);
      if (timestamp !== undefined) {
        titles.push(timestamp.title);
        if (timestamp.hint !== undefined) {
          hint = { text: timestamp.hint, expired: timestamp.expired };
        }
      }
    }
    if (!model.valueTruncated && isColorValue(value)) {
      const swatch = document.createElement("span");
      swatch.className = "color-swatch";
      if (swatch.style) swatch.style.backgroundColor = value.trim();
      row.appendChild(swatch);
    }
    if (!model.valueTruncated && /^https?:\/\/\S+$/i.test(value.trim())) {
      span.classList.add("link");
      titles.push(t("Cmd/Ctrl+click to open the link"));
    }
    if (model.decodable || model.decoded) {
      const isNonJson = (model.decodableKind !== undefined && model.decodableKind !== "json") ||
        (model.decoded?.kind !== undefined && model.decoded.kind !== "json");
      titles.push(isNonJson ? t("Click to show the decoded value inline") : t("Click to show the embedded JSON inline"));
    }
    titles.push(t("Right-click (or Shift+F10) to inspect or copy this string"));
  }
  span.title = titles.join("\n");
  row.appendChild(span);
  if (hint !== undefined) {
    const hintSpan = document.createElement("span");
    hintSpan.className = hint.expired ? "value-hint expired" : "value-hint";
    hintSpan.textContent = hint.text;
    row.appendChild(hintSpan);
  }
}

function buildCollapsedPreview(model: JsonTreeWebviewNode, children: JsonTreeWebviewChild[]): string {
  const maxChars = 72;
  const maxItems = 3;
  const parts: string[] = [];
  let total = 0;

  const formatShortVal = (node: JsonTreeWebviewNode): string => {
    if (node.type === "string") {
      const raw = node.raw ?? JSON.stringify(node.value ?? "");
      return raw.length > 24 ? `${raw.slice(0, 21)}…"` : raw;
    }
    if (node.type === "object") return `{${(node.children || []).length}}`;
    if (node.type === "array") return `[${(node.children || []).length}]`;
    const raw = node.raw ?? String(node.value);
    return raw.length > 24 ? `${raw.slice(0, 23)}…` : raw;
  };

  for (let index = 0; index < children.length && index < maxItems; index += 1) {
    const child = children[index];
    const val = formatShortVal(child.value);
    const segment = model.type === "object"
      ? `${String(child.key).slice(0, 20)}: ${val}`
      : val;
    if (total + segment.length > maxChars && parts.length > 0) break;
    parts.push(segment);
    total += segment.length + 2;
  }
  const hasMore = children.length > parts.length;
  return parts.join(", ") + (hasMore ? ", …" : "");
}

function formatLocalTimestamp(date: Date): string {
  const pad2 = (n: number): string => String(n).padStart(2, "0");
  const y = date.getFullYear();
  const m = pad2(date.getMonth() + 1);
  const d = pad2(date.getDate());
  const hh = pad2(date.getHours());
  const mm = pad2(date.getMinutes());
  const ss = pad2(date.getSeconds());
  const offsetMinutes = -date.getTimezoneOffset();
  let tz = "UTC";
  if (offsetMinutes !== 0) {
    const sign = offsetMinutes > 0 ? "+" : "-";
    const abs = Math.abs(offsetMinutes);
    const oh = Math.floor(abs / 60);
    const om = abs % 60;
    tz = om === 0 ? `UTC${sign}${oh}` : `UTC${sign}${oh}:${pad2(om)}`;
  }
  return `${y}-${m}-${d} ${hh}:${mm}:${ss} ${tz}`;
}

function formatRelativeTime(targetMs: number, nowMs: number): string {
  const diffSec = Math.round((targetMs - nowMs) / 1000);
  const abs = Math.abs(diffSec);
  const future = diffSec > 0;
  let label: string;
  if (abs < 5) return t("just now");
  if (abs < 60) label = `${abs}s`;
  else if (abs < 3600) label = `${Math.floor(abs / 60)}m`;
  else if (abs < 86400) label = `${Math.floor(abs / 3600)}h`;
  else if (abs < 86400 * 30) label = `${Math.floor(abs / 86400)}d`;
  else if (abs < 86400 * 365) label = `${Math.floor(abs / (86400 * 30))}mo`;
  else label = `${Math.floor(abs / (86400 * 365))}y`;
  return future ? t("in {0}", label) : t("{0} ago", label);
}

function isTimeLikeKey(key: string): boolean {
  return /(?:time|date|stamp|epoch|created|updated|modified|expire|(?:^|_)ts(?:$|_)|_at$|^iat$|^nbf$|^exp$|_ms$|_sec$)/i.test(key) ||
    /(?:At|Ts|Ms)$/.test(key);
}

function isExpiryKey(key: string): boolean {
  return /^(?:exp|expires?_?(?:at|time|on)?|expireAt|expiresAt|expiredAt)$/i.test(key);
}

function formatTimestampHint(
  milliseconds: number,
  key: string,
  alwaysInline: boolean,
): { title: string; hint?: string; expired?: boolean } {
  const date = new Date(milliseconds);
  const iso = date.toISOString().replace(".000Z", "Z");
  const localText = formatLocalTimestamp(date);
  const nowMs = Date.now();
  const relative = formatRelativeTime(milliseconds, nowMs);
  const expired = isExpiryKey(key) && milliseconds < nowMs;
  const showInline = alwaysInline || isTimeLikeKey(key);
  let hint: string | undefined;
  if (showInline) {
    hint = `${localText} · ${relative}`;
    if (expired) hint += ` · ${t("expired")}`;
  }
  return {
    title: t("Timestamp: {0} UTC · {1} ({2})", iso, localText, relative),
    hint,
    expired,
  };
}

/** Plausible Unix timestamps (2000–2100) in seconds, milliseconds, microseconds, or nanoseconds. */
function describeTimestamp(raw: string, key: string): { title: string; hint?: string; expired?: boolean } | undefined {
  let milliseconds: number;
  if (/^\d{10}(?:\.\d+)?$/.test(raw)) milliseconds = Number(raw) * 1000;
  else if (/^\d{13}$/.test(raw)) milliseconds = Number(raw);
  else if (/^\d{16}$/.test(raw)) milliseconds = Math.trunc(Number(raw) / 1_000);
  else if (/^\d{19}$/.test(raw)) milliseconds = Math.trunc(Number(raw.slice(0, 13)));
  else return undefined;
  if (milliseconds < Date.UTC(2000, 0, 1) || milliseconds >= Date.UTC(2100, 0, 1)) return undefined;
  return formatTimestampHint(milliseconds, key, false);
}

const ISO_DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|z|([+-])(\d{2}):?(\d{2}))$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** Parses strict timezone-aware ISO-8601 date-time strings and converts to local & relative time. */
function describeIsoTimestamp(value: string, key: string): { title: string; hint?: string; expired?: boolean } | undefined {
  if (value.length < 20 || value.length > 40) return undefined;
  const match = ISO_DATETIME_RE.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (
    year < 1970 ||
    year > 2100 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return undefined;
  }
  const fracMs = match[7] ? Number(match[7].slice(0, 3).padEnd(3, "0")) : 0;
  let tzMinutes = 0;
  if (match[9] !== undefined) {
    const tzH = Number(match[10]);
    const tzM = Number(match[11]);
    if (tzH > 23 || tzM > 59) return undefined;
    tzMinutes = (match[9] === "-" ? -1 : 1) * (tzH * 60 + tzM);
  }
  const ms = Date.UTC(year, month - 1, day, hour, minute, second, fracMs) - tzMinutes * 60_000;
  if (!Number.isFinite(ms)) return undefined;
  return formatTimestampHint(ms, key, true);
}

function isColorValue(value: string): boolean {
  const text = value.trim();
  return /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(text) ||
    /^(?:rgb|hsl)a?\([^()]{1,60}\)$/i.test(text);
}

// Breadcrumb & Keyboard navigation

function buildAncestry(nodeId: number): number[] {
  const ids: number[] = [];
  let current: number | undefined = nodeId;
  while (current !== undefined) {
    ids.push(current);
    current = parentById.get(current);
  }
  return ids.reverse();
}

function updateBreadcrumb(nodeId: number | undefined): void {
  if (!breadcrumbSegments) return;
  if (nodeId === undefined || !modelById.has(nodeId)) {
    breadcrumbSegments.replaceChildren();
    if (breadcrumbCopyJsonPath) breadcrumbCopyJsonPath.disabled = true;
    if (breadcrumbCopyJq) breadcrumbCopyJq.disabled = true;
    return;
  }
  if (breadcrumbCopyJsonPath) breadcrumbCopyJsonPath.disabled = false;
  if (breadcrumbCopyJq) breadcrumbCopyJq.disabled = false;

  const ancestry = buildAncestry(nodeId);
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < ancestry.length; index += 1) {
    const id = ancestry[index];
    const edge = edgeById.get(id);
    if (index > 0) {
      const sep = document.createElement("span");
      sep.className = "breadcrumb-sep";
      sep.textContent = edge?.decoded ? "⟩" : "›";
      fragment.appendChild(sep);
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = edge?.decoded ? "breadcrumb-segment decoded" : "breadcrumb-segment";
    button.setAttribute("data-node-id", String(id));
    const parentModel = parentById.get(id) !== undefined ? modelById.get(parentById.get(id)!) : undefined;
    const rawLabel = edge?.label ?? "$";
    const text = index === 0
      ? "$"
      : parentModel?.type === "array"
        ? `[${rawLabel}]`
        : rawLabel;
    button.textContent = text.length > 32 ? `${text.slice(0, 31)}…` : text;
    button.title = rawLabel;
    fragment.appendChild(button);
  }
  breadcrumbSegments.replaceChildren(fragment);
  if (breadcrumbBar) breadcrumbBar.classList.remove("hidden");
}

function focusNodeById(nodeId: number): void {
  const ancestry = buildAncestry(nodeId);
  const expansion = activeExpansionSet();
  for (let index = 0; index < ancestry.length - 1; index += 1) {
    expansion.add(ancestry[index]);
    if (searchActive) searchRevealedIds.add(ancestry[index]);
  }
  rebuildVisibleRows();
  setFocusedNode(nodeId, true);
}

function setFocusedNode(nodeId: number, focus = true): void {
  const previousId = focusedNodeId;
  focusedNodeId = nodeId;

  if (previousId !== undefined && previousId !== nodeId) {
    const prevEl = renderedRowElements.get(previousId);
    if (prevEl) prevEl.tabIndex = -1;
  }

  if (focus) {
    const rowIndex = rowIndexById.get(nodeId);
    if (rowIndex !== undefined) ensureRowVisible(rowIndex);
    const el = renderedRowElements.get(nodeId);
    if (el) {
      el.tabIndex = 0;
      el.focus();
    }
  } else {
    const el = renderedRowElements.get(nodeId);
    if (el) el.tabIndex = 0;
  }

  updateBreadcrumb(nodeId);
}

function handleTreeKeydown(event: KeyboardEvent): void {
  if (focusedNodeId === undefined || visibleRows.length === 0) return;
  const currentIndex = rowIndexById.get(focusedNodeId);
  if (currentIndex === undefined) return;
  const currentRow = visibleRows[currentIndex];
  const model = currentRow.model;
  const expandable = isExpandableModel(model);
  const decodable = isDecodableModel(model);

  if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "c") {
    const selectedText = window.getSelection?.()?.toString() ?? "";
    if (selectedText.length === 0) {
      event.preventDefault();
      if (event.shiftKey) {
        postNodeAction("copyJsonPath", focusedNodeId);
      } else {
        postNodeAction(model.type === "string" ? "copyDecodedString" : "copyValue", focusedNodeId);
      }
    }
    return;
  }

  let targetId: number | undefined;
  switch (event.key) {
    case "ArrowDown":
      targetId = visibleRows[currentIndex + 1]?.id;
      break;
    case "ArrowUp":
      targetId = visibleRows[currentIndex - 1]?.id;
      break;
    case "PageDown": {
      const viewportHeight = typeof tree.clientHeight === "number" && tree.clientHeight > 0 ? tree.clientHeight : 600;
      const step = Math.max(1, Math.floor(viewportHeight / ROW_HEIGHT) - 1);
      targetId = visibleRows[Math.min(visibleRows.length - 1, currentIndex + step)]?.id;
      break;
    }
    case "PageUp": {
      const viewportHeight = typeof tree.clientHeight === "number" && tree.clientHeight > 0 ? tree.clientHeight : 600;
      const step = Math.max(1, Math.floor(viewportHeight / ROW_HEIGHT) - 1);
      targetId = visibleRows[Math.max(0, currentIndex - step)]?.id;
      break;
    }
    case "ArrowRight":
      if ((expandable && !isExpandedId(focusedNodeId)) || decodable) {
        toggleNodeManually(focusedNodeId);
      } else if (expandable && isExpandedId(focusedNodeId)) {
        const nextRow = visibleRows[currentIndex + 1];
        if (nextRow && parentById.get(nextRow.id) === focusedNodeId) {
          targetId = nextRow.id;
        }
      }
      break;
    case "ArrowLeft":
      if (expandable && isExpandedId(focusedNodeId)) {
        toggleNodeManually(focusedNodeId);
      } else {
        targetId = parentById.get(focusedNodeId);
      }
      break;
    case "Home":
      targetId = visibleRows[0]?.id;
      break;
    case "End":
      targetId = visibleRows[visibleRows.length - 1]?.id;
      break;
    case "Enter":
    case " ":
      if (expandable || decodable) toggleNodeManually(focusedNodeId);
      else openKeyboardMenu(focusedNodeId);
      break;
    case "ContextMenu":
      openKeyboardMenu(focusedNodeId);
      break;
    case "F10":
      if (!event.shiftKey) return;
      openKeyboardMenu(focusedNodeId);
      break;
    default:
      return;
  }
  event.preventDefault();
  if (targetId !== undefined) setFocusedNode(targetId, true);
}

function openKeyboardMenu(nodeId: number): void {
  const rowIndex = rowIndexById.get(nodeId);
  if (rowIndex !== undefined) ensureRowVisible(rowIndex);
  const el = renderedRowElements.get(nodeId);
  const rowEl = el?.children[0] as HTMLElement | undefined;
  const rect = rowEl?.getBoundingClientRect?.() ?? { left: 0, bottom: 0 };
  showMenu(rect.left ?? 0, rect.bottom ?? 0, nodeId, true);
}

/**
 * Expands the path to a node and highlights it without taking keyboard focus,
 * so following the editor cursor never interrupts typing.
 */
function revealNode(ids: number[]): void {
  if (treeOperationRunning) {
    pendingReveal = ids;
    return;
  }
  pendingReveal = undefined;
  if (!currentRoot || ids.length === 0 || ids[0] !== currentRoot.id || searchActive) return;

  for (let index = 0; index < ids.length - 1; index += 1) {
    const id = ids[index];
    const model = modelById.get(id);
    if (model && isExpandableModel(model)) {
      expandedIds.add(id);
    }
  }
  const targetId = ids[ids.length - 1];
  cursorSyncedNodeId = targetId;
  rebuildVisibleRows();
  const rowIndex = rowIndexById.get(targetId);
  if (rowIndex !== undefined) {
    ensureRowVisible(rowIndex);
  }
  setFocusedNode(targetId, false);
  schedulePersist();
}

function showMenu(
  x: number,
  y: number,
  nodeId: number,
  fromKeyboard: boolean,
): void {
  const model = modelById.get(nodeId);
  if (!model) return;
  const edgeInfo = edgeById.get(nodeId);
  const parentId = parentById.get(nodeId);

  menu.replaceChildren();
  menuOriginId = nodeId;
  if (sourceRevealable) {
    addMenuItem(t("Reveal in source"), () => vscode.postMessage({ type: "revealInSource", nodeId: model.id }));
    addSeparator();
  }
  if (model.type === "string") {
    if (isDecodableModel(model)) {
      addMenuItem(decodableMenuLabel(model.decodableKind), () => requestDecode(model.id));
    }
    addMenuItem(t("Open as nested JSON tree"), () => vscode.postMessage({ type: "openNested", nodeId: model.id }));
    addMenuItem(t("Open parsed JSON in new editor"), () => vscode.postMessage({ type: "openParsedJson", nodeId: model.id }));
    addMenuItem(t("Open decoded string value in new editor"), () => vscode.postMessage({ type: "openDecodedValue", nodeId: model.id }));
    if (!model.valueTruncated && typeof model.value === "string" && /^https?:\/\/\S+$/i.test(model.value.trim())) {
      addMenuItem(t("Open link"), () => vscode.postMessage({ type: "openLink", nodeId: model.id }));
    }
    addSeparator();
    addMenuItem(t("Copy raw JSON string (escaped)"), () => vscode.postMessage({ type: "copyRawString", nodeId: model.id }));
    addMenuItem(t("Copy decoded string value"), () => vscode.postMessage({ type: "copyDecodedString", nodeId: model.id }));
    addSeparator();
  } else {
    addMenuItem(t("Copy value"), () => vscode.postMessage({ type: "copyValue", nodeId: model.id }));
  }

  if (isExpandableModel(model)) {
    addMenuItem(t("Expand subtree"), () => expandSubtree(model.id));
    addMenuItem(t("Collapse subtree"), () => collapseSubtree(model.id));
  }
  if (parentId !== undefined) {
    addMenuItem(t("Collapse sibling branches"), () => collapseSiblings(model.id));
  }
  if (model.type === "object" || model.type === "array") {
    addMenuItem(t("Open subtree as new tree"), () => vscode.postMessage({ type: "openSubtree", nodeId: model.id }));
    addMenuItem(t("Open formatted JSON in new editor"), () => vscode.postMessage({ type: "openFormattedJson", nodeId: model.id }));
    if (
      model.type === "array" &&
      (model.children?.length ?? 0) > 0 &&
      model.children!.some((child) => child.value.type === "object")
    ) {
      addMenuItem(t("View as table"), () => vscode.postMessage({ type: "openArrayTable", nodeId: model.id }));
    }
    addSeparator();
  } else if (model.decoded !== undefined) {
    addSeparator();
  }

  if (edgeInfo?.hasKey) {
    addMenuItem(t("Copy key"), () => vscode.postMessage({ type: "copyKey", nodeId: model.id }));
  }
  if (edgeInfo?.hasRawKey) {
    addMenuItem(t("Copy raw key token"), () => vscode.postMessage({ type: "copyRawKey", nodeId: model.id }));
  }
  addMenuItem(t("Copy JSON path"), () => vscode.postMessage({ type: "copyJsonPath", nodeId: model.id }));
  addMenuItem(t("Copy jq path"), () => vscode.postMessage({ type: "copyJqPath", nodeId: model.id }));

  menu.classList.remove("hidden");
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)) + "px";
  menu.style.top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4)) + "px";
  if (fromKeyboard) menuItems()[0]?.focus();
}

function menuItems(): HTMLElement[] {
  return Array.from(menu.querySelectorAll<HTMLElement>(".menu-item"));
}

function handleMenuKeydown(event: KeyboardEvent): void {
  const items = menuItems();
  const index = items.indexOf(document.activeElement as HTMLElement);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const delta = event.key === "ArrowDown" ? 1 : -1;
    items[(index + delta + items.length) % items.length]?.focus();
  } else if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    items[index]?.click();
  } else if (event.key === "Escape" || event.key === "Tab") {
    event.preventDefault();
    event.stopPropagation();
    hideMenu(true);
  }
}

function addMenuItem(label: string, action: () => void): void {
  const item = document.createElement("div");
  item.className = "menu-item";
  item.setAttribute("role", "menuitem");
  item.tabIndex = -1;
  item.textContent = label;
  item.addEventListener("click", (event: MouseEvent) => {
    event.stopPropagation();
    hideMenu(true);
    action();
  });
  menu.appendChild(item);
}

function addSeparator(): void {
  const separator = document.createElement("div");
  separator.className = "menu-separator";
  separator.setAttribute("role", "separator");
  menu.appendChild(separator);
}

function hideMenu(restoreFocus = false): void {
  const wasOpen = !menu.classList.contains("hidden");
  menu.classList.add("hidden");
  if (wasOpen && restoreFocus && menuOriginId !== undefined) setFocusedNode(menuOriginId, true);
  menuOriginId = undefined;
}

// Table View

function openTableView(table: TableModel): void {
  currentTable = table;
  tableSortColumn = -1;
  tableSortAsc = true;
  if (tableFilterInput) tableFilterInput.value = "";
  if (tableTitle) tableTitle.textContent = table.title;
  tree.classList.add("hidden");
  emptySearch.classList.add("hidden");
  tableView?.classList.remove("hidden");
  renderTableHeader();
  renderTableRows();
}

function closeTableView(restoreFocus: boolean): void {
  if (!tableView || tableView.classList.contains("hidden")) return;
  tableView.classList.add("hidden");
  tree.classList.remove("hidden");
  if (restoreFocus && focusedNodeId !== undefined) {
    setFocusedNode(focusedNodeId, true);
  }
}

function renderTableHeader(): void {
  if (!dataTable || !currentTable) return;
  const thead = dataTable.querySelector("thead");
  if (!thead) return;
  const tr = document.createElement("tr");
  const indexTh = document.createElement("th");
  indexTh.textContent = "#";
  tr.appendChild(indexTh);

  for (let colIndex = 0; colIndex < currentTable.columns.length; colIndex += 1) {
    const th = document.createElement("th");
    th.setAttribute("data-col-index", String(colIndex));
    const indicator = tableSortColumn === colIndex ? (tableSortAsc ? " ▲" : " ▼") : "";
    th.textContent = currentTable.columns[colIndex] + indicator;
    th.title = currentTable.columns[colIndex];
    tr.appendChild(th);
  }
  thead.replaceChildren(tr);
}

function renderTableRows(): void {
  if (!dataTable || !currentTable) return;
  const tbody = dataTable.querySelector("tbody");
  if (!tbody) return;

  const filterNeedle = (tableFilterInput?.value ?? "").trim().toLowerCase();
  const indices: number[] = [];
  for (let index = 0; index < currentTable.rows.length; index += 1) {
    const row = currentTable.rows[index];
    if (
      filterNeedle.length === 0 ||
      row.rowLabel.toLowerCase().includes(filterNeedle) ||
      row.cells.some((cell) => cell.toLowerCase().includes(filterNeedle))
    ) {
      indices.push(index);
    }
  }

  if (tableSortColumn >= 0 && tableSortColumn < currentTable.columns.length) {
    const col = tableSortColumn;
    const dir = tableSortAsc ? 1 : -1;
    indices.sort((a, b) => {
      const av = currentTable!.rows[a].cells[col] ?? "";
      const bv = currentTable!.rows[b].cells[col] ?? "";
      const an = av.length > 0 ? Number(av) : Number.NaN;
      const bn = bv.length > 0 ? Number(bv) : Number.NaN;
      if (!Number.isNaN(an) && !Number.isNaN(bn)) {
        return an === bn ? a - b : (an - bn) * dir;
      }
      if (av === bv) return a - b;
      return av < bv ? -dir : dir;
    });
  }

  tableVisibleRowIndices = indices;
  if (tableCount) {
    const base = indices.length === currentTable.rows.length
      ? t("{0} rows", currentTable.rows.length.toLocaleString())
      : t("{0} / {1} rows", indices.length.toLocaleString(), currentTable.rows.length.toLocaleString());
    tableCount.textContent = currentTable.truncated ? `${base} (${t("truncated")})` : base;
  }

  const fragment = document.createDocumentFragment();
  for (const rowIndex of indices) {
    const row = currentTable.rows[rowIndex];
    const tr = document.createElement("tr");
    tr.setAttribute("data-row-index", String(rowIndex));
    const numTd = document.createElement("td");
    numTd.className = "table-row-num";
    numTd.textContent = row.rowLabel;
    tr.appendChild(numTd);
    for (const cell of row.cells) {
      const td = document.createElement("td");
      td.textContent = cell;
      td.title = cell;
      tr.appendChild(td);
    }
    fragment.appendChild(tr);
  }
  tbody.replaceChildren(fragment);
}

// Structural paths (object key + occurrence, array index, "decoded" for decoded
// strings) identify nodes across a re-parse even when sibling keys shift.

function captureViewByStructure(): { expandedPaths: WebviewPathStep[][]; scrollTop: number } {
  const wanted = new Set(expandedIds);
  const expandedPaths: WebviewPathStep[][] = [];
  if (currentRoot !== undefined && wanted.size > 0) {
    type Frame =
      | { kind: "enter"; model: JsonTreeWebviewNode; step?: WebviewPathStep }
      | { kind: "exit" };
    const path: WebviewPathStep[] = [];
    const stack: Frame[] = [{ kind: "enter", model: currentRoot }];
    while (stack.length > 0) {
      const frame = stack.pop() as Frame;
      if (frame.kind === "exit") {
        path.pop();
        continue;
      }
      if (frame.step !== undefined) {
        path.push(frame.step);
        stack.push({ kind: "exit" });
      }
      const model = frame.model;
      if (wanted.has(model.id)) expandedPaths.push(path.slice());
      if (model.decoded) {
        stack.push({ kind: "enter", model: model.decoded.root, step: "decoded" });
      }
      const children = model.children;
      if (children !== undefined && children.length > 0) {
        if (model.type === "object") {
          const counts = new Map<string, number>();
          const steps: WebviewPathStep[] = new Array(children.length);
          for (let index = 0; index < children.length; index += 1) {
            const key = String(children[index].key);
            const occurrence = counts.get(key) ?? 0;
            counts.set(key, occurrence + 1);
            steps[index] = { key, occurrence };
          }
          for (let index = children.length - 1; index >= 0; index -= 1) {
            stack.push({ kind: "enter", model: children[index].value, step: steps[index] });
          }
        } else {
          for (let index = children.length - 1; index >= 0; index -= 1) {
            stack.push({ kind: "enter", model: children[index].value, step: index });
          }
        }
      }
    }
  }
  return { expandedPaths, scrollTop: tree.scrollTop };
}

function resolveStructuralPaths(paths: WebviewPathStep[][]): number[] {
  const ids: number[] = [];
  for (const path of paths) {
    let model: JsonTreeWebviewNode | undefined = currentRoot;
    for (const step of path) {
      if (step === "decoded") {
        model = model?.decoded?.root;
      } else if (typeof step === "number") {
        model = model?.children?.[step]?.value;
      } else if (model?.type === "object" && model.children !== undefined) {
        let seen = 0;
        let found: JsonTreeWebviewNode | undefined;
        for (const child of model.children) {
          if (String(child.key) === step.key) {
            if (seen === step.occurrence) {
              found = child.value;
              break;
            }
            seen += 1;
          }
        }
        model = found;
      } else {
        model = undefined;
      }
      if (model === undefined) break;
    }
    if (model !== undefined) ids.push(model.id);
  }
  return ids;
}

// View state persistence lets the panel drop retainContextWhenHidden.

function loadViewState(key: number): SavedViewState | undefined {
  const saved = vscode.getState?.() as SavedViewState | undefined;
  return saved && saved.renderKey === key && Array.isArray(saved.expanded) ? saved : undefined;
}

function schedulePersist(): void {
  if (persistScheduled || typeof vscode.setState !== "function") return;
  persistScheduled = true;
  setTimeout(() => {
    persistScheduled = false;
    vscode.setState?.({
      renderKey,
      expanded: [...expandedIds],
      query: searchInput.value,
      scrollTop: tree.scrollTop,
      searchDecoded,
      sortKeys,
    } satisfies SavedViewState);
  }, 250);
}

vscode.postMessage({ type: "ready" });

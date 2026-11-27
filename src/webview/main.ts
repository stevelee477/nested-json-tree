import type { JsonTreeWebviewChild, JsonTreeWebviewNode } from "../jsonTree";
import type {
  HostToWebviewMessage,
  JsonlViewState,
  NodeAction,
  NodeInspectionMessage,
  PanelSourceDescriptor,
  RenderDiffPayload,
  RenderMessage,
  SourceViewState,
  WebviewToHostMessage,
} from "../protocol";
import {
  advanceJsonTreeSearch,
  createJsonTreeSearchState,
  type JsonTreeSearchOptions,
  type JsonTreeSearchScope,
  type JsonTreeSearchState,
} from "../search";
import type { TableModel } from "../tableData";

interface VsCodeApi {
  postMessage(message: WebviewToHostMessage): void;
  getState?(): unknown;
  setState?(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

type SearchScope = JsonTreeSearchScope;

type WebviewPathStep = number | { key: string; occurrence: number } | "decoded";

/** Survives the Webview being discarded while its tab is hidden. */
interface SavedViewState {
  renderKey: number;
  expanded: number[];
  expandedPaths?: WebviewPathStep[][];
  query: string;
  scrollTop: number;
  searchDecoded?: boolean;
  searchCaseSensitive?: boolean;
  searchRegex?: boolean;
  searchScope?: SearchScope;
  sortKeys?: boolean;
  pinnedPaths?: WebviewPathStep[][];
  inspectorOpen?: boolean;
  inspectorWrap?: boolean;
  panelSource?: PanelSourceDescriptor;
  kind?: PanelSourceDescriptor["kind"];
  uri?: string;
  lineNumber?: number;
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

const ROW_HEIGHT = 22;
const OVERSCAN_ROWS = 15;
const TREE_OPERATION_CHUNK_SIZE = 500;
const MAX_SUBTREE_EXPAND_NODES = 50_000;
const TABLE_VIRTUALIZE_THRESHOLD = 100;
const TABLE_ROW_HEIGHT = 27;
const TABLE_OVERSCAN_ROWS = 20;
const TABLE_FILTER_DEBOUNCE_MS = 80;

const STRICT_NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const STRICT_INT_RE = /^-?(?:0|[1-9]\d*)$/;

const strings = readL10nBundle();
const vscode = acquireVsCodeApi();
const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const tree = byId<HTMLElement>("tree");
const menu = byId<HTMLDivElement>("menu");
const searchInput = byId<HTMLInputElement>("search-input");
const searchCaseButton = byId<HTMLButtonElement>("search-case");
const searchRegexButton = byId<HTMLButtonElement>("search-regex");
const searchScopeSelect = byId<HTMLSelectElement>("search-scope");
const searchScopeWarning = byId<HTMLElement>("search-scope-warning");
const searchCount = byId<HTMLElement>("search-count");
const previousMatchButton = byId<HTMLButtonElement>("previous-match");
const nextMatchButton = byId<HTMLButtonElement>("next-match");
const clearSearchButton = byId<HTMLButtonElement>("clear-search");
const diffClipboardButton = byId<HTMLButtonElement>("diff-clipboard");
const toggleInspectorButton = byId<HTMLButtonElement>("toggle-inspector");
const expandAllButton = byId<HTMLButtonElement>("expand-all");
const collapseAllButton = byId<HTMLButtonElement>("collapse-all");
const expandDepthSelect = byId<HTMLSelectElement>("expand-depth");
const sortKeysButton = byId<HTMLButtonElement>("sort-keys");
const emptySearch = byId<HTMLElement>("empty-search");
const recoveryWarning = byId<HTMLElement>("recovery-warning");
const diffBar = byId<HTMLElement>("diff-bar");
const diffAddedCount = byId<HTMLElement>("diff-added-count");
const diffRemovedCount = byId<HTMLElement>("diff-removed-count");
const diffChangedCount = byId<HTMLElement>("diff-changed-count");
const diffUnchangedCount = byId<HTMLElement>("diff-unchanged-count");
const diffChangesOnlyInput = byId<HTMLInputElement>("diff-changes-only");
const treeOperationStatus = byId<HTMLElement>("tree-operation-status");
const jsonlBar = byId<HTMLElement>("jsonl-bar");
const previousJsonlButton = byId<HTMLButtonElement>("previous-jsonl");
const nextJsonlButton = byId<HTMLButtonElement>("next-jsonl");
const jsonlDiffPrevButton = byId<HTMLButtonElement>("jsonl-diff-prev");
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
const pinnedBar = byId<HTMLElement>("pinned-bar");
const pinnedChips = byId<HTMLElement>("pinned-chips");
const pinnedClearButton = byId<HTMLButtonElement>("pinned-clear");
const breadcrumbBar = byId<HTMLElement>("breadcrumb-bar");
const breadcrumbSegments = byId<HTMLElement>("breadcrumb-segments");
const breadcrumbCopyJsonPath = byId<HTMLButtonElement>("breadcrumb-copy-jsonpath");
const breadcrumbCopyJq = byId<HTMLButtonElement>("breadcrumb-copy-jq");
const inspectorDrawer = byId<HTMLElement>("inspector-drawer");
const inspectorPath = byId<HTMLElement>("inspector-path");
const inspectorMeta = byId<HTMLElement>("inspector-meta");
const inspectorWrapButton = byId<HTMLButtonElement>("inspector-wrap");
const inspectorCopyButton = byId<HTMLButtonElement>("inspector-copy");
const inspectorCloseButton = byId<HTMLButtonElement>("inspector-close");
const inspectorContent = byId<HTMLElement>("inspector-content");
const tableView = byId<HTMLElement>("table-view");
const tableTitle = byId<HTMLElement>("table-title");
const tableFilterInput = byId<HTMLInputElement>("table-filter");
const tableCount = byId<HTMLElement>("table-count");
const tableFlattenButton = byId<HTMLButtonElement>("table-flatten");
const tableCopyCsvButton = byId<HTMLButtonElement>("table-copy-csv");
const tableCopyTsvButton = byId<HTMLButtonElement>("table-copy-tsv");
const tableCopyMdButton = byId<HTMLButtonElement>("table-copy-md");
const tableExportCsvButton = byId<HTMLButtonElement>("table-export-csv");
const tableCloseButton = byId<HTMLButtonElement>("table-close");
const tableContainer = byId<HTMLElement>("table-container");
const dataTable = byId<HTMLTableElement>("data-table");

const treeSpacerTop = createSpacer();
const treeRowsContainer = createRowsContainer();
const treeSpacerBottom = createSpacer();
tree.replaceChildren(treeSpacerTop, treeRowsContainer, treeSpacerBottom);

let currentRoot: JsonTreeWebviewNode | undefined;
let renderKey = -1;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let jsonlFilterTimer: ReturnType<typeof setTimeout> | undefined;
let tableFilterTimer: ReturnType<typeof setTimeout> | undefined;
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
let searchCaseSensitive = false;
let searchRegex = false;
let searchScope: SearchScope = "all";
let sortKeys = false;
let decodeRequestedFor = -1;
let stickyStatus = "";
let currentPanelSource: PanelSourceDescriptor | undefined;

let currentDiff: RenderDiffPayload | undefined;
let diffChangesOnly = false;
let diffBranchIds = new Set<number>();
const diffRevealedIds = new Set<number>();

let pinnedPaths: WebviewPathStep[][] = [];
let inspectorOpen = false;
let inspectorWrap = true;
let lastInspectedNodeId: number | undefined;

// Dense node-indexed arrays replace per-node Map hash tables for 500k-node trees.
let modelById: Array<JsonTreeWebviewNode | undefined> = [];
let parentById = new Int32Array(0);
let edgeById: Array<EdgeInfo | undefined> = [];
let depthById = new Int32Array(0);

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
let tableFlatten = false;
let tableRenderedStart = -1;
let tableRenderedEnd = -1;

function getModel(id: number): JsonTreeWebviewNode | undefined {
  return id >= 0 && id < modelById.length ? modelById[id] : undefined;
}

function getParentId(id: number): number | undefined {
  if (id < 0 || id >= parentById.length) return undefined;
  const parent = parentById[id];
  return parent >= 0 ? parent : undefined;
}

function getEdge(id: number): EdgeInfo | undefined {
  return id >= 0 && id < edgeById.length ? edgeById[id] : undefined;
}

function getDepth(id: number): number {
  return id >= 0 && id < depthById.length ? depthById[id] : 0;
}

function ensureNodeIndexCapacity(minCapacity: number): void {
  if (minCapacity <= parentById.length) {
    if (modelById.length < minCapacity) modelById.length = minCapacity;
    if (edgeById.length < minCapacity) edgeById.length = minCapacity;
    return;
  }
  let nextCap = Math.max(64, parentById.length);
  while (nextCap < minCapacity) nextCap *= 2;

  const nextParents = new Int32Array(nextCap);
  nextParents.fill(-1);
  nextParents.set(parentById);
  parentById = nextParents;

  const nextDepths = new Int32Array(nextCap);
  nextDepths.set(depthById);
  depthById = nextDepths;

  modelById.length = minCapacity;
  edgeById.length = minCapacity;
}

function findMaxNodeId(root: JsonTreeWebviewNode): number {
  let maxId = root.id;
  const stack: JsonTreeWebviewNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.id > maxId) maxId = node.id;
    if (node.decoded !== undefined) stack.push(node.decoded.root);
    const children = node.children;
    if (children !== undefined) {
      for (let index = 0; index < children.length; index += 1) {
        stack.push(children[index].value);
      }
    }
  }
  return maxId;
}

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
    case "nodeInspection":
      applyNodeInspection(message);
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
  const maxId = findMaxNodeId(root);
  modelById = new Array<JsonTreeWebviewNode | undefined>(maxId + 1);
  edgeById = new Array<EdgeInfo | undefined>(maxId + 1);
  parentById = new Int32Array(maxId + 1);
  parentById.fill(-1);
  depthById = new Int32Array(maxId + 1);
  sortedChildrenCache = new WeakMap<JsonTreeWebviewNode, JsonTreeWebviewChild[]>();
  indexSubtree(root, undefined, { label: "$", hasKey: false, hasRawKey: false }, 1);
}

function indexSubtree(
  root: JsonTreeWebviewNode,
  rootParentId: number | undefined,
  rootEdge: EdgeInfo | undefined,
  rootDepth: number,
): void {
  const maxId = findMaxNodeId(root);
  ensureNodeIndexCapacity(maxId + 1);
  const pending: Array<{
    model: JsonTreeWebviewNode;
    parentId: number | undefined;
    edge: EdgeInfo | undefined;
    depth: number;
  }> = [{ model: root, parentId: rootParentId, edge: rootEdge, depth: rootDepth }];

  while (pending.length > 0) {
    const { model, parentId, edge, depth } = pending.pop()!;
    const id = model.id;
    if (id >= parentById.length) ensureNodeIndexCapacity(id + 1);
    modelById[id] = model;
    parentById[id] = parentId ?? -1;
    edgeById[id] = edge;
    depthById[id] = depth;

    if (model.decoded !== undefined) {
      pending.push({
        model: model.decoded.root,
        parentId: id,
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
        parentId: id,
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

function computeDiffBranchIds(diff: RenderDiffPayload | undefined): Set<number> {
  const branches = new Set<number>();
  if (!diff) return branches;
  for (const rawId of Object.keys(diff.annotations)) {
    const id = Number(rawId);
    if (!Number.isSafeInteger(id)) continue;
    let current: number | undefined = id;
    while (current !== undefined && !branches.has(current)) {
      branches.add(current);
      current = getParentId(current);
    }
  }
  return branches;
}

function applyDiffState(diff: RenderDiffPayload | undefined): void {
  currentDiff = diff;
  diffRevealedIds.clear();
  diffBranchIds = computeDiffBranchIds(diff);
  if (!diffBar) return;
  diffBar.classList.toggle("hidden", diff === undefined);
  if (diff === undefined) {
    diffChangesOnly = false;
    if (diffChangesOnlyInput) diffChangesOnlyInput.checked = false;
    return;
  }
  if (diffAddedCount) {
    diffAddedCount.textContent = `+${diff.summary.added.toLocaleString()}`;
    diffAddedCount.title = t("{0} added", diff.summary.added.toLocaleString());
  }
  if (diffRemovedCount) {
    diffRemovedCount.textContent = `-${diff.summary.removed.toLocaleString()}`;
    diffRemovedCount.title = t("{0} removed", diff.summary.removed.toLocaleString());
  }
  if (diffChangedCount) {
    diffChangedCount.textContent = `~${diff.summary.changed.toLocaleString()}`;
    diffChangedCount.title = t("{0} changed", diff.summary.changed.toLocaleString());
  }
  if (diffUnchangedCount) {
    diffUnchangedCount.textContent = t("{0} unchanged", diff.summary.unchanged.toLocaleString());
  }
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
  lastInspectedNodeId = undefined;
  stickyStatus = "";
  decodingIds.clear();
  searchExactIds = new Set<number>();
  searchBranchIds = new Set<number>();
  searchExpandedIds.clear();
  searchRevealedIds.clear();
  searchCount.textContent = "";
  searchCount.title = "";
  searchCount.classList.remove("search-error");
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

  const loaded = renderKey === -1 ? loadViewState(message) : undefined;
  const saved = loaded?.saved;
  renderKey = message.renderKey;
  currentRoot = message.root;
  if (message.panelSource !== undefined) currentPanelSource = message.panelSource;
  expandAllAllowed = message.canExpandAll;
  expandAllLimitValue = message.expandAllLimit;
  expandedIds.clear();
  indexModelTree(currentRoot);
  applyDiffState(message.diff);

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
  if (saved?.searchCaseSensitive !== undefined) setSearchCaseSensitive(saved.searchCaseSensitive);
  if (saved?.searchRegex !== undefined) setSearchRegex(saved.searchRegex);
  if (saved?.searchScope !== undefined) setSearchScope(saved.searchScope);
  if (saved?.sortKeys !== undefined) setSortKeys(saved.sortKeys, false);
  if (Array.isArray(saved?.pinnedPaths)) pinnedPaths = saved.pinnedPaths;
  if (saved?.inspectorWrap !== undefined) setInspectorWrap(saved.inspectorWrap);
  if (saved?.inspectorOpen !== undefined) setInspectorOpen(saved.inspectorOpen, false);

  const restore = snapshot !== undefined
    ? { query: searchInput.value, expanded: resolveStructuralPaths(snapshot.expandedPaths), scrollTop: snapshot.scrollTop }
    : saved !== undefined
      ? {
          query: saved.query,
          expanded: loaded?.revivedBySource && Array.isArray(saved.expandedPaths)
            ? resolveStructuralPaths(saved.expandedPaths)
            : saved.expanded,
          scrollTop: saved.scrollTop,
        }
      : undefined;

  setFocusedNode(currentRoot.id, false);
  tree.scrollTop = 0;

  if (restore) {
    searchInput.value = restore.query;
    for (const id of restore.expanded) {
      const model = getModel(id);
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
  } else if (currentDiff !== undefined && diffBranchIds.size > 0) {
    expandedIds.add(currentRoot.id);
    for (const id of diffBranchIds) {
      if (currentDiff.annotations[id] === undefined) {
        const model = getModel(id);
        if (model !== undefined && isExpandableModel(model)) expandedIds.add(id);
      }
    }
    rebuildVisibleRows();
    updateActionButtons();
  } else if (expandAllAllowed) {
    expandedIds.add(currentRoot.id);
    rebuildVisibleRows();
    updateActionButtons();
  } else {
    rebuildVisibleRows();
    updateActionButtons();
  }

  renderPinnedBar();
  if (inspectorOpen) updateInspector(true);
  if (currentPanelSource !== undefined || pinnedPaths.length > 0) schedulePersist();
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

searchCaseButton?.addEventListener("click", () => {
  setSearchCaseSensitive(!searchCaseSensitive);
  schedulePersist();
  if (searchInput.value.trim()) runSearch();
});
searchRegexButton?.addEventListener("click", () => {
  setSearchRegex(!searchRegex);
  schedulePersist();
  if (searchInput.value.trim()) runSearch();
});
searchScopeSelect?.addEventListener("change", () => {
  const val = searchScopeSelect.value;
  if (val === "all" || val === "keys" || val === "values") {
    setSearchScope(val);
    schedulePersist();
    if (searchInput.value.trim()) runSearch();
  }
});

diffClipboardButton?.addEventListener("click", () =>
  vscode.postMessage({ type: "diffWithClipboard" }));
jsonlDiffPrevButton?.addEventListener("click", () =>
  vscode.postMessage({ type: "diffJsonlPrevious" }));
diffChangesOnlyInput?.addEventListener("change", () => {
  diffChangesOnly = diffChangesOnlyInput.checked;
  diffRevealedIds.clear();
  if (diffChangesOnly && currentDiff) {
    const expansion = activeExpansionSet();
    for (const id of diffBranchIds) {
      if (currentDiff.annotations[id] === undefined) {
        const model = getModel(id);
        if (model && isExpandableModel(model)) expansion.add(id);
      }
    }
  }
  rebuildVisibleRows();
});

toggleInspectorButton?.addEventListener("click", () => {
  setInspectorOpen(!inspectorOpen, true);
  schedulePersist();
});
inspectorCloseButton?.addEventListener("click", () => {
  setInspectorOpen(false, false);
  schedulePersist();
});
inspectorWrapButton?.addEventListener("click", () => {
  setInspectorWrap(!inspectorWrap);
  schedulePersist();
});
inspectorCopyButton?.addEventListener("click", () => {
  if (focusedNodeId === undefined) return;
  const model = getModel(focusedNodeId);
  if (model) {
    postNodeAction(model.type === "string" ? "copyDecodedString" : "copyValue", focusedNodeId);
  }
});

pinnedClearButton?.addEventListener("click", () => {
  pinnedPaths = [];
  renderPinnedBar();
  schedulePersist();
});
pinnedChips?.addEventListener("click", (event: Event) => {
  const removeBtn = findClosest(event.target, "pinned-chip-remove");
  if (removeBtn) {
    const idx = Number(removeBtn.getAttribute("data-pin-index"));
    if (Number.isInteger(idx) && idx >= 0 && idx < pinnedPaths.length) {
      pinnedPaths.splice(idx, 1);
      renderPinnedBar();
      schedulePersist();
    }
    return;
  }
  const chip = findClosest(event.target, "pinned-chip");
  if (!chip) return;
  const idx = Number(chip.getAttribute("data-pin-index"));
  if (!Number.isInteger(idx) || idx < 0 || idx >= pinnedPaths.length) return;
  const resolvedId = resolveSingleStructuralPath(pinnedPaths[idx]);
  if (resolvedId !== undefined) {
    const ids = buildAncestry(resolvedId);
    if (ids.length > 0) revealNode(ids, true);
  }
});

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

tableFilterInput?.addEventListener("input", () => {
  clearTimeout(tableFilterTimer);
  tableFilterTimer = setTimeout(() => {
    if (tableContainer) tableContainer.scrollTop = 0;
    renderTableRows();
  }, TABLE_FILTER_DEBOUNCE_MS);
});
tableFilterInput?.addEventListener("keydown", (event: KeyboardEvent) => {
  if (event.key === "Enter") {
    event.preventDefault();
    clearTimeout(tableFilterTimer);
    if (tableContainer) tableContainer.scrollTop = 0;
    renderTableRows();
  } else if (event.key === "Escape" && tableFilterInput.value.length > 0) {
    event.preventDefault();
    event.stopPropagation();
    clearTimeout(tableFilterTimer);
    tableFilterInput.value = "";
    if (tableContainer) tableContainer.scrollTop = 0;
    renderTableRows();
  }
});
tableContainer?.addEventListener("scroll", () => {
  if (tableVisibleRowIndices.length > TABLE_VIRTUALIZE_THRESHOLD) {
    renderTableViewport(false);
  }
});
tableFlattenButton?.addEventListener("click", () => {
  tableFlatten = !tableFlatten;
  tableFlattenButton.classList.toggle("active", tableFlatten);
  tableFlattenButton.setAttribute("aria-pressed", String(tableFlatten));
  vscode.postMessage({ type: "reopenTable", flatten: tableFlatten });
});
tableCopyCsvButton?.addEventListener("click", () =>
  vscode.postMessage({ type: "exportTable", mode: "copy", rowIndices: tableVisibleRowIndices }));
tableCopyTsvButton?.addEventListener("click", () =>
  vscode.postMessage({ type: "exportTable", mode: "copy", format: "tsv", rowIndices: tableVisibleRowIndices }));
tableCopyMdButton?.addEventListener("click", () =>
  vscode.postMessage({ type: "exportTable", mode: "copy", format: "markdown", rowIndices: tableVisibleRowIndices }));
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
    closeTableView(false);
    const ids = buildAncestry(row.targetNodeId);
    if (ids.length > 0) revealNode(ids, true);
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
  // Preserve text selection inside .value when the user dragged across text.
  if (!findClosest(event.target, "toggle")) {
    const selectedText = window.getSelection?.()?.toString() ?? "";
    if (selectedText.length > 0) return;
  }
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
  const filterDiff = currentDiff !== undefined && diffChangesOnly;
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
    edge: getEdge(currentRoot.id),
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
    if (filterDiff) {
      const visibleInDiff =
        entry.id === currentRoot.id ||
        diffBranchIds.has(entry.id) ||
        diffRevealedIds.has(entry.id);
      if (!visibleInDiff) continue;
    }

    rowIndexById.set(entry.id, visibleRows.length);
    visibleRows.push(entry);

    if (!isExpandableModel(entry.model) || !expansion.has(entry.id)) continue;

    if (entry.model.decoded !== undefined) {
      const decodedRoot = entry.model.decoded.root;
      if (searchActive && searchRevealedIds.has(entry.id)) {
        searchRevealedIds.add(decodedRoot.id);
      }
      if (filterDiff && diffRevealedIds.has(entry.id)) {
        diffRevealedIds.add(decodedRoot.id);
      }
      stack.push({
        id: decodedRoot.id,
        level: entry.level + 1,
        label: decodedRowLabel(entry.model.decoded),
        model: decodedRoot,
        edge: getEdge(decodedRoot.id),
      });
      continue;
    }

    const children = getOrderedChildren(entry.model);
    const parentRevealed = searchActive && searchRevealedIds.has(entry.id);
    const parentDiffRevealed = filterDiff && diffRevealedIds.has(entry.id);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (parentRevealed) searchRevealedIds.add(child.value.id);
      if (parentDiffRevealed) diffRevealedIds.add(child.value.id);
      stack.push({
        id: child.value.id,
        level: entry.level + 1,
        label: String(child.key),
        model: child.value,
        edge: getEdge(child.value.id),
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

  const prevStart = renderedStart;
  const prevEnd = renderedEnd;
  if (!force && start === prevStart && end === prevEnd) return;
  const restoreFocus = wasTreeFocused();
  renderedStart = start;
  renderedEnd = end;

  treeSpacerTop.style.height = `${start * ROW_HEIGHT}px`;
  treeSpacerBottom.style.height = `${Math.max(0, total - end) * ROW_HEIGHT}px`;

  // Recycle surviving DOM row subtrees in place when scrolling across overlapping windows.
  if (
    !force &&
    prevStart >= 0 &&
    start < prevEnd &&
    end > prevStart &&
    treeRowsContainer.children.length === prevEnd - prevStart
  ) {
    const dropTop = Math.max(0, start - prevStart);
    for (let i = 0; i < dropTop; i += 1) {
      const child = treeRowsContainer.children[0] as HTMLElement | undefined;
      if (!child) break;
      const idAttr = child.getAttribute("data-node-id");
      if (idAttr !== null) renderedRowElements.delete(Number(idAttr));
      treeRowsContainer.removeChild(child);
    }

    const dropBottom = Math.max(0, prevEnd - end);
    for (let i = 0; i < dropBottom; i += 1) {
      const child = treeRowsContainer.children[treeRowsContainer.children.length - 1] as HTMLElement | undefined;
      if (!child) break;
      const idAttr = child.getAttribute("data-node-id");
      if (idAttr !== null) renderedRowElements.delete(Number(idAttr));
      treeRowsContainer.removeChild(child);
    }

    if (start < prevStart) {
      const topFragment = document.createDocumentFragment();
      for (let index = start; index < prevStart; index += 1) {
        const row = visibleRows[index];
        const el = renderedRowElements.get(row.id) ?? createRowElement(row);
        renderedRowElements.set(row.id, el);
        topFragment.appendChild(el);
      }
      treeRowsContainer.insertBefore(topFragment, treeRowsContainer.firstChild);
    }

    if (end > prevEnd) {
      const bottomFragment = document.createDocumentFragment();
      for (let index = prevEnd; index < end; index += 1) {
        const row = visibleRows[index];
        const el = renderedRowElements.get(row.id) ?? createRowElement(row);
        renderedRowElements.set(row.id, el);
        bottomFragment.appendChild(el);
      }
      treeRowsContainer.appendChild(bottomFragment);
    }
  } else {
    const reusable = force ? undefined : new Map(renderedRowElements);
    renderedRowElements.clear();
    const fragment = document.createDocumentFragment();
    for (let index = start; index < end; index += 1) {
      const row = visibleRows[index];
      const el = reusable?.get(row.id) ?? createRowElement(row);
      renderedRowElements.set(row.id, el);
      fragment.appendChild(el);
    }
    treeRowsContainer.replaceChildren(fragment);
  }

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

  const diffAnnotation = currentDiff?.annotations[id];
  const row = document.createElement("div");
  row.className = "row";
  if (diffAnnotation !== undefined) {
    row.classList.add("diff-row", `diff-${diffAnnotation.status}`);
  }
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

  if (diffAnnotation !== undefined) {
    const badge = document.createElement("span");
    badge.className = `diff-status-badge diff-${diffAnnotation.status}`;
    badge.textContent = diffAnnotation.status === "added"
      ? "+"
      : diffAnnotation.status === "removed"
        ? "-"
        : "~";
    badge.title = diffAnnotation.status === "added"
      ? t("Added")
      : diffAnnotation.status === "removed"
        ? t("Removed")
        : t("Changed");
    row.appendChild(badge);
  }

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

  appendValue(row, model, label, expanded, diffAnnotation);

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
  const model = getModel(nodeId);
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
  const options: JsonTreeSearchOptions = {
    caseSensitive: searchCaseSensitive,
    regex: searchRegex,
    scope: searchScope,
  };
  const state = createJsonTreeSearchState(currentRoot, query, 5_000, options);

  if (state.invalidRegex !== undefined) {
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
    searchCount.textContent = t("Invalid regex");
    searchCount.title = state.invalidRegex;
    searchCount.classList.add("search-error");
    previousMatchButton.disabled = true;
    nextMatchButton.disabled = true;
    emptySearch.classList.add("hidden");
    if (wasActive) rebuildVisibleRows();
    updateActionButtons();
    return;
  }

  searchCount.title = "";
  searchCount.classList.remove("search-error");
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
  if (result.invalidRegex !== undefined) {
    searchActive = false;
    searchApplying = false;
    searchCount.textContent = t("Invalid regex");
    searchCount.title = result.invalidRegex;
    searchCount.classList.add("search-error");
    previousMatchButton.disabled = true;
    nextMatchButton.disabled = true;
    emptySearch.classList.add("hidden");
    rebuildVisibleRows();
    updateActionButtons();
    return;
  }
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
  searchCount.title = "";
  searchCount.classList.remove("search-error");
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
  const root = getModel(nodeId);
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
    if (currentDiff && diffChangesOnly) diffRevealedIds.add(model.id);
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
  const root = getModel(nodeId);
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
  const parentId = getParentId(nodeId);
  if (parentId === undefined) return;
  const parent = getModel(parentId);
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
  const model = getModel(nodeId);
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
    if (currentDiff && diffChangesOnly) diffRevealedIds.add(nodeId);
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

function setSearchCaseSensitive(enabled: boolean): void {
  searchCaseSensitive = enabled;
  if (!searchCaseButton) return;
  searchCaseButton.classList.toggle("active", enabled);
  searchCaseButton.setAttribute("aria-pressed", String(enabled));
}

function setSearchRegex(enabled: boolean): void {
  searchRegex = enabled;
  if (!searchRegexButton) return;
  searchRegexButton.classList.toggle("active", enabled);
  searchRegexButton.setAttribute("aria-pressed", String(enabled));
}

function setSearchScope(scope: SearchScope): void {
  searchScope = scope;
  if (searchScopeSelect) searchScopeSelect.value = scope;
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
  const model = getModel(nodeId);
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
    (getDepth(model.id) || 1) + 1,
  );
  if (currentDiff !== undefined) {
    diffBranchIds = computeDiffBranchIds(currentDiff);
  }
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
  if (currentDiff && diffChangesOnly) {
    diffRevealedIds.add(model.id);
    diffRevealedIds.add(decoded.root.id);
  }
  rebuildVisibleRows();
  if (pinnedPaths.length > 0) renderPinnedBar();
}

function markNodeNotDecodable(nodeId: number, cancelled = false): void {
  decodingIds.delete(nodeId);
  const model = getModel(nodeId);
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
    const model = getModel(item.nodeId);
    if (model === undefined || model.decoded !== undefined) continue;
    attachDecodedToNode(item.nodeId, item.decoded, false);
  }
  stickyStatus = message.limited
    ? t("Decoded {0} strings for search (limit reached)", message.decodedCount.toLocaleString())
    : message.decodedCount === 1
      ? t("Decoded 1 string for search")
      : t("Decoded {0} strings for search", message.decodedCount.toLocaleString());
  updateActionButtons();
  if (pinnedPaths.length > 0) renderPinnedBar();
  if (searchInput.value.trim()) {
    runSearch();
  } else if (message.items.length > 0) {
    renderVirtualWindow(true);
  }
}

/** Asks the Host to parse a string's embedded content; the reply attaches it inline. */
function requestDecode(nodeId: number): void {
  const model = getModel(nodeId);
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
  if (currentPanelSource?.kind === "jsonl") {
    currentPanelSource = { ...currentPanelSource, lineNumber: Math.max(0, state.lineNumber - 1) };
  }
  jsonlStatus.textContent = state.status || "";
  const busy = state.busy === true;
  previousJsonlButton.disabled = busy;
  nextJsonlButton.disabled = busy;
  if (jsonlDiffPrevButton) jsonlDiffPrevButton.disabled = busy;
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
    case "url-json": return t("decoded JSON (URL)");
    case "base64-gzip-json": return t("decoded JSON (Gzip Base64)");
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

function appendValue(
  row: HTMLElement,
  model: JsonTreeWebviewNode,
  key: string,
  isExpanded: boolean,
  diffAnnotation?: RenderDiffPayload["annotations"][number],
): void {
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

  if (diffAnnotation?.status === "changed" && diffAnnotation.oldRaw !== undefined) {
    const oldSpan = document.createElement("span");
    oldSpan.className = "diff-old-value";
    const displayOld = diffAnnotation.oldRaw.length > 80
      ? `${diffAnnotation.oldRaw.slice(0, 79)}…`
      : diffAnnotation.oldRaw;
    oldSpan.textContent = `${displayOld} → `;
    oldSpan.title = diffAnnotation.oldRaw;
    row.appendChild(oldSpan);
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

// Value Inspector Drawer

function setInspectorWrap(enabled: boolean): void {
  inspectorWrap = enabled;
  if (inspectorWrapButton) {
    inspectorWrapButton.classList.toggle("active", enabled);
    inspectorWrapButton.setAttribute("aria-pressed", String(enabled));
  }
  if (inspectorContent) {
    inspectorContent.classList.toggle("wrap", enabled);
  }
}

function setInspectorOpen(open: boolean, requestUpdate = true): void {
  inspectorOpen = open;
  if (toggleInspectorButton) {
    toggleInspectorButton.classList.toggle("active", open);
    toggleInspectorButton.setAttribute("aria-pressed", String(open));
  }
  if (!inspectorDrawer) return;
  const inTable = tableView !== null && tableView !== undefined && !tableView.classList.contains("hidden");
  inspectorDrawer.classList.toggle("hidden", !open || inTable);
  if (open && requestUpdate) {
    updateInspector(true);
  }
}

function openInspectorForNode(nodeId: number): void {
  setFocusedNode(nodeId, false);
  setInspectorOpen(true, true);
  schedulePersist();
}

function formatDisplayPathFromAncestry(ancestry: number[]): string {
  if (ancestry.length === 0) return "$";
  let out = "$";
  for (let index = 1; index < ancestry.length; index += 1) {
    const id = ancestry[index];
    const edge = getEdge(id);
    const parentId = getParentId(id);
    const parent = parentId !== undefined ? getModel(parentId) : undefined;
    if (edge?.decoded) {
      out += "⟩";
    } else if (parent?.type === "array") {
      out += `[${edge?.label ?? "0"}]`;
    } else {
      const label = edge?.label ?? "";
      out += /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(label) ? `.${label}` : `[${JSON.stringify(label)}]`;
    }
  }
  return out;
}

function measureUtf8Bytes(text: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text).length;
  }
  return text.length;
}

function formatInspectorMeta(
  nodeType: string,
  charLength: number,
  lineCount: number,
  byteLength: number,
  childCount?: number,
): string {
  const parts = [
    t(typeLabel(nodeType as JsonTreeWebviewNode["type"])),
    t("{0} chars", charLength.toLocaleString()),
    lineCount === 1 ? t("1 line") : t("{0} lines", lineCount.toLocaleString()),
    t("{0} B", byteLength.toLocaleString()),
  ];
  if (childCount !== undefined) {
    parts.push(
      nodeType === "array"
        ? t("array, {0} items", childCount.toLocaleString())
        : t("object, {0} keys", childCount.toLocaleString()),
    );
  }
  return parts.join(" · ");
}

function updateInspector(forceRequest = false): void {
  if (!inspectorOpen || !inspectorDrawer) return;
  if (focusedNodeId === undefined || getModel(focusedNodeId) === undefined) {
    if (inspectorPath) inspectorPath.textContent = "";
    if (inspectorMeta) inspectorMeta.textContent = "";
    if (inspectorContent) inspectorContent.textContent = "";
    return;
  }
  const model = getModel(focusedNodeId)!;
  const ancestry = buildAncestry(focusedNodeId);
  const pathText = formatDisplayPathFromAncestry(ancestry);
  let previewText: string;
  if (model.type === "string") {
    previewText = String(model.value ?? "");
  } else if (model.type === "object" || model.type === "array") {
    previewText = buildCollapsedPreview(model, getOrderedChildren(model));
    if (previewText.length === 0) previewText = model.type === "array" ? "[]" : "{}";
  } else {
    previewText = model.raw ?? String(model.value);
  }
  const charLength = model.valueLength ?? model.rawLength ?? previewText.length;
  const lineCount = previewText.length === 0 ? 1 : previewText.split("\n").length;
  const byteLength = measureUtf8Bytes(previewText);
  const childCount = model.children?.length;

  if (inspectorPath) {
    inspectorPath.textContent = pathText;
    inspectorPath.title = pathText;
  }
  if (inspectorMeta) {
    inspectorMeta.textContent = formatInspectorMeta(model.type, charLength, lineCount, byteLength, childCount);
  }
  if (inspectorContent) {
    inspectorContent.textContent = previewText;
  }

  if (forceRequest || lastInspectedNodeId !== focusedNodeId) {
    lastInspectedNodeId = focusedNodeId;
    vscode.postMessage({ type: "inspectNode", nodeId: focusedNodeId });
  }
}

function applyNodeInspection(message: NodeInspectionMessage): void {
  if (!inspectorOpen || message.nodeId !== focusedNodeId) return;
  if (inspectorPath) {
    inspectorPath.textContent = message.path;
    inspectorPath.title = message.path;
  }
  if (inspectorMeta) {
    inspectorMeta.textContent = formatInspectorMeta(
      message.nodeType,
      message.charLength,
      message.lineCount,
      message.byteLength,
      message.childCount,
    );
  }
  if (inspectorContent) {
    inspectorContent.textContent = message.fullValue;
  }
}

// Pin / Watch Paths Bar

function structuralPathKey(path: readonly WebviewPathStep[]): string {
  return JSON.stringify(path);
}

function getStructuralPathForNode(nodeId: number): WebviewPathStep[] | undefined {
  if (!currentRoot || nodeId === currentRoot.id || getModel(nodeId) === undefined) return undefined;
  const ancestry = buildAncestry(nodeId);
  if (ancestry.length < 2 || ancestry[0] !== currentRoot.id) return undefined;
  const steps: WebviewPathStep[] = [];
  for (let index = 1; index < ancestry.length; index += 1) {
    const parentId = ancestry[index - 1];
    const childId = ancestry[index];
    const parent = getModel(parentId);
    if (!parent) return undefined;
    if (parent.decoded?.root.id === childId) {
      steps.push("decoded");
      continue;
    }
    const children = parent.children ?? [];
    if (parent.type === "array") {
      let foundIndex = -1;
      for (let c = 0; c < children.length; c += 1) {
        if (children[c].value.id === childId) {
          foundIndex = c;
          break;
        }
      }
      if (foundIndex < 0) return undefined;
      steps.push(foundIndex);
    } else if (parent.type === "object") {
      let targetKey: string | undefined;
      let occurrence = 0;
      for (let c = 0; c < children.length; c += 1) {
        if (children[c].value.id === childId) {
          targetKey = String(children[c].key);
          break;
        }
      }
      if (targetKey === undefined) return undefined;
      for (let c = 0; c < children.length; c += 1) {
        if (children[c].value.id === childId) break;
        if (String(children[c].key) === targetKey) occurrence += 1;
      }
      steps.push({ key: targetKey, occurrence });
    } else {
      return undefined;
    }
  }
  return steps;
}

function resolveSingleStructuralPath(path: readonly WebviewPathStep[]): number | undefined {
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
    if (model === undefined) return undefined;
  }
  return model?.id;
}

function isNodePinned(nodeId: number): boolean {
  const path = getStructuralPathForNode(nodeId);
  if (!path) return false;
  const key = structuralPathKey(path);
  return pinnedPaths.some((existing) => structuralPathKey(existing) === key);
}

function togglePinNode(nodeId: number): void {
  const path = getStructuralPathForNode(nodeId);
  if (!path) return;
  const key = structuralPathKey(path);
  const existingIndex = pinnedPaths.findIndex((existing) => structuralPathKey(existing) === key);
  if (existingIndex >= 0) {
    pinnedPaths.splice(existingIndex, 1);
  } else {
    pinnedPaths.push(path);
  }
  renderPinnedBar();
  schedulePersist();
}

function formatPinnedPathLabel(path: readonly WebviewPathStep[]): string {
  const parts: string[] = [];
  for (const step of path) {
    if (step === "decoded") {
      parts.push("⟩");
    } else if (typeof step === "number") {
      parts.push(`[${step}]`);
    } else {
      const suffix = step.occurrence > 0 ? `#${step.occurrence + 1}` : "";
      const seg = `${step.key}${suffix}`;
      if (parts.length === 0 || parts[parts.length - 1] === "⟩") {
        parts.push(seg);
      } else {
        parts.push(`.${seg}`);
      }
    }
  }
  return parts.join("");
}

function formatPinnedShortValue(model: JsonTreeWebviewNode | undefined): string {
  if (!model) return "—";
  if (model.type === "object") return `{${(model.children ?? []).length}}`;
  if (model.type === "array") return `[${(model.children ?? []).length}]`;
  if (model.type === "string") {
    const val = String(model.value ?? "");
    return val.length > 28 ? `${val.slice(0, 27)}…` : val;
  }
  const raw = model.raw ?? String(model.value);
  return raw.length > 28 ? `${raw.slice(0, 27)}…` : raw;
}

function renderPinnedBar(): void {
  if (!pinnedBar || !pinnedChips) return;
  if (pinnedPaths.length === 0) {
    pinnedBar.classList.add("hidden");
    pinnedChips.replaceChildren();
    return;
  }
  pinnedBar.classList.remove("hidden");
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < pinnedPaths.length; index += 1) {
    const path = pinnedPaths[index];
    const resolvedId = resolveSingleStructuralPath(path);
    const model = resolvedId !== undefined ? getModel(resolvedId) : undefined;
    const label = formatPinnedPathLabel(path);
    const shortVal = formatPinnedShortValue(model);

    const chip = document.createElement("span");
    chip.className = model ? "pinned-chip" : "pinned-chip missing";
    chip.setAttribute("data-pin-index", String(index));

    const jumpBtn = document.createElement("button");
    jumpBtn.type = "button";
    jumpBtn.className = "pinned-chip-jump";
    jumpBtn.setAttribute("data-pin-index", String(index));
    jumpBtn.disabled = model === undefined;
    jumpBtn.title = model !== undefined ? `${label}: ${shortVal}` : t("Not present in current record");

    const labelSpan = document.createElement("span");
    labelSpan.className = "pinned-chip-label";
    labelSpan.textContent = label;
    const sepText = document.createElement("span");
    sepText.textContent = ": ";
    const valSpan = document.createElement("span");
    valSpan.className = "pinned-chip-value";
    valSpan.textContent = shortVal;
    jumpBtn.appendChild(labelSpan);
    jumpBtn.appendChild(sepText);
    jumpBtn.appendChild(valSpan);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "pinned-chip-remove";
    removeBtn.setAttribute("data-pin-index", String(index));
    removeBtn.setAttribute("aria-label", t("Unpin field"));
    removeBtn.title = t("Unpin field");
    removeBtn.textContent = "×";

    chip.appendChild(jumpBtn);
    chip.appendChild(removeBtn);
    fragment.appendChild(chip);
  }
  pinnedChips.replaceChildren(fragment);
}

// Breadcrumb & Keyboard navigation

function buildAncestry(nodeId: number): number[] {
  if (getModel(nodeId) === undefined) return [];
  const ids: number[] = [];
  let current: number | undefined = nodeId;
  while (current !== undefined) {
    ids.push(current);
    current = getParentId(current);
  }
  return ids.reverse();
}

function updateBreadcrumb(nodeId: number | undefined): void {
  if (!breadcrumbSegments) return;
  if (nodeId === undefined || getModel(nodeId) === undefined) {
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
    const edge = getEdge(id);
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
    const parentId = getParentId(id);
    const parentModel = parentId !== undefined ? getModel(parentId) : undefined;
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
    if (currentDiff && diffChangesOnly) diffRevealedIds.add(ancestry[index]);
  }
  if (searchActive) searchRevealedIds.add(nodeId);
  if (currentDiff && diffChangesOnly) diffRevealedIds.add(nodeId);
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
  if (inspectorOpen && previousId !== nodeId) {
    updateInspector(false);
  }
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
        if (nextRow && getParentId(nextRow.id) === focusedNodeId) {
          targetId = nextRow.id;
        }
      }
      break;
    case "ArrowLeft":
      if (expandable && isExpandedId(focusedNodeId)) {
        toggleNodeManually(focusedNodeId);
      } else {
        targetId = getParentId(focusedNodeId);
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
 * Expands the path to a node and highlights it. By default does not take
 * keyboard focus so following the editor cursor never interrupts typing;
 * interactive jumps (table rows, pinned chips) pass `focusTarget = true`.
 */
function revealNode(ids: number[], focusTarget = false): void {
  if (treeOperationRunning) {
    pendingReveal = ids;
    return;
  }
  pendingReveal = undefined;
  if (!currentRoot || ids.length === 0 || ids[0] !== currentRoot.id) return;
  if (searchActive && !focusTarget) return;

  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index];
    if (searchActive) searchRevealedIds.add(id);
    if (currentDiff && diffChangesOnly) diffRevealedIds.add(id);
    if (index < ids.length - 1) {
      const model = getModel(id);
      if (model && isExpandableModel(model)) {
        expandedIds.add(id);
        if (searchActive) searchExpandedIds.add(id);
      }
    }
  }
  const targetId = ids[ids.length - 1];
  cursorSyncedNodeId = targetId;
  rebuildVisibleRows();
  const rowIndex = rowIndexById.get(targetId);
  if (rowIndex !== undefined) {
    ensureRowVisible(rowIndex);
  }
  setFocusedNode(targetId, focusTarget);
  schedulePersist();
}

function showMenu(
  x: number,
  y: number,
  nodeId: number,
  fromKeyboard: boolean,
): void {
  const model = getModel(nodeId);
  if (!model) return;
  const edgeInfo = getEdge(nodeId);
  const parentId = getParentId(nodeId);

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
    addMenuItem(t("Inspect value"), () => openInspectorForNode(model.id));
    addSeparator();
  } else {
    addMenuItem(t("Copy value"), () => vscode.postMessage({ type: "copyValue", nodeId: model.id }));
    addMenuItem(t("Inspect value"), () => openInspectorForNode(model.id));
  }

  if (parentId !== undefined) {
    const pinned = isNodePinned(model.id);
    addMenuItem(pinned ? t("Unpin field") : t("Pin field"), () => togglePinNode(model.id));
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
    addMenuItem(t("Compare subtree with clipboard"), () => vscode.postMessage({ type: "diffSubtreeWithClipboard", nodeId: model.id }));
    addMenuItem(t("Generate types / schema…"), () => vscode.postMessage({ type: "generateTypes", nodeId: model.id }));
    if (
      model.type === "array" &&
      (model.children?.length ?? 0) > 0 &&
      model.children!.some((child) => child.value.type === "object")
    ) {
      addMenuItem(t("View as table"), () => vscode.postMessage({ type: "openArrayTable", nodeId: model.id }));
    }
    addSeparator();
  } else if (model.decoded !== undefined) {
    addMenuItem(t("Compare subtree with clipboard"), () => vscode.postMessage({ type: "diffSubtreeWithClipboard", nodeId: model.id }));
    addMenuItem(t("Generate types / schema…"), () => vscode.postMessage({ type: "generateTypes", nodeId: model.id }));
    addSeparator();
  } else {
    addMenuItem(t("Compare subtree with clipboard"), () => vscode.postMessage({ type: "diffSubtreeWithClipboard", nodeId: model.id }));
    addMenuItem(t("Generate types / schema…"), () => vscode.postMessage({ type: "generateTypes", nodeId: model.id }));
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

function compareTableCellValues(av: string, bv: string, dir: number): number {
  if (av === bv) return 0;
  const aIsNum = STRICT_NUMBER_RE.test(av);
  const bIsNum = STRICT_NUMBER_RE.test(bv);
  if (aIsNum && bIsNum) {
    if (STRICT_INT_RE.test(av) && STRICT_INT_RE.test(bv)) {
      const ai = BigInt(av);
      const bi = BigInt(bv);
      if (ai !== bi) return ai < bi ? -dir : dir;
      return 0;
    }
    const an = Number(av);
    const bn = Number(bv);
    if (!Number.isNaN(an) && !Number.isNaN(bn) && an !== bn) {
      return an < bn ? -dir : dir;
    }
    return av < bv ? -dir : dir;
  }
  if (aIsNum !== bIsNum) {
    return aIsNum ? -dir : dir;
  }
  return av < bv ? -dir : dir;
}

function openTableView(table: TableModel): void {
  clearTimeout(tableFilterTimer);
  currentTable = table;
  tableSortColumn = -1;
  tableSortAsc = true;
  const flattened = table.flattened === true;
  tableFlatten = flattened;
  if (tableFlattenButton) {
    tableFlattenButton.classList.toggle("active", tableFlatten);
    tableFlattenButton.setAttribute("aria-pressed", String(tableFlatten));
  }
  if (tableFilterInput) tableFilterInput.value = "";
  if (tableContainer) tableContainer.scrollTop = 0;
  if (tableTitle) tableTitle.textContent = table.title;
  tree.classList.add("hidden");
  inspectorDrawer?.classList.add("hidden");
  emptySearch.classList.add("hidden");
  tableView?.classList.remove("hidden");
  renderTableHeader();
  renderTableRows();
}

function closeTableView(restoreFocus: boolean): void {
  if (!tableView || tableView.classList.contains("hidden")) return;
  clearTimeout(tableFilterTimer);
  tableView.classList.add("hidden");
  tree.classList.remove("hidden");
  if (inspectorOpen) inspectorDrawer?.classList.remove("hidden");
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
      const cmp = compareTableCellValues(av, bv, dir);
      return cmp !== 0 ? cmp : a - b;
    });
  }

  tableVisibleRowIndices = indices;
  if (tableCount) {
    const base = indices.length === currentTable.rows.length
      ? t("{0} rows", currentTable.rows.length.toLocaleString())
      : t("{0} / {1} rows", indices.length.toLocaleString(), currentTable.rows.length.toLocaleString());
    if (currentTable.truncated && currentTable.truncatedColumns) {
      tableCount.textContent = `${base} (${t("rows & columns truncated")})`;
      tableCount.title = t("Showing first {0} columns", currentTable.columns.length.toLocaleString());
    } else if (currentTable.truncated) {
      tableCount.textContent = `${base} (${t("truncated")})`;
      tableCount.title = "";
    } else if (currentTable.truncatedColumns) {
      tableCount.textContent = `${base} (${t("columns truncated")})`;
      tableCount.title = t("Showing first {0} columns", currentTable.columns.length.toLocaleString());
    } else {
      tableCount.textContent = base;
      tableCount.title = "";
    }
  }

  renderTableViewport(true);
}

function createTableRowElement(rowIndex: number): HTMLTableRowElement {
  const row = currentTable!.rows[rowIndex];
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
  return tr;
}

function createTableSpacerRow(colSpan: number, heightPx: number): HTMLTableRowElement {
  const tr = document.createElement("tr");
  tr.className = "table-spacer-row";
  tr.setAttribute("aria-hidden", "true");
  const td = document.createElement("td");
  td.setAttribute("colspan", String(colSpan));
  td.style.height = `${heightPx}px`;
  tr.appendChild(td);
  return tr;
}

function renderTableViewport(force: boolean): void {
  if (!dataTable || !currentTable) return;
  const tbody = dataTable.querySelector("tbody");
  if (!tbody) return;

  const total = tableVisibleRowIndices.length;
  if (total <= TABLE_VIRTUALIZE_THRESHOLD) {
    tableRenderedStart = 0;
    tableRenderedEnd = total;
    const fragment = document.createDocumentFragment();
    for (const rowIndex of tableVisibleRowIndices) {
      fragment.appendChild(createTableRowElement(rowIndex));
    }
    tbody.replaceChildren(fragment);
    return;
  }

  const viewportHeight =
    typeof tableContainer?.clientHeight === "number" && tableContainer.clientHeight > 0
      ? tableContainer.clientHeight
      : 600;
  const scrollTop = Math.max(0, tableContainer?.scrollTop || 0);
  const firstVisible = Math.floor(scrollTop / TABLE_ROW_HEIGHT);
  const visibleCount = Math.max(1, Math.ceil(viewportHeight / TABLE_ROW_HEIGHT));
  const start = Math.min(total, Math.max(0, firstVisible - TABLE_OVERSCAN_ROWS));
  const end = Math.min(total, firstVisible + visibleCount + TABLE_OVERSCAN_ROWS);

  if (!force && start === tableRenderedStart && end === tableRenderedEnd) return;
  tableRenderedStart = start;
  tableRenderedEnd = end;

  const colSpan = currentTable.columns.length + 1;
  const fragment = document.createDocumentFragment();
  if (start > 0) {
    fragment.appendChild(createTableSpacerRow(colSpan, start * TABLE_ROW_HEIGHT));
  }
  for (let index = start; index < end; index += 1) {
    fragment.appendChild(createTableRowElement(tableVisibleRowIndices[index]));
  }
  if (end < total) {
    fragment.appendChild(createTableSpacerRow(colSpan, (total - end) * TABLE_ROW_HEIGHT));
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
    const resolved = resolveSingleStructuralPath(path);
    if (resolved !== undefined) ids.push(resolved);
  }
  return ids;
}

// View state persistence lets the panel drop retainContextWhenHidden.

function extractSavedPanelSource(saved: SavedViewState): PanelSourceDescriptor | undefined {
  if (
    saved.panelSource !== undefined &&
    typeof saved.panelSource.uri === "string" &&
    (saved.panelSource.kind === "document" || saved.panelSource.kind === "jsonl")
  ) {
    return saved.panelSource;
  }
  if ((saved.kind === "document" || saved.kind === "jsonl") && typeof saved.uri === "string") {
    return {
      kind: saved.kind,
      uri: saved.uri,
      ...(saved.lineNumber !== undefined ? { lineNumber: saved.lineNumber } : {}),
    };
  }
  return undefined;
}

function panelSourcesMatch(a: PanelSourceDescriptor, b: PanelSourceDescriptor): boolean {
  if (a.kind !== b.kind || a.uri !== b.uri) return false;
  if (a.kind === "jsonl") {
    return (a.lineNumber ?? 0) === (b.lineNumber ?? 0);
  }
  return true;
}

function loadViewState(message: RenderMessage): { saved: SavedViewState; revivedBySource: boolean } | undefined {
  const saved = vscode.getState?.() as SavedViewState | undefined;
  if (!saved || !Array.isArray(saved.expanded)) return undefined;
  if (saved.renderKey === message.renderKey) {
    return { saved, revivedBySource: false };
  }
  if (message.renderKey === 0 && message.panelSource !== undefined) {
    const savedSource = extractSavedPanelSource(saved);
    if (savedSource !== undefined && panelSourcesMatch(savedSource, message.panelSource)) {
      return { saved, revivedBySource: true };
    }
  }
  return undefined;
}

function schedulePersist(): void {
  if (persistScheduled || typeof vscode.setState !== "function") return;
  persistScheduled = true;
  setTimeout(() => {
    persistScheduled = false;
    const expandedPaths = expandedIds.size > 0 ? captureViewByStructure().expandedPaths : undefined;
    const state: SavedViewState = {
      renderKey,
      expanded: [...expandedIds],
      ...(expandedPaths !== undefined ? { expandedPaths } : {}),
      query: searchInput.value,
      scrollTop: tree.scrollTop,
      searchDecoded,
      searchCaseSensitive,
      searchRegex,
      searchScope,
      sortKeys,
      ...(pinnedPaths.length > 0 ? { pinnedPaths } : {}),
      ...(inspectorOpen ? { inspectorOpen, inspectorWrap } : {}),
      ...(currentPanelSource !== undefined
        ? {
            panelSource: currentPanelSource,
            kind: currentPanelSource.kind,
            uri: currentPanelSource.uri,
            ...(currentPanelSource.lineNumber !== undefined ? { lineNumber: currentPanelSource.lineNumber } : {}),
          }
        : {}),
    };
    vscode.setState?.(state);
  }, 250);
}

vscode.postMessage({ type: "ready" });

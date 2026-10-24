import type { JsonTreeWebviewNode } from "../jsonTree";
import type {
  HostToWebviewMessage,
  JsonlViewState,
  RenderMessage,
  SourceViewState,
  WebviewToHostMessage,
} from "../protocol";
import { advanceJsonTreeSearch, createJsonTreeSearchState, JsonTreeSearchState } from "../search";

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
}

interface EdgeInfo {
  hasKey: boolean;
  hasRawKey: boolean;
  keyTruncated?: true;
  keyLength?: number;
  rawKeyTruncated?: true;
  rawKeyLength?: number;
  /** The node is JSON decoded from its parent string. */
  decoded?: true;
}

interface TreeNodeElement extends HTMLDivElement {
  nodeId: number;
  treeParent: TreeNodeElement | undefined;
  rowElement: HTMLDivElement;
  expandable: boolean;
  decodable: boolean;
  setExpanded(shouldExpand: boolean): void;
  ensureExpanded(isCurrent: () => boolean, onComplete: () => void, eager?: boolean): boolean;
  isExpanded(): boolean;
  getRenderedChildren(): TreeNodeElement[];
  revealChildrenInSearch(): void;
  rememberExpansion(): void;
  applySearchState(isExactMatch: boolean, isMatchBranch: boolean): void;
  restoreSearchState(): boolean;
  openMenu(): void;
  attachDecoded(decoded: NonNullable<JsonTreeWebviewNode["decoded"]>): void;
  markNotDecodable(): void;
}

/** Child-index step for JSON decoded from a string (matches the Host index). */
const DECODED_EDGE = -2;

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
const jsonlStatus = byId<HTMLElement>("jsonl-status");
const sourceBar = byId<HTMLElement>("source-bar");
const syncCursorInput = byId<HTMLInputElement>("sync-cursor");
const refreshSourceButton = byId<HTMLButtonElement>("refresh-source");
const sourceStatus = byId<HTMLElement>("source-status");
let rootNode: TreeNodeElement | undefined;
let currentRoot: JsonTreeWebviewNode | undefined;
let renderKey = -1;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let searchActive = false;
let searchApplying = false;
let latestSearchRequest = 0;
let matchRows: HTMLElement[] = [];
let activeMatchIndex = -1;
let searchTruncated = false;
let expandAllAllowed = false;
let activeTreeOperation = 0;
let treeOperationRunning = false;
let focusedNode: TreeNodeElement | undefined;
let menuOrigin: TreeNodeElement | undefined;
let cursorRow: HTMLElement | undefined;
let revealGeneration = 0;
/** Nodes can be revealed in the source editor (document, selection, or JSONL). */
let sourceRevealable = false;
/** Rendered nodes by ID, so Host replies can find their target row. */
const renderedNodes = new Map<number, TreeNodeElement>();
/** Expansion outside search mode; search-driven expansion is never persisted. */
const expandedIds = new Set<number>();
let persistScheduled = false;
const MATERIALIZE_CHILD_CHUNK_SIZE = 200;
const TREE_OPERATION_CHUNK_SIZE = 200;

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
      renderedNodes.get(message.nodeId)?.attachDecoded(message.decoded);
      return;
    case "decodeFailed":
      renderedNodes.get(message.nodeId)?.markNotDecodable();
      return;
    case "revealNode":
      revealNode(message.ids);
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

function render(message: RenderMessage): void {
  // A re-parse of the same source keeps the view by structure, since IDs change.
  const snapshot = message.preserveView && currentRoot !== undefined ? captureViewByStructure() : undefined;
  activeTreeOperation += 1;
  latestSearchRequest += 1;
  revealGeneration += 1;
  treeOperationRunning = false;
  clearTimeout(searchTimer);
  searchActive = false;
  searchApplying = false;
  matchRows = [];
  activeMatchIndex = -1;
  cursorRow = undefined;
  searchCount.textContent = "";
  previousMatchButton.disabled = true;
  nextMatchButton.disabled = true;
  emptySearch.classList.add("hidden");
  treeOperationStatus.textContent = "";
  hideMenu();
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
  expandedIds.clear();
  renderedNodes.clear();
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
  rootNode = createNode("$", currentRoot, undefined, undefined);
  tree.replaceChildren(rootNode);
  setFocusedNode(rootNode, false);
  const restore = snapshot !== undefined
    ? { query: searchInput.value, expanded: resolveStructuralPaths(snapshot.expandedPaths), scrollTop: snapshot.scrollTop }
    : saved;
  if (restore) {
    searchInput.value = restore.query;
    restoreExpansion(new Set(restore.expanded), () => {
      tree.scrollTop = restore.scrollTop;
      if (searchInput.value.trim()) runSearch();
    });
  } else if (searchInput.value.trim()) {
    runSearch();
  } else if (message.autoExpand && expandAllAllowed) {
    runTreeOperation(true);
  } else if (expandAllAllowed) {
    runRootExpansion();
  } else {
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
  } else if (event.key === "ArrowDown" && focusedNode) {
    event.preventDefault();
    focusedNode.focus();
  }
});
previousMatchButton.addEventListener("click", () => selectRelativeMatch(-1));
nextMatchButton.addEventListener("click", () => selectRelativeMatch(1));
clearSearchButton.addEventListener("click", clearSearch);

expandAllButton.addEventListener("click", () => runTreeOperation(true));
collapseAllButton.addEventListener("click", () => runTreeOperation(false));
previousJsonlButton.addEventListener("click", () => vscode.postMessage({ type: "previousJsonl" }));
nextJsonlButton.addEventListener("click", () => vscode.postMessage({ type: "nextJsonl" }));
goJsonlButton.addEventListener("click", goToJsonlLine);
jsonlLineInput.addEventListener("keydown", (event: KeyboardEvent) => {
  if (event.key === "Enter") {
    event.preventDefault();
    goToJsonlLine();
  }
});
revealSourceButton.addEventListener("click", () => vscode.postMessage({ type: "revealSource" }));
followCursorInput.addEventListener("change", () => vscode.postMessage({ type: "setFollowCursor", enabled: followCursorInput.checked }));
syncCursorInput?.addEventListener("change", () => vscode.postMessage({ type: "setSyncCursor", enabled: syncCursorInput.checked }));
refreshSourceButton?.addEventListener("click", () => vscode.postMessage({ type: "refreshSource" }));
tree.addEventListener("keydown", handleTreeKeydown);
tree.addEventListener("scroll", schedulePersist);
menu.addEventListener("keydown", handleMenuKeydown);

document.addEventListener("click", () => hideMenu());
document.addEventListener("scroll", () => hideMenu(), true);
document.addEventListener("keydown", (event: KeyboardEvent) => {
  if (event.key === "Escape") hideMenu(true);
  if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "f") {
    event.preventDefault();
    searchInput.focus();
    searchInput.select();
  }
});

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
  const state = createJsonTreeSearchState(currentRoot, query);
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
  if (requestId !== latestSearchRequest || !searchActive || !rootNode) return;
  const exactIds = new Set(result.matches);
  const pending: TreeNodeElement[] = [rootNode];
  let index = 0;
  const isCurrent = (): boolean => requestId === latestSearchRequest && searchActive;
  const processChunk = (): void => {
    if (!isCurrent()) return;
    const startedAt = performance.now();
    while (index < pending.length && performance.now() - startedAt < 8) {
      const node = pending[index];
      node.rememberExpansion();
      const isMatchBranch = result.expandIds.has(node.nodeId);
      node.applySearchState(exactIds.has(node.nodeId), isMatchBranch);
      const finishCurrentNode = (): void => {
        for (const childNode of node.getRenderedChildren()) pending.push(childNode);
        index += 1;
      };
      if (
        isMatchBranch &&
        !node.ensureExpanded(isCurrent, () => {
          if (!isCurrent()) return;
          finishCurrentNode();
          setTimeout(processChunk, 0);
        })
      ) {
        return;
      }
      finishCurrentNode();
    }
    if (index < pending.length) {
      setTimeout(processChunk, 0);
      return;
    }
    searchApplying = false;
    matchRows = Array.from(tree.querySelectorAll<HTMLElement>(".row.search-match"));
    activeMatchIndex = -1;
    const count = result.truncated ? matchRows.length + "+" : String(matchRows.length);
    searchCount.textContent = matchRows.length === 1 ? t("{0} match", count) : t("{0} matches", count);
    const hasMatches = matchRows.length > 0;
    previousMatchButton.disabled = !hasMatches;
    nextMatchButton.disabled = !hasMatches;
    emptySearch.classList.toggle("hidden", hasMatches);
    updateActionButtons();
    if (hasMatches) selectRelativeMatch(1, result.truncated);
  };
  processChunk();
}

function selectRelativeMatch(delta: number, truncated = searchTruncated): void {
  if (matchRows.length === 0) return;
  searchTruncated = truncated;
  if (activeMatchIndex >= 0) matchRows[activeMatchIndex].classList.remove("active-match");
  activeMatchIndex = (activeMatchIndex + delta + matchRows.length) % matchRows.length;
  const row = matchRows[activeMatchIndex];
  row.classList.add("active-match");
  row.scrollIntoView({ block: "center", behavior: "smooth" });
  const owner = (row as HTMLElement & { treeNode?: TreeNodeElement }).treeNode;
  if (owner) setFocusedNode(owner, false);
  const total = truncated ? matchRows.length + "+" : String(matchRows.length);
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
  const requestId = ++latestSearchRequest;
  searchActive = false;
  searchApplying = false;
  matchRows = [];
  activeMatchIndex = -1;
  searchCount.textContent = "";
  previousMatchButton.disabled = true;
  nextMatchButton.disabled = true;
  clearSearchButton.disabled = true;
  emptySearch.classList.add("hidden");
  if (wasActive && rootNode) {
    restoreSearchState(requestId);
  } else {
    updateActionButtons();
  }
}

/** Shared chunked breadth-first walk over rendered nodes. */
function walkTree(
  isCurrent: () => boolean,
  visit: (node: TreeNodeElement) => boolean,
  onDone: () => void,
  progress?: (count: number) => void,
): void {
  if (!rootNode) return;
  const pending: TreeNodeElement[] = [rootNode];
  let index = 0;
  const processChunk = (): void => {
    if (!isCurrent()) return;
    const startedAt = performance.now();
    let processedInChunk = 0;
    while (index < pending.length && processedInChunk < TREE_OPERATION_CHUNK_SIZE && performance.now() - startedAt < 8) {
      const node = pending[index];
      const finishCurrentNode = (): void => {
        for (const childNode of node.getRenderedChildren()) pending.push(childNode);
        index += 1;
        processedInChunk += 1;
      };
      if (
        visit(node) &&
        !node.ensureExpanded(isCurrent, () => {
          if (!isCurrent()) return;
          finishCurrentNode();
          progress?.(index);
          setTimeout(processChunk, 0);
        }, true)
      ) {
        return;
      }
      finishCurrentNode();
    }
    progress?.(index);
    if (index < pending.length) {
      setTimeout(processChunk, 0);
    } else {
      onDone();
    }
  };
  processChunk();
}

function restoreSearchState(requestId: number): void {
  const operationId = ++activeTreeOperation;
  treeOperationRunning = true;
  updateActionButtons();
  walkTree(
    () => requestId === latestSearchRequest && operationId === activeTreeOperation && !searchActive,
    (node) => node.restoreSearchState(),
    () => {
      treeOperationRunning = false;
      updateActionButtons();
    },
  );
}

/** Re-expands the nodes saved before the Webview was discarded or the source re-parsed. */
function restoreExpansion(ids: Set<number>, onDone: () => void): void {
  const operationId = ++activeTreeOperation;
  treeOperationRunning = true;
  updateActionButtons();
  walkTree(
    () => operationId === activeTreeOperation,
    (node) => node.expandable && ids.has(node.nodeId),
    () => {
      treeOperationRunning = false;
      updateActionButtons();
      onDone();
    },
  );
}

function runTreeOperation(shouldExpand: boolean): void {
  // Collapse all also works during search and cancels an in-flight expansion.
  if (!rootNode || (shouldExpand && (searchActive || !expandAllAllowed))) return;
  const operationId = ++activeTreeOperation;
  const searchedTree = searchActive;
  treeOperationRunning = true;
  updateActionButtons();
  walkTree(
    () => operationId === activeTreeOperation && searchActive === searchedTree,
    (node) => {
      if (!shouldExpand) node.setExpanded(false);
      return shouldExpand;
    },
    () => {
      treeOperationRunning = false;
      treeOperationStatus.textContent = "";
      updateActionButtons();
    },
    (count) => {
      treeOperationStatus.textContent = shouldExpand
        ? t("Expanding… {0} nodes · Collapse all to stop", count.toLocaleString())
        : t("Collapsing… {0} nodes", count.toLocaleString());
    },
  );
}

function runRootExpansion(): void {
  if (!rootNode || !expandAllAllowed) return;
  const operationId = ++activeTreeOperation;
  treeOperationRunning = true;
  updateActionButtons();
  const isCurrent = (): boolean => operationId === activeTreeOperation && !searchActive;
  const finish = (): void => {
    if (!isCurrent()) return;
    treeOperationRunning = false;
    updateActionButtons();
  };
  if (rootNode.ensureExpanded(isCurrent, finish)) finish();
}

function toggleNodeManually(node: TreeNodeElement): void {
  if (treeOperationRunning || searchApplying) return;
  if (node.decodable) {
    requestDecode(node);
    return;
  }
  if (!node.expandable) return;
  const operationId = ++activeTreeOperation;
  const shouldExpand = !node.isExpanded();
  if (!shouldExpand) {
    node.setExpanded(false);
    return;
  }
  const searchedTree = searchActive;
  // Inside search results, an explicitly opened branch shows all its children.
  if (searchedTree) node.revealChildrenInSearch();
  node.ensureExpanded(
    () => operationId === activeTreeOperation && searchActive === searchedTree,
    () => {},
  );
}

/** Asks the Host to parse a string's embedded JSON; the reply attaches it inline. */
function requestDecode(node: TreeNodeElement): void {
  if (!node.decodable) return;
  node.rowElement.classList.add("decoding");
  vscode.postMessage({ type: "expandDecoded", nodeId: node.nodeId });
}

function updateActionButtons(): void {
  expandAllButton.disabled = searchActive || treeOperationRunning || !expandAllAllowed;
  collapseAllButton.disabled = false;
  searchInput.disabled = false;
  if (!treeOperationRunning) treeOperationStatus.textContent = "";
}

function applyJsonlState(state: JsonlViewState): void {
  jsonlLineInput.value = String(state.lineNumber);
  jsonlTotal.textContent = " / " + Number(state.lineCount).toLocaleString();
  followCursorInput.checked = state.followCursor === true;
  jsonlStatus.textContent = state.status || "";
  const busy = state.busy === true;
  previousJsonlButton.disabled = busy;
  nextJsonlButton.disabled = busy;
  jsonlLineInput.disabled = busy;
  goJsonlButton.disabled = busy;
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

function createNode(
  key: string,
  model: JsonTreeWebviewNode,
  edgeInfo: EdgeInfo | undefined,
  treeParent: TreeNodeElement | undefined,
  level = 1,
): TreeNodeElement {
  const node = document.createElement("div") as TreeNodeElement;
  node.className = "node";
  node.setAttribute("role", "treeitem");
  node.setAttribute("aria-level", String(level));
  node.tabIndex = -1;
  const row = document.createElement("div") as HTMLDivElement & { treeNode?: TreeNodeElement };
  row.className = "row";
  row.treeNode = node;
  const isContainer = model.type === "object" || model.type === "array";
  let expandable = isContainer || model.decoded !== undefined;
  node.setAttribute("aria-label", key + ": " + describeValue(model));
  row.title = t(typeLabel(model.type));
  const toggle = document.createElement("span");
  row.appendChild(toggle);

  const keySpan = document.createElement("span");
  keySpan.className = edgeInfo?.decoded ? "key decoded-key" : "key";
  keySpan.textContent = key;
  if (edgeInfo?.keyTruncated) {
    keySpan.title = t("Key shortened from {0} characters", (edgeInfo.keyLength ?? 0).toLocaleString());
  }
  row.appendChild(keySpan);
  const separator = document.createElement("span");
  separator.className = "separator";
  separator.textContent = ":";
  row.appendChild(separator);

  appendValue(row, model, key);
  if (edgeInfo?.keyTruncated || edgeInfo?.rawKeyTruncated || model.rawTruncated || model.valueTruncated) {
    const truncatedBadge = document.createElement("span");
    truncatedBadge.className = "truncated-note";
    const lengths: number[] = [];
    if (edgeInfo?.keyTruncated) lengths.push(edgeInfo.keyLength ?? 0);
    if (edgeInfo?.rawKeyTruncated) lengths.push(edgeInfo.rawKeyLength ?? 0);
    if (model.rawTruncated) lengths.push(model.rawLength ?? 0);
    if (model.valueTruncated) lengths.push(model.valueLength ?? 0);
    const longest = Math.max(...lengths);
    truncatedBadge.textContent = t("… {0} chars", longest.toLocaleString());
    truncatedBadge.title = t("Only the beginning and end are displayed and searched. Copy/open actions use the complete value.");
    row.appendChild(truncatedBadge);
  }
  node.appendChild(row);

  let children: HTMLDivElement | undefined;
  let fullyMaterialized = false;
  let nextChildIndex = 0;
  let materializeGeneration = 0;
  let isExpanded = false;
  let savedExpansion = false;
  let hasSavedExpansion = false;
  let revealInSearch = false;
  const childNodes: TreeNodeElement[] = [];
  const childModels = (): Array<{ label: string; model: JsonTreeWebviewNode; edge: EdgeInfo }> => {
    if (model.decoded !== undefined) {
      const label = model.decoded.recovered ? t("decoded JSON (recovered)") : t("decoded JSON");
      return [{ label, model: model.decoded.root, edge: { hasKey: false, hasRawKey: false, decoded: true } }];
    }
    return (model.children || []).map((child) => ({
      label: String(child.key),
      model: child.value,
      edge: {
        hasKey: true,
        hasRawKey: child.rawKey !== undefined,
        keyTruncated: child.keyTruncated,
        keyLength: child.keyLength,
        rawKeyTruncated: child.rawKeyTruncated,
        rawKeyLength: child.rawKeyLength,
      },
    }));
  };
  let modelChildren = childModels();
  const updateToggle = (): void => {
    toggle.className = "toggle" + (expandable ? "" : node.decodable ? " decodable" : " empty");
    toggle.textContent = expandable ? (isExpanded ? "▾" : "▸") : node.decodable ? "▸" : "";
    toggle.title = node.decodable ? t("Show embedded JSON") : "";
    if (expandable || node.decodable) node.setAttribute("aria-expanded", String(isExpanded));
  };
  const setExpanded = (shouldExpand: boolean): void => {
    if (!expandable) return;
    if (!shouldExpand) materializeGeneration += 1;
    if (children) children.classList.toggle("hidden", !shouldExpand);
    isExpanded = shouldExpand;
    updateToggle();
    if (!searchActive) {
      if (shouldExpand) expandedIds.add(model.id);
      else expandedIds.delete(model.id);
      schedulePersist();
    }
  };
  const ensureExpanded = (isCurrent: () => boolean, onComplete: () => void, eager = false): boolean => {
    if (!expandable) return true;
    setExpanded(true);
    if (fullyMaterialized) return true;
    if (modelChildren.length === 0) {
      fullyMaterialized = true;
      return true;
    }
    if (!children) {
      children = document.createElement("div");
      children.className = "children";
      children.setAttribute("role", "group");
      node.appendChild(children);
    }
    const group = children;
    const generation = ++materializeGeneration;
    const processMaterializeChunk = (notify = true): void => {
      if (generation !== materializeGeneration || !isCurrent() || !isExpanded) return;
      const fragment = document.createDocumentFragment();
      const startedAt = performance.now();
      let createdInChunk = 0;
      while (
        nextChildIndex < modelChildren.length &&
        createdInChunk < MATERIALIZE_CHILD_CHUNK_SIZE &&
        performance.now() - startedAt < 8
      ) {
        const child = modelChildren[nextChildIndex];
        const childNode = createNode(child.label, child.model, child.edge, node, level + 1);
        if (searchActive && !revealInSearch) childNode.classList.add("search-hidden");
        childNodes.push(childNode);
        fragment.appendChild(childNode);
        nextChildIndex += 1;
        createdInChunk += 1;
      }
      group.appendChild(fragment);
      if (nextChildIndex < modelChildren.length) {
        setTimeout(processMaterializeChunk, 0);
      } else {
        fullyMaterialized = true;
        if (notify) onComplete();
      }
    };
    // Bulk operations share their traversal time slice instead of paying
    // one timer turn for every tiny object. Wide/manual expansion still
    // yields in bounded chunks, and synchronous completion never invokes
    // the asynchronous continuation twice.
    if (eager) processMaterializeChunk(false);
    else setTimeout(processMaterializeChunk, 0);
    return fullyMaterialized;
  };
  node.nodeId = model.id;
  node.treeParent = treeParent;
  node.rowElement = row;
  node.decodable = !expandable && model.decodable === true;
  Object.defineProperty(node, "expandable", { get: () => expandable });
  node.setExpanded = setExpanded;
  node.ensureExpanded = ensureExpanded;
  node.isExpanded = () => isExpanded;
  node.getRenderedChildren = () => childNodes;
  node.revealChildrenInSearch = () => {
    revealInSearch = true;
    for (const childNode of childNodes) childNode.classList.remove("search-hidden");
  };
  node.rememberExpansion = () => {
    if (!hasSavedExpansion) {
      savedExpansion = isExpanded;
      hasSavedExpansion = true;
    }
  };
  node.applySearchState = (isExactMatch: boolean, isMatchBranch: boolean) => {
    revealInSearch = false;
    node.classList.toggle("search-hidden", !isExactMatch && !isMatchBranch);
    row.classList.toggle("search-match", isExactMatch);
    row.classList.remove("active-match");
    if (expandable && !isMatchBranch) setExpanded(false);
  };
  node.restoreSearchState = () => {
    revealInSearch = false;
    node.classList.remove("search-hidden");
    row.classList.remove("search-match", "active-match");
    if (!hasSavedExpansion) return expandable && isExpanded;
    const shouldExpand = expandable && savedExpansion;
    if (expandable && !shouldExpand) setExpanded(false);
    hasSavedExpansion = false;
    return shouldExpand;
  };
  node.openMenu = () => {
    const rect = row.getBoundingClientRect();
    showMenu((rect as DOMRect).left ?? 0, (rect as DOMRect).bottom ?? 0, model, edgeInfo, node, true);
  };
  node.attachDecoded = (decoded) => {
    row.classList.remove("decoding");
    if (expandable) return;
    // Mutating the shared model keeps search and later renders consistent.
    model.decoded = decoded;
    delete model.decodable;
    node.decodable = false;
    expandable = true;
    modelChildren = childModels();
    if (searchActive) node.revealChildrenInSearch();
    updateToggle();
    // Opening a string shows the decoded value's top level, not just its root row.
    if (ensureExpanded(() => true, () => {}, true)) {
      childNodes[0]?.ensureExpanded(() => true, () => {}, true);
    }
  };
  node.markNotDecodable = () => {
    row.classList.remove("decoding");
    delete model.decodable;
    node.decodable = false;
    node.removeAttribute?.("aria-expanded");
    updateToggle();
  };
  updateToggle();
  renderedNodes.set(model.id, node);
  row.addEventListener("click", () => {
    setFocusedNode(node, false);
    toggleNodeManually(node);
  });
  row.addEventListener("contextmenu", (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setFocusedNode(node, false);
    showMenu(event.clientX, event.clientY, model, edgeInfo, node, false);
  });
  return node;
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

function appendValue(row: HTMLElement, model: JsonTreeWebviewNode, key: string): void {
  const span = document.createElement("span");
  if (model.type === "object" || model.type === "array") {
    span.className = "summary";
    const count = (model.children || []).length;
    span.textContent = model.type === "array" ? "[" + count + "]" : "{" + count + "}";
    row.appendChild(span);
    return;
  }

  span.className = "value " + model.type;
  span.textContent = model.raw ?? "";
  const titles: string[] = [];
  let hint: string | undefined;
  if (model.rawTruncated) {
    titles.push(t("Value shortened from {0} characters; right-click actions use the complete value", (model.rawLength ?? 0).toLocaleString()));
  }
  if (model.type === "number") {
    const timestamp = describeTimestamp(model.raw ?? "", key);
    if (timestamp !== undefined) {
      titles.push(timestamp.title);
      hint = timestamp.hint;
    }
  } else if (model.type === "string") {
    const value = typeof model.value === "string" ? model.value : "";
    const length = model.valueLength ?? Array.from(value).length;
    titles.push(length === 1 ? t("1 character") : t("{0} characters", length.toLocaleString()));
    if (!model.valueTruncated && isColorValue(value)) {
      const swatch = document.createElement("span");
      swatch.className = "color-swatch";
      if (swatch.style) swatch.style.backgroundColor = value.trim();
      row.appendChild(swatch);
    }
    if (!model.valueTruncated && /^https?:\/\/\S+$/i.test(value.trim())) {
      span.classList.add("link");
      titles.push(t("Cmd/Ctrl+click to open the link"));
      span.addEventListener("click", (event: MouseEvent) => {
        if (!event.metaKey && !event.ctrlKey) return;
        event.preventDefault();
        event.stopPropagation();
        vscode.postMessage({ type: "openLink", nodeId: model.id });
      });
    }
    if (model.decodable || model.decoded) titles.push(t("Click to show the embedded JSON inline"));
    titles.push(t("Right-click (or Shift+F10) to inspect or copy this string"));
  }
  span.title = titles.join("\n");
  row.appendChild(span);
  if (hint !== undefined) {
    const hintSpan = document.createElement("span");
    hintSpan.className = "value-hint";
    hintSpan.textContent = hint;
    row.appendChild(hintSpan);
  }
}

/** Plausible Unix timestamps (2000–2100) in seconds or milliseconds. */
function describeTimestamp(raw: string, key: string): { title: string; hint?: string } | undefined {
  if (!/^\d{10}(?:\.\d+)?$/.test(raw) && !/^\d{13}$/.test(raw)) return undefined;
  const milliseconds = raw.length === 13 ? Number(raw) : Number(raw) * 1000;
  if (milliseconds < Date.UTC(2000, 0, 1) || milliseconds >= Date.UTC(2100, 0, 1)) return undefined;
  const date = new Date(milliseconds);
  const iso = date.toISOString().replace(".000Z", "Z");
  const timeLikeKey = /(?:time|date|stamp|epoch|created|updated|modified|expire|^ts$|_at$|^iat$|^nbf$|^exp$)/i.test(key) ||
    /At$/.test(key);
  return {
    title: t("Timestamp: {0} UTC · {1} local", iso, date.toLocaleString()),
    hint: timeLikeKey ? iso : undefined,
  };
}

function isColorValue(value: string): boolean {
  const text = value.trim();
  return /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(text) ||
    /^(?:rgb|hsl)a?\([^()]{1,60}\)$/i.test(text);
}

// Keyboard navigation follows the WAI-ARIA tree pattern with a roving tabindex.

function setFocusedNode(node: TreeNodeElement, focus = true): void {
  if (focusedNode && focusedNode !== node) focusedNode.tabIndex = -1;
  focusedNode = node;
  node.tabIndex = 0;
  if (focus) {
    node.focus();
    node.rowElement.scrollIntoView?.({ block: "nearest" });
  }
}

function isShown(node: TreeNodeElement): boolean {
  return !node.classList.contains("search-hidden");
}

function visibleChildren(node: TreeNodeElement): TreeNodeElement[] {
  return node.isExpanded() ? node.getRenderedChildren().filter(isShown) : [];
}

function lastVisibleDescendant(node: TreeNodeElement): TreeNodeElement {
  let current = node;
  for (let children = visibleChildren(current); children.length > 0; children = visibleChildren(current)) {
    current = children[children.length - 1];
  }
  return current;
}

function nextVisible(node: TreeNodeElement): TreeNodeElement | undefined {
  const children = visibleChildren(node);
  if (children.length > 0) return children[0];
  for (let current = node; current.treeParent; current = current.treeParent) {
    const siblings = current.treeParent.getRenderedChildren();
    for (let index = siblings.indexOf(current) + 1; index < siblings.length; index += 1) {
      if (isShown(siblings[index])) return siblings[index];
    }
  }
  return undefined;
}

function previousVisible(node: TreeNodeElement): TreeNodeElement | undefined {
  const parent = node.treeParent;
  if (!parent) return undefined;
  const siblings = parent.getRenderedChildren();
  for (let index = siblings.indexOf(node) - 1; index >= 0; index -= 1) {
    if (isShown(siblings[index])) return lastVisibleDescendant(siblings[index]);
  }
  return parent;
}

function handleTreeKeydown(event: KeyboardEvent): void {
  const node = focusedNode;
  if (!node || !rootNode) return;
  let target: TreeNodeElement | undefined;
  switch (event.key) {
    case "ArrowDown":
      target = nextVisible(node);
      break;
    case "ArrowUp":
      target = previousVisible(node);
      break;
    case "ArrowRight":
      if ((node.expandable && !node.isExpanded()) || node.decodable) toggleNodeManually(node);
      else target = visibleChildren(node)[0];
      break;
    case "ArrowLeft":
      if (node.expandable && node.isExpanded()) toggleNodeManually(node);
      else target = node.treeParent;
      break;
    case "Home":
      target = rootNode;
      break;
    case "End":
      target = lastVisibleDescendant(rootNode);
      break;
    case "Enter":
    case " ":
      if (node.expandable || node.decodable) toggleNodeManually(node);
      else node.openMenu();
      break;
    case "ContextMenu":
      node.openMenu();
      break;
    case "F10":
      if (!event.shiftKey) return;
      node.openMenu();
      break;
    default:
      return;
  }
  event.preventDefault();
  if (target) setFocusedNode(target);
}

/**
 * Expands the path to a node and highlights it without taking keyboard focus,
 * so following the editor cursor never interrupts typing.
 */
function revealNode(ids: number[]): void {
  if (!rootNode || ids[0] !== rootNode.nodeId || searchActive || treeOperationRunning) return;
  const generation = ++revealGeneration;
  const isCurrent = (): boolean => generation === revealGeneration;
  let node: TreeNodeElement = rootNode;
  let index = 1;
  const descend = (): boolean => {
    const child = node.getRenderedChildren().find((candidate) => candidate.nodeId === ids[index]);
    if (child === undefined) return false;
    node = child;
    index += 1;
    return true;
  };
  const step = (): void => {
    while (index < ids.length) {
      if (!node.ensureExpanded(isCurrent, () => {
        if (isCurrent() && descend()) step();
      }, true)) return;
      if (!descend()) return;
    }
    if (cursorRow) cursorRow.classList.remove("cursor-match");
    cursorRow = node.rowElement;
    cursorRow.classList.add("cursor-match");
    setFocusedNode(node, false);
    cursorRow.scrollIntoView?.({ block: "nearest" });
  };
  step();
}

function showMenu(
  x: number,
  y: number,
  model: JsonTreeWebviewNode,
  edgeInfo: EdgeInfo | undefined,
  origin: TreeNodeElement,
  fromKeyboard: boolean,
): void {
  menu.replaceChildren();
  menuOrigin = origin;
  if (sourceRevealable) {
    addMenuItem(t("Reveal in source"), () => vscode.postMessage({ type: "revealInSource", nodeId: model.id }));
    addSeparator();
  }
  if (model.type === "string") {
    if (origin.decodable) {
      addMenuItem(t("Show embedded JSON inline"), () => requestDecode(origin));
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
  if (wasOpen && restoreFocus && menuOrigin) setFocusedNode(menuOrigin);
  menuOrigin = undefined;
}

// Structural paths (child indexes, DECODED_EDGE for decoded strings) identify
// nodes across a re-parse, where every ID changes.

function captureViewByStructure(): { expandedPaths: number[][]; scrollTop: number } {
  const wanted = new Set(expandedIds);
  const expandedPaths: number[][] = [];
  if (currentRoot !== undefined && wanted.size > 0) {
    const pending: Array<{ model: JsonTreeWebviewNode; path: number[] }> = [{ model: currentRoot, path: [] }];
    while (pending.length > 0) {
      const { model, path } = pending.pop() as { model: JsonTreeWebviewNode; path: number[] };
      if (wanted.has(model.id)) expandedPaths.push(path);
      if (model.decoded) pending.push({ model: model.decoded.root, path: [...path, DECODED_EDGE] });
      (model.children || []).forEach((child, index) => pending.push({ model: child.value, path: [...path, index] }));
    }
  }
  return { expandedPaths, scrollTop: tree.scrollTop };
}

function resolveStructuralPaths(paths: number[][]): number[] {
  const ids: number[] = [];
  for (const path of paths) {
    let model: JsonTreeWebviewNode | undefined = currentRoot;
    for (const step of path) {
      model = step === DECODED_EDGE ? model?.decoded?.root : model?.children?.[step]?.value;
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
    } satisfies SavedViewState);
  }, 250);
}

vscode.postMessage({ type: "ready" });

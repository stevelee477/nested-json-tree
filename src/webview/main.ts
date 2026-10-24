import type { JsonTreeWebviewNode } from "../jsonTree";
import type {
  HostToWebviewMessage,
  JsonlViewState,
  RenderMessage,
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
}

interface TreeNodeElement extends HTMLDivElement {
  nodeId: number;
  treeParent: TreeNodeElement | undefined;
  expandable: boolean;
  setExpanded(shouldExpand: boolean): void;
  ensureExpanded(isCurrent: () => boolean, onComplete: () => void, eager?: boolean): boolean;
  isExpanded(): boolean;
  getRenderedChildren(): TreeNodeElement[];
  revealChildrenInSearch(): void;
  rememberExpansion(): void;
  applySearchState(isExactMatch: boolean, isMatchBranch: boolean): void;
  restoreSearchState(): boolean;
  openMenu(): void;
}

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
let rootNode: TreeNodeElement | undefined;
let currentRoot: JsonTreeWebviewNode | undefined;
let renderKey = -1;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let searchActive = false;
let searchApplying = false;
let latestSearchRequest = 0;
let matchRows: HTMLElement[] = [];
let activeMatchIndex = -1;
let expandAllAllowed = false;
let activeTreeOperation = 0;
let treeOperationRunning = false;
let focusedNode: TreeNodeElement | undefined;
let menuOrigin: TreeNodeElement | undefined;
/** Expansion outside search mode; search-driven expansion is never persisted. */
const expandedIds = new Set<number>();
let persistScheduled = false;
const MATERIALIZE_CHILD_CHUNK_SIZE = 200;
const TREE_OPERATION_CHUNK_SIZE = 200;

window.addEventListener("message", (event: MessageEvent<HostToWebviewMessage>) => {
  const message = event.data;
  if (message.type === "jsonlState") {
    applyJsonlState(message);
    return;
  }
  if (message.type !== "render") return;
  render(message);
});

function render(message: RenderMessage): void {
  activeTreeOperation += 1;
  latestSearchRequest += 1;
  treeOperationRunning = false;
  clearTimeout(searchTimer);
  searchActive = false;
  searchApplying = false;
  matchRows = [];
  activeMatchIndex = -1;
  searchCount.textContent = "";
  previousMatchButton.disabled = true;
  nextMatchButton.disabled = true;
  emptySearch.classList.add("hidden");
  treeOperationStatus.textContent = "";
  hideMenu();
  recoveryWarning.classList.toggle("hidden", !message.recovery);
  recoveryWarning.textContent = message.recovery
    ? "Recovered partial JSON · " + message.recovery.errorCount + " syntax issue(s). Damaged values omitted; copy/open uses the recovered subset (array indices may differ)."
    : "";
  recoveryWarning.title = message.recovery
    ? message.recovery.issues.map((issue) => issue.code + " at character " + (issue.offset + 1)).join("; ")
    : "";
  const saved = renderKey === -1 ? loadViewState(message.renderKey) : undefined;
  renderKey = message.renderKey;
  currentRoot = message.root;
  expandAllAllowed = message.canExpandAll;
  expandedIds.clear();
  byId("title").textContent = message.title;
  byId("path").textContent = message.pathLabel;
  jsonlBar.classList.toggle("hidden", !message.jsonl);
  if (message.jsonl) applyJsonlState(message.jsonl);
  const hasTruncatedFields = message.truncatedFieldCount > 0;
  searchScopeWarning.classList.toggle("hidden", !hasTruncatedFields);
  searchInput.placeholder = hasTruncatedFields
    ? "Search displayed text (long values shortened)…"
    : "Search keys and values…";
  expandAllButton.title = expandAllAllowed
    ? "Expand every object and array"
    : "Expand all is unavailable because this tree exceeds " + message.expandAllLimit.toLocaleString() + " nodes";
  rootNode = createNode("$", currentRoot, undefined, undefined);
  tree.replaceChildren(rootNode);
  setFocusedNode(rootNode, false);
  if (saved) {
    searchInput.value = saved.query;
    restoreExpansion(new Set(saved.expanded), () => {
      tree.scrollTop = saved.scrollTop;
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
  searchCount.textContent = "Searching…";
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
    const suffix = result.truncated ? "+" : "";
    searchCount.textContent = matchRows.length + suffix + (matchRows.length === 1 ? " match" : " matches");
    const hasMatches = matchRows.length > 0;
    previousMatchButton.disabled = !hasMatches;
    nextMatchButton.disabled = !hasMatches;
    emptySearch.classList.toggle("hidden", hasMatches);
    updateActionButtons();
    if (hasMatches) selectRelativeMatch(1);
  };
  processChunk();
}

function selectRelativeMatch(delta: number): void {
  if (matchRows.length === 0) return;
  if (activeMatchIndex >= 0) matchRows[activeMatchIndex].classList.remove("active-match");
  activeMatchIndex = (activeMatchIndex + delta + matchRows.length) % matchRows.length;
  const row = matchRows[activeMatchIndex];
  row.classList.add("active-match");
  row.scrollIntoView({ block: "center", behavior: "smooth" });
  const owner = (row as HTMLElement & { treeNode?: TreeNodeElement }).treeNode;
  if (owner) setFocusedNode(owner, false);
  const total = searchCount.textContent?.includes("+") ? matchRows.length + "+" : String(matchRows.length);
  searchCount.textContent = (activeMatchIndex + 1) + " / " + total;
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

/** Re-expands the nodes saved before the Webview was discarded. */
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
      treeOperationStatus.textContent = (shouldExpand ? "Expanding… " : "Collapsing… ") + count.toLocaleString() + " nodes" +
        (shouldExpand ? " · Collapse all to stop" : "");
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
  if (treeOperationRunning || searchApplying || !node.expandable) return;
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
  const expandable = model.type === "object" || model.type === "array";
  node.setAttribute("aria-label", key + ": " + describeValue(model));
  row.title = model.type.charAt(0).toUpperCase() + model.type.slice(1);
  const toggle = document.createElement("span");
  toggle.className = "toggle" + (expandable ? "" : " empty");
  toggle.textContent = expandable ? "▸" : "";
  row.appendChild(toggle);

  const keySpan = document.createElement("span");
  keySpan.className = "key";
  keySpan.textContent = key;
  if (edgeInfo?.keyTruncated) {
    keySpan.title = "Key shortened from " + (edgeInfo.keyLength ?? 0).toLocaleString() + " characters";
  }
  row.appendChild(keySpan);
  const separator = document.createElement("span");
  separator.className = "separator";
  separator.textContent = ":";
  row.appendChild(separator);

  appendValue(row, model);
  if (edgeInfo?.keyTruncated || edgeInfo?.rawKeyTruncated || model.rawTruncated || model.valueTruncated) {
    const truncatedBadge = document.createElement("span");
    truncatedBadge.className = "truncated-note";
    const lengths: number[] = [];
    if (edgeInfo?.keyTruncated) lengths.push(edgeInfo.keyLength ?? 0);
    if (edgeInfo?.rawKeyTruncated) lengths.push(edgeInfo.rawKeyLength ?? 0);
    if (model.rawTruncated) lengths.push(model.rawLength ?? 0);
    if (model.valueTruncated) lengths.push(model.valueLength ?? 0);
    const longest = Math.max(...lengths);
    truncatedBadge.textContent = "… " + longest.toLocaleString() + " chars";
    truncatedBadge.title = "Only the beginning and end are displayed and searched. Copy/open actions use the complete value.";
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
  const modelChildren = model.children || [];
  const setExpanded = (shouldExpand: boolean): void => {
    if (!expandable) return;
    if (!shouldExpand) materializeGeneration += 1;
    if (children) children.classList.toggle("hidden", !shouldExpand);
    isExpanded = shouldExpand;
    toggle.textContent = shouldExpand ? "▾" : "▸";
    node.setAttribute("aria-expanded", String(shouldExpand));
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
        const childNode = createNode(String(child.key), child.value, {
          hasKey: true,
          hasRawKey: child.rawKey !== undefined,
          keyTruncated: child.keyTruncated,
          keyLength: child.keyLength,
          rawKeyTruncated: child.rawKeyTruncated,
          rawKeyLength: child.rawKeyLength,
        }, node, level + 1);
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
  node.expandable = expandable;
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
  if (expandable) node.setAttribute("aria-expanded", "false");
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

function describeValue(model: JsonTreeWebviewNode): string {
  if (model.type === "array") return "array, " + (model.children || []).length + " items";
  if (model.type === "object") return "object, " + (model.children || []).length + " keys";
  return model.type + " " + (model.raw ?? "");
}

function appendValue(row: HTMLElement, model: JsonTreeWebviewNode): void {
  const span = document.createElement("span");
  if (model.type === "object" || model.type === "array") {
    span.className = "summary";
    const count = (model.children || []).length;
    span.textContent = model.type === "array" ? "[" + count + "]" : "{" + count + "}";
  } else {
    span.className = "value " + model.type;
    span.textContent = model.raw ?? "";
    if (model.rawTruncated) {
      span.title = "Value shortened from " + (model.rawLength ?? 0).toLocaleString() + " characters; right-click actions use the complete value";
    } else if (model.type === "string") {
      span.title = "Right-click (or Shift+F10) to inspect or copy this string";
    }
  }
  row.appendChild(span);
}

// Keyboard navigation follows the WAI-ARIA tree pattern with a roving tabindex.

function setFocusedNode(node: TreeNodeElement, focus = true): void {
  if (focusedNode && focusedNode !== node) focusedNode.tabIndex = -1;
  focusedNode = node;
  node.tabIndex = 0;
  if (focus) {
    node.focus();
    node.scrollIntoView?.({ block: "nearest" });
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
      if (node.expandable && !node.isExpanded()) toggleNodeManually(node);
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
      if (node.expandable) toggleNodeManually(node);
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
  if (model.type === "string") {
    addMenuItem("Open as nested JSON tree", () => vscode.postMessage({ type: "openNested", nodeId: model.id }));
    addMenuItem("Open parsed JSON in new editor", () => vscode.postMessage({ type: "openParsedJson", nodeId: model.id }));
    addMenuItem("Open decoded string value in new editor", () => vscode.postMessage({ type: "openDecodedValue", nodeId: model.id }));
    addSeparator();
    addMenuItem("Copy raw JSON string (escaped)", () => vscode.postMessage({ type: "copyRawString", nodeId: model.id }));
    addMenuItem("Copy decoded string value", () => vscode.postMessage({ type: "copyDecodedString", nodeId: model.id }));
    addSeparator();
  } else {
    addMenuItem("Copy value", () => vscode.postMessage({ type: "copyValue", nodeId: model.id }));
  }
  if (edgeInfo?.hasKey) {
    addMenuItem("Copy key", () => vscode.postMessage({ type: "copyKey", nodeId: model.id }));
  }
  if (edgeInfo?.hasRawKey) {
    addMenuItem("Copy raw key token", () => vscode.postMessage({ type: "copyRawKey", nodeId: model.id }));
  }
  addMenuItem("Copy JSON path", () => vscode.postMessage({ type: "copyJsonPath", nodeId: model.id }));
  addMenuItem("Copy jq path", () => vscode.postMessage({ type: "copyJqPath", nodeId: model.id }));
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

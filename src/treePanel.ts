import * as vscode from "vscode";
import {
  JsonCandidate,
  JsonProcessingLimitError,
  parseNestedJsonCandidates,
} from "./parser";
import {
  JsonTreeNodeContext,
  JsonTreeOutputTooLargeError,
  assertTransferTextSize,
  buildJsonTreeContextIndex,
  createJsonTreeWebviewModel,
  isValidJsonTreeNodeId,
  materializeJsonTreePath,
  stringifyJsonTreeForTransfer,
} from "./jsonTree";
import {
  formatJqPathForTransfer,
  formatJsonPathForDisplay,
  formatJsonPathForTransfer,
} from "./paths";
import {
  advanceJsonTreeSearch,
  createJsonTreeSearchState,
  jsonTreePrimitiveSearchText,
} from "./search";
import {
  MAX_EXPAND_ALL_NODES,
  isTreeNodeCountWithinLimit,
  shouldAutoExpandTree,
} from "./treeOptions";

export type CandidatePicker = (
  candidates: ReturnType<typeof parseNestedJsonCandidates>,
  place: string,
) => Promise<JsonCandidate | undefined>;

type NodeAction =
  | "openNested"
  | "openParsedJson"
  | "copyValue"
  | "copyRawString"
  | "copyDecodedString"
  | "copyKey"
  | "copyRawKey"
  | "copyJsonPath"
  | "copyJqPath";

const NODE_ACTIONS = new Set<NodeAction>([
  "openNested",
  "openParsedJson",
  "copyValue",
  "copyRawString",
  "copyDecodedString",
  "copyKey",
  "copyRawKey",
  "copyJsonPath",
  "copyJqPath",
]);

export class JsonTreePanel {
  private readonly nodeContexts: Map<number, JsonTreeNodeContext>;
  private readonly webviewModel: ReturnType<typeof createJsonTreeWebviewModel>;

  static create(
    candidate: JsonCandidate,
    title: string,
    pickCandidate: CandidatePicker,
    pathLabel = "$",
  ): JsonTreePanel {
    const panel = vscode.window.createWebviewPanel(
      "nestedJsonTree.viewer",
      title,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    return new JsonTreePanel(panel, candidate, title, pathLabel, pickCandidate);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly candidate: JsonCandidate,
    private readonly title: string,
    private readonly pathLabel: string,
    private readonly pickCandidate: CandidatePicker,
  ) {
    this.nodeContexts = buildJsonTreeContextIndex(candidate.tree);
    this.webviewModel = createJsonTreeWebviewModel(candidate.tree);
    panel.webview.onDidReceiveMessage((message: unknown) => void this.handleMessage(message));
    panel.webview.html = this.getHtml(panel.webview);
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!isPanelMessage(message)) return;

    if (message.type === "ready") {
      const maxNodes = vscode.workspace
        .getConfiguration("nestedJsonTree")
        .get<number>("autoExpandMaxNodes", 200);
      await this.panel.webview.postMessage({
        type: "render",
        root: this.webviewModel.root,
        title: this.title,
        pathLabel: this.pathLabel,
        truncatedFieldCount: this.webviewModel.truncatedFieldCount,
        autoExpand: shouldAutoExpandTree(this.candidate.tree, maxNodes),
        canExpandAll: isTreeNodeCountWithinLimit(
          this.candidate.tree,
          MAX_EXPAND_ALL_NODES,
        ),
        expandAllLimit: MAX_EXPAND_ALL_NODES,
      });
      return;
    }

    if (!isNodeAction(message.type) || !isValidJsonTreeNodeId(message.nodeId)) return;
    const context = this.nodeContexts.get(message.nodeId);
    if (context === undefined) return;
    const node = context.node;

    if (message.type === "copyKey") {
      if (context.parent !== undefined && context.key !== undefined) {
        const text = String(context.key);
        try {
          assertTransferTextSize(text);
          await vscode.env.clipboard.writeText(text);
        } catch (error) {
          if (error instanceof JsonTreeOutputTooLargeError) {
            void vscode.window.showErrorMessage(`Cannot copy key: ${error.message}`);
            return;
          }
          throw error;
        }
      }
      return;
    }

    if (message.type === "copyRawKey") {
      if (context.rawKey !== undefined) {
        try {
          assertTransferTextSize(context.rawKey);
          await vscode.env.clipboard.writeText(context.rawKey);
        } catch (error) {
          if (error instanceof JsonTreeOutputTooLargeError) {
            void vscode.window.showErrorMessage(`Cannot copy raw key: ${error.message}`);
            return;
          }
          throw error;
        }
      }
      return;
    }

    if (message.type === "copyJsonPath" || message.type === "copyJqPath") {
      if (context.hasDuplicateKeyInPath) {
        const syntax = message.type === "copyJsonPath" ? "JSONPath" : "jq path";
        void vscode.window.showWarningMessage(
          `Cannot copy ${syntax}: this path passes through a duplicate object key and is ambiguous.`,
        );
        return;
      }
      const path = materializeJsonTreePath(context);
      try {
        const text =
          message.type === "copyJsonPath"
            ? formatJsonPathForTransfer(path)
            : formatJqPathForTransfer(path);
        await vscode.env.clipboard.writeText(text);
      } catch (error) {
        if (error instanceof JsonTreeOutputTooLargeError) {
          void vscode.window.showErrorMessage(`Cannot copy path: ${error.message}`);
          return;
        }
        throw error;
      }
      return;
    }

    if (
      message.type === "copyValue" ||
      message.type === "copyRawString" ||
      message.type === "copyDecodedString"
    ) {
      try {
        let text: string | undefined;
        let compacted = false;
        if (message.type === "copyValue") {
          const serialized = stringifyJsonTreeForTransfer(node);
          text = serialized.text;
          compacted = serialized.compacted;
        } else if (message.type === "copyRawString" && node.type === "string") {
          text = node.raw as string;
          assertTransferTextSize(text);
        } else if (message.type === "copyDecodedString" && node.type === "string") {
          text = node.value as string;
          assertTransferTextSize(text);
        }
        if (text !== undefined) {
          await vscode.env.clipboard.writeText(text);
          if (compacted) {
            void vscode.window.showInformationMessage(
              "Copied compact JSON because pretty-formatted output would be too large.",
            );
          }
        }
      } catch (error) {
        if (error instanceof JsonTreeOutputTooLargeError) {
          void vscode.window.showErrorMessage(`Cannot copy value: ${error.message}`);
          return;
        }
        throw error;
      }
      return;
    }

    if (message.type !== "openNested" && message.type !== "openParsedJson") return;
    if (node.type !== "string") return;
    const displayPath = formatJsonPathForDisplay(materializeJsonTreePath(context));
    let candidates: ReturnType<typeof parseNestedJsonCandidates>;
    try {
      candidates = parseNestedJsonCandidates(node.value as string);
    } catch (error) {
      if (error instanceof JsonProcessingLimitError) {
        void vscode.window.showErrorMessage(`Cannot open nested JSON at ${displayPath}: ${error.message}`);
        return;
      }
      throw error;
    }
    if (candidates.length === 0) {
      void vscode.window.showWarningMessage(`The string at ${displayPath} does not contain valid JSON.`);
      return;
    }

    const selected = await this.pickCandidate(candidates, displayPath);
    if (selected === undefined) {
      return;
    }

    if (message.type === "openParsedJson") {
      let serialized: ReturnType<typeof stringifyJsonTreeForTransfer>;
      try {
        serialized = stringifyJsonTreeForTransfer(selected.tree);
      } catch (error) {
        if (error instanceof JsonTreeOutputTooLargeError) {
          void vscode.window.showErrorMessage(`Cannot open parsed JSON: ${error.message}`);
          return;
        }
        throw error;
      }
      const document = await vscode.workspace.openTextDocument({
        content: serialized.text,
        language: "json",
      });
      await vscode.window.showTextDocument(document, {
        preview: false,
        viewColumn: vscode.ViewColumn.Beside,
      });
      if (serialized.compacted) {
        void vscode.window.showInformationMessage(
          "Opened compact JSON because pretty-formatted output would be too large.",
        );
      }
    } else {
      JsonTreePanel.create(
        selected,
        `Nested JSON · ${displayPath}`,
        this.pickCandidate,
        displayPath,
      );
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = createNonce();
    const searchRuntime = [
      `const createJsonTreeSearchState = ${createJsonTreeSearchState.toString()};`,
      `const jsonTreePrimitiveSearchText = ${jsonTreePrimitiveSearchText.toString()};`,
      `const advanceJsonTreeSearch = ${advanceJsonTreeSearch.toString()};`,
    ].join("\n");
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style nonce="${nonce}">
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      overflow: hidden;
    }
    header {
      height: 78px;
      display: flex;
      flex-direction: column;
      gap: 5px;
      padding: 6px 14px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
    }
    .header-main { width: 100%; display: flex; align-items: center; gap: 10px; min-height: 27px; }
    .header-title { min-width: 0; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .header-path { color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); }
    .header-actions { display: flex; gap: 4px; margin-left: auto; }
    .header-button {
      height: 26px;
      padding: 0 9px;
      border: 1px solid transparent;
      border-radius: 3px;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      font: inherit;
      cursor: pointer;
    }
    .header-button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .header-button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
    .header-button:disabled { opacity: 0.5; cursor: default; }
    .search-bar { width: 100%; display: flex; align-items: center; gap: 4px; }
    #search-input {
      min-width: 100px;
      height: 27px;
      flex: 1;
      padding: 2px 8px;
      border: 1px solid var(--vscode-input-border, transparent);
      outline: none;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      font: inherit;
    }
    #search-input:focus { border-color: var(--vscode-focusBorder); }
    #search-count { min-width: 72px; color: var(--vscode-descriptionForeground); text-align: right; white-space: nowrap; }
    #search-scope-warning {
      max-width: 260px;
      overflow: hidden;
      color: var(--vscode-editorWarning-foreground, var(--vscode-descriptionForeground));
      font-size: 11px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .search-button { width: 28px; padding: 0; font-family: var(--vscode-editor-font-family); }
    #tree { height: calc(100vh - 78px); padding: 8px 4px 24px 8px; overflow: auto; }
    .node { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
    .row {
      min-height: 23px;
      display: flex;
      align-items: center;
      padding-right: 8px;
      border-radius: 3px;
      white-space: nowrap;
      user-select: none;
    }
    .row:hover { background: var(--vscode-list-hoverBackground); }
    .row.search-match { background: var(--vscode-editor-findMatchHighlightBackground); }
    .row.search-match.active-match {
      background: var(--vscode-editor-findMatchBackground);
      outline: 1px solid var(--vscode-editor-findMatchBorder, var(--vscode-focusBorder));
    }
    .node.search-hidden { display: none; }
    .toggle {
      width: 18px;
      flex: 0 0 18px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
    }
    .toggle.empty { cursor: default; }
    .key { color: var(--vscode-symbolIcon-propertyForeground, #9cdcfe); }
    .separator { color: var(--vscode-descriptionForeground); margin-right: 6px; }
    .value.string { color: var(--vscode-debugTokenExpression-string, #ce9178); cursor: context-menu; }
    .value.number { color: var(--vscode-debugTokenExpression-number, #b5cea8); }
    .value.boolean { color: var(--vscode-debugTokenExpression-boolean, #569cd6); }
    .value.null { color: var(--vscode-descriptionForeground); font-style: italic; }
    .summary { color: var(--vscode-descriptionForeground); }
    .badge {
      margin-left: 8px;
      padding: 0 5px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-font-family);
      font-size: 10px;
      text-transform: uppercase;
    }
    .truncated-badge { text-transform: none; }
    .children { margin-left: 18px; border-left: 1px solid var(--vscode-tree-indentGuidesStroke); padding-left: 1px; }
    .hidden { display: none !important; }
    #menu {
      position: fixed;
      z-index: 100;
      min-width: 220px;
      padding: 4px;
      border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
      border-radius: 4px;
      color: var(--vscode-menu-foreground, var(--vscode-foreground));
      background: var(--vscode-menu-background, var(--vscode-editorWidget-background));
      box-shadow: 0 4px 14px var(--vscode-widget-shadow);
    }
    .menu-item { padding: 6px 10px; border-radius: 3px; cursor: default; }
    .menu-item:hover { color: var(--vscode-menu-selectionForeground); background: var(--vscode-menu-selectionBackground); }
    .menu-separator { height: 1px; margin: 4px; background: var(--vscode-menu-separatorBackground, var(--vscode-panel-border)); }
    #empty-search {
      position: fixed;
      top: 96px;
      left: 0;
      right: 0;
      color: var(--vscode-descriptionForeground);
      text-align: center;
      pointer-events: none;
    }
  </style>
</head>
<body>
  <header>
    <div class="header-main">
      <span class="header-title" id="title"></span>
      <span class="header-path" id="path"></span>
      <span class="header-actions">
        <button class="header-button" id="expand-all" type="button" title="Expand every object and array">Expand all</button>
        <button class="header-button" id="collapse-all" type="button" title="Collapse the entire tree">Collapse all</button>
      </span>
    </div>
    <div class="search-bar" role="search">
      <input id="search-input" type="search" placeholder="Search keys and values…" aria-label="Search JSON keys and values" spellcheck="false" disabled>
      <span id="search-scope-warning" class="hidden" title="Long keys and values are shortened in this view. Search covers the displayed prefix and suffix only; copy and open actions still use the complete host value.">Long values shortened · search is display-only</span>
      <span id="search-count" aria-live="polite"></span>
      <button class="header-button search-button" id="previous-match" type="button" title="Previous match (Shift+Enter)" disabled>↑</button>
      <button class="header-button search-button" id="next-match" type="button" title="Next match (Enter)" disabled>↓</button>
      <button class="header-button search-button" id="clear-search" type="button" title="Clear search (Escape)" disabled>×</button>
    </div>
  </header>
  <main id="tree" role="tree"></main>
  <div id="empty-search" class="hidden">No matches</div>
  <div id="menu" class="hidden" role="menu"></div>
  <script nonce="${nonce}">
    ${searchRuntime}
    const vscode = acquireVsCodeApi();
    const tree = document.getElementById('tree');
    const menu = document.getElementById('menu');
    const searchInput = document.getElementById('search-input');
    const searchScopeWarning = document.getElementById('search-scope-warning');
    const searchCount = document.getElementById('search-count');
    const previousMatchButton = document.getElementById('previous-match');
    const nextMatchButton = document.getElementById('next-match');
    const clearSearchButton = document.getElementById('clear-search');
    const expandAllButton = document.getElementById('expand-all');
    const collapseAllButton = document.getElementById('collapse-all');
    const emptySearch = document.getElementById('empty-search');
    let rootNode;
    let currentRoot;
    let searchTimer;
    let searchActive = false;
    let latestSearchRequest = 0;
    let matchRows = [];
    let activeMatchIndex = -1;
    let expandAllAllowed = false;
    let activeTreeOperation = 0;
    let treeOperationRunning = false;
    const MATERIALIZE_CHILD_CHUNK_SIZE = 200;

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type !== 'render') return;
      activeTreeOperation += 1;
      latestSearchRequest += 1;
      treeOperationRunning = false;
      currentRoot = message.root;
      expandAllAllowed = message.canExpandAll;
      document.getElementById('title').textContent = message.title;
      document.getElementById('path').textContent = message.pathLabel;
      const hasTruncatedFields = message.truncatedFieldCount > 0;
      searchScopeWarning.classList.toggle('hidden', !hasTruncatedFields);
      searchInput.placeholder = hasTruncatedFields
        ? 'Search displayed text (long values shortened)…'
        : 'Search keys and values…';
      expandAllButton.title = expandAllAllowed
        ? 'Expand every object and array'
        : 'Expand all is unavailable because this tree exceeds ' + message.expandAllLimit.toLocaleString() + ' nodes';
      rootNode = createNode('$', currentRoot, undefined);
      tree.replaceChildren(rootNode);
      if (message.autoExpand && expandAllAllowed) {
        runTreeOperation(true);
      } else if (expandAllAllowed) {
        runRootExpansion();
      } else {
        updateActionButtons();
      }
    });

    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(runSearch, 120);
    });
    searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        selectRelativeMatch(event.shiftKey ? -1 : 1);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        clearSearch();
      }
    });
    previousMatchButton.addEventListener('click', () => selectRelativeMatch(-1));
    nextMatchButton.addEventListener('click', () => selectRelativeMatch(1));
    clearSearchButton.addEventListener('click', clearSearch);

    expandAllButton.addEventListener('click', () => runTreeOperation(true));
    collapseAllButton.addEventListener('click', () => runTreeOperation(false));

    document.addEventListener('click', hideMenu);
    document.addEventListener('scroll', hideMenu, true);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') hideMenu();
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'f') {
        event.preventDefault();
        searchInput.focus();
        searchInput.select();
      }
    });

    function runSearch() {
      const query = searchInput.value.trim();
      clearSearchButton.disabled = query.length === 0;
      if (query.length === 0) {
        resetSearchView();
        return;
      }
      searchActive = true;
      activeTreeOperation += 1;
      treeOperationRunning = false;
      const requestId = ++latestSearchRequest;
      searchCount.textContent = 'Searching…';
      previousMatchButton.disabled = true;
      nextMatchButton.disabled = true;
      emptySearch.classList.add('hidden');
      updateActionButtons();
      const state = createJsonTreeSearchState(currentRoot, query);
      const processChunk = () => {
        if (requestId !== latestSearchRequest || !searchActive) return;
        if (advanceJsonTreeSearch(state, 2_000)) {
          applySearchResults(state, requestId);
        } else {
          setTimeout(processChunk, 0);
        }
      };
      processChunk();
    }

    function applySearchResults(result, requestId) {
      if (requestId !== latestSearchRequest || !searchActive || !rootNode) return;
      const exactIds = new Set(result.matches);
      const pending = [rootNode];
      let index = 0;
      const isCurrent = () => requestId === latestSearchRequest && searchActive;
      const processChunk = () => {
        if (!isCurrent()) return;
        const startedAt = performance.now();
        while (index < pending.length && performance.now() - startedAt < 8) {
          const node = pending[index];
          node.rememberExpansion();
          const isMatchBranch = result.expandIds.has(node.nodeId);
          node.applySearchState(exactIds.has(node.nodeId), isMatchBranch);
          const finishCurrentNode = () => {
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
        matchRows = Array.from(tree.querySelectorAll('.row.search-match'));
        activeMatchIndex = -1;
        const suffix = result.truncated ? '+' : '';
        searchCount.textContent = matchRows.length + suffix + (matchRows.length === 1 ? ' match' : ' matches');
        const hasMatches = matchRows.length > 0;
        previousMatchButton.disabled = !hasMatches;
        nextMatchButton.disabled = !hasMatches;
        emptySearch.classList.toggle('hidden', hasMatches);
        if (hasMatches) selectRelativeMatch(1);
      };
      processChunk();
    }

    function selectRelativeMatch(delta) {
      if (matchRows.length === 0) return;
      if (activeMatchIndex >= 0) matchRows[activeMatchIndex].classList.remove('active-match');
      activeMatchIndex = (activeMatchIndex + delta + matchRows.length) % matchRows.length;
      const row = matchRows[activeMatchIndex];
      row.classList.add('active-match');
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      const total = searchCount.textContent.includes('+') ? matchRows.length + '+' : String(matchRows.length);
      searchCount.textContent = (activeMatchIndex + 1) + ' / ' + total;
    }

    function clearSearch() {
      searchInput.value = '';
      clearTimeout(searchTimer);
      resetSearchView();
      searchInput.focus();
    }

    function resetSearchView() {
      const wasActive = searchActive;
      const requestId = ++latestSearchRequest;
      searchActive = false;
      matchRows = [];
      activeMatchIndex = -1;
      searchCount.textContent = '';
      previousMatchButton.disabled = true;
      nextMatchButton.disabled = true;
      clearSearchButton.disabled = true;
      emptySearch.classList.add('hidden');
      if (wasActive && rootNode) {
        restoreSearchState(requestId);
      } else {
        updateActionButtons();
      }
    }

    function restoreSearchState(requestId) {
      const operationId = ++activeTreeOperation;
      treeOperationRunning = true;
      updateActionButtons();
      const pending = [rootNode];
      let index = 0;
      const isCurrent = () =>
        requestId === latestSearchRequest && operationId === activeTreeOperation && !searchActive;
      const processChunk = () => {
        if (!isCurrent()) return;
        const startedAt = performance.now();
        while (index < pending.length && performance.now() - startedAt < 8) {
          const node = pending[index];
          const shouldExpand = node.restoreSearchState();
          const finishCurrentNode = () => {
            for (const childNode of node.getRenderedChildren()) pending.push(childNode);
            index += 1;
          };
          if (
            shouldExpand &&
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
        } else {
          treeOperationRunning = false;
          updateActionButtons();
        }
      };
      processChunk();
    }

    function runTreeOperation(shouldExpand) {
      if (!rootNode || searchActive || (shouldExpand && !expandAllAllowed)) return;
      const operationId = ++activeTreeOperation;
      treeOperationRunning = true;
      updateActionButtons();
      const pending = [rootNode];
      let index = 0;
      const isCurrent = () => operationId === activeTreeOperation && !searchActive;
      const processChunk = () => {
        if (!isCurrent()) return;
        const startedAt = performance.now();
        while (index < pending.length && performance.now() - startedAt < 8) {
          const node = pending[index];
          const finishCurrentNode = () => {
            for (const childNode of node.getRenderedChildren()) pending.push(childNode);
            index += 1;
          };
          if (
            shouldExpand &&
            !node.ensureExpanded(isCurrent, () => {
              if (!isCurrent()) return;
              finishCurrentNode();
              setTimeout(processChunk, 0);
            })
          ) {
            return;
          }
          if (!shouldExpand) node.setExpanded(false);
          finishCurrentNode();
        }
        if (index < pending.length) {
          setTimeout(processChunk, 0);
        } else {
          treeOperationRunning = false;
          updateActionButtons();
        }
      };
      processChunk();
    }

    function runRootExpansion() {
      if (!rootNode || !expandAllAllowed) return;
      const operationId = ++activeTreeOperation;
      treeOperationRunning = true;
      updateActionButtons();
      const isCurrent = () => operationId === activeTreeOperation && !searchActive;
      const finish = () => {
        if (!isCurrent()) return;
        treeOperationRunning = false;
        updateActionButtons();
      };
      if (rootNode.ensureExpanded(isCurrent, finish)) finish();
    }

    function toggleNodeManually(node) {
      if (searchActive || treeOperationRunning) return;
      const operationId = ++activeTreeOperation;
      const shouldExpand = !node.isExpanded();
      if (!shouldExpand) {
        node.setExpanded(false);
        return;
      }
      node.ensureExpanded(
        () => operationId === activeTreeOperation && !searchActive,
        () => {},
      );
    }

    function updateActionButtons() {
      expandAllButton.disabled = searchActive || treeOperationRunning || !expandAllAllowed;
      // Collapse all also acts as a user-visible cancellation for an in-flight expansion.
      collapseAllButton.disabled = searchActive;
      searchInput.disabled = treeOperationRunning;
    }

    function createNode(key, model, edgeInfo) {
      const node = document.createElement('div');
      node.className = 'node';
      if (searchActive) node.classList.add('search-hidden');
      node.setAttribute('role', 'treeitem');
      const row = document.createElement('div');
      row.className = 'row';
      const expandable = model.type === 'object' || model.type === 'array';
      const toggle = document.createElement('span');
      toggle.className = 'toggle' + (expandable ? '' : ' empty');
      toggle.textContent = expandable ? '▸' : '';
      row.appendChild(toggle);

      const keySpan = document.createElement('span');
      keySpan.className = 'key';
      keySpan.textContent = key;
      if (edgeInfo && edgeInfo.keyTruncated) {
        keySpan.title = 'Key shortened from ' + edgeInfo.keyLength.toLocaleString() + ' characters';
      }
      row.appendChild(keySpan);
      const separator = document.createElement('span');
      separator.className = 'separator';
      separator.textContent = ':';
      row.appendChild(separator);

      appendValue(row, model);
      if ((edgeInfo && (edgeInfo.keyTruncated || edgeInfo.rawKeyTruncated)) || model.rawTruncated || model.valueTruncated) {
        const truncatedBadge = document.createElement('span');
        truncatedBadge.className = 'badge truncated-badge';
        const lengths = [];
        if (edgeInfo && edgeInfo.keyTruncated) lengths.push(edgeInfo.keyLength);
        if (edgeInfo && edgeInfo.rawKeyTruncated) lengths.push(edgeInfo.rawKeyLength);
        if (model.rawTruncated) lengths.push(model.rawLength);
        if (model.valueTruncated) lengths.push(model.valueLength);
        const longest = Math.max(...lengths);
        truncatedBadge.textContent = 'truncated · ' + longest.toLocaleString() + ' chars';
        truncatedBadge.title = 'Only the beginning and end are displayed and searched. Copy/open actions use the complete value.';
        row.appendChild(truncatedBadge);
      }
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = model.type;
      row.appendChild(badge);
      node.appendChild(row);

      let children;
      let fullyMaterialized = false;
      let nextChildIndex = 0;
      let materializeGeneration = 0;
      let isExpanded = false;
      let savedExpansion = false;
      let hasSavedExpansion = false;
      const childNodes = [];
      const modelChildren = model.children || [];
      const setExpanded = (shouldExpand) => {
        if (!expandable) return;
        if (!shouldExpand) materializeGeneration += 1;
        if (children) children.classList.toggle('hidden', !shouldExpand);
        isExpanded = shouldExpand;
        toggle.textContent = shouldExpand ? '▾' : '▸';
        node.setAttribute('aria-expanded', String(shouldExpand));
      };
      const ensureExpanded = (isCurrent, onComplete) => {
        if (!expandable) return true;
        setExpanded(true);
        if (fullyMaterialized) return true;
        if (modelChildren.length === 0) {
          fullyMaterialized = true;
          return true;
        }
        if (!children) {
          children = document.createElement('div');
          children.className = 'children';
          children.setAttribute('role', 'group');
          node.appendChild(children);
        }
        const generation = ++materializeGeneration;
        const processMaterializeChunk = () => {
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
            const label = typeof child.key === 'number' ? '[' + child.key + ']' : child.key;
            const childNode = createNode(label, child.value, {
              hasKey: true,
              hasRawKey: child.rawKey !== undefined,
              keyTruncated: child.keyTruncated,
              keyLength: child.keyLength,
              rawKeyTruncated: child.rawKeyTruncated,
              rawKeyLength: child.rawKeyLength,
            });
            childNodes.push(childNode);
            fragment.appendChild(childNode);
            nextChildIndex += 1;
            createdInChunk += 1;
          }
          children.appendChild(fragment);
          if (nextChildIndex < modelChildren.length) {
            setTimeout(processMaterializeChunk, 0);
          } else {
            fullyMaterialized = true;
            onComplete();
          }
        };
        setTimeout(processMaterializeChunk, 0);
        return false;
      };
      node.nodeId = model.id;
      node.setExpanded = setExpanded;
      node.ensureExpanded = ensureExpanded;
      node.isExpanded = () => isExpanded;
      node.getRenderedChildren = () => childNodes;
      node.rememberExpansion = () => {
        if (!hasSavedExpansion) {
          savedExpansion = isExpanded;
          hasSavedExpansion = true;
        }
      };
      node.applySearchState = (isExactMatch, isMatchBranch) => {
        node.classList.toggle('search-hidden', !isExactMatch && !isMatchBranch);
        row.classList.toggle('search-match', isExactMatch);
        row.classList.remove('active-match');
        if (expandable && !isMatchBranch) setExpanded(false);
      };
      node.restoreSearchState = () => {
        node.classList.remove('search-hidden');
        row.classList.remove('search-match', 'active-match');
        if (!hasSavedExpansion) return expandable && isExpanded;
        const shouldExpand = expandable && hasSavedExpansion && savedExpansion;
        if (expandable && !shouldExpand) setExpanded(false);
        hasSavedExpansion = false;
        return shouldExpand;
      };
      if (expandable) {
        node.setAttribute('aria-expanded', 'false');
        row.addEventListener('click', () => toggleNodeManually(node));
      }
      row.addEventListener('contextmenu', (event) => showMenu(event, model, edgeInfo));
      return node;
    }

    function appendValue(row, model) {
      const span = document.createElement('span');
      if (model.type === 'object' || model.type === 'array') {
        span.className = 'summary';
        const count = (model.children || []).length;
        span.textContent = model.type === 'array' ? 'Array(' + count + ')' : 'Object(' + count + ')';
      } else {
        span.className = 'value ' + model.type;
        span.textContent = model.raw;
        if (model.rawTruncated) {
          span.title = 'Value shortened from ' + model.rawLength.toLocaleString() + ' characters; right-click actions use the complete value';
        } else if (model.type === 'string') {
          span.title = 'Right-click to inspect or copy this string';
        }
      }
      row.appendChild(span);
    }

    function showMenu(event, model, edgeInfo) {
      event.preventDefault();
      event.stopPropagation();
      menu.replaceChildren();
      if (model.type === 'string') {
        addMenuItem('Open as nested JSON tree', () => vscode.postMessage({ type: 'openNested', nodeId: model.id }));
        addMenuItem('Open parsed JSON in new editor', () => vscode.postMessage({ type: 'openParsedJson', nodeId: model.id }));
        addSeparator();
        addMenuItem('Copy raw JSON string (escaped)', () => vscode.postMessage({ type: 'copyRawString', nodeId: model.id }));
        addMenuItem('Copy decoded string value', () => vscode.postMessage({ type: 'copyDecodedString', nodeId: model.id }));
        addSeparator();
      } else {
        addMenuItem('Copy value', () => vscode.postMessage({ type: 'copyValue', nodeId: model.id }));
      }
      if (edgeInfo && edgeInfo.hasKey) {
        addMenuItem('Copy key', () => vscode.postMessage({ type: 'copyKey', nodeId: model.id }));
      }
      if (edgeInfo && edgeInfo.hasRawKey) {
        addMenuItem('Copy raw key token', () => vscode.postMessage({ type: 'copyRawKey', nodeId: model.id }));
      }
      addMenuItem('Copy JSON path', () => vscode.postMessage({ type: 'copyJsonPath', nodeId: model.id }));
      addMenuItem('Copy jq path', () => vscode.postMessage({ type: 'copyJqPath', nodeId: model.id }));
      menu.classList.remove('hidden');
      const rect = menu.getBoundingClientRect();
      menu.style.left = Math.max(4, Math.min(event.clientX, window.innerWidth - rect.width - 4)) + 'px';
      menu.style.top = Math.max(4, Math.min(event.clientY, window.innerHeight - rect.height - 4)) + 'px';
    }

    function addMenuItem(label, action) {
      const item = document.createElement('div');
      item.className = 'menu-item';
      item.textContent = label;
      item.addEventListener('click', (event) => { event.stopPropagation(); hideMenu(); action(); });
      menu.appendChild(item);
    }
    function addSeparator() {
      const separator = document.createElement('div');
      separator.className = 'menu-separator';
      menu.appendChild(separator);
    }
    function hideMenu() { menu.classList.add('hidden'); }

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

function isPanelMessage(value: unknown): value is { type: string; nodeId?: unknown } {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, "type") &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

function isNodeAction(value: string): value is NodeAction {
  return NODE_ACTIONS.has(value as NodeAction);
}

function createNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

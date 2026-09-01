import * as vscode from "vscode";
import { JsonValue, encodeJsonStringLiteral, parseNestedJsonCandidates } from "./parser";
import { formatJqPath } from "./paths";
import { searchJson } from "./search";
import { shouldAutoExpand } from "./treeOptions";

export type CandidatePicker = (
  candidates: ReturnType<typeof parseNestedJsonCandidates>,
  place: string,
) => Promise<JsonValue | undefined>;

interface PanelMessage {
  type:
    | "ready"
    | "openNested"
    | "openParsedJson"
    | "search"
    | "copy"
    | "copyEscapedString"
    | "copyJqPath";
  value?: string;
  path?: Array<string | number>;
  text?: string;
  query?: string;
  requestId?: number;
}

export class JsonTreePanel {
  static create(
    value: JsonValue,
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
    return new JsonTreePanel(panel, value, title, pathLabel, pickCandidate);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly value: JsonValue,
    private readonly title: string,
    private readonly pathLabel: string,
    private readonly pickCandidate: CandidatePicker,
  ) {
    panel.webview.onDidReceiveMessage((message: PanelMessage) => void this.handleMessage(message));
    panel.webview.html = this.getHtml(panel.webview);
  }

  private async handleMessage(message: PanelMessage): Promise<void> {
    if (message.type === "ready") {
      const maxNodes = vscode.workspace
        .getConfiguration("nestedJsonTree")
        .get<number>("autoExpandMaxNodes", 200);
      await this.panel.webview.postMessage({
        type: "render",
        value: this.value,
        title: this.title,
        pathLabel: this.pathLabel,
        autoExpand: shouldAutoExpand(this.value, maxNodes),
      });
      return;
    }

    if (message.type === "copy" && typeof message.text === "string") {
      await vscode.env.clipboard.writeText(message.text);
      return;
    }

    if (message.type === "copyEscapedString" && typeof message.value === "string") {
      await vscode.env.clipboard.writeText(encodeJsonStringLiteral(message.value));
      return;
    }

    if (message.type === "copyJqPath" && Array.isArray(message.path)) {
      await vscode.env.clipboard.writeText(formatJqPath(message.path));
      return;
    }

    if (
      message.type === "search" &&
      typeof message.query === "string" &&
      typeof message.requestId === "number"
    ) {
      const result = searchJson(this.value, message.query);
      await this.panel.webview.postMessage({
        type: "searchResults",
        requestId: message.requestId,
        ...result,
      });
      return;
    }

    if (
      (message.type !== "openNested" && message.type !== "openParsedJson") ||
      typeof message.value !== "string"
    ) {
      return;
    }

    const jsonPath = formatJsonPath(message.path ?? []);
    const candidates = parseNestedJsonCandidates(message.value);
    if (candidates.length === 0) {
      void vscode.window.showWarningMessage(`The string at ${jsonPath} does not contain valid JSON.`);
      return;
    }

    const selected = await this.pickCandidate(candidates, jsonPath);
    if (selected === undefined) {
      return;
    }

    if (message.type === "openParsedJson") {
      const document = await vscode.workspace.openTextDocument({
        content: JSON.stringify(selected, null, 2),
        language: "json",
      });
      await vscode.window.showTextDocument(document, {
        preview: false,
        viewColumn: vscode.ViewColumn.Beside,
      });
    } else {
      JsonTreePanel.create(selected, `Nested JSON · ${jsonPath}`, this.pickCandidate, jsonPath);
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = createNonce();
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
      <input id="search-input" type="search" placeholder="Search keys and values…" aria-label="Search JSON keys and values" spellcheck="false">
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
    const vscode = acquireVsCodeApi();
    const tree = document.getElementById('tree');
    const menu = document.getElementById('menu');
    const searchInput = document.getElementById('search-input');
    const searchCount = document.getElementById('search-count');
    const previousMatchButton = document.getElementById('previous-match');
    const nextMatchButton = document.getElementById('next-match');
    const clearSearchButton = document.getElementById('clear-search');
    const expandAllButton = document.getElementById('expand-all');
    const collapseAllButton = document.getElementById('collapse-all');
    const emptySearch = document.getElementById('empty-search');
    let rootNode;
    let searchTimer;
    let searchActive = false;
    let latestSearchRequest = 0;
    let matchRows = [];
    let activeMatchIndex = -1;

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'searchResults') {
        applySearchResults(message);
        return;
      }
      if (message.type !== 'render') return;
      document.getElementById('title').textContent = message.title;
      document.getElementById('path').textContent = message.pathLabel;
      rootNode = createNode('$', message.value, [], true, message.autoExpand);
      tree.replaceChildren(rootNode);
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

    expandAllButton.addEventListener('click', () => {
      if (rootNode && rootNode.setExpanded) rootNode.setExpanded(true, true);
    });
    collapseAllButton.addEventListener('click', () => {
      if (rootNode && rootNode.setExpanded) rootNode.setExpanded(false, true);
    });

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
      if (!searchActive && rootNode && rootNode.captureExpansion) {
        rootNode.captureExpansion();
      }
      searchActive = true;
      expandAllButton.disabled = true;
      collapseAllButton.disabled = true;
      latestSearchRequest += 1;
      searchCount.textContent = 'Searching…';
      vscode.postMessage({ type: 'search', query, requestId: latestSearchRequest });
    }

    function applySearchResults(message) {
      if (message.requestId !== latestSearchRequest || !searchActive || !rootNode) return;
      const exactPaths = new Set();
      const expandPaths = new Set();
      for (const path of message.paths) {
        exactPaths.add(pathKey(path));
        for (let length = 0; length < path.length; length += 1) {
          expandPaths.add(pathKey(path.slice(0, length)));
        }
      }
      rootNode.applySearch(exactPaths, expandPaths);
      matchRows = Array.from(tree.querySelectorAll('.row.search-match'));
      activeMatchIndex = -1;
      const suffix = message.truncated ? '+' : '';
      searchCount.textContent = matchRows.length + suffix + (matchRows.length === 1 ? ' match' : ' matches');
      const hasMatches = matchRows.length > 0;
      previousMatchButton.disabled = !hasMatches;
      nextMatchButton.disabled = !hasMatches;
      emptySearch.classList.toggle('hidden', hasMatches);
      if (hasMatches) selectRelativeMatch(1);
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
      latestSearchRequest += 1;
      if (searchActive && rootNode && rootNode.clearSearch) rootNode.clearSearch();
      searchActive = false;
      matchRows = [];
      activeMatchIndex = -1;
      searchCount.textContent = '';
      previousMatchButton.disabled = true;
      nextMatchButton.disabled = true;
      clearSearchButton.disabled = true;
      expandAllButton.disabled = false;
      collapseAllButton.disabled = false;
      emptySearch.classList.add('hidden');
    }

    function createNode(key, value, path, expanded, expandDescendants) {
      const node = document.createElement('div');
      node.className = 'node';
      node.setAttribute('role', 'treeitem');
      const row = document.createElement('div');
      row.className = 'row';
      const expandable = value !== null && typeof value === 'object';
      const toggle = document.createElement('span');
      toggle.className = 'toggle' + (expandable ? '' : ' empty');
      toggle.textContent = expandable ? (expanded ? '▾' : '▸') : '';
      row.appendChild(toggle);

      const keySpan = document.createElement('span');
      keySpan.className = 'key';
      keySpan.textContent = key;
      row.appendChild(keySpan);
      const separator = document.createElement('span');
      separator.className = 'separator';
      separator.textContent = ':';
      row.appendChild(separator);

      appendValue(row, value);
      const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'object' ? 'object' : typeof value;
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = type;
      row.appendChild(badge);
      node.appendChild(row);

      let children;
      let rendered = false;
      let isExpanded = false;
      let savedExpansion;
      const childNodes = [];
      const setExpanded = (shouldExpand, recursive = false) => {
        if (!expandable) return;
        if (!rendered && shouldExpand) {
          children = document.createElement('div');
          children.className = 'children';
          children.setAttribute('role', 'group');
          const entries = Array.isArray(value) ? value.map((item, index) => [index, item]) : Object.entries(value);
          for (const [childKey, childValue] of entries) {
            const label = typeof childKey === 'number' ? '[' + childKey + ']' : childKey;
            const childNode = createNode(
              label,
              childValue,
              path.concat(childKey),
              false,
              false
            );
            childNodes.push(childNode);
            children.appendChild(childNode);
          }
          node.appendChild(children);
          rendered = true;
        }
        if (recursive && rendered) {
          for (const childNode of childNodes) {
            if (childNode.setExpanded) childNode.setExpanded(shouldExpand, true);
          }
        }
        if (rendered) children.classList.toggle('hidden', !shouldExpand);
        isExpanded = shouldExpand;
        toggle.textContent = shouldExpand ? '▾' : '▸';
        node.setAttribute('aria-expanded', String(shouldExpand));
      };
      node.setExpanded = setExpanded;
      node.captureExpansion = () => {
        savedExpansion = isExpanded;
        if (rendered) {
          for (const childNode of childNodes) childNode.captureExpansion();
        }
      };
      node.applySearch = (exactPaths, expandPaths) => {
        const key = pathKey(path);
        const isExactMatch = exactPaths.has(key);
        const isMatchBranch = expandPaths.has(key);
        node.classList.toggle('search-hidden', !isExactMatch && !isMatchBranch);
        row.classList.toggle('search-match', isExactMatch);
        row.classList.remove('active-match');
        if (expandable) setExpanded(isMatchBranch, false);
        if (rendered) {
          for (const childNode of childNodes) childNode.applySearch(exactPaths, expandPaths);
        }
      };
      node.clearSearch = () => {
        node.classList.remove('search-hidden');
        row.classList.remove('search-match', 'active-match');
        if (rendered) {
          for (const childNode of childNodes) childNode.clearSearch();
        }
        if (expandable) setExpanded(savedExpansion ?? false, false);
        savedExpansion = undefined;
      };
      if (expandable) {
        setExpanded(expanded, expandDescendants);
        row.addEventListener('click', () => {
          if (!searchActive) setExpanded(toggle.textContent !== '▾');
        });
      }
      row.addEventListener('contextmenu', (event) => showMenu(event, key, value, path));
      return node;
    }

    function appendValue(row, value) {
      const span = document.createElement('span');
      if (value !== null && typeof value === 'object') {
        span.className = 'summary';
        const count = Array.isArray(value) ? value.length : Object.keys(value).length;
        span.textContent = Array.isArray(value) ? 'Array(' + count + ')' : 'Object(' + count + ')';
      } else {
        const type = value === null ? 'null' : typeof value;
        span.className = 'value ' + type;
        span.textContent = typeof value === 'string' ? JSON.stringify(value) : String(value);
        if (typeof value === 'string') span.title = 'Right-click to open nested JSON';
      }
      row.appendChild(span);
    }

    function showMenu(event, key, value, path) {
      event.preventDefault();
      event.stopPropagation();
      menu.replaceChildren();
      if (typeof value === 'string') {
        addMenuItem('Open as nested JSON tree', () => vscode.postMessage({ type: 'openNested', value, path }));
        addMenuItem('Open parsed JSON in new editor', () => vscode.postMessage({ type: 'openParsedJson', value, path }));
        addSeparator();
        addMenuItem('Copy raw JSON string (escaped)', () => vscode.postMessage({ type: 'copyEscapedString', value }));
        addMenuItem('Copy decoded string value', () => vscode.postMessage({ type: 'copy', text: value }));
        addSeparator();
      } else {
        addMenuItem('Copy value', () => vscode.postMessage({ type: 'copy', text: stringifyValue(value) }));
      }
      if (path.length > 0) addMenuItem('Copy key', () => vscode.postMessage({ type: 'copy', text: String(key) }));
      addMenuItem('Copy JSON path', () => vscode.postMessage({ type: 'copy', text: formatPath(path) }));
      addMenuItem('Copy jq path', () => vscode.postMessage({ type: 'copyJqPath', path }));
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
    function stringifyValue(value) { return typeof value === 'string' ? value : JSON.stringify(value, null, 2); }
    function pathKey(path) { return JSON.stringify(path); }
    function formatPath(path) {
      return '$' + path.map((segment) => typeof segment === 'number'
        ? '[' + segment + ']'
        : /^[A-Za-z_$][\\w$]*$/.test(segment) ? '.' + segment : '[' + JSON.stringify(segment) + ']'
      ).join('');
    }

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

function formatJsonPath(path: Array<string | number>): string {
  return `$${path
    .map((segment) => {
      if (typeof segment === "number") return `[${segment}]`;
      return /^[A-Za-z_$][\w$]*$/.test(segment) ? `.${segment}` : `[${JSON.stringify(segment)}]`;
    })
    .join("")}`;
}

function createNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

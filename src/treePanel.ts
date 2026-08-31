import * as vscode from "vscode";
import { JsonValue, encodeJsonStringLiteral, parseNestedJsonCandidates } from "./parser";
import { shouldAutoExpand } from "./treeOptions";

export type CandidatePicker = (
  candidates: ReturnType<typeof parseNestedJsonCandidates>,
  place: string,
) => Promise<JsonValue | undefined>;

interface PanelMessage {
  type: "ready" | "openNested" | "copy" | "copyEscapedString";
  value?: string;
  path?: Array<string | number>;
  text?: string;
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

    if (message.type !== "openNested" || typeof message.value !== "string") {
      return;
    }

    const jsonPath = formatJsonPath(message.path ?? []);
    const candidates = parseNestedJsonCandidates(message.value);
    if (candidates.length === 0) {
      void vscode.window.showWarningMessage(`The string at ${jsonPath} does not contain valid JSON.`);
      return;
    }

    const selected = await this.pickCandidate(candidates, jsonPath);
    if (selected !== undefined) {
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
      height: 42px;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 0 14px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
    }
    .header-title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .header-path { color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); }
    #tree { height: calc(100vh - 42px); padding: 8px 4px 24px 8px; overflow: auto; }
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
  </style>
</head>
<body>
  <header><span class="header-title" id="title"></span><span class="header-path" id="path"></span></header>
  <main id="tree" role="tree"></main>
  <div id="menu" class="hidden" role="menu"></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const tree = document.getElementById('tree');
    const menu = document.getElementById('menu');

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type !== 'render') return;
      document.getElementById('title').textContent = message.title;
      document.getElementById('path').textContent = message.pathLabel;
      tree.replaceChildren(createNode('$', message.value, [], true, message.autoExpand));
    });

    document.addEventListener('click', hideMenu);
    document.addEventListener('scroll', hideMenu, true);
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') hideMenu(); });

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
      const setExpanded = (shouldExpand) => {
        if (!expandable) return;
        if (!rendered) {
          children = document.createElement('div');
          children.className = 'children';
          children.setAttribute('role', 'group');
          const entries = Array.isArray(value) ? value.map((item, index) => [index, item]) : Object.entries(value);
          for (const [childKey, childValue] of entries) {
            const label = typeof childKey === 'number' ? '[' + childKey + ']' : childKey;
            children.appendChild(createNode(
              label,
              childValue,
              path.concat(childKey),
              expandDescendants,
              expandDescendants
            ));
          }
          node.appendChild(children);
          rendered = true;
        }
        children.classList.toggle('hidden', !shouldExpand);
        toggle.textContent = shouldExpand ? '▾' : '▸';
        node.setAttribute('aria-expanded', String(shouldExpand));
      };
      if (expandable) {
        setExpanded(expanded);
        row.addEventListener('click', () => setExpanded(toggle.textContent !== '▾'));
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
        addSeparator();
        addMenuItem('Copy raw JSON string (escaped)', () => vscode.postMessage({ type: 'copyEscapedString', value }));
        addMenuItem('Copy decoded string value', () => vscode.postMessage({ type: 'copy', text: value }));
        addSeparator();
      } else {
        addMenuItem('Copy value', () => vscode.postMessage({ type: 'copy', text: stringifyValue(value) }));
      }
      if (path.length > 0) addMenuItem('Copy key', () => vscode.postMessage({ type: 'copy', text: String(key) }));
      addMenuItem('Copy JSON path', () => vscode.postMessage({ type: 'copy', text: formatPath(path) }));
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

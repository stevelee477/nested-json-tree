/** Static Tree View markup. Pure, so it can be tested without VS Code. */

export interface WebviewHtmlOptions {
  nonce: string;
  cspSource: string;
  scriptUri: string;
  styleUri: string;
  /** BCP-47 display language for the HTML document (defaults to "en"). */
  language?: string;
  /** Translations for strings the Webview script formats at runtime (key → text). */
  l10nBundle: Record<string, string> | undefined;
  /** Translates a static label; defaults to identity. */
  t?: (message: string) => string;
}

export function renderWebviewHtml(options: WebviewHtmlOptions): string {
  const t = (message: string): string => escapeHtml((options.t ?? ((text) => text))(message));
  const lang = escapeHtml(options.language && options.language.trim().length > 0 ? options.language.trim() : "en");
  const csp = [
    "default-src 'none'",
    `style-src ${options.cspSource}`,
    `script-src 'nonce-${options.nonce}'`,
  ].join("; ");
  // A non-executable JSON block needs no CSP allowance; `<` is escaped so the
  // payload can never close the element.
  const bundle = JSON.stringify(options.l10nBundle ?? {}).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${options.styleUri}">
</head>
<body>
  <header>
    <div class="header-main">
      <span class="header-title" id="title"></span>
      <span class="header-path" id="path"></span>
      <span id="tree-operation-status" aria-live="polite"></span>
      <span class="header-actions">
        <button class="header-button" id="diff-clipboard" type="button" title="${t("Compare tree with clipboard JSON")}">${t("Diff Clipboard")}</button>
        <button class="header-button" id="toggle-inspector" type="button" aria-pressed="false" title="${t("Toggle Value Inspector")}">${t("Inspector")}</button>
        <select class="header-select" id="expand-depth" aria-label="${t("Expand to depth")}" title="${t("Expand tree to a chosen depth")}">
          <option value="">${t("Depth…")}</option>
          <option value="1">${t("Level 1")}</option>
          <option value="2">${t("Level 2")}</option>
          <option value="3">${t("Level 3")}</option>
          <option value="4">${t("Level 4")}</option>
          <option value="5">${t("Level 5")}</option>
        </select>
        <button class="header-button" id="sort-keys" type="button" aria-pressed="false" title="${t("Sort object keys alphabetically (display only)")}">${t("A→Z")}</button>
        <button class="header-button" id="expand-all" type="button" title="${t("Expand every object and array")}">${t("Expand all")}</button>
        <button class="header-button" id="collapse-all" type="button" title="${t("Collapse the entire tree")}">${t("Collapse all")}</button>
      </span>
    </div>
    <div class="recovery-warning hidden" id="recovery-warning" role="status"></div>
    <div class="diff-bar hidden" id="diff-bar" role="status" aria-label="${t("Tree diff summary")}">
      <span class="diff-badge diff-added" id="diff-added-count"></span>
      <span class="diff-badge diff-removed" id="diff-removed-count"></span>
      <span class="diff-badge diff-changed" id="diff-changed-count"></span>
      <span class="diff-unchanged-count" id="diff-unchanged-count"></span>
      <label class="follow-label diff-filter-label" title="${t("Show only added, removed, and changed paths")}"><input id="diff-changes-only" type="checkbox"> ${t("Changes only")}</label>
    </div>
    <div class="jsonl-bar hidden" id="jsonl-bar" aria-label="${t("JSONL navigation")}">
      <button class="header-button" id="previous-jsonl" type="button" title="${t("Previous valid JSON line")}">${t("← Prev")}</button>
      <button class="header-button" id="next-jsonl" type="button" title="${t("Next valid JSON line")}">${t("Next →")}</button>
      <button class="header-button" id="jsonl-diff-prev" type="button" title="${t("Compare with previous valid JSONL record")}">${t("Diff Prev")}</button>
      <label class="jsonl-line-label" for="jsonl-line">${t("Line")}</label>
      <input id="jsonl-line" type="number" min="1" step="1" inputmode="numeric" aria-label="${t("JSONL line number")}">
      <span id="jsonl-total"></span>
      <button class="header-button" id="go-jsonl" type="button">${t("Go")}</button>
      <button class="header-button" id="reveal-source" type="button" title="${t("Reveal this record in the source file")}">${t("Source")}</button>
      <label class="follow-label" title="${t("Follow the editor cursor across lines and highlight the node under it")}"><input id="follow-cursor" type="checkbox"> ${t("Follow cursor")}</label>
      <label class="follow-label" title="${t("Keep expanded branches and inline-decoded strings when moving between lines")}"><input id="keep-view" type="checkbox" checked> ${t("Keep view")}</label>
      <input id="jsonl-filter" type="search" placeholder="${t("Filter lines (e.g. level=ERROR)…")}" aria-label="${t("Filter JSONL lines")}" title="${t("Filter JSONL records by text or key=value (Enter: next match, Shift+Enter: previous)")}" spellcheck="false">
      <button class="header-button" id="jsonl-filter-list" type="button" title="${t("List matching JSONL lines")}">${t("List")}</button>
      <button class="header-button" id="jsonl-table" type="button" title="${t("Open matching JSONL records as a table")}">${t("Table")}</button>
      <span id="jsonl-status" aria-live="polite"></span>
    </div>
    <div class="source-bar hidden" id="source-bar" aria-label="${t("Source document")}">
      <label class="follow-label" title="${t("Highlight the node under the editor cursor")}"><input id="sync-cursor" type="checkbox"> ${t("Sync with editor")}</label>
      <button class="header-button hidden" id="refresh-source" type="button" title="${t("Parse the source document again")}">${t("Refresh")}</button>
      <span id="source-status" aria-live="polite"></span>
    </div>
    <div class="search-bar" role="search">
      <input id="search-input" type="search" placeholder="${t("Search keys and values…")}" aria-label="${t("Search JSON keys and values")}" spellcheck="false" disabled>
      <button class="header-button search-button" id="search-case" type="button" aria-pressed="false" title="${t("Match case")}">Aa</button>
      <button class="header-button search-button" id="search-regex" type="button" aria-pressed="false" title="${t("Use regular expression")}">.*</button>
      <select class="header-select search-scope-select" id="search-scope" aria-label="${t("Search scope")}" title="${t("Search scope: keys, values, or both")}">
        <option value="all">${t("All")}</option>
        <option value="keys">${t("Keys")}</option>
        <option value="values">${t("Values")}</option>
      </select>
      <span id="search-scope-warning" class="hidden" title="${t("Long keys and values are shortened in this view. Search covers the displayed prefix and suffix only; copy and open actions still use the complete host value.")}">${t("Long values shortened · search is display-only")}</span>
      <span id="search-count" aria-live="polite"></span>
      <button class="header-button search-button" id="search-decoded" type="button" aria-pressed="false" title="${t("Also search inside encoded strings (JSON, JWT, URL, Base64)")}">{}</button>
      <button class="header-button search-button" id="previous-match" type="button" title="${t("Previous match (Shift+Enter)")}" disabled>↑</button>
      <button class="header-button search-button" id="next-match" type="button" title="${t("Next match (Enter)")}" disabled>↓</button>
      <button class="header-button search-button" id="clear-search" type="button" title="${t("Clear search (Escape)")}" disabled>×</button>
    </div>
    <div class="pinned-bar hidden" id="pinned-bar" aria-label="${t("Pinned fields")}">
      <span class="pinned-title">${t("Pinned:")}</span>
      <div class="pinned-chips" id="pinned-chips"></div>
      <button class="header-button breadcrumb-button" id="pinned-clear" type="button" title="${t("Unpin all fields")}">${t("Clear")}</button>
    </div>
    <nav class="breadcrumb-bar" id="breadcrumb-bar" aria-label="${t("Focused node path")}">
      <span id="breadcrumb-segments"></span>
      <span class="breadcrumb-actions">
        <button class="header-button breadcrumb-button" id="breadcrumb-copy-jsonpath" type="button" title="${t("Copy JSONPath of focused node")}">${t("JSONPath")}</button>
        <button class="header-button breadcrumb-button" id="breadcrumb-copy-jq" type="button" title="${t("Copy jq path of focused node")}">${t("jq")}</button>
      </span>
    </nav>
  </header>
  <main id="tree" role="tree" aria-label="${t("JSON tree")}"></main>
  <aside id="inspector-drawer" class="inspector-drawer hidden" aria-label="${t("Value Inspector")}">
    <div class="inspector-toolbar">
      <span class="inspector-title">${t("Inspector")}</span>
      <span class="inspector-path" id="inspector-path"></span>
      <span class="inspector-meta" id="inspector-meta"></span>
      <span class="inspector-actions">
        <button class="header-button inspector-button active" id="inspector-wrap" type="button" aria-pressed="true" title="${t("Toggle word wrap")}">${t("Wrap")}</button>
        <button class="header-button inspector-button" id="inspector-copy" type="button" title="${t("Copy inspected value")}">${t("Copy")}</button>
        <button class="header-button inspector-button" id="inspector-close" type="button" title="${t("Close Inspector")}">×</button>
      </span>
    </div>
    <pre class="inspector-content wrap" id="inspector-content"></pre>
  </aside>
  <section id="table-view" class="table-view hidden" aria-label="${t("Table view")}">
    <div class="table-toolbar">
      <span class="table-title" id="table-title"></span>
      <input id="table-filter" type="search" placeholder="${t("Filter table rows…")}" aria-label="${t("Filter table rows")}" spellcheck="false">
      <span class="table-count" id="table-count"></span>
      <button class="header-button" id="table-flatten" type="button" aria-pressed="false" title="${t("Flatten nested object properties into dot-separated columns")}">${t("Flatten")}</button>
      <button class="header-button" id="table-copy-csv" type="button" title="${t("Copy visible rows as CSV")}">${t("Copy CSV")}</button>
      <button class="header-button" id="table-copy-tsv" type="button" title="${t("Copy visible rows as TSV")}">${t("Copy TSV")}</button>
      <button class="header-button" id="table-copy-md" type="button" title="${t("Copy visible rows as Markdown")}">${t("Copy MD")}</button>
      <button class="header-button" id="table-export-csv" type="button" title="${t("Open visible rows as a CSV document")}">${t("Open CSV")}</button>
      <button class="header-button" id="table-close" type="button" title="${t("Return to tree view (Escape)")}">${t("Back to Tree")}</button>
    </div>
    <div id="table-container">
      <table id="data-table"><thead></thead><tbody></tbody></table>
    </div>
  </section>
  <div id="empty-search" class="hidden">${t("No matches")}</div>
  <div id="menu" class="hidden" role="menu"></div>
  <script type="application/json" id="l10n-bundle">${bundle}</script>
  <script nonce="${options.nonce}" src="${options.scriptUri}"></script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

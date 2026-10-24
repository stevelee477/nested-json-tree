/** Static Tree View markup. Pure, so it can be tested without VS Code. */

export interface WebviewHtmlOptions {
  nonce: string;
  cspSource: string;
  scriptUri: string;
  styleUri: string;
  /** Translations for strings the Webview script formats at runtime (key → text). */
  l10nBundle: Record<string, string> | undefined;
  /** Translates a static label; defaults to identity. */
  t?: (message: string) => string;
}

export function renderWebviewHtml(options: WebviewHtmlOptions): string {
  const t = (message: string): string => escapeHtml((options.t ?? ((text) => text))(message));
  const csp = [
    "default-src 'none'",
    `style-src ${options.cspSource}`,
    `script-src 'nonce-${options.nonce}'`,
  ].join("; ");
  // A non-executable JSON block needs no CSP allowance; `<` is escaped so the
  // payload can never close the element.
  const bundle = JSON.stringify(options.l10nBundle ?? {}).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
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
        <button class="header-button" id="expand-all" type="button" title="${t("Expand every object and array")}">${t("Expand all")}</button>
        <button class="header-button" id="collapse-all" type="button" title="${t("Collapse the entire tree")}">${t("Collapse all")}</button>
      </span>
    </div>
    <div class="recovery-warning hidden" id="recovery-warning" role="status"></div>
    <div class="jsonl-bar hidden" id="jsonl-bar" aria-label="${t("JSONL navigation")}">
      <button class="header-button" id="previous-jsonl" type="button" title="${t("Previous valid JSON line")}">${t("← Prev")}</button>
      <button class="header-button" id="next-jsonl" type="button" title="${t("Next valid JSON line")}">${t("Next →")}</button>
      <label class="jsonl-line-label" for="jsonl-line">${t("Line")}</label>
      <input id="jsonl-line" type="number" min="1" step="1" inputmode="numeric" aria-label="${t("JSONL line number")}">
      <span id="jsonl-total"></span>
      <button class="header-button" id="go-jsonl" type="button">${t("Go")}</button>
      <button class="header-button" id="reveal-source" type="button" title="${t("Reveal this record in the source file")}">${t("Source")}</button>
      <label class="follow-label" title="${t("Follow the editor cursor across lines and highlight the node under it")}"><input id="follow-cursor" type="checkbox"> ${t("Follow cursor")}</label>
      <span id="jsonl-status" aria-live="polite"></span>
    </div>
    <div class="source-bar hidden" id="source-bar" aria-label="${t("Source document")}">
      <label class="follow-label" title="${t("Highlight the node under the editor cursor")}"><input id="sync-cursor" type="checkbox"> ${t("Sync with editor")}</label>
      <button class="header-button hidden" id="refresh-source" type="button" title="${t("Parse the source document again")}">${t("Refresh")}</button>
      <span id="source-status" aria-live="polite"></span>
    </div>
    <div class="search-bar" role="search">
      <input id="search-input" type="search" placeholder="${t("Search keys and values…")}" aria-label="${t("Search JSON keys and values")}" spellcheck="false" disabled>
      <span id="search-scope-warning" class="hidden" title="${t("Long keys and values are shortened in this view. Search covers the displayed prefix and suffix only; copy and open actions still use the complete host value.")}">${t("Long values shortened · search is display-only")}</span>
      <span id="search-count" aria-live="polite"></span>
      <button class="header-button search-button" id="search-decoded" type="button" aria-pressed="false" title="${t("Also search inside encoded JSON strings")}">{}</button>
      <button class="header-button search-button" id="previous-match" type="button" title="${t("Previous match (Shift+Enter)")}" disabled>↑</button>
      <button class="header-button search-button" id="next-match" type="button" title="${t("Next match (Enter)")}" disabled>↓</button>
      <button class="header-button search-button" id="clear-search" type="button" title="${t("Clear search (Escape)")}" disabled>×</button>
    </div>
  </header>
  <main id="tree" role="tree" aria-label="${t("JSON tree")}"></main>
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

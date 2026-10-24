// Lists every translatable string so l10n bundles can be checked for coverage.
"use strict";
const { readFileSync } = require("node:fs");
const path = require("node:path");

/** Messages passed through a variable rather than a literal t()/l10n.t() call. */
const DYNAMIC_KEYS = ["Object", "Array", "String", "Number", "Boolean", "Null"];

const HOST_CALL = /vscode\.l10n\.t\(\s*"((?:[^"\\]|\\.)*)"/g;
const WEBVIEW_CALL = /\bt\(\s*"((?:[^"\\]|\\.)*)"/g;
const SOURCES = {
  "src/extension.ts": HOST_CALL,
  "src/treePanel.ts": HOST_CALL,
  "src/settings.ts": HOST_CALL,
  "src/webviewHtml.ts": WEBVIEW_CALL,
  "src/webview/main.ts": WEBVIEW_CALL,
};

function collectL10nKeys(root) {
  const keys = new Set(DYNAMIC_KEYS);
  for (const [file, pattern] of Object.entries(SOURCES)) {
    const source = readFileSync(path.join(root, file), "utf8");
    for (const match of source.matchAll(pattern)) keys.add(JSON.parse(`"${match[1]}"`));
  }
  return [...keys].sort();
}

module.exports = { DYNAMIC_KEYS, collectL10nKeys };

if (require.main === module) {
  console.log(JSON.stringify(collectL10nKeys(path.resolve(__dirname, "..")), null, 2));
}

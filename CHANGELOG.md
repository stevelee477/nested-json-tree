# Changelog

## 0.4.0

- Added JSONC parsing with line/block comments and trailing commas.
- Replaced repeated delimiter rescanning with a bounded linear candidate scan for malformed input.
- Added explicit nesting, node, candidate, scan, and serialized-output limits so hostile input fails clearly instead of exhausting memory or surfacing an inner fragment as the complete value.
- Ignored JSON-looking values inside balanced prefix strings/comments while retaining recovery for unmatched log syntax.
- Preserved large-number tokens, original string/key escapes, and duplicate object keys throughout Tree View display, search, copy, and parsed-editor formatting.
- Derived context-menu values and paths from a Host-side node index, flagged duplicate-key paths as ambiguous, bounded exceptionally long Webview fields and UI paths, and measured copy-path output before allocation while retaining full Host-side copy/open behavior.
- Fixed jq filters for root-array items (`.[0]`) and root object keys that require quoting (`.["x-y"]`).
- Changed the JSONL/NDJSON command to read and size-check only the current line.
- Moved search and tree materialization into incremental Webview chunks and capped **Expand all** at 10,000 nodes to avoid blocking the Extension Host.
- Added real VS Code Extension Host smoke tests and a bundle-integrity regression test.
- Hardened CI and Release workflows with pinned Action SHAs, least-privilege publishing, dependency auditing, and full-history privacy checks.

## 0.3.1

- Added a custom JSON braces and tree icon, with an editable SVG source and packaged PNG asset.

## 0.3.0

- Added case-insensitive Tree View search across keys and primitive values.
- Search expands matching paths, filters unrelated branches, reports match counts, and supports next/previous navigation.

## 0.2.6

- Added the current-line tree command to JSONL/NDJSON editor context menus.
- Limited editor context-menu commands to JSON/JSONC and JSONL/NDJSON files while keeping them available in the Command Palette.

## 0.2.5

- Replaced raw escaped-string opening with **Open parsed JSON in new editor**, which decodes, parses, and formats nested JSON.

## 0.2.4

- Added **Open raw JSON string (escaped) in new editor** for string nodes.

## 0.2.3

- Added **Copy jq path** to the node context menu, including safe quoting for special key names.

## 0.2.2

- Empty object and array values are no longer shown as extracted JSON candidates.

## 0.2.1

- Added one-click **Expand all** and **Collapse all** controls to every tree view.

## 0.2.0

- Automatically expands trees containing at most 200 value nodes.
- Added the `nestedJsonTree.autoExpandMaxNodes` setting for changing or disabling the threshold.

## 0.1.1

- Added **Copy raw JSON string (escaped)** for string nodes.
- Kept decoded-string copying as a separate context-menu action.

## 0.1.0

- Added read-only JSON tree panels.
- Added extraction from text with unrelated prefixes and suffixes.
- Added current-line JSONL/NDJSON viewing.
- Added recursive escaped-JSON opening from string-node context menus.
- Added multiple-candidate selection and a 100 MB input limit.

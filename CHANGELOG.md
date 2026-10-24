# Changelog

## 0.7.0

- Raised the default value-node limit from 100,000 to 500,000 and made it configurable with `nestedJsonTree.maxValueNodes`; ordinary multi-megabyte record arrays now open.
- Stopped counting unmatched brackets in surrounding log text as nesting, so logs with many truncated records no longer fail with a misleading "nesting too deep" error. Deep complete values are still rejected.
- Recovered every record in a run of truncated log records instead of only the first, and removed quadratic work from partial recovery.
- Cleared the JSONL busy state and reported an error when navigation fails, for example after the source file is deleted; unexpected command and Tree View errors are now shown instead of being silently dropped.
- Follow cursor no longer opens a picker on lines with several JSON values; it shows the first one and notes how many there are.
- Allowed expanding/collapsing branches and **Collapse all** while search results are shown.
- Added keyboard navigation (arrow keys, Home/End, Enter/Space, Shift+F10) and an accessible actions menu to the Tree View.
- Restored expansion, search, and scroll state for hidden tabs instead of keeping every Webview alive in memory.
- Reduced Extension Host memory with a compact node index, no duplicate plain-value copy per candidate, and no retained Webview model.
- Moved the Webview script and styles into a separately bundled, type-checked module loaded under a nonce-only CSP with a cryptographic nonce.

## 0.6.0

- Added explicitly marked partial recovery for missing separators, truncated containers, and damaged values while retaining confirmed lossless tokens and omitting malformed primitives.
- Kept complete and recoverable JSON candidates separate in mixed log lines, without letting a broken outer record swallow later complete values.
- Shared bounded bulk-expansion slices across small containers, added progress feedback, and allowed search or Collapse all to cancel expansion.
- Reapplied search when replacing JSONL records instead of leaving the new tree hidden by stale search state.
- Added parser, JSONL, executable Webview, and Extension Host regression coverage.

## 0.5.0

- Opened nested JSON Tree Views as new tabs in the current editor group instead of splitting them to the side.
- Added previous/next valid-record navigation, line-number jumps, source reveal, and optional cursor following to JSONL/NDJSON Tree Views without parsing the whole file.
- Simplified Tree View rows to compact `{count}` and `[count]` summaries and removed redundant visual type badges.
- Added **Open decoded string value in new editor** for viewing decoded text without parsing or formatting it.
- Replaced README screenshots with cropped Retina captures and displayed them at a readable size.
- Updated VSIX packaging dependencies to resolve high-severity build-tool advisories.

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

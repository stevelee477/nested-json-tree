# Changelog

## 0.11.0

- Extended inline decoding to support **Gzip, Zlib, and Deflate-compressed Base64 / Base64URL** payloads (safely capped at 4 MiB decompressed output and decoded as JSON, Protobuf wire format, or readable UTF-8 text), **percent-encoded JSON** (`%7B%22…%7D` / `%5B…%5D`), relative URLs with query strings (`/api/v1/items?a=1&b=2`), custom URI schemes (`ws://`, `wss://`, `grpc://`, `app://`), and standalone query strings (`a=1&b=2&c=3`).
- Added **Cross-decoded structural JSON Tree Diff** (**Diff Clipboard**, **Compare subtree with clipboard**, and JSONL **Diff Prev**) with `+added`, `-removed`, and `~changed` (`old → new`) badges, a **Changes only** filter, and automatic inner diffing across escaped JSON strings.
- Added multi-language **Generate types / schema…** for any object, array, or decoded string node, emitting **TypeScript Interfaces**, **JSON Schema (Draft 2020-12)**, **Zod Schemas**, **Go Structs**, or **Python Pydantic** models to a new editor or the clipboard.
- Added a **Value Inspector** drawer (untruncated Host-side value, path, UTF-8 byte/line/character counts, word-wrap toggle, and one-click copy) and **Pinned Watch** fields (`path: value` chips preserved across live refreshes, panel revivals, and JSONL record navigation).
- Enhanced search and **Table view**: added **Match case (`Aa`)**, **Regex (`.*`)**, **Scope (`All` / `Keys` / `Values`)**, and **structured field comparisons** (`status>=400`, `env!=prod`, `level=error latency>100`); added **Flatten** nested objects into dot-separated columns, lossless 64-bit `BigInt` numeric sorting, click-to-jump during active search, and **TSV / Markdown** copy alongside CSV.
- Improved VS Code integration: added **Explorer context-menu** support (`.json`, `.jsonc`, `.jsonl`, `.ndjson`, `.log`), `jsonl` language-mode menu matching, `Alt+Cmd+J` / `Alt+Ctrl+J` shortcuts, and `WebviewPanelSerializer` restoration so open document and JSONL Tree Views revive with their expanded paths, pins, search options, and scroll position across window reloads.
- Improved large-tree, JSONL, and Webview performance: sped up JSONL record pre-filtering on lines with JSON escapes, added worker-thread `parseNestedJsonCandidatesAsync` with automatic idle worker cleanup, bounded large-tree Base64/Protobuf sniffing, and replaced Webview `Map` indexing and per-scroll DOM rebuilds with dense typed-array indexing, pooled virtual-row recycling, and virtualized **Table view** rendering.

## 0.10.0

- Improved large-document performance and responsiveness: added a single-pass iterative JSONC parser, reusable `worker_threads` parsing for documents at or above 250,000 characters (`out/parseWorker.js`), Webview virtual scrolling with single-container event delegation (raising the **Expand all** limit to 100,000 nodes), zero-AST Protobuf wire prechecks with packed repeated varint decoding, `O(n)` Base64 syntax/trailing-bit validation with slug filtering, `WeakMap` decodable detection caching, iterative subtree cloning, and minified production builds (`compile:prod` / `vscode:prepublish`).
- Enhanced interactive tree browsing: added a focused-node breadcrumb bar with click navigation and JSONPath / `jq` quick copy, a depth expansion selector, alphabetical object-key sorting (`A→Z`), collapsed container inline previews, row quick-action buttons, `Cmd`/`Ctrl`+`C` and `Shift`+`Cmd`/`Ctrl`+`C` copy shortcuts, **Open subtree in new Tree View**, **Open formatted JSON in new editor**, and unified nested decoding for **Open in new Tree View**.
- Expanded timestamp conversion to format both Unix timestamps (seconds, milliseconds, microseconds, nanoseconds; numeric or string) and strict ISO-8601 strings as local and relative time, with expired warnings on past `exp` / `expiresAt` fields.
- Added JSONL record filtering (free text, quoted phrases, `key=value`, `a.b=value`), matching-record listing, **Keep view** to preserve inline-decoded paths across records, and an interactive table view with filtering, sorting, row jump, and RFC 4180 CSV copy/export for both object-array nodes and JSONL records.

## 0.9.0

- Extended inline decoding to support **Base64 / Base64URL Protobuf wire format** (displaying field numbers and decoded field values including varints, 32/64-bit fixed/floats, nested messages, repeated fields, UTF-8 strings, and hex bytes), **Base64 / Base64URL JSON and readable text**, **JWT** (`header`, `payload`, `signature`), and **URL query strings** (`origin`, `pathname`, `params`, `hash`).
- Fixed dismissing a multi-candidate inline decode picker so it keeps the string expandable instead of permanently removing its expand affordance, and guarded against duplicate in-flight decode requests.
- Improved performance and memory usage: O(1) `JsonTreeIndex.size`, zero-copy document length checks on edits, `liveRefreshMaxCharacters` protection for edited JSONL lines, faster ASCII case-folding in search, and key-based structural paths so live refresh preserves expansion and inline-decoded state when sibling keys are inserted or removed.
- Extended timestamp value hints to recognize 16-digit microsecond, 19-digit nanosecond, and string-encoded Unix timestamps, set `<html lang>` from VS Code's display language, and added optional `--minify` support to the build script.

## 0.8.0

- Added **Open Selection as Tree** (editor context menu whenever text is selected) and **Open Clipboard as Tree**.
- Added inline decoding: strings that contain a JSON object or array expand in place, including double-encoded and repeatedly nested strings. Search covers decoded content, and jq paths cross it with `fromjson`.
- Linked document and selection trees to their source: **Reveal in source** selects a node's exact range, **Sync with editor** highlights the node under the cursor, and document trees refresh automatically after edits while keeping expansion, inline decoding, search, and scroll position. JSONL **Follow cursor** also highlights the node under the cursor.
- Added value hints for Unix timestamps (seconds and milliseconds), color swatches, string lengths, and `Cmd`/`Ctrl`+click links.
- Localized the UI, commands, and settings into Simplified Chinese.
- Selection trees follow edits outside the selection and re-parse after edits inside it; JSONL trees follow their record when lines above change.
- Auto-refresh now stops at 500,000 characters by default (`nestedJsonTree.liveRefreshMaxCharacters`) and waits longer for larger text.
- Strings that carry JSON inside other text can be decoded inline too, marked **decoded JSON (from text)**.
- Added a search option that decodes every embedded-JSON string before searching, within fixed budgets.
- The JSONL and source bars wrap in narrow panels, and the editor-cursor highlight survives the Tree View being hidden and shown again.
- Added `examples/demo.log`, real-browser Webview tests in CI, a screenshot generator, and a `npm run demo` scene for VS Code screenshots.

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

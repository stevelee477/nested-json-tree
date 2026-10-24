# Nested JSON Tree

<p align="center">
  <img src="assets/icon.png" width="112" alt="Nested JSON Tree icon">
</p>

<p align="center">
  Inspect JSON, JSONL, log-embedded JSON, and escaped nested JSON as an interactive tree in VS Code.
</p>

<p align="center">
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="https://github.com/stevelee477/nested-json-tree/actions/workflows/ci.yml"><img src="https://github.com/stevelee477/nested-json-tree/actions/workflows/ci.yml/badge.svg" alt="CI"></a> ·
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-59DDF2" alt="MIT License"></a>
</p>

Nested JSON Tree is a read-only viewer for the JSON that ordinary formatters struggle with: JSON hidden inside log lines, one record in a JSONL file, or an escaped JSON string nested several levels deep.

<a href="assets/screenshots/tree-search.png"><img src="assets/screenshots/tree-search.png" width="1000" alt="Search inside a JSON tree"></a>

## Highlights

- Open a JSON/JSONC document, a selection, or the clipboard as a collapsible tree.
- Expand escaped JSON strings **inline**, level after level, without leaving the tree.
- Keep the tree in sync with the editor: reveal any node in the source, highlight the node under the cursor, and refresh automatically as you edit.
- Accept JSONC line/block comments and trailing commas.
- Extract valid JSON even when unrelated text appears before or after it.
- Navigate valid JSONL/NDJSON records in one Tree View without loading the whole document into the parser.
- Right-click a string and recursively open escaped or double-encoded JSON.
- Decode, parse, format, and open nested JSON in a normal untitled editor.
- Open any decoded string as plain text, preserving real newlines and other decoded characters without requiring JSON.
- Preserve large integers and original tokens such as `"\u0061"` and `"\/"` in display, search, copy, and formatting.
- Search decoded and raw keys/values incrementally, filter unrelated branches, and navigate results.
- Copy lossless values, decoded strings, exact escaped string literals, JSONPath, and jq filters.
- Choose between multiple detected JSON candidates.
- Automatically expand small trees; keep large trees manageable.
- See readable hints for Unix timestamps, color values, string lengths, and links.
- English and Simplified Chinese UI, following VS Code's display language.

## Partial JSON recovery and expansion

Damaged input such as `{"id":7,"broken":undefined,"ok":true}` can retain the confirmed `id` and `ok` fields. Missing commas or closing delimiters are handled on a best-effort basis. Incomplete strings, malformed numbers such as `01` / `1e`, and invalid escapes are omitted rather than guessed; single-quoted or unquoted keys are not converted into JSON. Multiple JSON values on one line are listed separately, including mixtures of complete and recoverable values.

Recovered trees display **Recovered partial JSON**; the picker labels them **recovered subset**. The warning tooltip includes bounded diagnostics with character positions relative to the candidate source. Copy/open produces the recovered subset, **not the complete original JSON**. Damaged array elements are omitted, so recovered array indices may differ from the source. The original file is never modified.

**Expand all** shares bounded time/node slices across small containers instead of waiting one timer turn per object. **Collapse all** cancels expansion, and search can interrupt it. The 10,000-node bulk-expansion safety limit remains; larger trees can still be expanded manually in chunks.

## Nested JSON

Strings that contain a JSON object or array show an expand arrow. Click it (or press `→`) to decode the string **inline**: the parsed value appears as a **decoded JSON** child, double-encoded strings are unwrapped automatically, and the decoded value can contain further encoded strings. Search covers decoded content, and **Copy jq path** produces a runnable filter such as `.payload | fromjson | .user.id`. JSONPath cannot cross an encoded string, so it is copied relative to the decoded value.

Right-click any string node to open its JSON in a separate tree instead. The new tree supports the same actions, so nesting can be explored repeatedly.

<a href="assets/screenshots/nested-json-menu.png"><img src="assets/screenshots/nested-json-menu.png" width="1000" alt="Open escaped nested JSON"></a>

Choose **Open parsed JSON in new editor** to decode and format the value as a normal JSON document, or **Open decoded string value in new editor** to open the decoded text unchanged in a plain-text editor.

## JSONL / NDJSON

Place the cursor on a record and select **Nested JSON Tree: Open Current Line as Tree** from the editor context menu or Command Palette.

<a href="assets/screenshots/jsonl-current-line.png"><img src="assets/screenshots/jsonl-current-line.png" width="1000" alt="Navigate a JSONL file"></a>

The Tree View keeps the source URI and current line. Use **Prev**, **Next**, or a line number to jump between valid records in the same tab; empty, invalid, and resource-limited lines are skipped. **Source** reveals the current record in the editor. **Follow cursor** is optional and off by default.

Editor context-menu entries appear only for JSON/JSONC and JSONL/NDJSON files. Both commands remain available through `Cmd+Shift+P` / `Ctrl+Shift+P` for text and log files. With **Follow cursor** on, the node under the cursor is also highlighted within the current line.

## Selections, clipboard, and source sync

Select any text — for example the JSON part of a log line or a multi-line block — and choose **Open Selection as Tree** from the editor context menu. **Open Clipboard as Tree** parses whatever you copied from a terminal or browser.

Trees opened from a document or selection stay linked to it:

- **Reveal in source** (context menu) selects the node's exact range in the editor. Inside decoded string content, it reveals the enclosing string.
- **Sync with editor** (on by default) highlights the node under the editor cursor without taking keyboard focus.
- Document trees re-parse automatically about half a second after you stop typing, keeping expansion, inline-decoded strings, search, and scroll position. If the document temporarily has no valid JSON, the last valid tree stays visible. Documents above 2 million characters show **Refresh** instead of re-parsing on every edit.
- A selection's range cannot follow edits, so a selection tree is unlinked once its document changes.

## Installation

### From a GitHub Release

1. Download the latest `.vsix` from [Releases](https://github.com/stevelee477/nested-json-tree/releases).
2. In VS Code, open **Extensions**.
3. Select **… → Install from VSIX…** and choose the downloaded file.

Or install from the command line:

```sh
code --install-extension nested-json-tree-<version>.vsix
```

## Commands

| Command | Purpose |
| --- | --- |
| `Nested JSON Tree: Open Document as Tree` | Extract and open JSON from the active document. |
| `Nested JSON Tree: Open Current Line as Tree` | Extract and open JSON from the cursor's line. |
| `Nested JSON Tree: Open Selection as Tree` | Extract and open JSON from the selected text (also in the editor context menu whenever text is selected). |
| `Nested JSON Tree: Open Clipboard as Tree` | Extract and open JSON from the clipboard. |

## Tree controls

- **Expand all / Collapse all** controls every container at once; **Expand all** is limited to 10,000 nodes.
- `Cmd+F` / `Ctrl+F` focuses tree search.
- `Enter` and `Shift+Enter` move through search results.
- `Esc` clears search and restores the previous expansion state.
- While search results are shown, branches can still be expanded or collapsed, and **Collapse all** stays available.
- Right-click a node (or press `Shift+F10`) to copy its value, key, JSONPath, or jq path.
- Keyboard: `↑`/`↓` move between rows, `→`/`←` expand/collapse or move to the child/parent, `Home`/`End` jump to the first/last row, `Enter`/`Space` toggle a container or open the actions menu.
- Expansion, search text, and scroll position are restored when you return to a hidden Tree View tab.
- String-node actions can open parsed JSON or open the decoded value unchanged as plain text.
- Hover a value for hints: Unix timestamps in seconds or milliseconds show their UTC and local time (inline as well, when the key looks like a time such as `createdAt` or `ts`); strings show their length; colors such as `#3b82f6` or `rgb(…)` get a swatch; `Cmd`/`Ctrl`+click opens an `http(s)` link.

Example jq path:

```jq
.users[0]["display-name"]
```

## Settings

| Setting | Default | Description |
| --- | ---: | --- |
| `nestedJsonTree.autoExpandMaxNodes` | `200` | Fully expand trees at or below this node count. Set to `0` to disable automatic descendant expansion; roots above the 10,000-node materialization limit remain collapsed. |
| `nestedJsonTree.maxValueNodes` | `500000` | Maximum JSON value nodes parsed for one document or tree (10,000–5,000,000). Each million nodes uses roughly 250 MB of Extension Host memory. |

## Parsing boundaries

- Maximum input size: 100 MB.
- Safety limits: 1,024 nesting levels, 500,000 value nodes in total (configurable), 5,000 extracted candidates, and 50,000 potential container spans. Unmatched brackets in surrounding log text do not count as nesting.
- Common log prefixes and suffixes are supported. Extraction from ambiguous combinations of unmatched quotes/comments is best-effort.
- JSONC comments and trailing commas are accepted; opening parsed JSON in an editor produces strict JSON.
- Number and string tokens, key escapes, key order, and duplicate keys are preserved.
- Empty `{}` and `[]` extraction candidates are ignored.
- Complete parsing takes priority; damaged input may expose a clearly marked confirmed subset. Recovery is best-effort, may omit fields or candidates, and never repairs or overwrites the original source.
- Pretty output that would exceed 16 Mi characters falls back to compact JSON; clipboard/editor output above 50 Mi characters is rejected.
- Long key/value tokens and displayed UI paths are shortened to at most 10,000 characters. Search covers the shortened Tree View fields; copy and nested-open actions still use complete Host-side data.
- The tree is read-only; parsed JSON can be opened in a separate editor for editing.

## Development

```sh
npm install
npm test
npm run test:integration
npm run package
```

`npm run watch` rebuilds the extension and Webview bundles on change. Press `F5` in VS Code to launch an Extension Development Host. Synthetic screenshot data lives in [`examples/`](examples/).

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)

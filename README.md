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

![Search inside a JSON tree](assets/screenshots/tree-search.png)

## Highlights

- Open a JSON/JSONC document as a collapsible tree.
- Extract valid JSON even when unrelated text appears before or after it.
- Open the current JSONL/NDJSON line without parsing the whole file as one document.
- Right-click a string and recursively open escaped or double-encoded JSON.
- Decode, parse, format, and open nested JSON in a normal untitled editor.
- Search keys and primitive values, filter unrelated branches, and navigate results.
- Copy values, decoded strings, escaped JSON string literals, JSONPath, and jq filters.
- Choose between multiple detected JSON candidates.
- Automatically expand small trees; keep large trees manageable.

## Nested JSON

Right-click any string node to open JSON encoded inside it. The new tree supports the same actions, so nesting can be explored repeatedly.

![Open escaped nested JSON](assets/screenshots/nested-json-menu.png)

You can also choose **Open parsed JSON in new editor** to decode and format the value as a normal JSON document.

## JSONL / NDJSON

Place the cursor on a record and select **Nested JSON Tree: Open Current Line as Tree** from the editor context menu or Command Palette.

![Open the current JSONL line](assets/screenshots/jsonl-current-line.png)

Editor context-menu entries appear only for JSON/JSONC and JSONL/NDJSON files. Both commands remain available through `Cmd+Shift+P` / `Ctrl+Shift+P` for text and log files.

## Installation

### From a GitHub Release

1. Download the latest `.vsix` from [Releases](https://github.com/stevelee477/nested-json-tree/releases).
2. In VS Code, open **Extensions**.
3. Select **… → Install from VSIX…** and choose the downloaded file.

Or install from the command line:

```sh
code --install-extension nested-json-tree-0.3.1.vsix
```

## Commands

| Command | Purpose |
| --- | --- |
| `Nested JSON Tree: Open Document as Tree` | Extract and open JSON from the active document. |
| `Nested JSON Tree: Open Current Line as Tree` | Extract and open JSON from the cursor's line. |

## Tree controls

- **Expand all / Collapse all** controls every container at once.
- `Cmd+F` / `Ctrl+F` focuses tree search.
- `Enter` and `Shift+Enter` move through search results.
- `Esc` clears search and restores the previous expansion state.
- Right-click a node to copy its value, key, JSONPath, or jq path.

Example jq path:

```jq
.users[0]["display-name"]
```

## Settings

| Setting | Default | Description |
| --- | ---: | --- |
| `nestedJsonTree.autoExpandMaxNodes` | `200` | Fully expand trees at or below this node count. Set to `0` to expand only the root. |

## Parsing boundaries

- Maximum input size: 100 MB.
- Unrelated prefix and suffix text is supported.
- Empty `{}` and `[]` extraction candidates are ignored.
- Structurally broken JSON, such as missing quotes or braces, is not repaired.
- The tree is read-only; parsed JSON can be opened in a separate editor for editing.

## Development

```sh
npm install
npm test
npm run package
```

Press `F5` in VS Code to launch an Extension Development Host. Synthetic screenshot data lives in [`examples/`](examples/).

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)

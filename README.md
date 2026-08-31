# Nested JSON Tree

A VS Code viewer for JSON that is buried in logs, stored in JSONL, or encoded as an escaped string inside another JSON value.

## Features

- Opens the current document as an interactive JSON tree.
- Automatically expands JSON trees with at most 200 value nodes; larger trees open with only the root expanded.
- Provides **Expand all** and **Collapse all** buttons in every tree view.
- Ignores unrelated text before and after a valid JSON object or array.
- Detects multiple JSON candidates and asks which one to open.
- Opens the current JSONL/NDJSON line without parsing the rest as JSON.
- Right-clicks any string node and chooses **Open as nested JSON tree**.
- Copies either the decoded string value or its raw JSON literal form, preserving escapes such as `\\n`, `\\"`, and `\\\\`.
- Repeats nested-string decoding, so double-encoded JSON also works.
- Copies a node's value, key, or JSON path from the tree context menu.
- Rejects input files larger than 100 MB.

The viewer is read-only. This first version does not repair structurally broken JSON such as missing quotes or braces.

Set `nestedJsonTree.autoExpandMaxNodes` in VS Code Settings to change the automatic expansion threshold. Set it to `0` to keep descendants collapsed by default.

## Usage

1. Open a JSON, JSONL, NDJSON, log, or plain-text file.
2. Run one of these commands from the Command Palette or editor context menu:
   - `Nested JSON Tree: Open Document as Tree`
   - `Nested JSON Tree: Open Current Line as Tree`
3. Expand object and array nodes in the tree.
4. Right-click a string value to open JSON encoded inside it in a new tree tab.
5. Choose **Copy raw JSON string (escaped)** when you need the quoted JSON literal rather than decoded newlines or tabs.

## Development

```sh
npm install
npm test
npm run package
```

Press `F5` in VS Code to launch an Extension Development Host.

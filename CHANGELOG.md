# Changelog

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

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const sourcePath = path.resolve(__dirname, "../../src/treePanel.ts");
const source = readFileSync(sourcePath, "utf8");

test("embedded Tree View script has valid JavaScript syntax", () => {
  const match = source.match(/<script nonce="\$\{nonce\}">([\s\S]*?)<\/script>/);
  assert.ok(match, "embedded webview script must be present");
  assert.doesNotThrow(() => new Function(match[1]));
});

test("Tree View markup includes accessible search controls", () => {
  assert.match(source, /id="search-input"[^>]+aria-label="Search JSON keys and values"/);
  assert.match(source, /id="previous-match"/);
  assert.match(source, /id="next-match"/);
  assert.match(source, /id="clear-search"/);
});

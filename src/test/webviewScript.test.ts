import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  advanceJsonTreeSearch,
  createJsonTreeSearchState,
  jsonTreePrimitiveSearchText,
} from "../search";

import { createWebviewHarness } from "./webviewHarness";

const sourcePath = path.resolve(__dirname, "../../src/treePanel.ts");
const source = readFileSync(sourcePath, "utf8");

function embeddedWebviewScript(): string {
  const match = source.match(/<script nonce="\$\{nonce\}">([\s\S]*?)<\/script>/);
  assert.ok(match, "embedded webview script must be present");
  const runtime = [
    `const createJsonTreeSearchState = ${createJsonTreeSearchState.toString()};`,
    `const jsonTreePrimitiveSearchText = ${jsonTreePrimitiveSearchText.toString()};`,
    `const advanceJsonTreeSearch = ${advanceJsonTreeSearch.toString()};`,
  ].join("\n");
  return match[1].replace("${searchRuntime}", runtime);
}

test("embedded Tree View script has valid JavaScript syntax", () => {
  assert.doesNotThrow(() => new Function(embeddedWebviewScript()));
});

test("Tree View markup includes accessible search controls", () => {
  assert.match(source, /id="search-input"[^>]+aria-label="Search JSON keys and values"/);
  assert.match(source, /id="previous-match"/);
  assert.match(source, /id="next-match"/);
  assert.match(source, /id="clear-search"/);
  assert.match(source, /id="search-scope-warning"[^>]+>Long values shortened/);
});

test("search runs incrementally inside the Webview", () => {
  assert.match(source, /createJsonTreeSearchState\(currentRoot, query\)/);
  assert.match(source, /advanceJsonTreeSearch\(state, 2_000\)/);
  assert.match(source, /exactIds\.has\(node\.nodeId\)/);
  assert.doesNotMatch(source, /postMessage\(\{ type: 'search'/);
});

test("Tree View renders and acts on lossless node tokens", () => {
  assert.match(source, /span\.textContent = model\.raw/);
  assert.match(source, /type: 'copyRawString', nodeId: model\.id/);
  assert.match(source, /type: 'copyValue', nodeId: model\.id/);
  assert.doesNotMatch(source, /JSON\.stringify\(value, null, 2\)/);
});

test("Webview actions send only host-resolved node IDs", () => {
  for (const type of [
    "openNested",
    "openParsedJson",
    "openDecodedValue",
    "copyValue",
    "copyRawString",
    "copyDecodedString",
    "copyKey",
    "copyRawKey",
    "copyJsonPath",
    "copyJqPath",
  ]) {
    assert.match(source, new RegExp(`type: '${type}', nodeId: model\\.id`));
  }
  assert.match(source, /Copy raw key token/);
  assert.doesNotMatch(source, /vscode\.postMessage\(\{[^}]*\b(?:text|path)\s*:/);
  assert.doesNotMatch(source, /message\.(?:text|path)\b/);
  assert.match(source, /buildJsonTreeContextIndex\(candidate\.tree\)/);
  assert.match(source, /isValidJsonTreeNodeId\(message\.nodeId\)/);
  assert.match(source, /hasDuplicateKeyInPath/);
});

test("nested Tree Views open as new tabs in the source editor group", () => {
  assert.match(
    source,
    /viewColumn: vscode\.ViewColumn = vscode\.ViewColumn\.Beside/,
  );
  assert.match(
    source,
    /displayPath,\s*this\.panel\.viewColumn \?\? vscode\.ViewColumn\.Active,/,
  );
  assert.match(source, /viewColumn: vscode\.ViewColumn\.Beside,/);
});

test("JSONL Tree Views expose in-panel record navigation", () => {
  for (const id of [
    "jsonl-bar",
    "previous-jsonl",
    "next-jsonl",
    "jsonl-line",
    "jsonl-total",
    "go-jsonl",
    "reveal-source",
    "follow-cursor",
    "jsonl-status",
  ]) {
    assert.match(source, new RegExp(`id="${id}"`));
  }
  for (const type of [
    "previousJsonl",
    "nextJsonl",
    "goToJsonlLine",
    "revealSource",
    "setFollowCursor",
  ]) {
    assert.match(source, new RegExp(`type: '${type}'`));
  }
  assert.match(source, /findJsonlRecord/);
  assert.match(source, /onDidChangeTextEditorSelection/);
  assert.match(source, /setTimeout\(\(\) => void this\.followSourceLine\(lineNumber\), 150\)/);
});

test("Tree rows use compact container counts without visual type badges", () => {
  assert.match(source, /\? '\[' \+ count \+ '\]' : '\{' \+ count \+ '\}'/);
  assert.doesNotMatch(source, /badge\.textContent = model\.type/);
  assert.match(source, /row\.setAttribute\('aria-label', key \+ ': ' \+ model\.type\)/);
});

test("Webview model truncation is explicit and limits search scope", () => {
  assert.match(source, /createJsonTreeWebviewModel\(candidate\.tree\)/);
  assert.match(source, /const displayPath = formatJsonPathForDisplay\(materializeJsonTreePath\(context\)\)/);
  assert.doesNotMatch(source, /const jsonPath = formatJsonPath\(materializeJsonTreePath\(context\)\)/);
  assert.match(source, /truncatedFieldCount: this\.webviewModel\.truncatedFieldCount/);
  assert.match(source, /Search displayed text \(long values shortened\)/);
  assert.match(source, /copy and open actions still use the complete host value/i);
  assert.match(source, /'… ' \+ longest\.toLocaleString\(\) \+ ' chars'/);
});

test("bulk tree operations are iterative, chunked, and size-limited", () => {
  assert.match(source, /canExpandAll: isTreeNodeCountWithinLimit/);
  assert.match(source, /else if \(expandAllAllowed\) \{\s*runRootExpansion\(\)/);
  assert.match(source, /performance\.now\(\) - startedAt < 8/);
  assert.match(source, /createdInChunk < MATERIALIZE_CHILD_CHUNK_SIZE/);
  assert.match(source, /setTimeout\(processMaterializeChunk, 0\)/);
  assert.match(source, /isMatchBranch &&[\s\S]+node\.ensureExpanded/);
  assert.match(source, /shouldExpand &&[\s\S]+node\.ensureExpanded/);
  assert.match(source, /collapseAllButton\.disabled = searchActive/);
  assert.doesNotMatch(source, /setExpanded\(shouldExpand, true\)/);
});

test("oversized roots stay collapsed and manual expansion materializes cancellable chunks", () => {
  const { elements, windowListeners, timers } = createWebviewHarness(embeddedWebviewScript());
  const children = Array.from({ length: 20_000 }, (_, index) => ({
    key: index,
    value: { id: index + 1, type: "number", raw: "0" },
  }));
  const onMessage = windowListeners.get("message")?.[0];
  assert.ok(onMessage);
  onMessage({
    data: {
      type: "render",
      root: { id: 0, type: "array", children },
      title: "wide",
      pathLabel: "$",
      autoExpand: false,
      canExpandAll: false,
      expandAllLimit: 10_000,
    },
  });

  const root = elements.get("tree")?.children[0];
  assert.ok(root);
  assert.equal(root.attributes.get("aria-expanded"), "false");
  assert.equal(root.children.length, 1, "an oversized root must not materialize children initially");
  assert.equal(timers.length, 0);

  const row = root.children[0];
  row.dispatch("click");
  assert.equal(root.attributes.get("aria-expanded"), "true");
  assert.equal(root.children[1].children.length, 0, "manual expansion must yield before DOM work");
  assert.equal(timers.length, 1);

  const firstChunk = timers.shift();
  assert.ok(firstChunk);
  firstChunk();
  assert.equal(root.children[1].children.length, 200);
  assert.equal(timers.length, 1, "more children should be scheduled for a later turn");

  row.dispatch("click");
  const cancelledChunk = timers.shift();
  assert.ok(cancelledChunk);
  cancelledChunk();
  assert.equal(root.children[1].children.length, 200, "collapsing must cancel pending materialization");
});


function renderTree(harness: ReturnType<typeof createWebviewHarness>, root: unknown, options: Record<string, unknown> = {}): void {
  const onMessage = harness.windowListeners.get("message")?.[0];
  assert.ok(onMessage);
  onMessage({ data: {
    type: "render", root, title: "test", pathLabel: "$", autoExpand: false,
    canExpandAll: true, expandAllLimit: 10_000, ...options,
  } });
}

function arrayOfSmallObjects(count: number) {
  let id = 0;
  const root = { id: id++, type: "array", children: [] as unknown[] };
  for (let index = 0; index < count; index += 1) {
    root.children.push({ key: index, value: {
      id: id++, type: "object", children: [
        { key: "value", value: { id: id++, type: "number", raw: String(index) } },
      ],
    } });
  }
  return root;
}

test("bulk expansion shares timer turns across many small objects and still yields", () => {
  const harness = createWebviewHarness(embeddedWebviewScript());
  renderTree(harness, arrayOfSmallObjects(2_000), { autoExpand: true });
  assert.ok(harness.timers.length > 0, "wide arrays should yield DOM work");
  const turns = harness.drainTimers();
  assert.ok(turns < 60, `expected shared slices, not one timer per object; got ${turns}`);
  const root = harness.elements.get("tree")!.children[0];
  assert.equal(root.children[1].children.length, 2_000);
  for (const object of root.children[1].children) {
    assert.equal(object.attributes.get("aria-expanded"), "true");
    assert.equal(object.children[1].children.length, 1);
  }
  assert.equal(harness.elements.get("expand-all")!.disabled, false);
  assert.equal(harness.elements.get("tree-operation-status")!.textContent, "");
});

test("collapse cancels bulk expansion and a later expand does not duplicate nodes", () => {
  const harness = createWebviewHarness(embeddedWebviewScript());
  renderTree(harness, arrayOfSmallObjects(1_000), { autoExpand: true });
  harness.timers.shift()!();
  harness.elements.get("collapse-all")!.dispatch("click");
  harness.drainTimers();
  const root = harness.elements.get("tree")!.children[0];
  assert.equal(root.attributes.get("aria-expanded"), "false");
  assert.ok(root.children[1].children.length < 1_000);
  harness.elements.get("expand-all")!.dispatch("click");
  harness.drainTimers();
  assert.equal(root.children[1].children.length, 1_000);
  const nodeIds = root.children[1].children.map((node) => node.attributes.get("aria-expanded"));
  assert.ok(nodeIds.every((state) => state === "true"));
});

test("search can interrupt expansion without leaving controls busy", () => {
  const harness = createWebviewHarness(embeddedWebviewScript());
  renderTree(harness, arrayOfSmallObjects(1_000), { autoExpand: true });
  assert.equal(harness.elements.get("search-input")!.disabled, false);
  harness.elements.get("search-input")!.value = "999";
  harness.elements.get("search-input")!.dispatch("input");
  harness.drainTimers();
  assert.match(harness.elements.get("search-count")!.textContent, /1/);
  harness.elements.get("clear-search")!.dispatch("click");
  harness.drainTimers();
  assert.equal(harness.elements.get("expand-all")!.disabled, false);
});

test("replacing a searched JSONL record reruns the query instead of hiding the tree", () => {
  const harness = createWebviewHarness(embeddedWebviewScript());
  renderTree(harness, { id: 0, type: "string", raw: '"first foo"', value: "first foo" });
  harness.drainTimers();
  harness.elements.get("search-input")!.value = "foo";
  harness.elements.get("search-input")!.dispatch("input");
  harness.drainTimers();
  renderTree(harness, { id: 0, type: "string", raw: '"second foo"', value: "second foo" });
  harness.drainTimers();
  const root = harness.elements.get("tree")!.children[0];
  assert.equal(root.classList.contains("search-hidden"), false);
  assert.equal(harness.elements.get("search-input")!.value, "foo");
  assert.match(harness.elements.get("search-count")!.textContent, /1/);
  renderTree(harness, { id: 0, type: "string", raw: '"no match"', value: "no match" });
  harness.drainTimers();
  assert.equal(harness.elements.get("tree")!.children[0].classList.contains("search-hidden"), true);
  assert.match(harness.elements.get("search-count")!.textContent, /0/);
});

test("partial recovery warning resets when navigating back to a complete value", () => {
  const harness = createWebviewHarness(embeddedWebviewScript());
  const root = { id: 0, type: "number", raw: "1" };
  renderTree(harness, root, { recovery: {
    errorCount: 1, issues: [{ code: "CloseBraceExpected", offset: 8, length: 0 }],
  } });
  harness.drainTimers();
  const warning = harness.elements.get("recovery-warning")!;
  assert.equal(warning.classList.contains("hidden"), false);
  assert.match(warning.textContent, /recovered subset/);
  assert.match(warning.title, /character 9/);
  renderTree(harness, root);
  harness.drainTimers();
  assert.equal(warning.classList.contains("hidden"), true);
  assert.equal(warning.textContent, "");
});

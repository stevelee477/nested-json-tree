import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { createWebviewHarness } from "./webviewHarness";

const root = path.resolve(__dirname, "../..");
const hostSource = readFileSync(path.join(root, "src/treePanel.ts"), "utf8");
const webviewSource = readFileSync(path.join(root, "src/webview/main.ts"), "utf8");

/** The bundled script that the panel actually loads. */
function embeddedWebviewScript(): string {
  return readFileSync(path.join(root, "out/webview/main.js"), "utf8");
}

test("Webview bundle is self-contained and valid JavaScript", () => {
  const bundle = embeddedWebviewScript();
  assert.doesNotThrow(() => new Function(bundle));
  assert.doesNotMatch(bundle, /\brequire\(/);
  assert.doesNotMatch(bundle, /jsonc-parser|parseTree/);
});

test("panel loads bundled assets under a nonce-only script CSP", () => {
  assert.match(hostSource, /script-src 'nonce-\$\{nonce\}'/);
  assert.doesNotMatch(hostSource, /'unsafe-inline'|'unsafe-eval'/);
  assert.match(hostSource, /<script nonce="\$\{nonce\}" src="\$\{scriptUri\}"><\/script>/);
  assert.match(hostSource, /localResourceRoots: \[webviewRoot\(services\.extensionUri\)\]/);
  assert.match(hostSource, /randomBytes\(16\)/);
  assert.doesNotMatch(hostSource, /Math\.random/);
  assert.doesNotMatch(hostSource, /retainContextWhenHidden: true/);
});

test("Tree View markup includes accessible search and tree controls", () => {
  assert.match(hostSource, /id="search-input"[^>]+aria-label="Search JSON keys and values"/);
  assert.match(hostSource, /id="previous-match"/);
  assert.match(hostSource, /id="next-match"/);
  assert.match(hostSource, /id="clear-search"/);
  assert.match(hostSource, /id="search-scope-warning"[^>]+>Long values shortened/);
  assert.match(hostSource, /id="tree" role="tree" aria-label="JSON tree"/);
});

test("search runs incrementally inside the Webview", () => {
  assert.match(webviewSource, /createJsonTreeSearchState\(currentRoot, query\)/);
  assert.match(webviewSource, /advanceJsonTreeSearch\(state, 2_000\)/);
  assert.match(webviewSource, /exactIds\.has\(node\.nodeId\)/);
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
    assert.match(webviewSource, new RegExp(`type: "${type}", nodeId: model\\.id`));
  }
  assert.match(webviewSource, /Copy raw key token/);
  assert.doesNotMatch(webviewSource, /vscode\.postMessage\(\{[^}]*\b(?:text|path)\s*:/);
  assert.doesNotMatch(hostSource, /message\.(?:text|path)\b/);
  assert.match(hostSource, /buildJsonTreeContextIndex\(init\.candidate\.tree\)/);
  assert.match(hostSource, /isValidJsonTreeNodeId\(message\.nodeId\)/);
  assert.match(hostSource, /hasDuplicateKeyInPath/);
});

test("nested Tree Views open as new tabs in the source editor group", () => {
  assert.match(hostSource, /init\.viewColumn \?\? vscode\.ViewColumn\.Beside/);
  assert.match(hostSource, /viewColumn: this\.panel\.viewColumn \?\? vscode\.ViewColumn\.Active,/);
  assert.match(hostSource, /viewColumn: vscode\.ViewColumn\.Beside \}/);
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
    assert.match(hostSource, new RegExp(`id="${id}"`));
  }
  for (const type of ["previousJsonl", "nextJsonl", "goToJsonlLine", "revealSource", "setFollowCursor"]) {
    assert.match(webviewSource, new RegExp(`type: "${type}"`));
  }
  assert.match(hostSource, /findJsonlRecord/);
  assert.match(hostSource, /onDidChangeTextEditorSelection/);
  assert.match(hostSource, /this\.followSourceLine\(lineNumber\)\.catch/);
});

test("JSONL navigation always clears its busy state", () => {
  assert.match(hostSource, /finally \{\s*if \(finalStatus !== undefined && isCurrent\(\)\) await this\.postJsonlState\(finalStatus\)/);
});

test("following the cursor never opens a candidate picker", () => {
  const follow = hostSource.slice(hostSource.indexOf("private async followSourceLine"), hostSource.indexOf("private async revealSourceLine"));
  assert.doesNotMatch(follow, /pickCandidate/);
  assert.match(follow, /candidates\[0\]/);
});

test("Tree rows use compact container counts without visual type badges", () => {
  assert.match(webviewSource, /\? "\[" \+ count \+ "\]" : "\{" \+ count \+ "\}"/);
  assert.doesNotMatch(webviewSource, /badge\.textContent = model\.type/);
  assert.match(webviewSource, /node\.setAttribute\("aria-label", key \+ ": " \+ describeValue\(model\)\)/);
});

test("Webview model truncation is explicit and limits search scope", () => {
  assert.match(hostSource, /createJsonTreeWebviewModel\(tree\)/);
  assert.match(hostSource, /const displayPath = formatJsonPathForDisplay\(materializeJsonTreePath\(context\)\)/);
  assert.match(hostSource, /truncatedFieldCount: model\.truncatedFieldCount/);
  assert.match(webviewSource, /Search displayed text \(long values shortened\)/);
  assert.match(hostSource, /copy and open actions still use the complete host value/i);
  assert.match(webviewSource, /"… " \+ longest\.toLocaleString\(\) \+ " chars"/);
});

test("bulk tree operations are iterative, chunked, and size-limited", () => {
  assert.match(hostSource, /canExpandAll: isTreeNodeCountWithinLimit/);
  assert.match(webviewSource, /else if \(expandAllAllowed\) \{\s*runRootExpansion\(\)/);
  assert.match(webviewSource, /performance\.now\(\) - startedAt < 8/);
  assert.match(webviewSource, /createdInChunk < MATERIALIZE_CHILD_CHUNK_SIZE/);
  assert.match(webviewSource, /setTimeout\(processMaterializeChunk, 0\)/);
  assert.match(webviewSource, /isMatchBranch &&[\s\S]+node\.ensureExpanded/);
  assert.doesNotMatch(webviewSource, /setExpanded\(shouldExpand, true\)/);
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
    type: "render", renderKey: 0, root, title: "test", pathLabel: "$", autoExpand: false,
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


function searchFor(harness: ReturnType<typeof createWebviewHarness>, query: string): void {
  harness.elements.get("search-input")!.value = query;
  harness.elements.get("search-input")!.dispatch("input");
  harness.drainTimers();
}

test("nodes can be expanded and collapsed manually while search results are shown", () => {
  const harness = createWebviewHarness(embeddedWebviewScript());
  renderTree(harness, arrayOfSmallObjects(3));
  harness.drainTimers();
  searchFor(harness, "value");
  const root = harness.elements.get("tree")!.children[0];
  const first = root.children[1].children[0];
  assert.equal(first.attributes.get("aria-expanded"), "true");
  first.children[0].dispatch("click");
  assert.equal(first.attributes.get("aria-expanded"), "false", "a matched branch can be collapsed during search");
  first.children[0].dispatch("click");
  harness.drainTimers();
  assert.equal(first.attributes.get("aria-expanded"), "true");
  assert.equal(harness.elements.get("collapse-all")!.disabled, false, "Collapse all stays available during search");
  harness.elements.get("collapse-all")!.dispatch("click");
  harness.drainTimers();
  assert.equal(root.attributes.get("aria-expanded"), "false");
});

test("expanding a non-matching branch during search reveals its children", () => {
  const harness = createWebviewHarness(embeddedWebviewScript());
  const tree = {
    id: 0, type: "object", children: [
      { key: "hit", rawKey: '"hit"', value: { id: 1, type: "number", raw: "1" } },
      { key: "other", rawKey: '"other"', value: { id: 2, type: "object", children: [
        { key: "inner", rawKey: '"inner"', value: { id: 3, type: "number", raw: "2" } },
      ] } },
    ],
  };
  renderTree(harness, tree);
  harness.drainTimers();
  searchFor(harness, "hit");
  const root = harness.elements.get("tree")!.children[0];
  const other = root.children[1].children[1];
  assert.equal(other.classList.contains("search-hidden"), true);
  other.children[0].dispatch("click");
  harness.drainTimers();
  assert.equal(other.attributes.get("aria-expanded"), "true");
  assert.equal(other.children[1].children[0].classList.contains("search-hidden"), false);
});

test("tree rows support WAI-ARIA keyboard navigation with a roving tabindex", () => {
  const harness = createWebviewHarness(embeddedWebviewScript());
  renderTree(harness, arrayOfSmallObjects(2));
  harness.drainTimers();
  const tree = harness.elements.get("tree")!;
  const root = tree.children[0] as unknown as { tabIndex: number; attributes: Map<string, string>; children: Array<{ tabIndex: number; attributes: Map<string, string> }> };
  const key = (name: string) => tree.dispatch("keydown", { key: name, preventDefault() {} });
  assert.equal(root.tabIndex, 0);
  assert.equal(root.attributes.get("aria-level"), "1");
  key("ArrowDown");
  const first = (root.children[1] as unknown as { children: Array<{ tabIndex: number; attributes: Map<string, string> }> }).children[0];
  assert.equal(first.tabIndex, 0);
  assert.equal(root.tabIndex, -1);
  assert.equal(first.attributes.get("aria-level"), "2");
  key("ArrowRight");
  harness.drainTimers();
  assert.equal(first.attributes.get("aria-expanded"), "true");
  key("ArrowLeft");
  assert.equal(first.attributes.get("aria-expanded"), "false");
  key("ArrowLeft");
  assert.equal(root.tabIndex, 0, "ArrowLeft on a collapsed node moves to its parent");
  key("End");
  const second = (root.children[1] as unknown as { children: Array<{ tabIndex: number }> }).children[1];
  assert.equal(second.tabIndex, 0);
  key("Home");
  assert.equal(root.tabIndex, 0);
});

test("expansion, search, and scroll state survive the Webview being discarded", () => {
  let saved: unknown;
  const api = { getState: () => saved, setState: (state: unknown) => { saved = state; } };
  const first = createWebviewHarness(embeddedWebviewScript(), api);
  renderTree(first, arrayOfSmallObjects(3), { renderKey: 4 });
  first.drainTimers();
  const firstRoot = first.elements.get("tree")!.children[0];
  firstRoot.children[1].children[1].children[0].dispatch("click");
  first.drainTimers();
  (first.elements.get("tree") as unknown as { scrollTop: number }).scrollTop = 42;
  first.elements.get("tree")!.dispatch("scroll");
  first.drainTimers();
  assert.deepEqual((saved as { expanded: number[] }).expanded.sort(), [0, 3]);

  const restored = createWebviewHarness(embeddedWebviewScript(), api);
  renderTree(restored, arrayOfSmallObjects(3), { renderKey: 4 });
  restored.drainTimers();
  const root = restored.elements.get("tree")!.children[0];
  assert.equal(root.attributes.get("aria-expanded"), "true");
  assert.equal(root.children[1].children[1].attributes.get("aria-expanded"), "true");
  assert.equal(root.children[1].children[0].attributes.get("aria-expanded"), "false");
  assert.equal((restored.elements.get("tree") as unknown as { scrollTop: number }).scrollTop, 42);

  const otherRecord = createWebviewHarness(embeddedWebviewScript(), api);
  renderTree(otherRecord, arrayOfSmallObjects(3), { renderKey: 5 });
  otherRecord.drainTimers();
  const otherRoot = otherRecord.elements.get("tree")!.children[0];
  assert.equal(otherRoot.children[1].children[1].attributes.get("aria-expanded"), "false", "state for another value is ignored");
});

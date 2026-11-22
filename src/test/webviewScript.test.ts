import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { renderWebviewHtml } from "../webviewHtml";
import { createWebviewHarness } from "./webviewHarness";

const root = path.resolve(__dirname, "../..");
const hostSource = readFileSync(path.join(root, "src/treePanel.ts"), "utf8");
const webviewSource = readFileSync(path.join(root, "src/webview/main.ts"), "utf8");
const markup = renderWebviewHtml({
  nonce: "NONCE",
  cspSource: "vscode-resource:",
  scriptUri: "vscode-resource:/main.js",
  styleUri: "vscode-resource:/tree.css",
  l10nBundle: { "</script><script>alert(1)</script>": "x" },
});

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
  assert.match(markup, /content="default-src 'none'; style-src vscode-resource:; script-src 'nonce-NONCE'"/);
  assert.doesNotMatch(markup, /'unsafe-inline'|'unsafe-eval'/);
  assert.match(markup, /<script nonce="NONCE" src="vscode-resource:\/main\.js"><\/script>/);
  // Every executable script carries the nonce; the l10n bundle is inert JSON
  // and cannot terminate its own element.
  assert.equal(markup.match(/<script(?! nonce="NONCE")(?! type="application\/json")/g), null);
  assert.equal(markup.match(/<\/script>/g)?.length, 2);
  assert.match(hostSource, /localResourceRoots: \[webviewRoot\(services\.extensionUri\)\]/);
  assert.match(hostSource, /randomBytes\(16\)/);
  assert.doesNotMatch(hostSource, /Math\.random/);
  assert.doesNotMatch(hostSource, /retainContextWhenHidden: true/);
});

test("Tree View markup includes accessible search and tree controls", () => {
  assert.match(markup, /id="search-input"[^>]+aria-label="Search JSON keys and values"/);
  assert.match(markup, /id="previous-match"/);
  assert.match(markup, /id="next-match"/);
  assert.match(markup, /id="clear-search"/);
  assert.match(markup, /id="search-scope-warning"[^>]+>Long values shortened/);
  assert.match(markup, /id="tree" role="tree" aria-label="JSON tree"/);
  for (const id of [
    "source-bar",
    "sync-cursor",
    "refresh-source",
    "source-status",
    "expand-depth",
    "sort-keys",
    "breadcrumb-bar",
    "breadcrumb-segments",
    "table-view",
  ]) {
    assert.match(markup, new RegExp(`id="${id}"`));
  }
});

test("search runs incrementally inside the Webview", () => {
  assert.match(webviewSource, /createJsonTreeSearchState\(currentRoot as never, query\)/);
  assert.match(webviewSource, /advanceJsonTreeSearch\(state, 2_000\)/);
  assert.match(webviewSource, /searchExactIds\.has\(/);
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

test("JSONL Tree Views expose in-panel record navigation, filter, and table view", () => {
  for (const id of [
    "jsonl-bar",
    "previous-jsonl",
    "next-jsonl",
    "jsonl-line",
    "jsonl-total",
    "go-jsonl",
    "reveal-source",
    "follow-cursor",
    "keep-view",
    "jsonl-filter",
    "jsonl-filter-list",
    "jsonl-table",
    "jsonl-status",
  ]) {
    assert.match(markup, new RegExp(`id="${id}"`));
  }
  for (const type of [
    "previousJsonl",
    "nextJsonl",
    "goToJsonlLine",
    "revealSource",
    "setFollowCursor",
    "setKeepView",
    "setJsonlFilter",
    "listJsonlMatches",
    "openJsonlTable",
  ]) {
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
  assert.match(webviewSource, /\? "\[" \+ children\.length \+ "\]" : "\{" \+ children\.length \+ "\}"/);
  assert.doesNotMatch(webviewSource, /badge\.textContent = model\.type/);
  assert.match(webviewSource, /node\.setAttribute\("aria-label", label \+ ": " \+ describeValue\(model\)\)/);
});

test("Webview model truncation is explicit and limits search scope", () => {
  assert.match(hostSource, /createJsonTreeWebviewModel\(tree\)/);
  assert.match(hostSource, /const displayPath = formatJsonPathForDisplay\(materializeJsonTreePath\(context\)\)/);
  assert.match(hostSource, /truncatedFieldCount: model\.truncatedFieldCount/);
  assert.match(webviewSource, /Search displayed text \(long values shortened\)/);
  assert.match(markup, /copy and open actions still use the complete host value/i);
  assert.match(webviewSource, /t\("… \{0\} chars", longest\.toLocaleString\(\)\)/);
});

type Harness = ReturnType<typeof createWebviewHarness>;
type FakeNode = Harness["elements"] extends Map<string, infer E> ? E : never;

function renderedNodes(harness: Harness): FakeNode[] {
  return harness.elements.get("tree")!.children[1].children;
}

function spacers(harness: Harness) {
  const treeEl = harness.elements.get("tree")!;
  return { top: treeEl.children[0], bottom: treeEl.children[2] };
}

function rowParts(node: FakeNode) {
  const row = node.children[0];
  const findByClass = (name: string) => row.children.find((child) => child.className.split(" ").includes(name) || child.classList.contains(name));
  return {
    row,
    toggle: findByClass("toggle")!,
    key: findByClass("key")!,
    value: findByClass("value") ?? findByClass("summary")!,
    swatch: findByClass("color-swatch"),
    hint: findByClass("value-hint"),
    preview: findByClass("inline-preview"),
    actions: findByClass("row-actions")!,
  };
}

function nodeByKey(harness: Harness, key: string): FakeNode {
  const match = renderedNodes(harness).find((node) => rowParts(node).key.textContent === key);
  assert.ok(match, `missing rendered node with key ${key}`);
  return match;
}

function nodeById(harness: Harness, id: number): FakeNode {
  const match = renderedNodes(harness).find((node) => node.getAttribute("data-node-id") === String(id));
  assert.ok(match, `missing rendered node with id ${id}`);
  return match;
}

function expectedLocalTimestampPrefix(ms: number): string {
  const date = new Date(ms);
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const tz = offset === 0
    ? "UTC"
    : `UTC${offset > 0 ? "+" : "-"}${Math.floor(Math.abs(offset) / 60)}${Math.abs(offset) % 60 === 0 ? "" : ":" + pad2(Math.abs(offset) % 60)}`;
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())} ${tz}`;
}

test("virtual scrolling mounts only a bounded viewport slice for wide trees and updates spacers on scroll", () => {
  const harness = createWebviewHarness(embeddedWebviewScript());
  const children = Array.from({ length: 20_000 }, (_, index) => ({
    key: index,
    value: { id: index + 1, type: "number", raw: String(index) },
  }));
  renderTree(harness, { id: 0, type: "array", children }, { canExpandAll: false, expandAllLimit: 100_000 });
  harness.drainTimers();

  assert.equal(renderedNodes(harness).length, 1);
  const root = nodeById(harness, 0);
  assert.equal(root.getAttribute("aria-expanded"), "false");

  rowParts(root).row.dispatch("click");
  harness.drainTimers();

  const initialWindow = renderedNodes(harness);
  assert.ok(initialWindow.length > 20 && initialWindow.length < 100, `expected bounded virtual window, got ${initialWindow.length}`);
  assert.equal(nodeById(harness, 0).getAttribute("aria-expanded"), "true");
  assert.equal(spacers(harness).top.style.height, "0px");
  assert.ok(parseInt(spacers(harness).bottom.style.height, 10) > 400_000);

  const treeEl = harness.elements.get("tree")!;
  treeEl.scrollTop = 22_000;
  treeEl.dispatch("scroll");
  harness.drainTimers();

  const scrolledWindow = renderedNodes(harness);
  assert.ok(scrolledWindow.length > 20 && scrolledWindow.length < 100);
  assert.ok(parseInt(spacers(harness).top.style.height, 10) > 15_000);
  const visibleLabels = scrolledWindow.map((node) => rowParts(node).key.textContent);
  assert.ok(visibleLabels.includes("1000"));
});

function renderTree(harness: ReturnType<typeof createWebviewHarness>, root: unknown, options: Record<string, unknown> = {}): void {
  const onMessage = harness.windowListeners.get("message")?.[0];
  assert.ok(onMessage);
  onMessage({ data: {
    type: "render", renderKey: 0, root, title: "test", pathLabel: "$", autoExpand: false,
    canExpandAll: true, expandAllLimit: 100_000, ...options,
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

test("bulk expansion runs in chunked slices and renders virtualized rows cleanly", () => {
  const harness = createWebviewHarness(embeddedWebviewScript());
  renderTree(harness, arrayOfSmallObjects(2_000), { autoExpand: true });
  assert.ok(harness.timers.length > 0, "wide arrays should yield work");
  const turns = harness.drainTimers();
  assert.ok(turns < 60, `expected shared slices, not one timer per object; got ${turns}`);
  assert.equal(harness.elements.get("expand-all")!.disabled, false);
  assert.equal(harness.elements.get("tree-operation-status")!.textContent, "");
  assert.equal(nodeById(harness, 0).getAttribute("aria-expanded"), "true");
  assert.equal(nodeById(harness, 1).getAttribute("aria-expanded"), "true");
  assert.ok(renderedNodes(harness).length < 100);
});

test("collapse cancels bulk expansion and a later expand restores full expansion", () => {
  const harness = createWebviewHarness(embeddedWebviewScript());
  renderTree(harness, arrayOfSmallObjects(1_000), { autoExpand: true });
  harness.timers.shift()!();
  harness.elements.get("collapse-all")!.dispatch("click");
  harness.drainTimers();
  assert.equal(nodeById(harness, 0).getAttribute("aria-expanded"), "false");
  assert.equal(renderedNodes(harness).length, 1);

  harness.elements.get("expand-all")!.dispatch("click");
  harness.drainTimers();
  assert.equal(nodeById(harness, 0).getAttribute("aria-expanded"), "true");
  assert.equal(nodeById(harness, 1).getAttribute("aria-expanded"), "true");
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
  assert.equal(renderedNodes(harness).length, 1);
  assert.equal(harness.elements.get("search-input")!.value, "foo");
  assert.match(harness.elements.get("search-count")!.textContent, /1/);
  renderTree(harness, { id: 0, type: "string", raw: '"no match"', value: "no match" });
  harness.drainTimers();
  assert.equal(renderedNodes(harness).length, 0);
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
  assert.equal(nodeById(harness, 1).getAttribute("aria-expanded"), "true");
  rowParts(nodeById(harness, 1)).row.dispatch("click");
  assert.equal(nodeById(harness, 1).getAttribute("aria-expanded"), "false", "a matched branch can be collapsed during search");
  rowParts(nodeById(harness, 1)).row.dispatch("click");
  harness.drainTimers();
  assert.equal(nodeById(harness, 1).getAttribute("aria-expanded"), "true");
  assert.equal(harness.elements.get("collapse-all")!.disabled, false, "Collapse all stays available during search");
  harness.elements.get("collapse-all")!.dispatch("click");
  harness.drainTimers();
  assert.equal(nodeById(harness, 0).getAttribute("aria-expanded"), "false");
});

test("expanding a matched collapsed branch during search reveals its non-matching children", () => {
  const harness = createWebviewHarness(embeddedWebviewScript());
  const tree = {
    id: 0, type: "object", children: [
      { key: "hit", rawKey: '"hit"', value: { id: 1, type: "object", children: [
        { key: "inner", rawKey: '"inner"', value: { id: 2, type: "number", raw: "99" } },
      ] } },
      { key: "other", rawKey: '"other"', value: { id: 3, type: "number", raw: "1" } },
    ],
  };
  renderTree(harness, tree);
  harness.drainTimers();
  searchFor(harness, "hit");
  assert.equal(renderedNodes(harness).map((n) => rowParts(n).key.textContent).join(","), "$,hit");
  rowParts(nodeByKey(harness, "hit")).row.dispatch("click");
  harness.drainTimers();
  assert.equal(nodeByKey(harness, "hit").getAttribute("aria-expanded"), "true");
  assert.equal(nodeByKey(harness, "inner").getAttribute("data-node-id"), "2");
});

test("tree rows support WAI-ARIA keyboard navigation with a roving tabindex", () => {
  const harness = createWebviewHarness(embeddedWebviewScript());
  renderTree(harness, arrayOfSmallObjects(2));
  harness.drainTimers();
  const tree = harness.elements.get("tree")!;
  const key = (name: string) => tree.dispatch("keydown", { key: name, preventDefault() {} });
  assert.equal(nodeById(harness, 0).tabIndex, 0);
  assert.equal(nodeById(harness, 0).getAttribute("aria-level"), "1");
  key("ArrowDown");
  assert.equal(nodeById(harness, 1).tabIndex, 0);
  assert.equal(nodeById(harness, 0).tabIndex, -1);
  assert.equal(nodeById(harness, 1).getAttribute("aria-level"), "2");
  key("ArrowRight");
  harness.drainTimers();
  assert.equal(nodeById(harness, 1).getAttribute("aria-expanded"), "true");
  key("ArrowLeft");
  assert.equal(nodeById(harness, 1).getAttribute("aria-expanded"), "false");
  key("ArrowLeft");
  assert.equal(nodeById(harness, 0).tabIndex, 0, "ArrowLeft on a collapsed node moves to its parent");
  key("End");
  assert.equal(nodeById(harness, 3).tabIndex, 0);
  key("Home");
  assert.equal(nodeById(harness, 0).tabIndex, 0);
});

test("expansion, search, sortKeys, and scroll state survive the Webview being discarded", () => {
  let saved: unknown;
  const api = { getState: () => saved, setState: (state: unknown) => { saved = state; } };
  const first = createWebviewHarness(embeddedWebviewScript(), api);
  renderTree(first, arrayOfSmallObjects(40), { renderKey: 4 });
  first.drainTimers();
  rowParts(nodeById(first, 3)).row.dispatch("click");
  first.elements.get("sort-keys")!.dispatch("click");
  first.drainTimers();
  first.elements.get("tree")!.scrollTop = 42;
  first.elements.get("tree")!.dispatch("scroll");
  first.drainTimers();
  assert.deepEqual((saved as { expanded: number[] }).expanded.sort(), [0, 3]);
  assert.equal((saved as { sortKeys: boolean }).sortKeys, true);

  const restored = createWebviewHarness(embeddedWebviewScript(), api);
  renderTree(restored, arrayOfSmallObjects(40), { renderKey: 4 });
  restored.drainTimers();
  assert.equal(nodeById(restored, 0).getAttribute("aria-expanded"), "true");
  assert.equal(nodeById(restored, 3).getAttribute("aria-expanded"), "true");
  assert.equal(nodeById(restored, 1).getAttribute("aria-expanded"), "false");
  assert.equal(restored.elements.get("sort-keys")!.getAttribute("aria-pressed"), "true");
  assert.equal(restored.elements.get("tree")!.scrollTop, 42);

  const otherRecord = createWebviewHarness(embeddedWebviewScript(), api);
  renderTree(otherRecord, arrayOfSmallObjects(40), { renderKey: 5 });
  otherRecord.drainTimers();
  assert.equal(nodeById(otherRecord, 3).getAttribute("aria-expanded"), "false", "state for another value is ignored");
});

const objectWithPayload = () => ({
  id: 0, type: "object", children: [
    { key: "payload", rawKey: '"payload"', value: {
      id: 1, type: "string", raw: '"{\\"user\\":7}"', value: '{"user":7}', decodable: true,
    } },
  ],
});

test("decodable strings request inline decoding and render the decoded JSON as a child", () => {
  const harness = createWebviewHarness(embeddedWebviewScript());
  renderTree(harness, objectWithPayload());
  harness.drainTimers();
  const payload = nodeByKey(harness, "payload");
  assert.equal(rowParts(payload).toggle.className, "toggle decodable");
  rowParts(payload).row.dispatch("click");
  assert.deepEqual(harness.posted.at(-1), { type: "expandDecoded", nodeId: 1 });

  harness.send({ type: "decoded", nodeId: 1, decoded: {
    unwrapDepth: 0,
    root: { id: 2, type: "object", children: [{ key: "user", rawKey: '"user"', value: { id: 3, type: "number", raw: "7" } }] },
  } });
  harness.drainTimers();
  assert.equal(nodeById(harness, 1).getAttribute("aria-expanded"), "true");
  const decodedRoot = nodeById(harness, 2);
  assert.equal(rowParts(decodedRoot).key.textContent, "decoded JSON");
  assert.equal(rowParts(decodedRoot).key.className, "key decoded-key");

  searchFor(harness, "user");
  assert.match(harness.elements.get("search-count")!.textContent, /1/);
});

test("a string that fails to decode loses its expand affordance, while cancellation preserves it", () => {
  const harness = createWebviewHarness(embeddedWebviewScript());
  renderTree(harness, objectWithPayload());
  harness.drainTimers();
  const payload = nodeByKey(harness, "payload");

  // Clicking while a decode request is already in flight does not send a duplicate message.
  rowParts(payload).row.dispatch("click");
  rowParts(payload).row.dispatch("click");
  assert.equal(harness.posted.filter((message) => message.type === "expandDecoded").length, 1);

  // Dismissing a candidate picker clears loading state without stripping the affordance.
  harness.send({ type: "decodeFailed", nodeId: 1, cancelled: true });
  assert.equal(rowParts(nodeById(harness, 1)).row.classList.contains("decoding"), false);
  assert.equal(rowParts(nodeById(harness, 1)).toggle.className, "toggle decodable");
  rowParts(nodeById(harness, 1)).row.dispatch("click");
  assert.equal(harness.posted.filter((message) => message.type === "expandDecoded").length, 2);

  // Permanent failure removes the expand affordance.
  harness.send({ type: "decodeFailed", nodeId: 1 });
  assert.equal(rowParts(nodeById(harness, 1)).toggle.className, "toggle empty");
  assert.equal(nodeById(harness, 1).attributes.has("aria-expanded"), false);
  rowParts(nodeById(harness, 1)).row.dispatch("click");
  assert.equal(harness.posted.filter((message) => message.type === "expandDecoded").length, 2);
});

test("non-JSON inline decoded kinds render format-specific labels and tooltips", () => {
  const harness = createWebviewHarness(embeddedWebviewScript());
  renderTree(harness, {
    id: 0,
    type: "object",
    children: [
      { key: "pb", rawKey: '"pb"', value: { id: 1, type: "string", raw: '"CJYB"', value: "CJYB", decodable: true, decodableKind: "base64" } },
      { key: "token", rawKey: '"token"', value: { id: 2, type: "string", raw: '"eyJ.eyJ.sig"', value: "eyJ.eyJ.sig", decodable: true, decodableKind: "jwt" } },
    ],
  });
  harness.drainTimers();
  assert.equal(rowParts(nodeByKey(harness, "pb")).toggle.title, "Show decoded Base64");
  assert.equal(rowParts(nodeByKey(harness, "token")).toggle.title, "Show decoded JWT");

  harness.send({
    type: "decoded",
    nodeId: 1,
    decoded: {
      unwrapDepth: 0,
      kind: "base64-protobuf",
      root: { id: 10, type: "object", children: [{ key: "1", rawKey: '"1"', value: { id: 11, type: "number", raw: "150" } }] },
    },
  });
  harness.drainTimers();
  assert.equal(rowParts(nodeById(harness, 10)).key.textContent, "decoded Protobuf (Base64)");
});

test("Unix timestamps (s/ms/us/ns, string) and ISO-8601 strings convert to local/relative time and flag expired keys", () => {
  const harness = createWebviewHarness(embeddedWebviewScript());
  renderTree(harness, {
    id: 0,
    type: "object",
    children: [
      { key: "createdAt", rawKey: '"createdAt"', value: { id: 1, type: "number", raw: "1767225600000000" } },
      { key: "updatedAt", rawKey: '"updatedAt"', value: { id: 2, type: "number", raw: "1767225600000000000" } },
      { key: "ts", rawKey: '"ts"', value: { id: 3, type: "string", raw: '"1767225600000"', value: "1767225600000" } },
      { key: "isoEvent", rawKey: '"isoEvent"', value: { id: 4, type: "string", raw: '"2026-01-01T00:00:00.000Z"', value: "2026-01-01T00:00:00.000Z" } },
      { key: "exp", rawKey: '"exp"', value: { id: 5, type: "number", raw: "1577836800" } },
    ],
  });
  harness.drainTimers();
  const expected2026 = expectedLocalTimestampPrefix(1767225600000);
  for (const key of ["createdAt", "updatedAt", "ts", "isoEvent"]) {
    const parts = rowParts(nodeByKey(harness, key));
    assert.ok(parts.hint, `expected inline hint for ${key}`);
    assert.ok(parts.hint.textContent.startsWith(expected2026), `${key} hint ${parts.hint.textContent} should start with ${expected2026}`);
    assert.match(parts.value.title, /2026-01-01T00:00:00Z UTC/);
  }
  const expHint = rowParts(nodeByKey(harness, "exp")).hint!;
  assert.equal(expHint.className, "value-hint expired");
  assert.match(expHint.textContent, /expired/);
});

test("preserveView keeps object expansion by key when new keys are inserted above", () => {
  const harness = createWebviewHarness(embeddedWebviewScript());
  renderTree(harness, {
    id: 0,
    type: "object",
    children: [
      { key: "first", rawKey: '"first"', value: { id: 1, type: "object", children: [{ key: "a", rawKey: '"a"', value: { id: 2, type: "number", raw: "1" } }] } },
      { key: "target", rawKey: '"target"', value: { id: 3, type: "object", children: [{ key: "b", rawKey: '"b"', value: { id: 4, type: "number", raw: "2" } }] } },
    ],
  }, { renderKey: 1 });
  harness.drainTimers();
  rowParts(nodeByKey(harness, "target")).row.dispatch("click");
  harness.drainTimers();

  renderTree(harness, {
    id: 10,
    type: "object",
    children: [
      { key: "inserted", rawKey: '"inserted"', value: { id: 11, type: "object", children: [{ key: "z", rawKey: '"z"', value: { id: 12, type: "number", raw: "0" } }] } },
      { key: "first", rawKey: '"first"', value: { id: 13, type: "object", children: [{ key: "a", rawKey: '"a"', value: { id: 14, type: "number", raw: "1" } }] } },
      { key: "target", rawKey: '"target"', value: { id: 15, type: "object", children: [{ key: "b", rawKey: '"b"', value: { id: 16, type: "number", raw: "2" } }] } },
    ],
  }, { renderKey: 2, preserveView: true });
  harness.drainTimers();
  assert.equal(nodeByKey(harness, "inserted").getAttribute("aria-expanded"), "false");
  assert.equal(nodeByKey(harness, "first").getAttribute("aria-expanded"), "false");
  assert.equal(nodeByKey(harness, "target").getAttribute("aria-expanded"), "true");
});

test("renderWebviewHtml applies the provided display language", () => {
  const zhHtml = renderWebviewHtml({
    nonce: "NONCE",
    cspSource: "vscode-resource:",
    scriptUri: "vscode-resource:/main.js",
    styleUri: "vscode-resource:/tree.css",
    language: "zh-CN",
    l10nBundle: {},
  });
  assert.match(zhHtml, /<html lang="zh-CN">/);
});

test("values show timestamp, color, length, and link hints", () => {
  const harness = createWebviewHarness(embeddedWebviewScript());
  renderTree(harness, { id: 0, type: "object", children: [
    { key: "createdAt", rawKey: '"createdAt"', value: { id: 1, type: "number", raw: "1767225600" } },
    { key: "count", rawKey: '"count"', value: { id: 2, type: "number", raw: "1767225600000" } },
    { key: "color", rawKey: '"color"', value: { id: 3, type: "string", raw: '"#ff8800"', value: "#ff8800" } },
    { key: "home", rawKey: '"home"', value: { id: 4, type: "string", raw: '"https://example.com/a"', value: "https://example.com/a" } },
  ] });
  harness.drainTimers();

  const created = rowParts(nodeByKey(harness, "createdAt"));
  assert.match(created.value.title, /2026-01-01T00:00:00Z UTC/);
  assert.ok(created.hint?.textContent.startsWith(expectedLocalTimestampPrefix(1767225600000)));
  // Milliseconds are recognized, but an unrelated key gets only a tooltip.
  const count = rowParts(nodeByKey(harness, "count"));
  assert.match(count.value.title, /2026-01-01T00:00:00Z UTC/);
  assert.equal(count.hint, undefined);

  const colorParts = rowParts(nodeByKey(harness, "color"));
  assert.equal(colorParts.swatch?.className, "color-swatch");
  assert.equal(colorParts.swatch?.style.backgroundColor, "#ff8800");
  assert.match(colorParts.value.title, /7 characters/);

  const link = rowParts(nodeByKey(harness, "home")).value;
  assert.equal(link.classList.contains("link"), true);
  link.dispatch("click", { metaKey: false, ctrlKey: false, preventDefault() {} });
  assert.equal(harness.posted.filter((message) => message.type === "openLink").length, 0);
  link.dispatch("click", { metaKey: true, ctrlKey: false, preventDefault() {} });
  assert.deepEqual(harness.posted.at(-1), { type: "openLink", nodeId: 4 });
});

test("revealNode expands ancestors and highlights the node without stealing focus", () => {
  const harness = createWebviewHarness(embeddedWebviewScript());
  renderTree(harness, arrayOfSmallObjects(3), { canExpandAll: false });
  harness.drainTimers();
  harness.send({ type: "revealNode", ids: [0, 5, 6] });
  harness.drainTimers();
  assert.equal(nodeById(harness, 5).getAttribute("aria-expanded"), "true");
  const valueNode = nodeById(harness, 6);
  assert.equal(rowParts(valueNode).row.classList.contains("cursor-match"), true);
  assert.equal(valueNode.tabIndex, 0);
});

test("a re-parsed source keeps expansion by structure even though IDs change", () => {
  const harness = createWebviewHarness(embeddedWebviewScript());
  renderTree(harness, arrayOfSmallObjects(3), { renderKey: 1 });
  harness.drainTimers();
  rowParts(nodeById(harness, 5)).row.dispatch("click");
  harness.drainTimers();

  const shifted = arrayOfSmallObjects(3);
  const renumber = (node: { id: number; children?: Array<{ value: never }> }): void => {
    node.id += 100;
    for (const child of node.children ?? []) renumber(child.value);
  };
  renumber(shifted as never);
  renderTree(harness, shifted, { renderKey: 2, preserveView: true });
  harness.drainTimers();
  assert.equal(nodeById(harness, 105).getAttribute("aria-expanded"), "true");
  assert.equal(nodeById(harness, 101).getAttribute("aria-expanded"), "false");
});

test("the source bar reflects link, sync, and refresh state", () => {
  const harness = createWebviewHarness(embeddedWebviewScript());
  renderTree(harness, arrayOfSmallObjects(1), {
    source: { linked: true, syncCursor: true, status: "", canRefresh: false },
  });
  const bar = harness.elements.get("source-bar")!;
  const sync = harness.elements.get("sync-cursor")!;
  const refresh = harness.elements.get("refresh-source")!;
  assert.equal(bar.classList.contains("hidden"), false);
  assert.equal(sync.checked, true);
  assert.equal(refresh.classList.contains("hidden"), true);
  harness.send({ type: "sourceState", linked: false, syncCursor: true, status: "changed", canRefresh: true });
  assert.equal(sync.disabled, true);
  assert.equal(refresh.classList.contains("hidden"), false);
  assert.equal(harness.elements.get("source-status")!.textContent, "changed");
  refresh.dispatch("click");
  assert.deepEqual(harness.posted.at(-1), { type: "refreshSource" });
});

test("runtime Webview strings use the Host-provided translation bundle", () => {
  const harness = createWebviewHarness(embeddedWebviewScript(), {}, {
    "{0} matches": "{0} 个匹配",
    "{0} / {1}": "第 {0} 个，共 {1} 个",
  });
  renderTree(harness, arrayOfSmallObjects(2));
  harness.drainTimers();
  searchFor(harness, "value");
  assert.equal(harness.elements.get("search-count")!.textContent, "第 1 个，共 2 个");
});

test("search can ask the Host to decode embedded JSON first and then covers it", () => {
  const harness = createWebviewHarness(embeddedWebviewScript());
  renderTree(harness, objectWithPayload());
  harness.drainTimers();
  const toggle = harness.elements.get("search-decoded")!;
  searchFor(harness, "user");
  assert.equal(harness.posted.some((message) => message.type === "decodeAllForSearch"), false, "off by default");
  assert.match(harness.elements.get("search-count")!.textContent, /1/);

  toggle.dispatch("click");
  harness.drainTimers();
  assert.equal(toggle.attributes.get("aria-pressed"), "true");
  assert.deepEqual(harness.posted.filter((message) => message.type === "decodeAllForSearch"), [{ type: "decodeAllForSearch", renderKey: 0 }]);

  harness.send({
    type: "decodedBatch", renderKey: 0, decodedCount: 1, limited: false,
    items: [{ nodeId: 1, decoded: { unwrapDepth: 0, root: { id: 2, type: "object", children: [
      { key: "user", rawKey: '"user"', value: { id: 3, type: "number", raw: "7" } },
    ] } } }],
  });
  harness.drainTimers();
  // The escaped string and the decoded key both match now.
  assert.match(harness.elements.get("search-count")!.textContent, /\/ 2$/);
  assert.equal(harness.elements.get("tree-operation-status")!.textContent, "Decoded 1 string for search");
  // A batch for an older render is ignored, and decoding is requested once per render.
  harness.send({ type: "decodedBatch", renderKey: 99, decodedCount: 5, limited: true, items: [] });
  assert.equal(harness.elements.get("tree-operation-status")!.textContent, "Decoded 1 string for search");
  searchFor(harness, "use");
  assert.equal(harness.posted.filter((message) => message.type === "decodeAllForSearch").length, 1);
});

test("a reveal that arrives during expansion is applied once the tree settles", () => {
  const harness = createWebviewHarness(embeddedWebviewScript());
  renderTree(harness, arrayOfSmallObjects(400), { autoExpand: true });
  // Expansion is still running; the Host re-sends the cursor highlight after a Webview reload.
  harness.send({ type: "revealNode", ids: [0, 799, 800] });
  harness.drainTimers();
  const valueNode = nodeById(harness, 800);
  assert.equal(rowParts(valueNode).row.classList.contains("cursor-match"), true);
});

test("breadcrumb bar tracks focus, navigates on click, and copies JSONPath/jq", () => {
  const harness = createWebviewHarness(embeddedWebviewScript());
  renderTree(harness, {
    id: 0, type: "object", children: [
      { key: "user", rawKey: '"user"', value: { id: 1, type: "object", children: [
        { key: "name", rawKey: '"name"', value: { id: 2, type: "string", raw: '"Ada"', value: "Ada" } },
      ] } },
    ],
  }, { autoExpand: true });
  harness.drainTimers();
  harness.send({ type: "revealNode", ids: [0, 1, 2] });
  harness.drainTimers();

  const segments = harness.elements.get("breadcrumb-segments")!.children.filter((el) => el.className.includes("breadcrumb-segment"));
  assert.deepEqual(segments.map((el) => el.textContent), ["$", "user", "name"]);

  harness.elements.get("breadcrumb-copy-jsonpath")!.dispatch("click");
  assert.deepEqual(harness.posted.at(-1), { type: "copyJsonPath", nodeId: 2 });
  harness.elements.get("breadcrumb-copy-jq")!.dispatch("click");
  assert.deepEqual(harness.posted.at(-1), { type: "copyJqPath", nodeId: 2 });

  segments[1].dispatch("click");
  assert.equal(nodeById(harness, 1).tabIndex, 0);
});

test("quick row action buttons and Cmd+C / Shift+Cmd+C copy shortcuts post expected actions", () => {
  const harness = createWebviewHarness(embeddedWebviewScript());
  renderTree(harness, {
    id: 0, type: "object", children: [
      { key: "msg", rawKey: '"msg"', value: { id: 1, type: "string", raw: '"hello"', value: "hello" } },
    ],
  }, { autoExpand: true });
  harness.drainTimers();

  const msgNode = nodeByKey(harness, "msg");
  const copyBtn = rowParts(msgNode).actions.children.find((btn) => btn.getAttribute("data-action") === "copyQuickValue")!;
  copyBtn.dispatch("click");
  assert.deepEqual(harness.posted.at(-1), { type: "copyDecodedString", nodeId: 1 });

  rowParts(msgNode).row.dispatch("click");
  harness.elements.get("tree")!.dispatch("keydown", { key: "c", metaKey: true, shiftKey: false, preventDefault() {} });
  assert.deepEqual(harness.posted.at(-1), { type: "copyDecodedString", nodeId: 1 });
  harness.elements.get("tree")!.dispatch("keydown", { key: "c", metaKey: true, shiftKey: true, preventDefault() {} });
  assert.deepEqual(harness.posted.at(-1), { type: "copyJsonPath", nodeId: 1 });
});

test("depth selector, sort keys toggle, collapsed previews, and subtree menu actions work cleanly", () => {
  const harness = createWebviewHarness(embeddedWebviewScript());
  renderTree(harness, {
    id: 0, type: "object", children: [
      { key: "zeta", rawKey: '"zeta"', value: { id: 1, type: "object", children: [
        { key: "deep", rawKey: '"deep"', value: { id: 2, type: "object", children: [
          { key: "leaf", rawKey: '"leaf"', value: { id: 3, type: "number", raw: "1" } },
        ] } },
      ] } },
      { key: "alpha", rawKey: '"alpha"', value: { id: 4, type: "number", raw: "2" } },
    ],
  });
  harness.drainTimers();

  // Collapsed zeta displays an inline preview.
  assert.match(rowParts(nodeByKey(harness, "zeta")).preview?.textContent ?? "", /deep: \{1\}/);

  // Depth selector Level 2 expands root + zeta, keeping deep collapsed.
  const depthSelect = harness.elements.get("expand-depth")!;
  depthSelect.value = "2";
  depthSelect.dispatch("change");
  assert.equal(nodeById(harness, 1).getAttribute("aria-expanded"), "true");
  assert.equal(nodeById(harness, 2).getAttribute("aria-expanded"), "false");

  // A->Z toggle sorts root's object keys visually without altering node IDs.
  harness.elements.get("sort-keys")!.dispatch("click");
  const topKeys = renderedNodes(harness)
    .filter((n) => n.getAttribute("aria-level") === "2")
    .map((n) => rowParts(n).key.textContent);
  assert.deepEqual(topKeys, ["alpha", "zeta"]);

  // Context menu on zeta offers subtree & container actions.
  rowParts(nodeByKey(harness, "zeta")).row.dispatch("contextmenu", { clientX: 10, clientY: 10, preventDefault() {} });
  const menuItems = harness.elements.get("menu")!.children.map((el) => el.textContent);
  assert.ok(menuItems.includes("Expand subtree"));
  assert.ok(menuItems.includes("Open subtree as new tree"));
  assert.ok(menuItems.includes("Open formatted JSON in new editor"));
  const openSubtreeItem = harness.elements.get("menu")!.children.find((el) => el.textContent === "Open subtree as new tree")!;
  openSubtreeItem.dispatch("click");
  assert.deepEqual(harness.posted.at(-1), { type: "openSubtree", nodeId: 1 });
});

test("JSONL filter, keep-view, and table view filter/sort/export/jump work end-to-end", () => {
  const harness = createWebviewHarness(embeddedWebviewScript());
  renderTree(harness, arrayOfSmallObjects(1), {
    jsonl: { lineNumber: 1, lineCount: 10, followCursor: false, keepView: true, filterQuery: "", status: "" },
  });
  harness.drainTimers();

  harness.elements.get("keep-view")!.checked = false;
  harness.elements.get("keep-view")!.dispatch("change");
  assert.deepEqual(harness.posted.at(-1), { type: "setKeepView", enabled: false });

  const filterInput = harness.elements.get("jsonl-filter")!;
  filterInput.value = "level=ERROR";
  filterInput.dispatch("keydown", { key: "Enter", shiftKey: false, preventDefault() {} });
  assert.deepEqual(harness.posted.at(-1), { type: "nextJsonl", query: "level=ERROR" });

  harness.elements.get("jsonl-table")!.dispatch("click");
  assert.deepEqual(harness.posted.at(-1), { type: "openJsonlTable", query: "level=ERROR" });

  harness.send({
    type: "tableData",
    table: {
      title: "demo.jsonl",
      columns: ["id", "name"],
      rows: [
        { rowLabel: "1", targetLineNumber: 0, cells: ["10", "beta"] },
        { rowLabel: "2", targetLineNumber: 1, cells: ["2", "alpha"] },
      ],
      truncated: false,
      truncatedColumns: false,
      sourceKind: "jsonl",
    },
  });
  assert.equal(harness.elements.get("table-view")!.classList.contains("hidden"), false);
  assert.equal(harness.elements.get("tree")!.classList.contains("hidden"), true);

  // Numeric sort on column "id" puts 2 before 10.
  const idHeader = harness.elements.get("data-table")!.querySelector("thead")!.children[0].children[1];
  idHeader.dispatch("click");
  const tbody = harness.elements.get("data-table")!.querySelector("tbody")!;
  assert.deepEqual(tbody.children.map((tr) => tr.children[1].textContent), ["2", "10"]);

  // Filter table rows and export CSV.
  harness.elements.get("table-filter")!.value = "alpha";
  harness.elements.get("table-filter")!.dispatch("input");
  assert.equal(tbody.children.length, 1);
  harness.elements.get("table-copy-csv")!.dispatch("click");
  assert.deepEqual(harness.posted.at(-1), { type: "exportTable", mode: "copy", rowIndices: [1] });

  // Clicking row jumps to that JSONL line and closes table.
  tbody.children[0].dispatch("click");
  assert.deepEqual(harness.posted.at(-1), { type: "goToJsonlLine", lineNumber: 2 });
  assert.equal(harness.elements.get("table-view")!.classList.contains("hidden"), true);
});

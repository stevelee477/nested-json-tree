import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  advanceJsonTreeSearch,
  createJsonTreeSearchState,
  jsonTreePrimitiveSearchText,
} from "../search";

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

test("Webview model truncation is explicit and limits search scope", () => {
  assert.match(source, /createJsonTreeWebviewModel\(candidate\.tree\)/);
  assert.match(source, /const displayPath = formatJsonPathForDisplay\(materializeJsonTreePath\(context\)\)/);
  assert.doesNotMatch(source, /const jsonPath = formatJsonPath\(materializeJsonTreePath\(context\)\)/);
  assert.match(source, /truncatedFieldCount: this\.webviewModel\.truncatedFieldCount/);
  assert.match(source, /Search displayed text \(long values shortened\)/);
  assert.match(source, /copy and open actions still use the complete host value/i);
  assert.match(source, /truncated · /);
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
  class FakeClassList {
    private readonly names = new Set<string>();

    add(...names: string[]): void {
      for (const name of names) this.names.add(name);
    }

    remove(...names: string[]): void {
      for (const name of names) this.names.delete(name);
    }

    toggle(name: string, force?: boolean): boolean {
      const enabled = force ?? !this.names.has(name);
      if (enabled) this.names.add(name);
      else this.names.delete(name);
      return enabled;
    }
  }

  class FakeElement {
    readonly classList = new FakeClassList();
    readonly listeners = new Map<string, Array<(event: unknown) => void>>();
    readonly attributes = new Map<string, string>();
    readonly children: FakeElement[] = [];
    className = "";
    textContent = "";
    title = "";
    value = "";
    disabled = false;

    constructor(readonly fragment = false) {}

    addEventListener(type: string, listener: (event: unknown) => void): void {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    dispatch(type: string): void {
      for (const listener of this.listeners.get(type) ?? []) listener({});
    }

    appendChild(child: FakeElement): FakeElement {
      if (child.fragment) this.children.push(...child.children);
      else this.children.push(child);
      return child;
    }

    replaceChildren(...children: FakeElement[]): void {
      this.children.splice(0, this.children.length, ...children);
    }

    setAttribute(name: string, value: string): void {
      this.attributes.set(name, value);
    }

    querySelectorAll(): FakeElement[] {
      return [];
    }

    getBoundingClientRect(): { width: number; height: number } {
      return { width: 0, height: 0 };
    }

    focus(): void {}
    select(): void {}
    scrollIntoView(): void {}
  }

  const elementIds = [
    "tree",
    "menu",
    "search-input",
    "search-count",
    "search-scope-warning",
    "previous-match",
    "next-match",
    "clear-search",
    "expand-all",
    "collapse-all",
    "empty-search",
    "title",
    "path",
  ];
  const elements = new Map(elementIds.map((id) => [id, new FakeElement()]));
  const windowListeners = new Map<string, Array<(event: { data: unknown }) => void>>();
  const timers: Array<() => void> = [];
  const document = {
    getElementById: (id: string) => elements.get(id),
    createElement: () => new FakeElement(),
    createDocumentFragment: () => new FakeElement(true),
    addEventListener: () => {},
  };
  const window = {
    innerWidth: 1_000,
    innerHeight: 800,
    addEventListener: (type: string, listener: (event: { data: unknown }) => void) => {
      const listeners = windowListeners.get(type) ?? [];
      listeners.push(listener);
      windowListeners.set(type, listeners);
    },
  };
  const setTimeout = (callback: () => void): number => {
    timers.push(callback);
    return timers.length;
  };

  const run = new Function(
    "window",
    "document",
    "acquireVsCodeApi",
    "setTimeout",
    "clearTimeout",
    "performance",
    embeddedWebviewScript(),
  );
  run(window, document, () => ({ postMessage: () => {} }), setTimeout, () => {}, { now: () => 0 });

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

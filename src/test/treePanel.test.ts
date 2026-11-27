import assert from "node:assert/strict";
import Module from "node:module";
import test, { after } from "node:test";
import type { HostToWebviewMessage, NodeInspectionMessage, RenderMessage, TableDataMessage } from "../protocol";
import { parseJsonCandidates } from "../parser";

interface MockWebviewPanel {
  title: string;
  viewColumn: number;
  disposed: boolean;
  posted: HostToWebviewMessage[];
  webview: {
    cspSource: string;
    html: string;
    options: Record<string, unknown>;
    asWebviewUri(uri: MockUri): MockUri;
    postMessage(msg: HostToWebviewMessage): Promise<boolean>;
    onDidReceiveMessage(cb: (msg: unknown) => void): { dispose(): void };
  };
  onDidDispose(cb: () => void): { dispose(): void };
  dispose(): void;
}

class MockUri {
  constructor(
    public readonly scheme: string,
    public readonly path: string,
  ) {}

  get fsPath(): string {
    return this.path;
  }

  toString(): string {
    return `${this.scheme}://${this.path}`;
  }

  static file(filePath: string): MockUri {
    return new MockUri("file", filePath);
  }

  static parse(raw: string): MockUri {
    const idx = raw.indexOf("://");
    if (idx < 0) return new MockUri("file", raw);
    return new MockUri(raw.slice(0, idx), raw.slice(idx + 3));
  }

  static joinPath(base: MockUri, ...parts: string[]): MockUri {
    const joined = [base.path.replace(/\/+$/, ""), ...parts].join("/");
    return new MockUri(base.scheme, joined);
  }
}

let clipboardText = "";
const openedDocs: Array<{ content: string; language: string }> = [];
const mockTextFiles = new Map<string, string>();
let quickPickQueue: Array<(items: ReadonlyArray<Record<string, unknown>>) => unknown> = [];
const createdPanels: MockWebviewPanel[] = [];

function createMockPanel(title: string, viewColumn = 2): MockWebviewPanel {
  const disposeListeners: Array<() => void> = [];
  const posted: HostToWebviewMessage[] = [];
  const panel: MockWebviewPanel = {
    title,
    viewColumn,
    disposed: false,
    posted,
    webview: {
      cspSource: "vscode-webview://mock",
      html: "",
      options: {},
      asWebviewUri: (uri) => uri,
      postMessage: async (msg) => {
        posted.push(msg);
        return true;
      },
      onDidReceiveMessage: () => ({ dispose() {} }),
    },
    onDidDispose: (cb) => {
      disposeListeners.push(cb);
      return { dispose() {} };
    },
    dispose() {
      if (panel.disposed) return;
      panel.disposed = true;
      for (const listener of disposeListeners) listener();
    },
  };
  createdPanels.push(panel);
  return panel;
}

const vscodeMock = {
  Uri: MockUri,
  ViewColumn: { Active: 1, Beside: 2, One: 1 },
  Position: class {
    constructor(public readonly line: number, public readonly character: number) {}
  },
  Range: class {
    constructor(public readonly start: unknown, public readonly end: unknown) {}
  },
  Selection: class {
    constructor(public readonly start: unknown, public readonly end: unknown) {}
  },
  TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
  env: {
    language: "en",
    clipboard: {
      readText: async () => clipboardText,
      writeText: async (value: string) => {
        clipboardText = value;
      },
    },
    openExternal: async () => true,
  },
  l10n: {
    bundle: undefined,
    t: (message: string, ...args: unknown[]) =>
      message.replace(/\{(\d+)\}/g, (_, idx) => String(args[Number(idx)] ?? "")),
  },
  workspace: {
    textDocuments: [] as unknown[],
    getConfiguration: () => ({
      get: (_key: string, fallback: unknown) => fallback,
    }),
    onDidChangeTextDocument: () => ({ dispose() {} }),
    openTextDocument: async (arg: MockUri | { content?: string; language?: string }) => {
      if (arg instanceof MockUri) {
        const text = mockTextFiles.get(arg.toString());
        if (text === undefined) throw new Error(`Missing mock file ${arg.toString()}`);
        const lines = text.split("\n");
        return {
          uri: arg,
          isUntitled: false,
          version: 1,
          lineCount: lines.length,
          getText: () => text,
          lineAt: (lineNumber: number) => ({
            text: lines[lineNumber] ?? "",
            range: { start: { line: lineNumber, character: 0 }, end: { line: lineNumber, character: (lines[lineNumber] ?? "").length } },
          }),
          offsetAt: () => 0,
          positionAt: () => ({ line: 0, character: 0 }),
        };
      }
      const doc = {
        content: arg.content ?? "",
        language: arg.language ?? "plaintext",
        uri: MockUri.parse(`untitled://doc-${openedDocs.length + 1}`),
        isUntitled: true,
        version: 1,
        lineCount: (arg.content ?? "").split("\n").length,
        getText: () => arg.content ?? "",
      };
      openedDocs.push({ content: doc.content, language: doc.language });
      return doc;
    },
  },
  window: {
    visibleTextEditors: [],
    activeTextEditor: undefined,
    createWebviewPanel: (_viewType: string, title: string, column: number) => createMockPanel(title, column),
    onDidChangeTextEditorSelection: () => ({ dispose() {} }),
    showTextDocument: async (doc: unknown) => ({ document: doc, revealRange() {} }),
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showQuickPick: async (items: ReadonlyArray<Record<string, unknown>>) => {
      const handler = quickPickQueue.shift();
      return handler ? handler(items) : items[0];
    },
  },
  commands: {
    registerCommand: () => ({ dispose() {} }),
  },
};

type ModuleLoader = {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
};

const moduleLoader = Module as unknown as ModuleLoader;
const originalLoad = moduleLoader._load;
moduleLoader._load = function patchedLoad(request: string, parent: unknown, isMain: boolean): unknown {
  if (request === "vscode") return vscodeMock;
  return originalLoad.call(this, request, parent, isMain);
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const treePanelMod = require("../treePanel") as typeof import("../treePanel");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const extensionMod = require("../extension") as typeof import("../extension");

after(() => {
  moduleLoader._load = originalLoad;
  for (const panel of createdPanels.splice(0)) panel.dispose();
});

test("openNestedString reuses attached node.decoded without re-prompting and uses async parser otherwise", async () => {
  let pickerCalls = 0;
  const services = {
    extensionUri: MockUri.file("/ext"),
    pickCandidate: async (candidates: ReturnType<typeof parseJsonCandidates>) => {
      pickerCalls += 1;
      return candidates[0];
    },
  };
  const [candidate] = parseJsonCandidates(
    JSON.stringify({
      multi: 'prefix {"first": 1} middle {"second": 2}',
      plain: JSON.stringify({ hello: "world" }),
    }),
  );
  const panel = treePanelMod.JsonTreePanel.create(services as never, {
    candidate,
    title: "Test Tree",
  });
  const handle = panel.testHandle();
  const multiNode = handle.tree.children!.find((c) => c.key === "multi")!.value;
  const plainNode = handle.tree.children!.find((c) => c.key === "plain")!.value;

  await handle.runNodeAction("expandDecoded", multiNode.id);
  assert.equal(pickerCalls, 1);
  assert.ok(multiNode.decoded);

  // Opening an already-decoded string as a tree or editor must reuse node.decoded without calling pickCandidate again.
  const beforePanels = treePanelMod.getPanelTestHandles().length;
  await handle.runNodeAction("openNested", multiNode.id);
  assert.equal(pickerCalls, 1);
  assert.equal(treePanelMod.getPanelTestHandles().length, beforePanels + 1);
  const decodedChildPanel = treePanelMod.getPanelTestHandles().at(-1)!;
  assert.equal(decodedChildPanel.tree.children?.[0]?.key, "first");

  openedDocs.length = 0;
  await handle.runNodeAction("openParsedJson", multiNode.id);
  assert.equal(pickerCalls, 1);
  assert.equal(openedDocs.length, 1);
  assert.equal(openedDocs[0].language, "json");
  assert.match(openedDocs[0].content, /"first": 1/);

  // Undecoded string uses parseNestedJsonCandidatesAsync.
  await handle.runNodeAction("openNested", plainNode.id);
  const nestedPanel = treePanelMod.getPanelTestHandles().at(-1)!;
  assert.equal(nestedPanel.title, "Nested JSON · $.plain");
  assert.equal(nestedPanel.tree.children?.[0]?.value.value, "world");
});

const defaultServices = {
  extensionUri: MockUri.file("/ext"),
  pickCandidate: async (all: ReturnType<typeof parseJsonCandidates>) => all[0],
} as unknown as import("../treePanel").PanelServices;

test("inspectNode returns untruncated Host value, UTF-8 byte count, line count, and child count", async () => {
  const longText = `${"🎉".repeat(6_000)}\nline-two`;
  const [candidate] = parseJsonCandidates(JSON.stringify({ message: longText, meta: { a: 1, b: 2 } }));
  const panel = treePanelMod.JsonTreePanel.create(
    defaultServices,
    { candidate, title: "Inspect Test" },
  );
  const handle = panel.testHandle();
  const msgNode = handle.tree.children!.find((c) => c.key === "message")!.value;
  const metaNode = handle.tree.children!.find((c) => c.key === "meta")!.value;

  await handle.runNodeAction("inspectNode", msgNode.id);
  const msgInspect = createdPanels.at(-1)!.posted.at(-1) as NodeInspectionMessage;
  assert.equal(msgInspect.type, "nodeInspection");
  assert.equal(msgInspect.path, "$.message");
  assert.equal(msgInspect.fullValue, longText);
  assert.equal(msgInspect.byteLength, Buffer.byteLength(longText, "utf8"));
  assert.equal(msgInspect.charLength, longText.length);
  assert.equal(msgInspect.lineCount, 2);

  await handle.runNodeAction("inspectNode", metaNode.id);
  const metaInspect = handle.lastInspection!;
  assert.equal(metaInspect.childCount, 2);
  assert.match(metaInspect.fullValue, /"a": 1/);
});

test("generateTypes supports QuickPick editor opening and clipboard copy across languages", async () => {
  const [candidate] = parseJsonCandidates(JSON.stringify({ users: [{ id: 1, name: "Ada" }] }));
  const panel = treePanelMod.JsonTreePanel.create(
    defaultServices,
    { candidate, title: "Schema Test" },
  );
  const handle = panel.testHandle();
  const usersNode = handle.tree.children![0].value;

  openedDocs.length = 0;
  quickPickQueue = [
    (items) => items.find((item) => item.target === "go"),
    (items) => items.find((item) => item.mode === "open"),
  ];
  await handle.runNodeAction("generateTypes", usersNode.id);
  assert.equal(openedDocs.length, 1);
  assert.equal(openedDocs[0].language, "go");
  assert.match(openedDocs[0].content, /type User struct/);

  clipboardText = "";
  quickPickQueue = [
    (items) => items.find((item) => item.target === "python"),
    (items) => items.find((item) => item.mode === "copy"),
  ];
  await handle.runNodeAction("generateTypes", usersNode.id);
  assert.match(clipboardText, /class User\(BaseModel\):/);
});

test("reopenTable toggles nested column flattening and exportTable formats CSV, TSV, and Markdown", async () => {
  const [candidate] = parseJsonCandidates(
    JSON.stringify({
      items: [
        { id: 1, user: { name: "Ada", role: "admin" } },
        { id: 2, user: { name: "Grace", role: "ops" } },
      ],
    }),
  );
  const panel = treePanelMod.JsonTreePanel.create(
    defaultServices,
    { candidate, title: "Table Test" },
  );
  const handle = panel.testHandle();
  const itemsNode = handle.tree.children![0].value;

  await handle.runNodeAction("openArrayTable", itemsNode.id);
  assert.deepEqual(handle.lastTable?.columns, ["id", "user"]);
  assert.equal(handle.lastTable?.flattened, false);

  await handle.postFromWebview({ type: "reopenTable", flatten: true });
  const tableMsg = createdPanels.at(-1)!.posted.at(-1) as TableDataMessage;
  assert.equal(tableMsg.type, "tableData");
  assert.deepEqual(handle.lastTable?.columns, ["id", "user.name", "user.role"]);
  assert.equal(handle.lastTable?.flattened, true);

  await handle.postFromWebview({ type: "exportTable", mode: "copy", format: "tsv", rowIndices: [0, 1] });
  assert.equal(clipboardText, "id\tuser.name\tuser.role\n1\tAda\tadmin\n2\tGrace\tops");

  openedDocs.length = 0;
  await handle.postFromWebview({ type: "exportTable", mode: "open", format: "markdown", rowIndices: [0] });
  assert.equal(openedDocs.length, 1);
  assert.equal(openedDocs[0].language, "markdown");
  assert.equal(
    openedDocs[0].content,
    "| id | user.name | user.role |\n| --- | --- | --- |\n| 1 | Ada | admin |",
  );
});

test("diffWithClipboard, diffJsonlPrevious, and JsonTreePanel.revive populate RenderMessage diff & panelSource", async () => {
  const jsonlUri = MockUri.file("/workspace/events.jsonl");
  const line0 = JSON.stringify({ id: 1, status: "pending", legacy: true });
  const line1 = JSON.stringify({ id: 1, status: "ok", extra: 42 });
  mockTextFiles.set(jsonlUri.toString(), `${line0}\n${line1}`);

  const [secondCandidate] = parseJsonCandidates(line1);
  const services = { extensionUri: MockUri.file("/ext"), pickCandidate: async (all: ReturnType<typeof parseJsonCandidates>) => all[0] };
  const revivedMockPanel = createMockPanel("Old Title");
  const revived = treePanelMod.JsonTreePanel.revive(revivedMockPanel as never, services as never, {
    candidate: secondCandidate,
    title: "JSON Tree · events.jsonl:2",
    pathLabel: "$ · line 2",
    jsonlSource: {
      uri: jsonlUri as never,
      sourceName: "events.jsonl",
      lineNumber: 1,
      lineCount: 2,
    },
  });
  assert.equal(revivedMockPanel.title, "JSON Tree · events.jsonl:2");

  const handle = revived.testHandle();
  await handle.postFromWebview({ type: "ready" });
  const renderMsg = revivedMockPanel.posted.find((m) => m.type === "render") as RenderMessage;
  assert.deepEqual(renderMsg.panelSource, {
    kind: "jsonl",
    uri: "file:///workspace/events.jsonl",
    lineNumber: 1,
  });
  assert.deepEqual(extensionMod.extractSerializedPanelSource({ panelSource: renderMsg.panelSource }), {
    kind: "jsonl",
    uri: "file:///workspace/events.jsonl",
    lineNumber: 1,
  });

  // Diff against previous valid JSONL line
  await handle.postFromWebview({ type: "diffJsonlPrevious" });
  const jsonlDiffMock = createdPanels.at(-1)!;
  const jsonlDiffHandle = treePanelMod.getPanelTestHandles().at(-1)!;
  assert.equal(jsonlDiffHandle.title, "JSON Diff · events.jsonl:1 → 2");
  assert.deepEqual(jsonlDiffHandle.diff?.summary, {
    added: 1,
    removed: 1,
    changed: 1,
    unchanged: 2,
  });
  await jsonlDiffHandle.postFromWebview({ type: "ready" });
  const diffRenderMsg = jsonlDiffMock.posted.find((m) => m.type === "render") as RenderMessage;
  assert.deepEqual(diffRenderMsg.diff?.summary, jsonlDiffHandle.diff?.summary);

  // Diff full tree against clipboard
  clipboardText = JSON.stringify({ id: 1, status: "ok", extra: 99 });
  await handle.postFromWebview({ type: "diffWithClipboard" });
  const clipDiffHandle = treePanelMod.getPanelTestHandles().at(-1)!;
  assert.equal(clipDiffHandle.diff?.summary.changed, 1);
  assert.equal(clipDiffHandle.diff?.summary.added, 0);
  assert.equal(clipDiffHandle.diff?.summary.removed, 0);
});

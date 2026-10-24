import assert from "node:assert/strict";
import * as vscode from "vscode";
import type { ExtensionTestApi } from "../../extension";
import type { JsonTreeNode } from "../../jsonTree";
import type { PanelTestHandle } from "../../treePanel";

const EXTENSION_NAME = "nested-json-tree";
const OPEN_DOCUMENT_COMMAND = "nestedJsonTree.openDocument";
const OPEN_CURRENT_LINE_COMMAND = "nestedJsonTree.openCurrentLine";
const VIEW_TYPE = "nestedJsonTree.viewer";

export async function run(): Promise<void> {
  const extension = vscode.extensions.all.find(
    (candidate) => candidate.packageJSON.name === EXTENSION_NAME,
  );
  assert.ok(extension, `Could not find the ${EXTENSION_NAME} development extension.`);

  const api = (await extension.activate()) as ExtensionTestApi;
  assert.equal(extension.isActive, true, "The extension should be active after activation.");

  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes(OPEN_DOCUMENT_COMMAND), `${OPEN_DOCUMENT_COMMAND} should be registered.`);
  assert.ok(
    commands.includes(OPEN_CURRENT_LINE_COMMAND),
    `${OPEN_CURRENT_LINE_COMMAND} should be registered.`,
  );

  verifyLocalization();
  await expectWebviewReady(api, verifyOpenDocumentCommand);
  await expectWebviewReady(api, verifyOpenCurrentLineCommand);
  await expectWebviewReady(api, verifyRecoveredDocumentCommand);
  await verifySelectionRevealAndCursorSync(api);
  await verifyLiveRefreshKeepsInlineDecodedJson(api);
  await verifyOpenClipboardCommand(api);
  await verifySelectionTracksEdits(api);
  await verifyJsonlLineTracksEdits(api);
  await verifyEmbeddedJsonAndSearchDecoding(api);
}

/** Polls a fresh handle for the newest panel with this title. */
function poll(api: ExtensionTestApi, title: string, ready: (panel: PanelTestHandle) => boolean, description: string) {
  return waitFor(() => {
    const panel = newestPanel(api, title);
    return panel !== undefined && ready(panel) ? panel : undefined;
  }, description);
}

async function verifySelectionTracksEdits(api: ExtensionTestApi): Promise<void> {
  const content = 'header\nlog {"value": 42} tail\n';
  const document = await vscode.workspace.openTextDocument({ language: "plaintext", content });
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  const start = content.indexOf("{");
  editor.selection = new vscode.Selection(document.positionAt(start), document.positionAt(content.indexOf("}") + 1));
  await vscode.commands.executeCommand("nestedJsonTree.openSelection");
  const title = treeTitle("Untitled", 2);
  await poll(api, title, () => true, "the selection panel");

  // An edit above the selection only shifts it; the tree stays linked.
  await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), "new first line\n"));
  let panel = await poll(api, title, (current) => current.parsedVersion === document.version, "the selection to follow an edit above it");
  await panel.runNodeAction("revealInSource", childValue(panel.tree, "value").id);
  const active = await waitFor(() => vscode.window.activeTextEditor?.document === document ? vscode.window.activeTextEditor : undefined, "the source editor");
  assert.equal(document.getText(active.selection), "42");

  // An edit inside the selection re-parses just the selection.
  const before = panel.renderVersion;
  const valueOffset = document.getText().indexOf("42");
  await active.edit((edit) => edit.replace(new vscode.Range(document.positionAt(valueOffset), document.positionAt(valueOffset + 2)), "1234"));
  panel = await poll(api, title, (current) => current.renderVersion > before, "the selection to re-parse");
  assert.equal(childValue(panel.tree, "value").raw, "1234");

  // An edit across the selection boundary unlinks it.
  const braceOffset = document.getText().indexOf("{");
  await active.edit((edit) => edit.delete(new vscode.Range(document.positionAt(braceOffset - 2), document.positionAt(braceOffset + 2))));
  await poll(api, title, (current) => current.parsedVersion === undefined, "the selection to unlink");
}

async function verifyJsonlLineTracksEdits(api: ExtensionTestApi): Promise<void> {
  const document = await vscode.workspace.openTextDocument({ language: "plaintext", content: '{"i":0}\n{"i":1}\n{"i":2}\n' });
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  editor.selection = new vscode.Selection(2, 0, 2, 0);
  await vscode.commands.executeCommand("nestedJsonTree.openCurrentLine");
  await poll(api, treeTitle("Untitled", 3), () => true, "the JSONL panel");

  await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), '{"i":-1}\n'));
  let panel = await poll(api, treeTitle("Untitled", 4), (current) => current.lineNumber === 3, "the record to move down a line");
  assert.equal(panel.parsedVersion, document.version);
  assert.equal(childValue(panel.tree, "i").raw, "2", "the tree is unchanged");

  const before = panel.renderVersion;
  await editor.edit((edit) => edit.replace(new vscode.Range(3, 5, 3, 6), "5"));
  panel = await poll(api, treeTitle("Untitled", 4), (current) => current.renderVersion > before, "the edited record to re-parse");
  assert.equal(childValue(panel.tree, "i").raw, "5");

  await editor.edit((edit) => edit.delete(new vscode.Range(2, 0, 4, 0)));
  await poll(api, treeTitle("Untitled", 3), (current) => current.parsedVersion === undefined, "a deleted record to unlink");
}

async function verifyEmbeddedJsonAndSearchDecoding(api: ExtensionTestApi): Promise<void> {
  const content = JSON.stringify({
    message: 'retrying: {"attempt": 2} after timeout',
    layers: JSON.stringify({ inner: JSON.stringify({ deep: true }) }),
  });
  const document = await vscode.workspace.openTextDocument({ language: "json", content });
  await vscode.window.showTextDocument(document, { preview: false });
  await vscode.commands.executeCommand("nestedJsonTree.openDocument");
  const panel = await poll(api, treeTitle("Untitled"), (current) => childValue(current.tree, "message").decoded === undefined, "the embedded-JSON panel");

  const message = childValue(panel.tree, "message");
  await panel.runNodeAction("expandDecoded", message.id);
  assert.equal(message.decoded?.embedded, true, "JSON inside text is flagged as embedded");
  assert.equal(childValue(message.decoded!.root, "attempt").raw, "2");

  await panel.postFromWebview({ type: "decodeAllForSearch", renderKey: panel.renderVersion });
  const layers = childValue(panel.tree, "layers");
  const inner = childValue(layers.decoded!.root, "inner");
  assert.equal(layers.decoded?.embedded, undefined);
  assert.equal(childValue(inner.decoded!.root, "deep").raw, "true", "decoding for search follows nested strings");
}

/** Expected panel title in the active display language. */
function treeTitle(name: "Untitled", line?: number): string {
  const sourceName = vscode.l10n.t(name);
  return line === undefined
    ? vscode.l10n.t("JSON Tree · {0}", sourceName)
    : vscode.l10n.t("JSON Tree · {0}:{1}", sourceName, line);
}

/** Run with VSCODE_TEST_LOCALE=zh-cn to check that the extension's bundle loads. */
function verifyLocalization(): void {
  const requested = process.env.VSCODE_TEST_LOCALE;
  if (requested !== undefined) assert.equal(vscode.env.language.toLowerCase(), requested.toLowerCase());
  if (!vscode.env.language.toLowerCase().startsWith("zh")) {
    assert.equal(vscode.l10n.t("Open link"), "Open link");
    return;
  }
  assert.equal(vscode.l10n.t("Open link"), "打开链接");
  assert.equal(vscode.l10n.t("JSON Tree · {0}", "a.json"), "JSON 树 · a.json");
}

async function waitFor<T>(read: () => T | undefined, description: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}.`);
    await delay(50);
  }
}

function newestPanel(api: ExtensionTestApi, title: string): PanelTestHandle | undefined {
  return api.panels().filter((panel) => panel.title === title).at(-1);
}

function childValue(node: JsonTreeNode, key: string | number): JsonTreeNode {
  const child = node.children?.find((candidate) => candidate.key === key);
  assert.ok(child, `missing child ${String(key)}`);
  return child.value;
}

async function verifySelectionRevealAndCursorSync(api: ExtensionTestApi): Promise<void> {
  const content = 'INFO request done\nDEBUG payload={"a": {"b": 42}, "c": "x"} trailing\n';
  const document = await vscode.workspace.openTextDocument({ language: "plaintext", content });
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}") + 1;
  editor.selection = new vscode.Selection(document.positionAt(start), document.positionAt(end));
  await vscode.commands.executeCommand("nestedJsonTree.openSelection");
  const panel = await waitFor(() => newestPanel(api, treeTitle("Untitled", 2)), "the selection panel");
  const b = childValue(childValue(panel.tree, "a"), "b");

  await panel.runNodeAction("revealInSource", b.id);
  const revealed = await waitFor(() => {
    const active = vscode.window.activeTextEditor;
    return active?.document === document && !active.selection.isEmpty ? active : undefined;
  }, "the revealed source range");
  assert.equal(document.getText(revealed.selection), "42");

  const a = childValue(panel.tree, "a");
  revealed.selection = new vscode.Selection(document.positionAt(content.indexOf('"a"') + 1), document.positionAt(content.indexOf('"a"') + 1));
  await waitFor(() => newestPanel(api, treeTitle("Untitled", 2))?.lastSyncedNodeId === a.id || undefined, "cursor sync to the key's value");
}

async function verifyLiveRefreshKeepsInlineDecodedJson(api: ExtensionTestApi): Promise<void> {
  const content = '{"payload": "{\\"items\\": [1, 2]}", "n": 1}';
  const document = await vscode.workspace.openTextDocument({ language: "json", content });
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  await vscode.commands.executeCommand("nestedJsonTree.openDocument");
  const title = treeTitle("Untitled");
  const panel = await waitFor(() => newestPanel(api, title), "the document panel");
  const payload = childValue(panel.tree, "payload");
  await panel.runNodeAction("expandDecoded", payload.id);
  assert.equal(payload.decoded?.root.type, "object", "the string's JSON is attached inline");
  assert.equal(childValue(payload.decoded!.root, "items").children?.length, 2);

  const before = panel.renderVersion;
  const numberOffset = content.lastIndexOf("1");
  await editor.edit((edit) => edit.replace(
    new vscode.Range(document.positionAt(numberOffset), document.positionAt(numberOffset + 1)),
    "2",
  ));
  const refreshed = await waitFor(() => {
    const current = newestPanel(api, title);
    return current !== undefined && current.renderVersion > before ? current : undefined;
  }, "the live refresh after an edit");
  assert.equal(childValue(refreshed.tree, "n").raw, "2");
  assert.equal(refreshed.parsedVersion, document.version);
  assert.equal(childValue(refreshed.tree, "payload").decoded?.root.type, "object", "inline decoding survives a refresh");
}

async function verifyOpenClipboardCommand(api: ExtensionTestApi): Promise<void> {
  await vscode.env.clipboard.writeText('copied: {"from": "clipboard"}');
  await vscode.commands.executeCommand("nestedJsonTree.openClipboard");
  const panel = await waitFor(() => newestPanel(api, vscode.l10n.t("JSON Tree · Clipboard")), "the clipboard panel");
  assert.equal(childValue(panel.tree, "from").value, "clipboard");
}

/** Proves the bundled Webview script loaded under the panel CSP and reached the host. */
async function expectWebviewReady(
  api: ExtensionTestApi,
  openPanel: () => Promise<void>,
): Promise<void> {
  const before = api.readyWebviewCount();
  await openPanel();
  const deadline = Date.now() + 10_000;
  while (api.readyWebviewCount() <= before) {
    if (Date.now() > deadline) throw new Error("The Tree View Webview script never reported ready.");
    await delay(50);
  }
}

async function verifyOpenDocumentCommand(): Promise<void> {
  const document = await vscode.workspace.openTextDocument({
    language: "json",
    content: '{"source":"document","ok":true}',
  });
  await vscode.window.showTextDocument(document, { preview: false });

  const expectedLabel = treeTitle("Untitled");
  const existingCount = viewerTabs().filter((tab) => tab.label === expectedLabel).length;
  await vscode.commands.executeCommand(OPEN_DOCUMENT_COMMAND);
  const tab = await waitForViewerTab(
    (candidate) => candidate.label === expectedLabel,
    existingCount,
  );

  assert.equal(isViewerViewType(tab.input.viewType), true);
  assert.equal(tab.label, expectedLabel);
}

async function verifyOpenCurrentLineCommand(): Promise<void> {
  const document = await vscode.workspace.openTextDocument({
    language: "plaintext",
    content: 'not json\n{"source":"current-line","line":2}',
  });
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  editor.selection = new vscode.Selection(1, 0, 1, 0);

  const expectedLabel = treeTitle("Untitled", 2);
  const existingCount = viewerTabs().filter((tab) => tab.label === expectedLabel).length;
  await vscode.commands.executeCommand(OPEN_CURRENT_LINE_COMMAND);
  const tab = await waitForViewerTab(
    (candidate) => candidate.label === expectedLabel,
    existingCount,
  );

  assert.equal(isViewerViewType(tab.input.viewType), true);
  assert.equal(tab.label, expectedLabel);
}

function viewerTabs(): Array<vscode.Tab & { input: vscode.TabInputWebview }> {
  return vscode.window.tabGroups.all
    .flatMap((group) => [...group.tabs])
    .filter(
      (tab): tab is vscode.Tab & { input: vscode.TabInputWebview } =>
        isViewerViewType((tab.input as Partial<vscode.TabInputWebview>).viewType),
    );
}

function isViewerViewType(viewType: unknown): viewType is string {
  return typeof viewType === "string" && (viewType === VIEW_TYPE || viewType.endsWith(`-${VIEW_TYPE}`));
}

async function waitForViewerTab(
  matchesExpectedTab: (tab: vscode.Tab & { input: vscode.TabInputWebview }) => boolean,
  existingCount: number,
  timeoutMs = 10_000,
): Promise<vscode.Tab & { input: vscode.TabInputWebview }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matchingTabs = viewerTabs().filter(matchesExpectedTab);
    if (matchingTabs.length > existingCount) return matchingTabs[matchingTabs.length - 1];
    await delay(50);
  }
  const visibleTabs = vscode.window.tabGroups.all
    .flatMap((group) => [...group.tabs])
    .map((tab) => {
      const input = tab.input as Partial<vscode.TabInputWebview> & {
        constructor?: { name?: string };
      };
      return `${tab.label} (${input.constructor?.name ?? "unknown"}, viewType=${String(input.viewType)})`;
    })
    .join(", ");
  throw new Error(`Timed out waiting for a new ${VIEW_TYPE} Webview tab. Tabs: ${visibleTabs}`);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function verifyRecoveredDocumentCommand(): Promise<void> {
  const document = await vscode.workspace.openTextDocument({
    language: "json",
    content: '{"source":"partial","bad":oops,"nested":{"ok":true}',
  });
  await vscode.window.showTextDocument(document, { preview: false });
  const expectedLabel = treeTitle("Untitled");
  const existingCount = viewerTabs().filter((tab) => tab.label === expectedLabel).length;
  await vscode.commands.executeCommand(OPEN_DOCUMENT_COMMAND);
  const tab = await waitForViewerTab((candidate) => candidate.label === expectedLabel, existingCount);
  assert.equal(isViewerViewType(tab.input.viewType), true);
}

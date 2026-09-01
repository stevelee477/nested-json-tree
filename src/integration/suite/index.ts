import assert from "node:assert/strict";
import * as vscode from "vscode";

const EXTENSION_NAME = "nested-json-tree";
const OPEN_DOCUMENT_COMMAND = "nestedJsonTree.openDocument";
const OPEN_CURRENT_LINE_COMMAND = "nestedJsonTree.openCurrentLine";
const VIEW_TYPE = "nestedJsonTree.viewer";

export async function run(): Promise<void> {
  const extension = vscode.extensions.all.find(
    (candidate) => candidate.packageJSON.name === EXTENSION_NAME,
  );
  assert.ok(extension, `Could not find the ${EXTENSION_NAME} development extension.`);

  await extension.activate();
  assert.equal(extension.isActive, true, "The extension should be active after activation.");

  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes(OPEN_DOCUMENT_COMMAND), `${OPEN_DOCUMENT_COMMAND} should be registered.`);
  assert.ok(
    commands.includes(OPEN_CURRENT_LINE_COMMAND),
    `${OPEN_CURRENT_LINE_COMMAND} should be registered.`,
  );

  await verifyOpenDocumentCommand();
  await verifyOpenCurrentLineCommand();
}

async function verifyOpenDocumentCommand(): Promise<void> {
  const document = await vscode.workspace.openTextDocument({
    language: "json",
    content: '{"source":"document","ok":true}',
  });
  await vscode.window.showTextDocument(document, { preview: false });

  const expectedLabel = "JSON Tree · Untitled";
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

  const expectedLabel = "JSON Tree · Untitled:2";
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

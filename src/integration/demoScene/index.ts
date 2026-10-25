/* eslint-disable no-console -- the demo runner reads readiness markers from stdout. */
import * as path from "node:path";
import * as vscode from "vscode";
import type { ExtensionTestApi } from "../../extension";
import type { JsonTreeNode } from "../../jsonTree";

/**
 * Sets up a screenshot-ready scene in a real VS Code window, then waits until
 * the window is closed. Started by `npm run demo`; not part of the test suite.
 */
export async function run(): Promise<void> {
  const extension = vscode.extensions.all.find((candidate) => candidate.packageJSON.name === "nested-json-tree");
  if (!extension) throw new Error("The development extension is not loaded.");
  const api = (await extension.activate()) as ExtensionTestApi;

  // A clean, default-looking window. These settings live in the test profile only.
  const settings = vscode.workspace.getConfiguration();
  for (const [key, value] of Object.entries({
    "workbench.colorTheme": "Default Dark Modern",
    "editor.minimap.enabled": false,
    "breadcrumbs.enabled": false,
    "workbench.startupEditor": "none",
    "editor.renderLineHighlight": "none",
  })) {
    await settings.update(key, value, vscode.ConfigurationTarget.Global);
  }
  // Re-apply the theme: startup may reuse cached colors from another theme.
  await settings.update("workbench.colorTheme", "Default Dark+", vscode.ConfigurationTarget.Global);
  await settings.update("workbench.colorTheme", "Default Dark Modern", vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand("workbench.action.closeSidebar");
  await vscode.commands.executeCommand("workbench.action.closePanel");
  const scene = process.env.DEMO_SCENE ?? "jsonl";
  // "search" uses the same record as "jsonl"; "menu" uses a record whose string is still encoded.
  const line = scene === "menu" ? 3 : 1;

  const logUri = vscode.Uri.file(path.resolve(__dirname, "../../../examples/demo.log"));
  const document = await vscode.workspace.openTextDocument(logUri);
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  editor.selection = new vscode.Selection(line, 0, line, 0);
  await vscode.commands.executeCommand("nestedJsonTree.openCurrentLine");

  let panel = api.panels().at(-1);
  for (let attempt = 0; panel === undefined && attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    panel = api.panels().at(-1);
  }
  if (panel === undefined) throw new Error("The Tree View did not open.");
  const child = (node: JsonTreeNode, key: string): JsonTreeNode | undefined =>
    node.children?.find((candidate) => candidate.key === key)?.value;
  const body = child(panel.tree, "body");
  if (body && scene !== "menu") {
    await panel.runNodeAction("expandDecoded", body.id);
    const trace = body.decoded && child(body.decoded.root, "trace");
    if (trace) await panel.runNodeAction("expandDecoded", trace.id);
  }
  await panel.postFromWebview({ type: "setFollowCursor", enabled: true });

  // Put the cursor on a key so the tree highlights the node under it.
  const text = document.lineAt(line).text;
  const key = text.indexOf(scene === "menu" ? '"status"' : '"orderId"') + 2;
  await vscode.window.showTextDocument(document, { viewColumn: editor.viewColumn, preview: false });
  vscode.window.activeTextEditor!.selection = new vscode.Selection(line, key, line, key);
  vscode.window.activeTextEditor!.revealRange(new vscode.Range(line, 0, line, 0));
  // Startup notifications arrive late; keep clearing them while the UI settles.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await vscode.commands.executeCommand("notifications.clearAll");
  }
  // Scenes driven by keystrokes start with the Tree View focused.
  if (scene !== "jsonl") await vscode.commands.executeCommand("workbench.action.focusSecondEditorGroup");
  console.log(`DEMO_WEBVIEWS_READY ${api.readyWebviewCount()}`);
  console.log(`DEMO_THEME ${JSON.stringify(vscode.workspace.getConfiguration("workbench").inspect("colorTheme"))} kind=${vscode.window.activeColorTheme.kind}`);
  console.log("DEMO_SCENE_READY");
  await new Promise(() => {});
}

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

  const logUri = vscode.Uri.file(path.resolve(__dirname, "../../../examples/demo.log"));
  const document = await vscode.workspace.openTextDocument(logUri);
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  editor.selection = new vscode.Selection(1, 0, 1, 0);
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
  if (body) {
    await panel.runNodeAction("expandDecoded", body.id);
    const trace = body.decoded && child(body.decoded.root, "trace");
    if (trace) await panel.runNodeAction("expandDecoded", trace.id);
  }
  await panel.postFromWebview({ type: "setFollowCursor", enabled: true });

  // Put the cursor on a key so the tree highlights the node under it.
  const line = document.lineAt(1).text;
  const key = line.indexOf('"orderId"') + 2;
  await vscode.window.showTextDocument(document, { viewColumn: editor.viewColumn, preview: false });
  vscode.window.activeTextEditor!.selection = new vscode.Selection(1, key, 1, key);

  void vscode.window.showInformationMessage("Demo scene ready. Close this window when you are done.");
  await new Promise(() => {});
}

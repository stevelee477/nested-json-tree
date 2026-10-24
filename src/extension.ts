import * as path from "node:path";
import * as vscode from "vscode";
import {
  JsonCandidate,
  JsonProcessingLimitError,
  assertInputSize,
  candidatePreview,
  parseJsonCandidates,
} from "./parser";
import { describeLimitError, getParseOptions, reportUnexpectedError } from "./settings";
import {
  DocumentSource,
  JsonTreePanel,
  JsonlSourceContext,
  PanelServices,
  PanelTestHandle,
  getPanelTestHandles,
  getReadyWebviewCount,
} from "./treePanel";

let services: PanelServices;

/** Returned from activate() for integration tests; not a supported public API. */
export interface ExtensionTestApi {
  readyWebviewCount(): number;
  panels(): PanelTestHandle[];
}

export function activate(context: vscode.ExtensionContext): ExtensionTestApi {
  services = { extensionUri: context.extensionUri, pickCandidate };
  const register = (command: string, action: string, run: () => Promise<void>): vscode.Disposable =>
    vscode.commands.registerCommand(command, () =>
      run().catch((error: unknown) => reportUnexpectedError(action, error)));
  context.subscriptions.push(
    register("nestedJsonTree.openDocument", vscode.l10n.t("Open Document as Tree"), openDocument),
    register("nestedJsonTree.openCurrentLine", vscode.l10n.t("Open Current Line as Tree"), openCurrentLine),
    register("nestedJsonTree.openSelection", vscode.l10n.t("Open Selection as Tree"), openSelection),
    register("nestedJsonTree.openClipboard", vscode.l10n.t("Open Clipboard as Tree"), openClipboard),
  );
  return { readyWebviewCount: getReadyWebviewCount, panels: getPanelTestHandles };
}

export function deactivate(): void {}

async function openDocument(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage(vscode.l10n.t("Open a JSON or text document first."));
    return;
  }

  const document = editor.document;
  const text = document.getText();
  if (!checkSize(text)) return;
  await parseAndOpen(text, vscode.l10n.t("JSON Tree · {0}", documentName(document)), vscode.l10n.t("the document"), {
    source: documentSource(document, "document", 0),
  });
}

async function openCurrentLine(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage(vscode.l10n.t("Open a JSONL or text document first."));
    return;
  }

  const lineNumber = editor.selection.active.line;
  const text = editor.document.lineAt(lineNumber).text;
  if (!checkSize(text)) return;
  const sourceName = documentName(editor.document);
  await parseAndOpen(
    text,
    vscode.l10n.t("JSON Tree · {0}:{1}", sourceName, lineNumber + 1),
    vscode.l10n.t("line {0}", lineNumber + 1),
    {
      jsonlSource: {
        uri: editor.document.uri,
        sourceName,
        lineNumber,
        lineCount: editor.document.lineCount,
        followCursor: false,
      },
    },
  );
}

/** Opens the first non-empty selection, keeping its document offset for source links. */
async function openSelection(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const selection = editor?.selections.find((candidate) => !candidate.isEmpty);
  if (!editor || !selection) {
    void vscode.window.showInformationMessage(vscode.l10n.t("Select the text that contains JSON first."));
    return;
  }

  const document = editor.document;
  const text = document.getText(selection);
  if (!checkSize(text)) return;
  const sourceName = documentName(document);
  const lines = selection.start.line === selection.end.line
    ? String(selection.start.line + 1)
    : `${selection.start.line + 1}–${selection.end.line + 1}`;
  await parseAndOpen(text, vscode.l10n.t("JSON Tree · {0}:{1}", sourceName, lines), vscode.l10n.t("the selection"), {
    source: documentSource(document, "selection", document.offsetAt(selection.start)),
  });
}

async function openClipboard(): Promise<void> {
  const text = await vscode.env.clipboard.readText();
  if (text.trim().length === 0) {
    void vscode.window.showInformationMessage(vscode.l10n.t("The clipboard is empty."));
    return;
  }
  if (!checkSize(text)) return;
  await parseAndOpen(text, vscode.l10n.t("JSON Tree · Clipboard"), vscode.l10n.t("the clipboard"), {});
}

function documentSource(
  document: vscode.TextDocument,
  scope: DocumentSource["scope"],
  baseOffset: number,
): DocumentSource {
  return { uri: document.uri, scope, baseOffset, version: document.version };
}

async function parseAndOpen(
  text: string,
  title: string,
  place: string,
  link: { source?: DocumentSource; jsonlSource?: JsonlSourceContext },
): Promise<void> {
  let candidates: JsonCandidate[];
  try {
    candidates = parseJsonCandidates(text, getParseOptions());
  } catch (error) {
    if (error instanceof JsonProcessingLimitError) {
      void vscode.window.showErrorMessage(describeLimitError(error));
      return;
    }
    throw error;
  }
  if (candidates.length === 0) {
    void vscode.window.showErrorMessage(vscode.l10n.t("No valid JSON object, array, or value was found in {0}.", place));
    return;
  }
  const selected = await pickCandidate(candidates, place);
  if (selected === undefined) return;
  JsonTreePanel.create(services, {
    candidate: selected,
    title,
    pathLabel: link.jsonlSource === undefined ? "$" : vscode.l10n.t("$ · line {0}", link.jsonlSource.lineNumber + 1),
    viewColumn: vscode.ViewColumn.Beside,
    source: link.source,
    jsonlSource: link.jsonlSource,
  });
}

async function pickCandidate(
  candidates: JsonCandidate[],
  place: string,
): Promise<JsonCandidate | undefined> {
  if (candidates.length === 1) return candidates[0];

  const items = candidates.map((candidate, index) => ({
    label: `$(json) ${vscode.l10n.t("JSON candidate {0}", index + 1)}`,
    description: vscode.l10n.t("characters {0}–{1}", candidate.start + 1, candidate.end) +
      (candidate.recovery ? ` · ${vscode.l10n.t("recovered subset")}` : ""),
    detail: candidatePreview(candidate),
    candidate,
  }));
  const selected = await vscode.window.showQuickPick(items, {
    title: vscode.l10n.t("Choose JSON from {0}", place),
    placeHolder: vscode.l10n.t("{0} JSON candidates found", candidates.length),
    matchOnDetail: true,
  });
  return selected?.candidate;
}

function checkSize(text: string): boolean {
  try {
    assertInputSize(text);
    return true;
  } catch (error) {
    if (!(error instanceof JsonProcessingLimitError)) throw error;
    void vscode.window.showErrorMessage(describeLimitError(error));
    return false;
  }
}

function documentName(document: vscode.TextDocument): string {
  return document.isUntitled ? vscode.l10n.t("Untitled") : path.basename(document.uri.fsPath);
}

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
import { JsonTreePanel, JsonlSourceContext, PanelServices, getReadyWebviewCount } from "./treePanel";

let services: PanelServices;

/** Returned from activate() for integration tests; not a supported public API. */
export interface ExtensionTestApi {
  readyWebviewCount(): number;
}

export function activate(context: vscode.ExtensionContext): ExtensionTestApi {
  services = { extensionUri: context.extensionUri, pickCandidate };
  context.subscriptions.push(
    vscode.commands.registerCommand("nestedJsonTree.openDocument", () =>
      openDocument().catch((error: unknown) => reportUnexpectedError("Open Document as Tree", error))),
    vscode.commands.registerCommand("nestedJsonTree.openCurrentLine", () =>
      openCurrentLine().catch((error: unknown) => reportUnexpectedError("Open Current Line as Tree", error))),
  );
  return { readyWebviewCount: getReadyWebviewCount };
}

export function deactivate(): void {}

async function openDocument(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage("Open a JSON or text document first.");
    return;
  }

  const text = editor.document.getText();
  if (!checkSize(text)) return;
  const sourceName = documentName(editor.document);
  await parseAndOpen(text, `JSON Tree · ${sourceName}`, "document");
}

async function openCurrentLine(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage("Open a JSONL or text document first.");
    return;
  }

  const lineNumber = editor.selection.active.line;
  const text = editor.document.lineAt(lineNumber).text;
  if (!checkSize(text)) return;
  const sourceName = documentName(editor.document);
  await parseAndOpen(
    text,
    `JSON Tree · ${sourceName}:${lineNumber + 1}`,
    `line ${lineNumber + 1}`,
    {
      uri: editor.document.uri,
      sourceName,
      lineNumber,
      lineCount: editor.document.lineCount,
      followCursor: false,
    },
  );
}

async function parseAndOpen(
  text: string,
  title: string,
  place: string,
  jsonlSource?: JsonlSourceContext,
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
  await openCandidates(candidates, title, place, jsonlSource);
}

async function openCandidates(
  candidates: JsonCandidate[],
  title: string,
  place: string,
  jsonlSource?: JsonlSourceContext,
): Promise<void> {
  if (candidates.length === 0) {
    void vscode.window.showErrorMessage(`No valid JSON object, array, or value was found in the ${place}.`);
    return;
  }
  const selected = await pickCandidate(candidates, place);
  if (selected !== undefined) {
    JsonTreePanel.create(services, {
      candidate: selected,
      title,
      pathLabel: jsonlSource === undefined ? "$" : `$ · line ${jsonlSource.lineNumber + 1}`,
      viewColumn: vscode.ViewColumn.Beside,
      jsonlSource,
    });
  }
}

async function pickCandidate(
  candidates: JsonCandidate[],
  place: string,
): Promise<JsonCandidate | undefined> {
  if (candidates.length === 1) return candidates[0];

  const items = candidates.map((candidate, index) => ({
    label: `$(json) JSON candidate ${index + 1}`,
    description: `characters ${candidate.start + 1}–${candidate.end}${candidate.recovery ? " · recovered subset" : ""}`,
    detail: candidatePreview(candidate),
    candidate,
  }));
  const selected = await vscode.window.showQuickPick(items, {
    title: `Choose JSON from ${place}`,
    placeHolder: `${candidates.length} JSON candidates found`,
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
    void vscode.window.showErrorMessage(error.message);
    return false;
  }
}

function documentName(document: vscode.TextDocument): string {
  return document.isUntitled ? "Untitled" : path.basename(document.uri.fsPath);
}

import * as path from "node:path";
import * as vscode from "vscode";
import {
  InputTooLargeError,
  JsonCandidate,
  JsonValue,
  assertInputSize,
  candidatePreview,
  parseJsonCandidates,
} from "./parser";
import { JsonTreePanel } from "./treePanel";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("nestedJsonTree.openDocument", () => void openDocument()),
    vscode.commands.registerCommand("nestedJsonTree.openCurrentLine", () => void openCurrentLine()),
  );
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
  await openCandidates(parseJsonCandidates(text), `JSON Tree · ${sourceName}`, "document");
}

async function openCurrentLine(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage("Open a JSONL or text document first.");
    return;
  }

  const documentText = editor.document.getText();
  if (!checkSize(documentText)) return;
  const lineNumber = editor.selection.active.line;
  const text = editor.document.lineAt(lineNumber).text;
  const sourceName = documentName(editor.document);
  await openCandidates(
    parseJsonCandidates(text),
    `JSON Tree · ${sourceName}:${lineNumber + 1}`,
    `line ${lineNumber + 1}`,
  );
}

async function openCandidates(candidates: JsonCandidate[], title: string, place: string): Promise<void> {
  if (candidates.length === 0) {
    void vscode.window.showErrorMessage(`No valid JSON object, array, or value was found in the ${place}.`);
    return;
  }
  const selected = await pickCandidate(candidates, place);
  if (selected !== undefined) {
    JsonTreePanel.create(selected, title, pickCandidate);
  }
}

async function pickCandidate(candidates: JsonCandidate[], place: string): Promise<JsonValue | undefined> {
  if (candidates.length === 1) return candidates[0].value;

  const items = candidates.map((candidate, index) => ({
    label: `$(json) JSON candidate ${index + 1}`,
    description: `characters ${candidate.start + 1}–${candidate.end}`,
    detail: candidatePreview(candidate),
    candidate,
  }));
  const selected = await vscode.window.showQuickPick(items, {
    title: `Choose JSON from ${place}`,
    placeHolder: `${candidates.length} valid JSON values found`,
    matchOnDetail: true,
  });
  return selected?.candidate.value;
}

function checkSize(text: string): boolean {
  try {
    assertInputSize(text);
    return true;
  } catch (error) {
    const message = error instanceof InputTooLargeError ? error.message : String(error);
    void vscode.window.showErrorMessage(message);
    return false;
  }
}

function documentName(document: vscode.TextDocument): string {
  return document.isUntitled ? "Untitled" : path.basename(document.uri.fsPath);
}

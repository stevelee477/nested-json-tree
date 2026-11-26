import * as path from "node:path";
import * as vscode from "vscode";
import { disposeParseWorker, parseJsonCandidatesAsync } from "./asyncParser";
import { findJsonlRecord } from "./jsonlNavigator";
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
  PanelInit,
  PanelServices,
  PanelTestHandle,
  VIEW_TYPE,
  getPanelTestHandles,
  getReadyWebviewCount,
} from "./treePanel";

let services: PanelServices;

/** Returned from activate() for integration tests; not a supported public API. */
export interface ExtensionTestApi {
  readyWebviewCount(): number;
  panels(): PanelTestHandle[];
}

/** Source metadata persisted in Webview state so panels survive window reloads. */
export interface SerializedPanelSource {
  kind: "document" | "jsonl";
  uri: string;
  /** Zero-based JSONL line number when `kind === "jsonl"`. */
  lineNumber?: number;
}

type RevivableJsonTreePanel = typeof JsonTreePanel & {
  revive?: (panel: vscode.WebviewPanel, services: PanelServices, init: PanelInit) => JsonTreePanel;
};

export function activate(context: vscode.ExtensionContext): ExtensionTestApi {
  services = { extensionUri: context.extensionUri, pickCandidate };
  const register = <Args extends unknown[]>(
    command: string,
    action: string,
    run: (...args: Args) => Promise<void>,
  ): vscode.Disposable =>
    vscode.commands.registerCommand(command, (...args: Args) =>
      run(...args).catch((error: unknown) => reportUnexpectedError(action, error)));
  context.subscriptions.push(
    register("nestedJsonTree.openDocument", vscode.l10n.t("Open Document as Tree"), openDocument),
    register("nestedJsonTree.openCurrentLine", vscode.l10n.t("Open Current Line as Tree"), openCurrentLine),
    register("nestedJsonTree.openSelection", vscode.l10n.t("Open Selection as Tree"), openSelection),
    register("nestedJsonTree.openClipboard", vscode.l10n.t("Open Clipboard as Tree"), openClipboard),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      deserializeWebviewPanel: (panel: vscode.WebviewPanel, state: unknown) =>
        restoreWebviewPanel(panel, state).catch((error: unknown) => {
          panel.dispose();
          reportUnexpectedError(vscode.l10n.t("Tree View action"), error);
        }),
    }),
  );
  return { readyWebviewCount: getReadyWebviewCount, panels: getPanelTestHandles };
}

export function deactivate(): Promise<void> {
  return disposeParseWorker();
}

export function extractSerializedPanelSource(state: unknown): SerializedPanelSource | undefined {
  if (!isPlainRecord(state)) return undefined;
  for (const candidate of [state, state.source, state.panelSource, state.serializedSource]) {
    if (isSerializedPanelSource(candidate)) return candidate;
  }
  return undefined;
}

async function openDocument(uri?: unknown): Promise<void> {
  if (isUri(uri)) {
    const document = await vscode.workspace.openTextDocument(uri);
    if (isJsonlUri(document.uri)) {
      await openFirstJsonlRecord(document);
      return;
    }
    await openDocumentTree(document);
    return;
  }

  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage(vscode.l10n.t("Open a JSON or text document first."));
    return;
  }

  await openDocumentTree(editor.document);
}

async function openDocumentTree(document: vscode.TextDocument): Promise<void> {
  const text = document.getText();
  if (!checkSize(text)) return;
  await parseAndOpen(text, vscode.l10n.t("JSON Tree · {0}", documentName(document)), vscode.l10n.t("the document"), {
    source: documentSource(document, "document", 0),
  });
}

async function openFirstJsonlRecord(document: vscode.TextDocument): Promise<void> {
  const parseOptions = getParseOptions();
  const result = await findJsonlRecord(
    {
      lineCount: document.lineCount,
      lineAt: (lineNumber) => document.lineAt(lineNumber).text,
    },
    0,
    1,
    {
      parseLine: (text) => {
        assertInputSize(text);
        return parseJsonCandidates(text, parseOptions);
      },
    },
  );
  if (result.status !== "found") {
    void vscode.window.showErrorMessage(
      vscode.l10n.t("No valid JSON object, array, or value was found in {0}.", vscode.l10n.t("the document")),
    );
    return;
  }
  const { lineNumber, candidates } = result.record;
  const place = vscode.l10n.t("line {0}", lineNumber + 1);
  const selected = await pickCandidate(candidates, place);
  if (selected === undefined) return;
  const sourceName = documentName(document);
  JsonTreePanel.create(services, {
    candidate: selected,
    title: vscode.l10n.t("JSON Tree · {0}:{1}", sourceName, lineNumber + 1),
    pathLabel: vscode.l10n.t("$ · line {0}", lineNumber + 1),
    viewColumn: vscode.ViewColumn.Beside,
    jsonlSource: {
      uri: document.uri,
      sourceName,
      lineNumber,
      lineCount: document.lineCount,
      followCursor: false,
    },
  });
}

async function restoreWebviewPanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
  panel.webview.options = {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(services.extensionUri, "out", "webview")],
  };
  const descriptor = extractSerializedPanelSource(state);
  if (descriptor === undefined) {
    panel.dispose();
    return;
  }

  let uri: vscode.Uri;
  try {
    uri = vscode.Uri.parse(descriptor.uri, true);
  } catch {
    panel.dispose();
    return;
  }

  let panelDisposed = false;
  const disposeSub = panel.onDidDispose(() => {
    panelDisposed = true;
  });
  try {
    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(uri);
    } catch {
      if (!panelDisposed) panel.dispose();
      return;
    }
    if (panelDisposed) return;

    const init = descriptor.kind === "jsonl"
      ? await buildRestoredJsonlInit(document, descriptor.lineNumber, panel.viewColumn)
      : await buildRestoredDocumentInit(document, panel.viewColumn);
    if (panelDisposed) return;
    if (init === undefined) {
      panel.dispose();
      return;
    }

    const revivable = JsonTreePanel as RevivableJsonTreePanel;
    if (typeof revivable.revive === "function") {
      panel.title = init.title;
      revivable.revive(panel, services, init);
    } else {
      const viewColumn = panel.viewColumn ?? vscode.ViewColumn.Active;
      panel.dispose();
      JsonTreePanel.create(services, { ...init, viewColumn });
    }
  } finally {
    disposeSub.dispose();
  }
}

async function buildRestoredDocumentInit(
  document: vscode.TextDocument,
  viewColumn: vscode.ViewColumn | undefined,
): Promise<PanelInit | undefined> {
  const text = document.getText();
  let candidates: JsonCandidate[];
  try {
    assertInputSize(text);
    candidates = await parseJsonCandidatesAsync(text, getParseOptions());
  } catch (error) {
    if (error instanceof JsonProcessingLimitError) return undefined;
    throw error;
  }
  if (candidates.length === 0) return undefined;
  return {
    candidate: candidates[0],
    title: vscode.l10n.t("JSON Tree · {0}", documentName(document)),
    pathLabel: "$",
    viewColumn,
    source: documentSource(document, "document", 0),
  };
}

async function buildRestoredJsonlInit(
  document: vscode.TextDocument,
  savedLineNumber: number | undefined,
  viewColumn: vscode.ViewColumn | undefined,
): Promise<PanelInit | undefined> {
  if (document.lineCount === 0) return undefined;
  const requestedLine = typeof savedLineNumber === "number" && Number.isFinite(savedLineNumber)
    ? Math.max(0, Math.trunc(savedLineNumber))
    : 0;
  const startLine = Math.min(requestedLine, document.lineCount - 1);
  const parseOptions = getParseOptions();
  const source = {
    lineCount: document.lineCount,
    lineAt: (line: number) => document.lineAt(line).text,
  };
  const parseLine = (text: string): JsonCandidate[] => {
    assertInputSize(text);
    return parseJsonCandidates(text, parseOptions);
  };
  let result = await findJsonlRecord(source, startLine, 1, { parseLine });
  if (result.status === "not-found" && startLine > 0) {
    result = await findJsonlRecord(source, startLine - 1, -1, { parseLine });
  }
  if (result.status !== "found") return undefined;

  const lineNumber = result.record.lineNumber;
  const sourceName = documentName(document);
  return {
    candidate: result.record.candidates[0],
    title: vscode.l10n.t("JSON Tree · {0}:{1}", sourceName, lineNumber + 1),
    pathLabel: vscode.l10n.t("$ · line {0}", lineNumber + 1),
    viewColumn,
    jsonlSource: {
      uri: document.uri,
      sourceName,
      lineNumber,
      lineCount: document.lineCount,
      followCursor: false,
    },
  };
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
    source: {
      ...documentSource(document, "selection", document.offsetAt(selection.start)),
      endOffset: document.offsetAt(selection.end),
    },
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
    candidates = await parseJsonCandidatesAsync(text, getParseOptions());
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
  return document.isUntitled
    ? vscode.l10n.t("Untitled")
    : path.basename(document.uri.fsPath || document.uri.path);
}

function isUri(value: unknown): value is vscode.Uri {
  return value instanceof vscode.Uri || (
    value !== null &&
    typeof value === "object" &&
    typeof (value as vscode.Uri).scheme === "string" &&
    typeof (value as vscode.Uri).fsPath === "string" &&
    typeof (value as vscode.Uri).toString === "function"
  );
}

function isJsonlUri(uri: vscode.Uri): boolean {
  const ext = path.extname(uri.fsPath || uri.path).toLowerCase();
  return ext === ".jsonl" || ext === ".ndjson";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSerializedPanelSource(value: unknown): value is SerializedPanelSource {
  if (!isPlainRecord(value)) return false;
  if (value.kind !== "document" && value.kind !== "jsonl") return false;
  if (typeof value.uri !== "string" || value.uri.length === 0) return false;
  if (value.lineNumber !== undefined && (typeof value.lineNumber !== "number" || !Number.isFinite(value.lineNumber))) {
    return false;
  }
  return true;
}

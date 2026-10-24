import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import {
  JsonCandidate,
  JsonProcessingLimitError,
  assertInputSize,
  parseJsonCandidates,
  parseNestedJsonCandidates,
} from "./parser";
import {
  JsonTreeIndex,
  JsonTreeNode,
  JsonTreeNodeContext,
  JsonTreeOutputTooLargeError,
  assertTransferTextSize,
  buildJsonTreeContextIndex,
  createJsonTreeWebviewModel,
  isValidJsonTreeNodeId,
  materializeJsonTreePath,
  stringifyJsonTreeForTransfer,
} from "./jsonTree";
import {
  formatJqPathForTransfer,
  formatJsonPathForDisplay,
  formatJsonPathForTransfer,
} from "./paths";
import { NODE_ACTIONS, NodeAction, RenderMessage } from "./protocol";
import {
  describeLimitError,
  getAutoExpandMaxNodes,
  getParseOptions,
  reportUnexpectedError,
} from "./settings";
import {
  MAX_EXPAND_ALL_NODES,
  isTreeNodeCountWithinLimit,
  shouldAutoExpandTree,
} from "./treeOptions";
import { findJsonlRecord } from "./jsonlNavigator";

export const VIEW_TYPE = "nestedJsonTree.viewer";

/** Webviews whose bundled script has started; exposed to integration tests. */
let readyWebviewCount = 0;

export function getReadyWebviewCount(): number {
  return readyWebviewCount;
}

export interface JsonlSourceContext {
  uri: vscode.Uri;
  sourceName: string;
  lineNumber: number;
  lineCount: number;
  followCursor?: boolean;
}

export type CandidatePicker = (
  candidates: JsonCandidate[],
  place: string,
) => Promise<JsonCandidate | undefined>;

/** Long-lived collaborators shared by every panel. */
export interface PanelServices {
  extensionUri: vscode.Uri;
  pickCandidate: CandidatePicker;
}

export interface PanelInit {
  candidate: JsonCandidate;
  title: string;
  pathLabel?: string;
  viewColumn?: vscode.ViewColumn;
  jsonlSource?: JsonlSourceContext;
}

export class JsonTreePanel {
  private index: JsonTreeIndex;
  /** Identifies the displayed value so the Webview restores only matching view state. */
  private renderVersion = 0;
  private navigationGeneration = 0;
  private followCursorTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly jsonlSource?: Required<JsonlSourceContext>;
  private candidate: JsonCandidate;
  private title: string;
  private pathLabel: string;

  static create(services: PanelServices, init: PanelInit): JsonTreePanel {
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      init.title,
      init.viewColumn ?? vscode.ViewColumn.Beside,
      // No retainContextWhenHidden: the Webview persists its own view state
      // and is rebuilt from the Host-side tree when it becomes visible again.
      { enableScripts: true, localResourceRoots: [webviewRoot(services.extensionUri)] },
    );
    return new JsonTreePanel(panel, services, init);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly services: PanelServices,
    init: PanelInit,
  ) {
    this.candidate = init.candidate;
    this.title = init.title;
    this.pathLabel = init.pathLabel ?? "$";
    this.index = buildJsonTreeContextIndex(init.candidate.tree);
    this.disposables.push(
      panel.webview.onDidReceiveMessage((message: unknown) => {
        this.handleMessage(message).catch((error: unknown) => {
          reportUnexpectedError("Tree View action", error);
        });
      }),
      panel.onDidDispose(() => this.dispose()),
    );
    if (init.jsonlSource !== undefined) {
      this.jsonlSource = { ...init.jsonlSource, followCursor: init.jsonlSource.followCursor ?? false };
      this.disposables.push(
        vscode.window.onDidChangeTextEditorSelection((event) => this.handleSourceSelection(event)),
      );
    }
    panel.webview.html = this.getHtml(panel.webview);
  }

  private dispose(): void {
    this.navigationGeneration += 1;
    if (this.followCursorTimer !== undefined) clearTimeout(this.followCursorTimer);
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }

  private async postRender(status = ""): Promise<void> {
    const tree = this.candidate.tree;
    // Built per render rather than retained: the bounded copy is only needed
    // while it is being transferred to the Webview.
    const model = createJsonTreeWebviewModel(tree);
    const message: RenderMessage = {
      type: "render",
      renderKey: this.renderVersion,
      root: model.root,
      title: this.title,
      pathLabel: this.pathLabel,
      truncatedFieldCount: model.truncatedFieldCount,
      recovery: this.candidate.recovery,
      autoExpand: shouldAutoExpandTree(tree, getAutoExpandMaxNodes()),
      canExpandAll: isTreeNodeCountWithinLimit(tree, MAX_EXPAND_ALL_NODES),
      expandAllLimit: MAX_EXPAND_ALL_NODES,
      jsonl: this.jsonlSource === undefined
        ? undefined
        : {
            lineNumber: this.jsonlSource.lineNumber + 1,
            lineCount: this.jsonlSource.lineCount,
            followCursor: this.jsonlSource.followCursor,
            status,
          },
    };
    await this.panel.webview.postMessage(message);
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!isPanelMessage(message)) return;

    if (message.type === "ready") {
      readyWebviewCount += 1;
      await this.postRender();
      return;
    }

    if (await this.handleJsonlMessage(message)) return;

    if (!NODE_ACTIONS.has(message.type) || !isValidJsonTreeNodeId(message.nodeId)) return;
    const context = this.index.get(message.nodeId);
    if (context === undefined) return;
    await this.runNodeAction(message.type as NodeAction, context);
  }

  private async runNodeAction(action: NodeAction, context: JsonTreeNodeContext): Promise<void> {
    const node = context.node;
    switch (action) {
      case "copyKey":
        if (context.parent !== undefined && context.key !== undefined) {
          await copyText(String(context.key), "key");
        }
        return;
      case "copyRawKey":
        if (context.rawKey !== undefined) await copyText(context.rawKey, "raw key");
        return;
      case "copyJsonPath":
      case "copyJqPath":
        await copyPath(action, context);
        return;
      case "copyValue":
        await copyValue(node);
        return;
      case "copyRawString":
        if (node.type === "string") await copyText(node.raw as string, "value");
        return;
      case "copyDecodedString":
        if (node.type === "string") await copyText(node.value as string, "value");
        return;
      case "openDecodedValue":
        if (node.type === "string") await openDecodedValue(node);
        return;
      case "openNested":
      case "openParsedJson":
        if (node.type === "string") await this.openNestedString(action, context);
        return;
    }
  }

  private async openNestedString(
    action: "openNested" | "openParsedJson",
    context: JsonTreeNodeContext,
  ): Promise<void> {
    const displayPath = formatJsonPathForDisplay(materializeJsonTreePath(context));
    let candidates: JsonCandidate[];
    try {
      candidates = parseNestedJsonCandidates(context.node.value as string, getParseOptions());
    } catch (error) {
      if (error instanceof JsonProcessingLimitError) {
        void vscode.window.showErrorMessage(`Cannot open nested JSON at ${displayPath}: ${describeLimitError(error)}`);
        return;
      }
      throw error;
    }
    if (candidates.length === 0) {
      void vscode.window.showWarningMessage(`The string at ${displayPath} does not contain valid JSON.`);
      return;
    }

    const selected = await this.services.pickCandidate(candidates, displayPath);
    if (selected === undefined) return;

    if (action === "openParsedJson") {
      await openParsedJson(selected);
      return;
    }
    JsonTreePanel.create(this.services, {
      candidate: selected,
      title: `Nested JSON · ${displayPath}`,
      pathLabel: displayPath,
      viewColumn: this.panel.viewColumn ?? vscode.ViewColumn.Active,
    });
  }

  private async handleJsonlMessage(message: PanelMessage): Promise<boolean> {
    const source = this.jsonlSource;
    if (source === undefined) return false;
    switch (message.type) {
      case "setFollowCursor":
        source.followCursor = message.enabled === true;
        await this.postJsonlState(source.followCursor ? "Following source cursor" : "Follow cursor off");
        return true;
      case "revealSource":
        await this.revealSourceLine();
        return true;
      case "previousJsonl":
        await this.navigateJsonl(source.lineNumber - 1, -1);
        return true;
      case "nextJsonl":
        await this.navigateJsonl(source.lineNumber + 1, 1);
        return true;
      case "goToJsonlLine":
        if (typeof message.lineNumber !== "number" || !Number.isInteger(message.lineNumber)) return true;
        await this.navigateJsonl(Math.max(0, message.lineNumber - 1), 1);
        return true;
      default:
        return false;
    }
  }

  private async navigateJsonl(startLine: number, direction: -1 | 1): Promise<void> {
    const source = this.jsonlSource;
    if (source === undefined) return;
    const generation = ++this.navigationGeneration;
    const isCurrent = (): boolean => generation === this.navigationGeneration;
    await this.postJsonlState("Scanning…", true);
    // Every exit path must clear the busy state, including a source document
    // that was deleted or renamed after the panel opened.
    let finalStatus: string | undefined = "Could not read the source document";
    try {
      const document = await vscode.workspace.openTextDocument(source.uri);
      source.lineCount = document.lineCount;
      const parseOptions = getParseOptions();
      const result = await findJsonlRecord(
        {
          lineCount: document.lineCount,
          lineAt: (lineNumber) => document.lineAt(lineNumber).text,
        },
        startLine,
        direction,
        {
          isCancelled: () => !isCurrent(),
          parseLine: (text) => {
            assertInputSize(text);
            return parseJsonCandidates(text, parseOptions);
          },
        },
      );
      if (!isCurrent() || result.status === "cancelled") return;
      if (result.status === "not-found") {
        finalStatus = direction > 0 ? "No later valid JSON line" : "No earlier valid JSON line";
        return;
      }
      finalStatus = "";
      const selected = await this.services.pickCandidate(result.record.candidates, `line ${result.record.lineNumber + 1}`);
      if (!isCurrent() || selected === undefined) return;
      const skipped = result.record.skippedLines;
      this.updateJsonlCandidate(selected, result.record.lineNumber);
      finalStatus = undefined;
      await this.postRender(
        skipped === 0
          ? ""
          : `Skipped ${skipped.toLocaleString()} invalid or empty line${skipped === 1 ? "" : "s"}`,
      );
    } finally {
      if (finalStatus !== undefined && isCurrent()) await this.postJsonlState(finalStatus);
    }
  }

  private updateJsonlCandidate(candidate: JsonCandidate, lineNumber: number): void {
    const source = this.jsonlSource;
    if (source === undefined) return;
    source.lineNumber = lineNumber;
    this.candidate = candidate;
    this.index = buildJsonTreeContextIndex(candidate.tree);
    this.renderVersion += 1;
    this.title = `JSON Tree · ${source.sourceName}:${lineNumber + 1}`;
    this.pathLabel = `$ · line ${lineNumber + 1}`;
    this.panel.title = this.title;
  }

  private async postJsonlState(status: string, busy = false): Promise<void> {
    const source = this.jsonlSource;
    if (source === undefined) return;
    await this.panel.webview.postMessage({
      type: "jsonlState",
      lineNumber: source.lineNumber + 1,
      lineCount: source.lineCount,
      followCursor: source.followCursor,
      status,
      busy,
    });
  }

  private handleSourceSelection(event: vscode.TextEditorSelectionChangeEvent): void {
    const source = this.jsonlSource;
    if (
      source === undefined ||
      !source.followCursor ||
      event.textEditor.document.uri.toString() !== source.uri.toString()
    ) return;
    if (this.followCursorTimer !== undefined) clearTimeout(this.followCursorTimer);
    const lineNumber = event.selections[0]?.active.line;
    if (lineNumber === undefined || lineNumber === source.lineNumber) return;
    this.followCursorTimer = setTimeout(() => {
      this.followSourceLine(lineNumber).catch((error: unknown) => reportUnexpectedError("Follow cursor", error));
    }, 150);
  }

  private async followSourceLine(lineNumber: number): Promise<void> {
    const source = this.jsonlSource;
    if (source === undefined || !source.followCursor) return;
    const generation = ++this.navigationGeneration;
    const document = await vscode.workspace.openTextDocument(source.uri);
    source.lineCount = document.lineCount;
    if (lineNumber >= document.lineCount) return;
    let candidates: JsonCandidate[];
    try {
      const text = document.lineAt(lineNumber).text;
      assertInputSize(text);
      candidates = parseJsonCandidates(text, getParseOptions());
    } catch (error) {
      if (error instanceof JsonProcessingLimitError) candidates = [];
      else throw error;
    }
    if (generation !== this.navigationGeneration) return;
    if (candidates.length === 0) {
      await this.postJsonlState(`Line ${lineNumber + 1} has no valid JSON`);
      return;
    }
    // Moving the cursor must never open a picker; Go/Prev/Next still offer one.
    this.updateJsonlCandidate(candidates[0], lineNumber);
    await this.postRender(
      candidates.length === 1
        ? ""
        : `Showing candidate 1 of ${candidates.length.toLocaleString()} · use Go to choose another`,
    );
  }

  private async revealSourceLine(): Promise<void> {
    const source = this.jsonlSource;
    if (source === undefined) return;
    const document = await vscode.workspace.openTextDocument(source.uri);
    source.lineCount = document.lineCount;
    const visible = vscode.window.visibleTextEditors.find(
      (editor) => editor.document.uri.toString() === source.uri.toString(),
    );
    const editor = await vscode.window.showTextDocument(document, {
      preview: false,
      viewColumn: visible?.viewColumn ?? vscode.ViewColumn.Beside,
      preserveFocus: false,
    });
    const line = Math.min(source.lineNumber, Math.max(0, document.lineCount - 1));
    const range = document.lineAt(line).range;
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = createNonce();
    const root = webviewRoot(this.services.extensionUri);
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(root, "main.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(root, "tree.css"));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <header>
    <div class="header-main">
      <span class="header-title" id="title"></span>
      <span class="header-path" id="path"></span>
      <span id="tree-operation-status" aria-live="polite"></span>
      <span class="header-actions">
        <button class="header-button" id="expand-all" type="button" title="Expand every object and array">Expand all</button>
        <button class="header-button" id="collapse-all" type="button" title="Collapse the entire tree">Collapse all</button>
      </span>
    </div>
    <div class="recovery-warning hidden" id="recovery-warning" role="status"></div>
    <div class="jsonl-bar hidden" id="jsonl-bar" aria-label="JSONL navigation">
      <button class="header-button" id="previous-jsonl" type="button" title="Previous valid JSON line">← Prev</button>
      <button class="header-button" id="next-jsonl" type="button" title="Next valid JSON line">Next →</button>
      <label class="jsonl-line-label" for="jsonl-line">Line</label>
      <input id="jsonl-line" type="number" min="1" step="1" inputmode="numeric" aria-label="JSONL line number">
      <span id="jsonl-total"></span>
      <button class="header-button" id="go-jsonl" type="button">Go</button>
      <button class="header-button" id="reveal-source" type="button" title="Reveal this record in the source file">Source</button>
      <label class="follow-label"><input id="follow-cursor" type="checkbox"> Follow cursor</label>
      <span id="jsonl-status" aria-live="polite"></span>
    </div>
    <div class="search-bar" role="search">
      <input id="search-input" type="search" placeholder="Search keys and values…" aria-label="Search JSON keys and values" spellcheck="false" disabled>
      <span id="search-scope-warning" class="hidden" title="Long keys and values are shortened in this view. Search covers the displayed prefix and suffix only; copy and open actions still use the complete host value.">Long values shortened · search is display-only</span>
      <span id="search-count" aria-live="polite"></span>
      <button class="header-button search-button" id="previous-match" type="button" title="Previous match (Shift+Enter)" disabled>↑</button>
      <button class="header-button search-button" id="next-match" type="button" title="Next match (Enter)" disabled>↓</button>
      <button class="header-button search-button" id="clear-search" type="button" title="Clear search (Escape)" disabled>×</button>
    </div>
  </header>
  <main id="tree" role="tree" aria-label="JSON tree"></main>
  <div id="empty-search" class="hidden">No matches</div>
  <div id="menu" class="hidden" role="menu"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

/** Bundled Webview assets; also the only folder the Webview may load from. */
function webviewRoot(extensionUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(extensionUri, "out", "webview");
}

/** Reports output-size limits for one transfer instead of failing the whole action. */
async function guardOutputSize(action: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    if (error instanceof JsonTreeOutputTooLargeError) {
      void vscode.window.showErrorMessage(`Cannot ${action}: ${error.message}`);
      return;
    }
    throw error;
  }
}

function copyText(text: string, label: string): Promise<void> {
  return guardOutputSize(`copy ${label}`, async () => {
    assertTransferTextSize(text);
    await vscode.env.clipboard.writeText(text);
  });
}

function copyPath(action: "copyJsonPath" | "copyJqPath", context: JsonTreeNodeContext): Promise<void> {
  if (context.hasDuplicateKeyInPath) {
    const syntax = action === "copyJsonPath" ? "JSONPath" : "jq path";
    void vscode.window.showWarningMessage(
      `Cannot copy ${syntax}: this path passes through a duplicate object key and is ambiguous.`,
    );
    return Promise.resolve();
  }
  const path = materializeJsonTreePath(context);
  return guardOutputSize("copy path", async () => {
    const text = action === "copyJsonPath" ? formatJsonPathForTransfer(path) : formatJqPathForTransfer(path);
    await vscode.env.clipboard.writeText(text);
  });
}

function copyValue(node: JsonTreeNode): Promise<void> {
  return guardOutputSize("copy value", async () => {
    const serialized = stringifyJsonTreeForTransfer(node);
    await vscode.env.clipboard.writeText(serialized.text);
    if (serialized.compacted) {
      void vscode.window.showInformationMessage(
        "Copied compact JSON because pretty-formatted output would be too large.",
      );
    }
  });
}

function openDecodedValue(node: JsonTreeNode): Promise<void> {
  return guardOutputSize("open decoded string", async () => {
    const text = node.value as string;
    assertTransferTextSize(text);
    const document = await vscode.workspace.openTextDocument({ content: text, language: "plaintext" });
    await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.Beside });
  });
}

function openParsedJson(selected: JsonCandidate): Promise<void> {
  return guardOutputSize("open parsed JSON", async () => {
    const serialized = stringifyJsonTreeForTransfer(selected.tree);
    const document = await vscode.workspace.openTextDocument({ content: serialized.text, language: "json" });
    await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.Beside });
    if (selected.recovery) {
      void vscode.window.showWarningMessage(
        "Opened a recovered JSON subset. Damaged or missing values were omitted; array indices refer to the recovered subset, not the original source.",
      );
    }
    if (serialized.compacted) {
      void vscode.window.showInformationMessage(
        "Opened compact JSON because pretty-formatted output would be too large.",
      );
    }
  });
}

interface PanelMessage {
  type: string;
  nodeId?: unknown;
  lineNumber?: unknown;
  enabled?: unknown;
}

function isPanelMessage(value: unknown): value is PanelMessage {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, "type") &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

function createNonce(): string {
  return randomBytes(16).toString("base64");
}

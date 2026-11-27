import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { parseJsonCandidatesAsync, parseNestedJsonCandidatesAsync } from "./asyncParser";
import {
  JsonCandidate,
  JsonProcessingLimitError,
  MAX_JSON_VALUE_NODES,
  assertInputSize,
  parseJsonCandidates,
} from "./parser";
import { isNonJsonDecodedKind } from "./decodable";
import { decodeInlineString } from "./inlineDecoder";
import {
  JsonTreeDecoded,
  JsonTreeIndex,
  JsonTreeNode,
  JsonTreeNodeContext,
  JsonTreeOutputTooLargeError,
  StructuralPathStep,
  assertTransferTextSize,
  buildJsonTreeContextIndex,
  cachedDetectDecodableKind,
  cloneSubtreeWithFreshIds,
  createJsonTreeWebviewModel,
  isValidJsonTreeNodeId,
  materializeJsonTreePath,
  stringifyJsonTreeForTransfer,
  walkJsonTree,
} from "./jsonTree";
import {
  formatJqPathForTransfer,
  formatJsonPathForDisplay,
  formatJsonPathForTransfer,
  isDecodedPath,
} from "./paths";
import {
  HostToWebviewMessage,
  NODE_ACTIONS,
  NodeAction,
  NodeInspectionMessage,
  PanelSourceDescriptor,
  RenderDiffPayload,
  RenderMessage,
  SourceViewState,
  TableExportFormat,
} from "./protocol";
import { SchemaTarget, generateTypesFromTree } from "./schemaGen";
import {
  describeLimitError,
  getAutoExpandMaxNodes,
  getLiveRefreshMaxCharacters,
  getParseOptions,
  reportUnexpectedError,
} from "./settings";
import {
  MAX_EXPAND_ALL_NODES,
  isTreeNodeCountWithinLimit,
  shouldAutoExpandTree,
} from "./treeOptions";
import {
  candidateMatchesFilter,
  findJsonlRecord,
  lineMightMatchFilter,
  parseJsonlFilter,
  searchJsonlLines,
} from "./jsonlNavigator";
import {
  TableModel,
  buildTableFromArrayNode,
  buildTableFromJsonlRecords,
  formatTableAsCsv,
  formatTableAsMarkdown,
} from "./tableData";
import { diffJsonTrees } from "./treeDiff";
import { TextChange, countLineBreaks, trackLine, trackRange } from "./editTracking";
import { renderWebviewHtml } from "./webviewHtml";

export const VIEW_TYPE = "nestedJsonTree.viewer";

const CURSOR_SYNC_DELAY_MS = 100;
/** Budgets for decoding every embedded-JSON string so search can cover it. */
const MAX_SEARCH_DECODED_STRINGS = 2_000;
const MAX_SEARCH_DECODED_NODES = 200_000;

/** Waits longer before re-parsing larger text; about 0.3 s plus 1 ms per 2,000 characters. */
function liveRefreshDelay(characters: number): number {
  return 300 + Math.min(1_000, Math.round(characters / 2_000));
}

/** Webviews whose bundled script has started; exposed to integration tests. */
let readyWebviewCount = 0;

export function getReadyWebviewCount(): number {
  return readyWebviewCount;
}

/** Host-side view of an open panel for integration tests; not a public API. */
export interface PanelTestHandle {
  title: string;
  renderVersion: number;
  parsedVersion: number | undefined;
  tree: JsonTreeNode;
  lastSyncedNodeId: number | undefined;
  lineNumber: number | undefined;
  lastTable: TableModel | undefined;
  diff: RenderDiffPayload | undefined;
  lastInspection: NodeInspectionMessage | undefined;
  runNodeAction(action: NodeAction, nodeId: number): Promise<void>;
  /** Delivers a message as if the Webview had sent it. */
  postFromWebview(message: unknown): Promise<void>;
}

const openPanels = new Set<JsonTreePanel>();

export function getPanelTestHandles(): PanelTestHandle[] {
  return [...openPanels].map((panel) => panel.testHandle());
}

export interface JsonlSourceContext {
  uri: vscode.Uri;
  sourceName: string;
  lineNumber: number;
  lineCount: number;
  followCursor?: boolean;
  keepView?: boolean;
  filterQuery?: string;
}

/** A tree parsed from a whole document or from a selection in it. */
export interface DocumentSource {
  uri: vscode.Uri;
  scope: "document" | "selection";
  /** Document offset of the parsed text (0 for a whole document). */
  baseOffset: number;
  /** End offset of a selection; tracked through edits outside it. */
  endOffset?: number;
  /** Document version the tree was parsed from. */
  version: number;
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
  source?: DocumentSource;
  jsonlSource?: JsonlSourceContext;
  diff?: RenderDiffPayload;
}

type TableSourceRef =
  | { kind: "array"; nodeId: number }
  | { kind: "jsonl"; query: string };

export class JsonTreePanel {
  private index: JsonTreeIndex;
  /** Identifies the displayed value so the Webview restores only matching view state. */
  private renderVersion = 0;
  private navigationGeneration = 0;
  private followCursorTimer: ReturnType<typeof setTimeout> | undefined;
  private cursorSyncTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private lastSyncedNodeId: number | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly jsonlSource?: Required<JsonlSourceContext>;
  private readonly source?: DocumentSource & { syncCursor: boolean; status: string; canRefresh: boolean };
  /** Document version the displayed tree was parsed from; undefined when unknown or unlinked. */
  private parsedVersion: number | undefined;
  private candidate: JsonCandidate;
  private title: string;
  private pathLabel: string;
  private diff: RenderDiffPayload | undefined;
  private lastTable: TableModel | undefined;
  private lastTableSource: TableSourceRef | undefined;
  private lastInspection: NodeInspectionMessage | undefined;

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

  static revive(panel: vscode.WebviewPanel, services: PanelServices, init: PanelInit): JsonTreePanel {
    panel.title = init.title;
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [webviewRoot(services.extensionUri)],
    };
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
    this.diff = init.diff;
    this.index = buildJsonTreeContextIndex(init.candidate.tree);
    this.disposables.push(
      panel.webview.onDidReceiveMessage((message: unknown) => {
        this.handleMessage(message).catch((error: unknown) => {
          reportUnexpectedError(vscode.l10n.t("Tree View action"), error);
        });
      }),
      panel.onDidDispose(() => this.dispose()),
    );
    if (init.jsonlSource !== undefined) {
      this.jsonlSource = {
        ...init.jsonlSource,
        followCursor: init.jsonlSource.followCursor ?? false,
        keepView: init.jsonlSource.keepView ?? true,
        filterQuery: init.jsonlSource.filterQuery ?? "",
      };
    } else if (init.source !== undefined) {
      this.source = { ...init.source, syncCursor: true, status: "", canRefresh: false };
      this.parsedVersion = init.source.version;
    }
    const uri = this.sourceUri();
    if (uri !== undefined) {
      if (this.jsonlSource !== undefined) {
        // JSONL panels are created right after reading the line, so the open
        // document's current version is the parsed one.
        this.parsedVersion = vscode.workspace.textDocuments
          .find((document) => document.uri.toString() === uri.toString())?.version;
      }
      this.disposables.push(
        vscode.window.onDidChangeTextEditorSelection((event) => this.handleSourceSelection(event)),
        vscode.workspace.onDidChangeTextDocument((event) => this.handleSourceEdit(event)),
      );
    }
    panel.webview.html = this.getHtml(panel.webview);
    openPanels.add(this);
  }

  testHandle(): PanelTestHandle {
    const readLastTable = (): TableModel | undefined => this.lastTable;
    const readDiff = (): RenderDiffPayload | undefined => this.diff;
    const readLastInspection = (): NodeInspectionMessage | undefined => this.lastInspection;
    return {
      title: this.title,
      renderVersion: this.renderVersion,
      parsedVersion: this.parsedVersion,
      tree: this.candidate.tree,
      lastSyncedNodeId: this.lastSyncedNodeId,
      lineNumber: this.jsonlSource?.lineNumber,
      get lastTable() {
        return readLastTable();
      },
      get diff() {
        return readDiff();
      },
      get lastInspection() {
        return readLastInspection();
      },
      postFromWebview: (message) => this.handleMessage(message),
      runNodeAction: async (action, nodeId) => {
        const context = this.index.get(nodeId);
        if (context === undefined) throw new Error(`Unknown node ${nodeId}.`);
        await this.runNodeAction(action, context);
      },
    };
  }

  private dispose(): void {
    openPanels.delete(this);
    this.navigationGeneration += 1;
    for (const timer of [this.followCursorTimer, this.cursorSyncTimer, this.refreshTimer]) {
      if (timer !== undefined) clearTimeout(timer);
    }
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }

  private post(message: HostToWebviewMessage): Thenable<boolean> {
    return this.panel.webview.postMessage(message);
  }

  private sourceUri(): vscode.Uri | undefined {
    return this.source?.uri ?? this.jsonlSource?.uri;
  }

  private sourceViewState(): SourceViewState | undefined {
    const source = this.source;
    if (source === undefined) return undefined;
    return {
      linked: this.parsedVersion !== undefined,
      syncCursor: source.syncCursor,
      status: source.status,
      canRefresh: source.canRefresh,
    };
  }

  private panelSourceDescriptor(): PanelSourceDescriptor | undefined {
    if (this.jsonlSource !== undefined) {
      return {
        kind: "jsonl",
        uri: this.jsonlSource.uri.toString(),
        lineNumber: this.jsonlSource.lineNumber,
      };
    }
    if (this.source?.scope === "document") {
      return {
        kind: "document",
        uri: this.source.uri.toString(),
      };
    }
    return undefined;
  }

  private async postRender(status = "", preserveView = false): Promise<void> {
    const tree = this.candidate.tree;
    // Built per render rather than retained: the bounded copy is only needed
    // while it is being transferred to the Webview.
    const model = createJsonTreeWebviewModel(tree);
    const panelSource = this.panelSourceDescriptor();
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
            keepView: this.jsonlSource.keepView,
            filterQuery: this.jsonlSource.filterQuery,
            status,
          },
      source: this.sourceViewState(),
      ...(panelSource !== undefined ? { panelSource } : {}),
      ...(this.diff !== undefined ? { diff: this.diff } : {}),
      preserveView,
    };
    await this.post(message);
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!isPanelMessage(message)) return;

    if (message.type === "ready") {
      readyWebviewCount += 1;
      await this.postRender();
      // A hidden tab's Webview is rebuilt when shown again; restore the
      // editor-cursor highlight instead of waiting for the cursor to move.
      if (this.lastSyncedNodeId !== undefined && this.index.get(this.lastSyncedNodeId) !== undefined) {
        await this.post({ type: "revealNode", ids: this.index.ancestry(this.lastSyncedNodeId) });
      }
      return;
    }

    if (message.type === "decodeAllForSearch") {
      if (message.renderKey === this.renderVersion) await this.decodeAllForSearch();
      return;
    }
    if (message.type === "exportTable") {
      await this.exportTable(message.mode, message.rowIndices, message.format);
      return;
    }
    if (message.type === "reopenTable") {
      await this.reopenTable(message.flatten === true);
      return;
    }
    if (message.type === "diffWithClipboard") {
      await this.diffTreeWithClipboard();
      return;
    }
    if (message.type === "diffJsonlPrevious") {
      await this.diffJsonlPrevious();
      return;
    }
    if (message.type === "savePanelViewState") {
      return;
    }
    if (await this.handleJsonlMessage(message)) return;
    if (await this.handleSourceMessage(message)) return;

    if (!NODE_ACTIONS.has(message.type) || !isValidJsonTreeNodeId(message.nodeId)) return;
    const context = this.index.get(message.nodeId);
    if (context === undefined) return;
    if (message.type === "generateTypes") {
      await this.generateTypes(context, message.target, message.mode);
      return;
    }
    await this.runNodeAction(message.type as NodeAction, context);
  }

  private async runNodeAction(action: NodeAction, context: JsonTreeNodeContext): Promise<void> {
    const node = context.node;
    switch (action) {
      case "copyKey":
        if (context.parent !== undefined && context.key !== undefined) {
          await copyText(String(context.key), vscode.l10n.t("key"));
        }
        return;
      case "copyRawKey":
        if (context.rawKey !== undefined) await copyText(context.rawKey, vscode.l10n.t("raw key"));
        return;
      case "copyJsonPath":
      case "copyJqPath":
        await copyPath(action, context);
        return;
      case "copyValue":
        await copyValue(node);
        return;
      case "copyRawString":
        if (node.type === "string") await copyText(node.raw as string, vscode.l10n.t("value"));
        return;
      case "copyDecodedString":
        if (node.type === "string") await copyText(node.value as string, vscode.l10n.t("value"));
        return;
      case "openDecodedValue":
        if (node.type === "string") await openDecodedValue(node);
        return;
      case "openSubtree":
        this.openSubtree(context);
        return;
      case "openFormattedJson":
        await openFormattedNodeJson(node);
        return;
      case "openArrayTable":
        await this.openArrayTable(context);
        return;
      case "openNested":
      case "openParsedJson":
        if (node.type === "string") await this.openNestedString(action, context);
        return;
      case "openLink":
        if (node.type === "string") await openLink(node.value as string);
        return;
      case "revealInSource":
        await this.revealInSource(context);
        return;
      case "expandDecoded":
        await this.expandDecoded(context);
        return;
      case "inspectNode":
        await this.inspectNode(context);
        return;
      case "generateTypes":
        await this.generateTypes(context);
        return;
      case "diffSubtreeWithClipboard":
        await this.diffSubtreeWithClipboard(context);
        return;
    }
  }

  private async openNestedString(
    action: "openNested" | "openParsedJson",
    context: JsonTreeNodeContext,
  ): Promise<void> {
    const displayPath = formatJsonPathForDisplay(materializeJsonTreePath(context));
    if (context.node.decoded !== undefined) {
      const existing = context.node.decoded;
      const isPureNestedJson = !isNonJsonDecodedKind(existing.kind) && !existing.embedded;
      await this.openDecodedPayload(action, existing, displayPath, isPureNestedJson);
      return;
    }

    const value = context.node.value as string;
    const parseOptions = getParseOptions();
    let candidates: JsonCandidate[];
    try {
      candidates = await parseNestedJsonCandidatesAsync(value, parseOptions);
    } catch (error) {
      if (error instanceof JsonProcessingLimitError) {
        void vscode.window.showErrorMessage(
          vscode.l10n.t("Cannot open nested JSON at {0}: {1}", displayPath, describeLimitError(error)),
        );
        return;
      }
      throw error;
    }

    if (candidates.length > 0) {
      const selected = await this.services.pickCandidate(candidates, displayPath);
      if (selected === undefined) return;
      if (action === "openParsedJson") {
        await openParsedJson(selected);
        return;
      }
      JsonTreePanel.create(this.services, {
        candidate: selected,
        title: vscode.l10n.t("Nested JSON · {0}", displayPath),
        pathLabel: displayPath,
        viewColumn: this.panel.viewColumn ?? vscode.ViewColumn.Active,
      });
      return;
    }

    const limit = parseOptions.maxValueNodes ?? MAX_JSON_VALUE_NODES;
    let decoded: JsonTreeDecoded | null | undefined;
    try {
      decoded = await decodeInlineString(value, limit, (all) => this.services.pickCandidate(all, displayPath));
    } catch (error) {
      if (error instanceof JsonProcessingLimitError) {
        void vscode.window.showErrorMessage(
          vscode.l10n.t("Cannot open nested JSON at {0}: {1}", displayPath, describeLimitError(error)),
        );
        return;
      }
      throw error;
    }
    if (decoded === undefined) return;
    if (decoded === null) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t("The string at {0} does not contain valid JSON or supported encoded data.", displayPath),
      );
      return;
    }

    await this.openDecodedPayload(action, decoded, displayPath, false);
  }

  private async openDecodedPayload(
    action: "openNested" | "openParsedJson",
    decoded: JsonTreeDecoded,
    displayPath: string,
    isPureNestedJson: boolean,
  ): Promise<void> {
    if (action === "openParsedJson") {
      if (decoded.kind === "base64-text") {
        await openPlainText(decoded.root.value as string, vscode.l10n.t("open decoded string"));
        return;
      }
      await openParsedJson({
        tree: decoded.root,
        nodeCount: countTreeNodes(decoded.root),
        raw: "",
        start: 0,
        end: 0,
        unwrapDepth: decoded.unwrapDepth,
        recovery: decoded.recovery,
      });
      return;
    }

    const cloned = cloneSubtreeWithFreshIds(decoded.root, true);
    JsonTreePanel.create(this.services, {
      candidate: {
        tree: cloned.tree,
        nodeCount: cloned.nodeCount,
        raw: "",
        start: 0,
        end: 0,
        unwrapDepth: decoded.unwrapDepth,
        recovery: decoded.recovery,
      },
      title: isPureNestedJson
        ? vscode.l10n.t("Nested JSON · {0}", displayPath)
        : vscode.l10n.t("Decoded · {0}", displayPath),
      pathLabel: displayPath,
      viewColumn: this.panel.viewColumn ?? vscode.ViewColumn.Active,
    });
  }

  private openSubtree(context: JsonTreeNodeContext): void {
    const displayPath = formatJsonPathForDisplay(materializeJsonTreePath(context));
    const cloned = cloneSubtreeWithFreshIds(context.node, true);
    JsonTreePanel.create(this.services, {
      candidate: {
        tree: cloned.tree,
        nodeCount: cloned.nodeCount,
        raw: "",
        start: 0,
        end: 0,
        unwrapDepth: 0,
      },
      title: vscode.l10n.t("JSON Subtree · {0}", displayPath),
      pathLabel: displayPath,
      viewColumn: this.panel.viewColumn ?? vscode.ViewColumn.Active,
    });
  }

  private async inspectNode(context: JsonTreeNodeContext): Promise<void> {
    const node = context.node;
    const path = formatJsonPathForDisplay(materializeJsonTreePath(context));
    await guardOutputSize(vscode.l10n.t("inspect value"), async () => {
      const fullValue = node.type === "string"
        ? (node.value as string)
        : stringifyJsonTreeForTransfer(node).text;
      assertTransferTextSize(fullValue);
      const inspection: NodeInspectionMessage = {
        type: "nodeInspection",
        nodeId: node.id,
        path,
        nodeType: node.type,
        fullValue,
        ...(node.raw !== undefined ? { rawToken: node.raw } : {}),
        byteLength: Buffer.byteLength(fullValue, "utf8"),
        charLength: fullValue.length,
        lineCount: countLineBreaks(fullValue) + 1,
        ...(node.children !== undefined ? { childCount: node.children.length } : {}),
      };
      this.lastInspection = inspection;
      await this.post(inspection);
    });
  }

  private async generateTypes(
    context: JsonTreeNodeContext,
    requestedTarget?: unknown,
    requestedMode?: unknown,
  ): Promise<void> {
    const options: Array<{ target: SchemaTarget; label: string; language: string; detail: string }> = [
      {
        target: "typescript",
        label: vscode.l10n.t("TypeScript Interface"),
        language: "typescript",
        detail: "interface Root { … }",
      },
      {
        target: "json-schema",
        label: vscode.l10n.t("JSON Schema"),
        language: "json",
        detail: "JSON Schema Draft 2020-12",
      },
      {
        target: "zod",
        label: vscode.l10n.t("Zod Schema"),
        language: "typescript",
        detail: "z.object({ … })",
      },
      {
        target: "go",
        label: vscode.l10n.t("Go Struct"),
        language: "go",
        detail: "type Root struct { … }",
      },
      {
        target: "python",
        label: vscode.l10n.t("Python Pydantic"),
        language: "python",
        detail: "class Root(BaseModel): …",
      },
    ];

    let chosen = options.find((item) => item.target === requestedTarget);
    let mode: "open" | "copy";

    if (chosen !== undefined) {
      mode = requestedMode === "copy" ? "copy" : "open";
    } else {
      chosen = await vscode.window.showQuickPick(options, {
        title: vscode.l10n.t("Generate Types / Schema"),
        placeHolder: vscode.l10n.t("Select target language or schema format"),
      });
      if (chosen === undefined) return;
      const actionItems: Array<{ label: string; mode: "open" | "copy" }> = [
        { label: `$(go-to-file) ${vscode.l10n.t("Open in new editor")}`, mode: "open" },
        { label: `$(clippy) ${vscode.l10n.t("Copy to clipboard")}`, mode: "copy" },
      ];
      const pickedAction = await vscode.window.showQuickPick(actionItems, {
        title: chosen.label,
        placeHolder: vscode.l10n.t("Choose where to send the generated code"),
      });
      if (pickedAction === undefined) return;
      mode = pickedAction.mode;
    }

    const rootName = typeof context.key === "string" && context.key.trim().length > 0
      ? context.key
      : "Root";
    const selectedTarget = chosen;
    await guardOutputSize(vscode.l10n.t("generate types"), async () => {
      const code = generateTypesFromTree(context.node, selectedTarget.target, { rootName });
      assertTransferTextSize(code);
      if (mode === "copy") {
        await vscode.env.clipboard.writeText(code);
        void vscode.window.showInformationMessage(
          vscode.l10n.t("Copied {0} to clipboard.", selectedTarget.label),
        );
      } else {
        const document = await vscode.workspace.openTextDocument({
          content: code,
          language: selectedTarget.language,
        });
        await vscode.window.showTextDocument(document, {
          preview: false,
          viewColumn: vscode.ViewColumn.Beside,
        });
      }
    });
  }

  private async diffTreeWithClipboard(): Promise<void> {
    const right = await this.parseClipboardCandidate();
    if (right === undefined) return;
    let leftRoot = this.candidate.tree;
    if (leftRoot.type === "string" && leftRoot.decoded !== undefined && right.tree.type !== "string") {
      leftRoot = leftRoot.decoded.root;
    }
    this.openDiffPanel(
      leftRoot,
      right.tree,
      vscode.l10n.t("JSON Diff · {0} ↔ Clipboard", this.pathLabel),
      this.pathLabel,
    );
  }

  private async diffSubtreeWithClipboard(context: JsonTreeNodeContext): Promise<void> {
    const displayPath = formatJsonPathForDisplay(materializeJsonTreePath(context));
    const right = await this.parseClipboardCandidate();
    if (right === undefined) return;
    let leftRoot = context.node;
    if (leftRoot.type === "string" && right.tree.type !== "string") {
      if (leftRoot.decoded !== undefined) {
        leftRoot = leftRoot.decoded.root;
      } else {
        try {
          const nested = await parseNestedJsonCandidatesAsync(leftRoot.value as string, getParseOptions());
          if (nested.length > 0) leftRoot = nested[0].tree;
        } catch (error) {
          if (!(error instanceof JsonProcessingLimitError)) throw error;
        }
      }
    }
    this.openDiffPanel(
      leftRoot,
      right.tree,
      vscode.l10n.t("JSON Diff · {0} ↔ Clipboard", displayPath),
      displayPath,
    );
  }

  private async diffJsonlPrevious(): Promise<void> {
    const source = this.jsonlSource;
    if (source === undefined) return;
    if (source.lineNumber <= 0) {
      await this.postJsonlState(vscode.l10n.t("No earlier valid JSON line"));
      return;
    }
    const generation = ++this.navigationGeneration;
    const isCurrent = (): boolean => generation === this.navigationGeneration;
    await this.postJsonlState(vscode.l10n.t("Scanning…"), true);
    let finalStatus: string | undefined = vscode.l10n.t("Could not read the source document");
    try {
      const document = await vscode.workspace.openTextDocument(source.uri);
      source.lineCount = document.lineCount;
      const parseOptions = getParseOptions();
      const filter = parseJsonlFilter(source.filterQuery);
      const result = await findJsonlRecord(
        {
          lineCount: document.lineCount,
          lineAt: (lineNumber) => document.lineAt(lineNumber).text,
        },
        source.lineNumber - 1,
        -1,
        {
          filter,
          isCancelled: () => !isCurrent(),
          parseLine: (text) => {
            assertInputSize(text);
            return parseJsonCandidates(text, parseOptions);
          },
        },
      );
      if (!isCurrent() || result.status === "cancelled") return;
      if (result.status === "not-found") {
        finalStatus = filter !== undefined
          ? vscode.l10n.t("No earlier record matches the filter")
          : vscode.l10n.t("No earlier valid JSON line");
        return;
      }
      finalStatus = "";
      const selected = await this.services.pickCandidate(
        result.record.candidates,
        vscode.l10n.t("line {0}", result.record.lineNumber + 1),
      );
      if (!isCurrent() || selected === undefined) return;
      this.openDiffPanel(
        selected.tree,
        this.candidate.tree,
        vscode.l10n.t("JSON Diff · {0}:{1} → {2}", source.sourceName, result.record.lineNumber + 1, source.lineNumber + 1),
        "$",
      );
    } finally {
      if (finalStatus !== undefined && isCurrent()) await this.postJsonlState(finalStatus);
    }
  }

  private async parseClipboardCandidate(): Promise<JsonCandidate | undefined> {
    const text = await vscode.env.clipboard.readText();
    if (text.trim().length === 0) {
      void vscode.window.showInformationMessage(vscode.l10n.t("The clipboard is empty."));
      return undefined;
    }
    let candidates: JsonCandidate[];
    try {
      assertInputSize(text);
      candidates = await parseJsonCandidatesAsync(text, getParseOptions());
    } catch (error) {
      if (error instanceof JsonProcessingLimitError) {
        void vscode.window.showErrorMessage(describeLimitError(error));
        return undefined;
      }
      throw error;
    }
    if (candidates.length === 0) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t("No valid JSON object, array, or value was found in {0}.", vscode.l10n.t("the clipboard")),
      );
      return undefined;
    }
    return this.services.pickCandidate(candidates, vscode.l10n.t("the clipboard"));
  }

  private openDiffPanel(
    left: JsonTreeNode,
    right: JsonTreeNode,
    title: string,
    pathLabel: string,
  ): void {
    const maxNodes = getParseOptions().maxValueNodes ?? MAX_JSON_VALUE_NODES;
    let diffResult: ReturnType<typeof diffJsonTrees>;
    try {
      diffResult = diffJsonTrees(left, right, { maxNodes });
    } catch (error) {
      if (error instanceof JsonProcessingLimitError) {
        void vscode.window.showErrorMessage(describeLimitError(error));
        return;
      }
      throw error;
    }
    JsonTreePanel.create(this.services, {
      candidate: {
        tree: diffResult.root,
        nodeCount: diffResult.nodeCount,
        raw: "",
        start: 0,
        end: 0,
        unwrapDepth: 0,
      },
      title,
      pathLabel,
      viewColumn: this.panel.viewColumn ?? vscode.ViewColumn.Active,
      diff: {
        summary: diffResult.summary,
        annotations: diffResult.annotations,
      },
    });
  }

  private async openArrayTable(context: JsonTreeNodeContext, flatten = false): Promise<void> {
    const displayPath = formatJsonPathForDisplay(materializeJsonTreePath(context));
    const table = buildTableFromArrayNode(context.node, displayPath, { flatten });
    if (table === undefined) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t("Select an array that contains at least one object to view as a table."),
      );
      return;
    }
    this.lastTable = table;
    this.lastTableSource = { kind: "array", nodeId: context.node.id };
    await this.post({ type: "tableData", table });
  }

  private async reopenTable(flatten: boolean): Promise<void> {
    const tableSource = this.lastTableSource;
    if (tableSource === undefined) return;
    if (tableSource.kind === "array") {
      const context = this.index.get(tableSource.nodeId);
      if (context !== undefined) await this.openArrayTable(context, flatten);
      return;
    }
    if (this.jsonlSource !== undefined) {
      this.jsonlSource.filterQuery = tableSource.query;
      await this.openJsonlTable(flatten);
    }
  }

  /** Decodes structured content (JSON, JWT, URL query, Base64/Protobuf) embedded in a string node. */
  private async expandDecoded(context: JsonTreeNodeContext): Promise<void> {
    const node = context.node;
    if (node.type !== "string") return;
    if (node.decoded !== undefined) {
      await this.post({ type: "decoded", nodeId: node.id, decoded: webviewDecoded(node.decoded) });
      return;
    }
    const value = node.value as string;
    const displayPath = formatJsonPathForDisplay(materializeJsonTreePath(context));
    const fail = async (warning?: string, cancelled = false): Promise<void> => {
      if (warning !== undefined) void vscode.window.showWarningMessage(warning);
      await this.post({ type: "decodeFailed", nodeId: node.id, ...(cancelled ? { cancelled: true } : {}) });
    };
    if (cachedDetectDecodableKind(node) === undefined) {
      await fail(vscode.l10n.t("The string at {0} does not contain valid JSON or supported encoded data.", displayPath));
      return;
    }

    const renderVersion = this.renderVersion;
    let decoded: JsonTreeDecoded | null | undefined;
    try {
      decoded = await decodeInlineString(value, this.remainingNodeBudget(), (candidates) =>
        this.services.pickCandidate(candidates, displayPath));
    } catch (error) {
      if (error instanceof JsonProcessingLimitError) {
        await fail(vscode.l10n.t("Cannot decode JSON at {0}: {1}", displayPath, describeLimitError(error)));
        return;
      }
      throw error;
    }
    // The panel may have moved to another record while a picker was open.
    if (renderVersion !== this.renderVersion || node.decoded !== undefined) return;
    if (decoded === null) {
      await fail(vscode.l10n.t("The string at {0} could not be decoded into a structured value.", displayPath));
      return;
    }
    if (decoded === undefined) {
      // User dismissed a multi-candidate picker; keep the node expandable.
      await fail(undefined, true);
      return;
    }
    this.index.attachDecoded(node.id, decoded);
    await this.post({ type: "decoded", nodeId: node.id, decoded: webviewDecoded(decoded) });
  }

  /**
   * Decodes every string that looks decodable (JSON, JWT, URL query, Base64/Protobuf),
   * breadth-first so strings inside newly decoded content are included, within fixed
   * budgets. Yields between strings so a large tree never blocks the Extension Host.
   */
  private async decodeAllForSearch(): Promise<void> {
    const renderVersion = this.renderVersion;
    const isCurrent = (): boolean => renderVersion === this.renderVersion;
    const pending: JsonTreeNode[] = [];
    const queueStrings = (root: JsonTreeNode): void => walkJsonTree(root, (node) => {
      if (node.type === "string" && node.decoded === undefined && cachedDetectDecodableKind(node) !== undefined) {
        pending.push(node);
      }
    });
    queueStrings(this.candidate.tree);
    const newRoots = new Set<number>();
    const owners: JsonTreeNode[] = [];
    let addedNodes = 0;
    let limited = false;
    for (let index = 0; index < pending.length; index += 1) {
      if (owners.length >= MAX_SEARCH_DECODED_STRINGS) {
        limited = true;
        break;
      }
      if (index % 50 === 49) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (!isCurrent()) return;
      }
      const node = pending[index];
      if (node.decoded !== undefined) continue;
      const budget = Math.min(this.remainingNodeBudget(), MAX_SEARCH_DECODED_NODES - addedNodes);
      let decoded: JsonTreeDecoded | null | undefined;
      try {
        decoded = budget >= 1 ? await decodeInlineString(node.value as string, budget, async (all) => all[0]) : undefined;
      } catch (error) {
        if (!(error instanceof JsonProcessingLimitError)) throw error;
        limited = true;
        continue;
      }
      if (budget < 1) {
        limited = true;
        break;
      }
      if (!decoded) continue;
      this.index.attachDecoded(node.id, decoded);
      newRoots.add(decoded.root.id);
      owners.push(node);
      walkJsonTree(decoded.root, () => {
        addedNodes += 1;
      });
      queueStrings(decoded.root);
    }
    if (!isCurrent()) return;
    // Owners inside other newly decoded content arrive as part of that content.
    const items = owners
      .filter((owner) => !this.index.ancestry(owner.id).some((id) => newRoots.has(id)))
      .map((owner) => ({ nodeId: owner.id, decoded: webviewDecoded(owner.decoded as JsonTreeDecoded) }));
    await this.post({
      type: "decodedBatch",
      renderKey: renderVersion,
      items,
      decodedCount: owners.length,
      limited,
    });
  }

  private remainingNodeBudget(): number {
    const limit = getParseOptions().maxValueNodes;
    return limit === undefined ? Number.POSITIVE_INFINITY : limit - this.index.size;
  }

  private async handleJsonlMessage(message: PanelMessage): Promise<boolean> {
    const source = this.jsonlSource;
    if (source === undefined) return false;
    switch (message.type) {
      case "setFollowCursor":
        source.followCursor = message.enabled === true;
        this.lastSyncedNodeId = undefined;
        await this.postJsonlState(source.followCursor
          ? vscode.l10n.t("Following source cursor")
          : vscode.l10n.t("Follow cursor off"));
        return true;
      case "setKeepView":
        source.keepView = message.enabled === true;
        await this.postJsonlState("");
        return true;
      case "setJsonlFilter": {
        source.filterQuery = typeof message.query === "string" ? message.query : "";
        const filter = parseJsonlFilter(source.filterQuery);
        await this.postJsonlState(filter !== undefined ? vscode.l10n.t("Filter active") : "");
        return true;
      }
      case "listJsonlMatches":
        if (typeof message.query === "string") source.filterQuery = message.query;
        await this.listJsonlMatches();
        return true;
      case "openJsonlTable":
        if (typeof message.query === "string") source.filterQuery = message.query;
        await this.openJsonlTable();
        return true;
      case "revealSource":
        await this.revealSourceLine();
        return true;
      case "previousJsonl":
        if (typeof message.query === "string") source.filterQuery = message.query;
        await this.navigateJsonl(source.lineNumber - 1, -1, parseJsonlFilter(source.filterQuery));
        return true;
      case "nextJsonl":
        if (typeof message.query === "string") source.filterQuery = message.query;
        await this.navigateJsonl(source.lineNumber + 1, 1, parseJsonlFilter(source.filterQuery));
        return true;
      case "goToJsonlLine":
        if (typeof message.lineNumber !== "number" || !Number.isInteger(message.lineNumber)) return true;
        await this.navigateJsonl(Math.max(0, message.lineNumber - 1), 1);
        return true;
      default:
        return false;
    }
  }

  private async handleSourceMessage(message: PanelMessage): Promise<boolean> {
    const source = this.source;
    if (source === undefined) return false;
    switch (message.type) {
      case "setSyncCursor":
        source.syncCursor = message.enabled === true;
        this.lastSyncedNodeId = undefined;
        await this.postSourceState();
        return true;
      case "refreshSource":
        await this.refreshFromSource(true);
        return true;
      default:
        return false;
    }
  }

  private async navigateJsonl(
    startLine: number,
    direction: -1 | 1,
    filter?: ReturnType<typeof parseJsonlFilter>,
  ): Promise<void> {
    const source = this.jsonlSource;
    if (source === undefined) return;
    const generation = ++this.navigationGeneration;
    const isCurrent = (): boolean => generation === this.navigationGeneration;
    await this.postJsonlState(vscode.l10n.t("Scanning…"), true);
    // Every exit path must clear the busy state, including a source document
    // that was deleted or renamed after the panel opened.
    let finalStatus: string | undefined = vscode.l10n.t("Could not read the source document");
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
          filter,
          isCancelled: () => !isCurrent(),
          parseLine: (text) => {
            assertInputSize(text);
            return parseJsonCandidates(text, parseOptions);
          },
        },
      );
      if (!isCurrent() || result.status === "cancelled") return;
      if (result.status === "not-found") {
        if (filter !== undefined) {
          finalStatus = direction > 0
            ? vscode.l10n.t("No later record matches the filter")
            : vscode.l10n.t("No earlier record matches the filter");
        } else {
          finalStatus = direction > 0
            ? vscode.l10n.t("No later valid JSON line")
            : vscode.l10n.t("No earlier valid JSON line");
        }
        return;
      }
      finalStatus = "";
      const selected = await this.services.pickCandidate(
        result.record.candidates,
        vscode.l10n.t("line {0}", result.record.lineNumber + 1),
      );
      if (!isCurrent() || selected === undefined) return;
      const decodedPaths = source.keepView ? this.captureDecodedPaths() : [];
      const skipped = result.record.skippedLines;
      this.updateJsonlCandidate(selected, result.record.lineNumber, document.version);
      if (decodedPaths.length > 0) {
        await this.reapplyDecodedPaths(decodedPaths);
        if (!isCurrent()) return;
      }
      finalStatus = undefined;
      const statusText = skipped === 0
        ? ""
        : filter !== undefined
          ? (skipped === 1
              ? vscode.l10n.t("Skipped 1 non-matching line")
              : vscode.l10n.t("Skipped {0} non-matching lines", skipped.toLocaleString()))
          : (skipped === 1
              ? vscode.l10n.t("Skipped 1 invalid or empty line")
              : vscode.l10n.t("Skipped {0} invalid or empty lines", skipped.toLocaleString()));
      await this.postRender(statusText, source.keepView);
    } finally {
      if (finalStatus !== undefined && isCurrent()) await this.postJsonlState(finalStatus);
    }
  }

  private async listJsonlMatches(): Promise<void> {
    const source = this.jsonlSource;
    if (source === undefined) return;
    const generation = ++this.navigationGeneration;
    const isCurrent = (): boolean => generation === this.navigationGeneration;
    await this.postJsonlState(vscode.l10n.t("Scanning…"), true);
    let finalStatus: string | undefined = vscode.l10n.t("Could not read the source document");
    try {
      const document = await vscode.workspace.openTextDocument(source.uri);
      source.lineCount = document.lineCount;
      const parseOptions = getParseOptions();
      const filter = parseJsonlFilter(source.filterQuery);
      const searchResult = await searchJsonlLines(
        {
          lineCount: document.lineCount,
          lineAt: (lineNumber) => document.lineAt(lineNumber).text,
        },
        {
          filter,
          isCancelled: () => !isCurrent(),
          parseLine: (text) => {
            assertInputSize(text);
            return parseJsonCandidates(text, parseOptions);
          },
        },
      );
      if (!isCurrent() || searchResult.status === "cancelled") return;
      if (searchResult.matches.length === 0) {
        finalStatus = vscode.l10n.t("No matching JSONL records found");
        return;
      }
      finalStatus = "";
      const items = searchResult.matches.map((match) => ({
        label: `$(list-tree) ${vscode.l10n.t("Line {0}", match.lineNumber + 1)}`,
        description: match.candidateCount > 1
          ? vscode.l10n.t("{0} JSON candidates found", match.candidateCount)
          : undefined,
        detail: match.preview,
        lineNumber: match.lineNumber,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        title: filter !== undefined
          ? vscode.l10n.t("Matching JSONL lines ({0})", filter.raw)
          : vscode.l10n.t("Valid JSONL lines"),
        placeHolder: searchResult.truncated
          ? vscode.l10n.t("Showing first {0} matching lines", searchResult.matches.length.toLocaleString())
          : vscode.l10n.t("{0} matching lines found", searchResult.matches.length.toLocaleString()),
        matchOnDetail: true,
      });
      if (!isCurrent() || picked === undefined) return;
      finalStatus = undefined;
      await this.navigateJsonl(picked.lineNumber, 1);
    } finally {
      if (finalStatus !== undefined && isCurrent()) await this.postJsonlState(finalStatus);
    }
  }

  private async openJsonlTable(flatten = false): Promise<void> {
    const source = this.jsonlSource;
    if (source === undefined) return;
    const generation = ++this.navigationGeneration;
    const isCurrent = (): boolean => generation === this.navigationGeneration;
    await this.postJsonlState(vscode.l10n.t("Building table…"), true);
    let finalStatus: string | undefined = vscode.l10n.t("Could not read the source document");
    try {
      const document = await vscode.workspace.openTextDocument(source.uri);
      source.lineCount = document.lineCount;
      const parseOptions = getParseOptions();
      const filter = parseJsonlFilter(source.filterQuery);
      const startLine = filter !== undefined ? 0 : source.lineNumber;
      const maxRecords = 500;
      const records: Array<{ lineNumber: number; tree: JsonTreeNode }> = [];
      let truncated = false;
      for (let lineNumber = startLine; lineNumber < document.lineCount; lineNumber += 1) {
        if (!isCurrent()) return;
        const lineText = document.lineAt(lineNumber).text;
        if (filter === undefined || lineMightMatchFilter(lineText, filter)) {
          let candidates: JsonCandidate[] = [];
          try {
            assertInputSize(lineText);
            candidates = parseJsonCandidates(lineText, parseOptions);
            if (filter !== undefined && candidates.length > 0) {
              candidates = candidates.filter((candidate) => candidateMatchesFilter(candidate, filter));
            }
          } catch (error) {
            if (!(error instanceof JsonProcessingLimitError)) throw error;
          }
          if (candidates.length > 0) {
            if (records.length >= maxRecords) {
              truncated = true;
              break;
            }
            records.push({ lineNumber, tree: candidates[0].tree });
          }
        }
        if ((lineNumber - startLine + 1) % 250 === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
      if (!isCurrent()) return;
      if (records.length === 0) {
        finalStatus = vscode.l10n.t("No matching JSONL records found");
        return;
      }
      const title = filter !== undefined
        ? vscode.l10n.t("{0} · filter: {1}", source.sourceName, filter.raw)
        : vscode.l10n.t("{0} (from line {1})", source.sourceName, startLine + 1);
      const table = buildTableFromJsonlRecords(records, title, truncated, { flatten });
      this.lastTable = table;
      this.lastTableSource = { kind: "jsonl", query: source.filterQuery };
      finalStatus = "";
      await this.post({ type: "tableData", table });
    } finally {
      if (finalStatus !== undefined && isCurrent()) await this.postJsonlState(finalStatus);
    }
  }

  private async exportTable(mode: unknown, rowIndices: unknown, format?: unknown): Promise<void> {
    const table = this.lastTable;
    if (table === undefined || (mode !== "copy" && mode !== "open") || !Array.isArray(rowIndices)) return;
    const exportFormat: TableExportFormat = format === "tsv" || format === "markdown" ? format : "csv";
    const selectedRows: string[][] = [];
    for (const rawIndex of rowIndices) {
      if (typeof rawIndex === "number" && Number.isInteger(rawIndex) && rawIndex >= 0 && rawIndex < table.rows.length) {
        selectedRows.push(table.rows[rawIndex].cells);
      }
    }
    const output = exportFormat === "markdown"
      ? formatTableAsMarkdown(table.columns, selectedRows)
      : formatTableAsCsv(table.columns, selectedRows, exportFormat === "tsv" ? "\t" : ",");
    const actionLabel = exportFormat === "markdown"
      ? vscode.l10n.t("export Markdown")
      : exportFormat === "tsv"
        ? vscode.l10n.t("export TSV")
        : vscode.l10n.t("export CSV");
    await guardOutputSize(actionLabel, async () => {
      assertTransferTextSize(output);
      if (mode === "copy") {
        await vscode.env.clipboard.writeText(output);
        const rowCountText = selectedRows.length.toLocaleString();
        const notice = exportFormat === "markdown"
          ? vscode.l10n.t("Copied {0} row(s) as Markdown.", rowCountText)
          : exportFormat === "tsv"
            ? vscode.l10n.t("Copied {0} row(s) as TSV.", rowCountText)
            : vscode.l10n.t("Copied {0} row(s) as CSV.", rowCountText);
        void vscode.window.showInformationMessage(notice);
      } else {
        const language = exportFormat === "markdown" ? "markdown" : exportFormat === "tsv" ? "tsv" : "csv";
        const document = await vscode.workspace.openTextDocument({ content: output, language });
        await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.Beside });
      }
    });
  }

  private updateJsonlCandidate(candidate: JsonCandidate, lineNumber: number, version: number): void {
    const source = this.jsonlSource;
    if (source === undefined) return;
    source.lineNumber = lineNumber;
    this.replaceCandidate(candidate, version);
    this.title = vscode.l10n.t("JSON Tree · {0}:{1}", source.sourceName, lineNumber + 1);
    this.pathLabel = vscode.l10n.t("$ · line {0}", lineNumber + 1);
    this.panel.title = this.title;
  }

  private replaceCandidate(candidate: JsonCandidate, version: number | undefined): void {
    this.candidate = candidate;
    this.index = buildJsonTreeContextIndex(candidate.tree);
    this.renderVersion += 1;
    this.parsedVersion = version;
    this.lastSyncedNodeId = undefined;
    this.diff = undefined;
    this.lastTable = undefined;
    this.lastTableSource = undefined;
    this.lastInspection = undefined;
  }

  private async postJsonlState(status: string, busy = false): Promise<void> {
    const source = this.jsonlSource;
    if (source === undefined) return;
    await this.post({
      type: "jsonlState",
      lineNumber: source.lineNumber + 1,
      lineCount: source.lineCount,
      followCursor: source.followCursor,
      keepView: source.keepView,
      filterQuery: source.filterQuery,
      status,
      busy,
    });
  }

  private async postSourceState(): Promise<void> {
    const state = this.sourceViewState();
    if (state !== undefined) await this.post({ type: "sourceState", ...state });
  }

  private handleSourceSelection(event: vscode.TextEditorSelectionChangeEvent): void {
    const uri = this.sourceUri();
    if (uri === undefined || event.textEditor.document.uri.toString() !== uri.toString()) return;
    const position = event.selections[0]?.active;
    if (position === undefined) return;

    const jsonl = this.jsonlSource;
    if (jsonl !== undefined) {
      if (!jsonl.followCursor) return;
      if (this.followCursorTimer !== undefined) clearTimeout(this.followCursorTimer);
      if (position.line !== jsonl.lineNumber) {
        const lineNumber = position.line;
        this.followCursorTimer = setTimeout(() => {
          this.followSourceLine(lineNumber).catch((error: unknown) =>
            reportUnexpectedError(vscode.l10n.t("Follow cursor"), error));
        }, 150);
        return;
      }
    } else if (!this.source?.syncCursor) {
      return;
    }

    if (this.cursorSyncTimer !== undefined) clearTimeout(this.cursorSyncTimer);
    const document = event.textEditor.document;
    this.cursorSyncTimer = setTimeout(() => {
      this.syncNodeToCursor(document, position).catch((error: unknown) =>
        reportUnexpectedError(vscode.l10n.t("Sync with editor"), error));
    }, CURSOR_SYNC_DELAY_MS);
  }

  /** Highlights the deepest node under the editor cursor without taking focus. */
  private async syncNodeToCursor(document: vscode.TextDocument, position: vscode.Position): Promise<void> {
    if (this.parsedVersion === undefined || document.version !== this.parsedVersion) return;
    const base = this.parsedTextOffset(document);
    if (base === undefined) return;
    const node = this.index.nodeAtOffset(document.offsetAt(position) - base - this.candidate.start);
    if (node === undefined || node.id === this.lastSyncedNodeId) return;
    this.lastSyncedNodeId = node.id;
    await this.post({ type: "revealNode", ids: this.index.ancestry(node.id) });
  }

  /** Document offset where the parsed text starts, for the current document version. */
  private parsedTextOffset(document: vscode.TextDocument): number | undefined {
    if (this.source !== undefined) return this.source.baseOffset;
    if (this.jsonlSource !== undefined && this.jsonlSource.lineNumber < document.lineCount) {
      return document.offsetAt(new vscode.Position(this.jsonlSource.lineNumber, 0));
    }
    return undefined;
  }

  private async revealInSource(context: JsonTreeNodeContext): Promise<void> {
    const uri = this.sourceUri();
    if (uri === undefined) return;
    // Decoded string content has no source range; reveal the string itself.
    let target: JsonTreeNodeContext | undefined = context;
    while (target !== undefined && target.node.offset === undefined) target = target.parent;
    if (target === undefined) return;

    const document = await vscode.workspace.openTextDocument(uri);
    if (this.parsedVersion === undefined || document.version !== this.parsedVersion) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t("The source changed after this tree was parsed. Refresh the tree, then try again."),
      );
      return;
    }
    const base = this.parsedTextOffset(document);
    if (base === undefined) return;
    const start = base + this.candidate.start + (target.node.offset as number);
    const range = new vscode.Range(
      document.positionAt(start),
      document.positionAt(start + (target.node.length ?? 0)),
    );
    const visible = vscode.window.visibleTextEditors.find(
      (editor) => editor.document.uri.toString() === uri.toString(),
    );
    const editor = await vscode.window.showTextDocument(document, {
      preview: false,
      viewColumn: visible?.viewColumn ?? vscode.ViewColumn.Beside,
      selection: range,
    });
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  private handleSourceEdit(event: vscode.TextDocumentChangeEvent): void {
    const uri = this.sourceUri();
    if (uri === undefined || event.contentChanges.length === 0 || event.document.uri.toString() !== uri.toString()) {
      return;
    }
    const changes: TextChange[] = event.contentChanges.map((change) => ({
      rangeOffset: change.rangeOffset,
      rangeLength: change.rangeLength,
      textLength: change.text.length,
      startLine: change.range.start.line,
      endLine: change.range.end.line,
      insertedLineBreaks: countLineBreaks(change.text),
    }));
    const document = event.document;
    const source = this.source;
    const jsonl = this.jsonlSource;

    if (jsonl !== undefined) {
      const update = trackLine(jsonl.lineNumber, changes);
      if (update.kind === "unchanged") return;
      const linked = this.parsedVersion !== undefined;
      jsonl.lineNumber = update.line;
      jsonl.lineCount = document.lineCount;
      this.title = vscode.l10n.t("JSON Tree · {0}:{1}", jsonl.sourceName, update.line + 1);
      this.pathLabel = vscode.l10n.t("$ · line {0}", update.line + 1);
      this.panel.title = this.title;
      if (update.kind === "deleted" || update.line >= document.lineCount) {
        this.parsedVersion = undefined;
        void this.postJsonlState(vscode.l10n.t("This record's line was deleted; showing the last parsed version"));
        return;
      }
      if (update.kind === "shifted") {
        // Same text on a new line: the tree stays valid for reveal and sync.
        if (linked) this.parsedVersion = document.version;
        void this.postJsonlState("");
        return;
      }
      this.scheduleRefresh(document.lineAt(update.line).text.length);
      return;
    }

    if (source?.scope === "selection") {
      if (source.endOffset === undefined) return;
      const update = trackRange(source.baseOffset, source.endOffset, changes);
      if (update.kind === "lost") {
        source.endOffset = undefined;
        this.parsedVersion = undefined;
        source.status = vscode.l10n.t("An edit crossed the selection's boundary; this tree is no longer linked to the source.");
        void this.postSourceState();
        return;
      }
      const linked = this.parsedVersion !== undefined;
      source.baseOffset = update.start;
      source.endOffset = update.end;
      if (update.kind === "shifted") {
        if (linked) this.parsedVersion = document.version;
        return;
      }
      this.scheduleRefresh(update.end - update.start);
      return;
    }

    this.scheduleRefresh(documentLength(document));
  }

  private scheduleRefresh(characters: number): void {
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
    if (characters > getLiveRefreshMaxCharacters()) {
      this.parsedVersion = undefined;
      if (this.source !== undefined) {
        this.source.status = vscode.l10n.t("The source changed.");
        this.source.canRefresh = true;
        void this.postSourceState();
      } else if (this.jsonlSource !== undefined) {
        void this.postJsonlState(vscode.l10n.t("This line is too large for live refresh; press Go to re-parse."));
      }
      return;
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshFromSource(false).catch((error: unknown) =>
        reportUnexpectedError(vscode.l10n.t("Refresh"), error));
    }, liveRefreshDelay(characters));
  }

  /**
   * Re-parses the same scope (whole document, tracked selection, or JSONL
   * line), keeps the most similar candidate, re-attaches inline-decoded
   * strings, and preserves the Webview's expansion by structure.
   */
  private async refreshFromSource(requested: boolean): Promise<void> {
    const uri = this.sourceUri();
    if (uri === undefined) return;
    const source = this.source;
    if (source?.scope === "selection" && source.endOffset === undefined) return;
    const generation = ++this.navigationGeneration;
    const document = await vscode.workspace.openTextDocument(uri);
    if (generation !== this.navigationGeneration) return;

    const jsonl = this.jsonlSource;
    if (jsonl !== undefined && jsonl.lineNumber >= document.lineCount) return;
    const text = jsonl !== undefined
      ? document.lineAt(jsonl.lineNumber).text
      : source?.scope === "selection"
        ? document.getText(new vscode.Range(document.positionAt(source.baseOffset), document.positionAt(source.endOffset as number)))
        : document.getText();
    const keepLast = vscode.l10n.t("showing the last valid version");
    let candidates: JsonCandidate[];
    try {
      assertInputSize(text);
      candidates = await parseJsonCandidatesAsync(text, getParseOptions());
    } catch (error) {
      if (!(error instanceof JsonProcessingLimitError)) throw error;
      this.parsedVersion = undefined;
      await this.setRefreshStatus(`${describeLimitError(error)} · ${keepLast}`);
      return;
    }
    if (generation !== this.navigationGeneration) return;
    if (candidates.length === 0) {
      this.parsedVersion = undefined;
      await this.setRefreshStatus(vscode.l10n.t("The source has no valid JSON; {0}", keepLast));
      return;
    }

    const previous = this.candidate;
    const decodedPaths = this.captureDecodedPaths();
    const next = candidates.reduce((best, candidate) =>
      Math.abs(candidate.start - previous.start) < Math.abs(best.start - previous.start) ? candidate : best);
    this.replaceCandidate(next, document.version);
    await this.reapplyDecodedPaths(decodedPaths);
    if (generation !== this.navigationGeneration) return;
    if (this.source !== undefined) {
      this.source.status = requested ? vscode.l10n.t("Refreshed") : "";
      this.source.canRefresh = false;
    }
    await this.postRender("", true);
  }

  private captureDecodedPaths(): StructuralPathStep[][] {
    const decodedPaths: StructuralPathStep[][] = [];
    walkJsonTree(this.candidate.tree, (node) => {
      if (node.decoded !== undefined) {
        const structural = this.index.structuralPath(node.id);
        if (structural !== undefined) decodedPaths.push(structural);
      }
    });
    return decodedPaths;
  }

  private async reapplyDecodedPaths(decodedPaths: StructuralPathStep[][]): Promise<void> {
    for (const structuralPath of decodedPaths) {
      const node = this.index.resolveStructuralPath(structuralPath);
      if (node?.type !== "string" || node.decoded !== undefined) continue;
      try {
        const decoded = await decodeInlineString(
          node.value as string,
          this.remainingNodeBudget(),
          async (all) => all[0],
        );
        if (decoded) this.index.attachDecoded(node.id, decoded);
      } catch (error) {
        if (!(error instanceof JsonProcessingLimitError)) throw error;
      }
    }
  }

  private async setRefreshStatus(status: string): Promise<void> {
    if (this.source !== undefined) {
      this.source.status = status;
      this.source.canRefresh = true;
      await this.postSourceState();
    } else {
      await this.postJsonlState(status);
    }
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
      await this.postJsonlState(vscode.l10n.t("Line {0} has no valid JSON", lineNumber + 1));
      return;
    }
    // Moving the cursor must never open a picker; Go/Prev/Next still offer one.
    const decodedPaths = source.keepView ? this.captureDecodedPaths() : [];
    this.updateJsonlCandidate(candidates[0], lineNumber, document.version);
    if (decodedPaths.length > 0) {
      await this.reapplyDecodedPaths(decodedPaths);
      if (generation !== this.navigationGeneration) return;
    }
    await this.postRender(
      candidates.length === 1
        ? ""
        : vscode.l10n.t("Showing candidate 1 of {0} · use Go to choose another", candidates.length.toLocaleString()),
      source.keepView,
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
    const root = webviewRoot(this.services.extensionUri);
    return renderWebviewHtml({
      nonce: createNonce(),
      cspSource: webview.cspSource,
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(root, "main.js")).toString(),
      styleUri: webview.asWebviewUri(vscode.Uri.joinPath(root, "tree.css")).toString(),
      language: vscode.env.language,
      l10nBundle: vscode.l10n.bundle,
      t: (message) => vscode.l10n.t(message),
    });
  }
}

/** Document character length without materializing the full text string. */
function documentLength(document: vscode.TextDocument): number {
  if (document.lineCount === 0) return 0;
  return document.offsetAt(document.lineAt(document.lineCount - 1).range.end);
}

function webviewDecoded(decoded: JsonTreeDecoded): NonNullable<RenderMessage["root"]["decoded"]> {
  const result: NonNullable<RenderMessage["root"]["decoded"]> = {
    root: createJsonTreeWebviewModel(decoded.root).root,
    unwrapDepth: decoded.unwrapDepth,
  };
  if (decoded.kind !== undefined && decoded.kind !== "json") result.kind = decoded.kind;
  if (decoded.recovery !== undefined) result.recovered = true;
  if (decoded.embedded) result.embedded = true;
  return result;
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
      void vscode.window.showErrorMessage(vscode.l10n.t("Cannot {0}: {1}", action, error.message));
      return;
    }
    throw error;
  }
}

function copyText(text: string, label: string): Promise<void> {
  return guardOutputSize(vscode.l10n.t("copy {0}", label), async () => {
    assertTransferTextSize(text);
    await vscode.env.clipboard.writeText(text);
  });
}

function copyPath(action: "copyJsonPath" | "copyJqPath", context: JsonTreeNodeContext): Promise<void> {
  if (context.hasDuplicateKeyInPath) {
    void vscode.window.showWarningMessage(action === "copyJsonPath"
      ? vscode.l10n.t("Cannot copy JSONPath: this path passes through a duplicate object key and is ambiguous.")
      : vscode.l10n.t("Cannot copy jq path: this path passes through a duplicate object key and is ambiguous."));
    return Promise.resolve();
  }
  const path = materializeJsonTreePath(context);
  return guardOutputSize(vscode.l10n.t("copy path"), async () => {
    const text = action === "copyJsonPath" ? formatJsonPathForTransfer(path) : formatJqPathForTransfer(path);
    await vscode.env.clipboard.writeText(text);
    if (action === "copyJsonPath" && isDecodedPath(path)) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t("JSONPath cannot cross an encoded string, so the copied path is relative to the decoded JSON."),
      );
    }
    if (action !== "copyJqPath") return;
    const crossed: JsonTreeDecoded[] = [];
    for (let ancestor: JsonTreeNodeContext | undefined = context; ancestor; ancestor = ancestor.parent) {
      if (ancestor.decodedFrom !== undefined) crossed.push(ancestor.decodedFrom);
    }
    if (crossed.some((decoded) => isNonJsonDecodedKind(decoded.kind))) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t("This path crosses a decoded non-JSON string; jq's fromjson cannot parse that format directly."),
      );
    } else if (crossed.some((decoded) => decoded.recovery !== undefined)) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t("This path crosses a recovered partial JSON string; jq's fromjson will reject the damaged original."),
      );
    } else if (crossed.some((decoded) => decoded.embedded)) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t("This path crosses a string with text around its JSON; jq's fromjson cannot parse that string as is."),
      );
    }
  });
}

function copyValue(node: JsonTreeNode): Promise<void> {
  return guardOutputSize(vscode.l10n.t("copy value"), async () => {
    const serialized = stringifyJsonTreeForTransfer(node);
    await vscode.env.clipboard.writeText(serialized.text);
    if (serialized.compacted) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t("Copied compact JSON because pretty-formatted output would be too large."),
      );
    }
  });
}

/** Opens only http(s) links; VS Code still asks before opening untrusted domains. */
async function openLink(value: string): Promise<void> {
  const text = value.trim();
  if (!/^https?:\/\/\S+$/i.test(text)) return;
  let uri: vscode.Uri;
  try {
    uri = vscode.Uri.parse(text, true);
  } catch {
    return;
  }
  if (uri.scheme === "http" || uri.scheme === "https") await vscode.env.openExternal(uri);
}

function countTreeNodes(root: JsonTreeNode): number {
  let count = 0;
  walkJsonTree(root, () => {
    count += 1;
  });
  return count;
}

function openPlainText(text: string, actionLabel: string): Promise<void> {
  return guardOutputSize(actionLabel, async () => {
    assertTransferTextSize(text);
    const document = await vscode.workspace.openTextDocument({ content: text, language: "plaintext" });
    await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.Beside });
  });
}

function openDecodedValue(node: JsonTreeNode): Promise<void> {
  return openPlainText(node.value as string, vscode.l10n.t("open decoded string"));
}

function openFormattedNodeJson(node: JsonTreeNode): Promise<void> {
  return guardOutputSize(vscode.l10n.t("open formatted JSON"), async () => {
    const serialized = stringifyJsonTreeForTransfer(node);
    const document = await vscode.workspace.openTextDocument({ content: serialized.text, language: "json" });
    await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.Beside });
    if (serialized.compacted) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t("Opened compact JSON because pretty-formatted output would be too large."),
      );
    }
  });
}

function openParsedJson(selected: JsonCandidate): Promise<void> {
  return guardOutputSize(vscode.l10n.t("open parsed JSON"), async () => {
    const serialized = stringifyJsonTreeForTransfer(selected.tree);
    const document = await vscode.workspace.openTextDocument({ content: serialized.text, language: "json" });
    await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.Beside });
    if (selected.recovery) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t("Opened a recovered JSON subset. Damaged or missing values were omitted; array indices refer to the recovered subset, not the original source."),
      );
    }
    if (serialized.compacted) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t("Opened compact JSON because pretty-formatted output would be too large."),
      );
    }
  });
}

interface PanelMessage {
  type: string;
  nodeId?: unknown;
  lineNumber?: unknown;
  enabled?: unknown;
  renderKey?: unknown;
  query?: unknown;
  mode?: unknown;
  format?: unknown;
  flatten?: unknown;
  target?: unknown;
  rowIndices?: unknown;
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

import type { JsonTreeWebviewNode } from "./jsonTree";
import type { JsonRecovery } from "./parser";
import type { TableModel } from "./tableData";

/** Messages shared by the Extension Host panel and the bundled Webview script. */

export type NodeAction =
  | "openNested"
  | "openParsedJson"
  | "openDecodedValue"
  | "openSubtree"
  | "openFormattedJson"
  | "openArrayTable"
  | "copyValue"
  | "copyRawString"
  | "copyDecodedString"
  | "copyKey"
  | "copyRawKey"
  | "copyJsonPath"
  | "copyJqPath"
  | "openLink"
  | "revealInSource"
  | "expandDecoded"
  | "inspectNode"
  | "generateTypes"
  | "diffSubtreeWithClipboard";

export const NODE_ACTIONS: ReadonlySet<string> = new Set<NodeAction>([
  "openNested",
  "openParsedJson",
  "openDecodedValue",
  "openSubtree",
  "openFormattedJson",
  "openArrayTable",
  "copyValue",
  "copyRawString",
  "copyDecodedString",
  "copyKey",
  "copyRawKey",
  "copyJsonPath",
  "copyJqPath",
  "openLink",
  "revealInSource",
  "expandDecoded",
  "inspectNode",
  "generateTypes",
  "diffSubtreeWithClipboard",
]);

export type TableExportFormat = "csv" | "tsv" | "markdown";

export interface JsonlViewState {
  lineNumber: number;
  lineCount: number;
  followCursor: boolean;
  keepView?: boolean;
  filterQuery?: string;
  status: string;
  busy?: boolean;
}

/** Link between a document-backed tree and its source editor. */
export interface SourceViewState {
  /** Tree nodes can be revealed in, and follow, the source editor. */
  linked: boolean;
  syncCursor: boolean;
  status: string;
  /** The source changed and the tree can be re-parsed on request. */
  canRefresh: boolean;
}

/** Serializable source descriptor persisted in Webview state for panel revival. */
export interface PanelSourceDescriptor {
  kind: "document" | "jsonl";
  uri: string;
  lineNumber?: number;
}

export interface RenderDiffSummary {
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
}

export interface RenderDiffNodeAnnotation {
  status: "added" | "removed" | "changed";
  oldRaw?: string;
}

export interface RenderDiffPayload {
  summary: RenderDiffSummary;
  annotations: Record<number, RenderDiffNodeAnnotation>;
}

export interface RenderMessage {
  type: "render";
  /** Changes whenever the panel shows a different value; keys saved Webview state. */
  renderKey: number;
  root: JsonTreeWebviewNode;
  title: string;
  pathLabel: string;
  truncatedFieldCount: number;
  recovery?: JsonRecovery;
  autoExpand: boolean;
  canExpandAll: boolean;
  expandAllLimit: number;
  jsonl?: JsonlViewState;
  /** Present for trees parsed from a document or selection (not JSONL panels). */
  source?: SourceViewState;
  /** Serializable source identity for WebviewPanelSerializer revival. */
  panelSource?: PanelSourceDescriptor;
  /** Structural diff annotations when displaying a tree comparison. */
  diff?: RenderDiffPayload;
  /** The same source was re-parsed: keep expansion, search, and scroll by structure. */
  preserveView?: boolean;
}

export interface JsonlStateMessage extends JsonlViewState {
  type: "jsonlState";
}

export interface SourceStateMessage extends SourceViewState {
  type: "sourceState";
}

export interface DecodedMessage {
  type: "decoded";
  nodeId: number;
  decoded: NonNullable<JsonTreeWebviewNode["decoded"]>;
}

export interface DecodeFailedMessage {
  type: "decodeFailed";
  nodeId: number;
  /** True when the user dismissed a picker rather than the string failing to decode. */
  cancelled?: boolean;
}

/** Strings decoded so search can cover them; owners are nodes the Webview already has. */
export interface DecodedBatchMessage {
  type: "decodedBatch";
  renderKey: number;
  items: Array<{ nodeId: number; decoded: NonNullable<JsonTreeWebviewNode["decoded"]> }>;
  decodedCount: number;
  /** A string or node budget stopped decoding early. */
  limited: boolean;
}

/** Expands every ancestor and highlights the node; IDs run from the root down. */
export interface RevealNodeMessage {
  type: "revealNode";
  ids: number[];
}

export interface TableDataMessage {
  type: "tableData";
  table: TableModel;
}

export interface NodeInspectionMessage {
  type: "nodeInspection";
  nodeId: number;
  path: string;
  nodeType: string;
  fullValue: string;
  rawToken?: string;
  byteLength: number;
  charLength: number;
  lineCount: number;
  childCount?: number;
}

export type HostToWebviewMessage =
  | RenderMessage
  | JsonlStateMessage
  | SourceStateMessage
  | DecodedMessage
  | DecodeFailedMessage
  | DecodedBatchMessage
  | RevealNodeMessage
  | TableDataMessage
  | NodeInspectionMessage;

export type WebviewToHostMessage =
  | { type: "ready" }
  | { type: NodeAction; nodeId: number }
  | { type: "setFollowCursor"; enabled: boolean }
  | { type: "setKeepView"; enabled: boolean }
  | { type: "setSyncCursor"; enabled: boolean }
  | { type: "refreshSource" }
  | { type: "decodeAllForSearch"; renderKey: number }
  | { type: "setJsonlFilter"; query: string }
  | { type: "listJsonlMatches"; query: string }
  | { type: "openJsonlTable"; query: string }
  | { type: "exportTable"; mode: "copy" | "open"; rowIndices: number[]; format?: TableExportFormat }
  | { type: "reopenTable"; flatten: boolean }
  | { type: "diffWithClipboard" }
  | { type: "diffJsonlPrevious" }
  | { type: "savePanelViewState"; state: unknown }
  | { type: "revealSource" }
  | { type: "previousJsonl" | "nextJsonl"; query?: string }
  | { type: "goToJsonlLine"; lineNumber: number };

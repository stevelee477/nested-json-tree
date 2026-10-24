import type { JsonTreeWebviewNode } from "./jsonTree";
import type { JsonRecovery } from "./parser";

/** Messages shared by the Extension Host panel and the bundled Webview script. */

export type NodeAction =
  | "openNested"
  | "openParsedJson"
  | "openDecodedValue"
  | "copyValue"
  | "copyRawString"
  | "copyDecodedString"
  | "copyKey"
  | "copyRawKey"
  | "copyJsonPath"
  | "copyJqPath"
  | "openLink"
  | "revealInSource"
  | "expandDecoded";

export const NODE_ACTIONS: ReadonlySet<string> = new Set<NodeAction>([
  "openNested",
  "openParsedJson",
  "openDecodedValue",
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
]);

export interface JsonlViewState {
  lineNumber: number;
  lineCount: number;
  followCursor: boolean;
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
}

/** Expands every ancestor and highlights the node; IDs run from the root down. */
export interface RevealNodeMessage {
  type: "revealNode";
  ids: number[];
}

export type HostToWebviewMessage =
  | RenderMessage
  | JsonlStateMessage
  | SourceStateMessage
  | DecodedMessage
  | DecodeFailedMessage
  | RevealNodeMessage;

export type WebviewToHostMessage =
  | { type: "ready" }
  | { type: NodeAction; nodeId: number }
  | { type: "setFollowCursor"; enabled: boolean }
  | { type: "setSyncCursor"; enabled: boolean }
  | { type: "refreshSource" }
  | { type: "revealSource" | "previousJsonl" | "nextJsonl" }
  | { type: "goToJsonlLine"; lineNumber: number };

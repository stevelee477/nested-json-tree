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
  | "copyJqPath";

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
]);

export interface JsonlViewState {
  lineNumber: number;
  lineCount: number;
  followCursor: boolean;
  status: string;
  busy?: boolean;
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
}

export interface JsonlStateMessage extends JsonlViewState {
  type: "jsonlState";
}

export type HostToWebviewMessage = RenderMessage | JsonlStateMessage;

export type WebviewToHostMessage =
  | { type: "ready" }
  | { type: NodeAction; nodeId: number }
  | { type: "setFollowCursor"; enabled: boolean }
  | { type: "revealSource" | "previousJsonl" | "nextJsonl" }
  | { type: "goToJsonlLine"; lineNumber: number };

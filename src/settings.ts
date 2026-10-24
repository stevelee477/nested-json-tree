import * as vscode from "vscode";
import { JsonParseOptions, JsonProcessingLimitError, JsonValueNodeLimitError } from "./parser";

const SECTION = "nestedJsonTree";

export function getParseOptions(): JsonParseOptions {
  return {
    maxValueNodes: vscode.workspace.getConfiguration(SECTION).get<number>("maxValueNodes"),
  };
}

export function getAutoExpandMaxNodes(): number {
  return vscode.workspace.getConfiguration(SECTION).get<number>("autoExpandMaxNodes", 200);
}

/** User-facing text for a parser limit, pointing at the setting that can raise it. */
export function describeLimitError(error: JsonProcessingLimitError): string {
  return error instanceof JsonValueNodeLimitError
    ? `${error.message} You can raise \`${SECTION}.maxValueNodes\` in Settings.`
    : error.message;
}

/** Last-resort reporting so a failed command or Webview action is never silent. */
export function reportUnexpectedError(action: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`[Nested JSON Tree] ${action} failed`, error);
  void vscode.window.showErrorMessage(`Nested JSON Tree: ${action} failed: ${detail}`);
}

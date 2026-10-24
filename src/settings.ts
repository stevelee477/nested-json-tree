import * as vscode from "vscode";
import {
  InputTooLargeError,
  JsonCandidateLimitError,
  JsonContainerScanLimitError,
  JsonNestingTooDeepError,
  JsonParseOptions,
  JsonProcessingLimitError,
  JsonValueNodeLimitError,
  MAX_INPUT_BYTES,
} from "./parser";

const SECTION = "nestedJsonTree";

export function getParseOptions(): JsonParseOptions {
  return {
    maxValueNodes: vscode.workspace.getConfiguration(SECTION).get<number>("maxValueNodes"),
  };
}

export function getAutoExpandMaxNodes(): number {
  return vscode.workspace.getConfiguration(SECTION).get<number>("autoExpandMaxNodes", 200);
}

/**
 * Localized text for a parser limit, pointing at the setting that can raise
 * it. The parser stays VS Code-free, so its own messages are English only.
 */
export function describeLimitError(error: JsonProcessingLimitError): string {
  if (error instanceof InputTooLargeError) {
    return vscode.l10n.t("Input is {0}; the limit is {1}.", formatMegabytes(error.actualBytes), formatMegabytes(MAX_INPUT_BYTES));
  }
  if (error instanceof JsonNestingTooDeepError) {
    return vscode.l10n.t("JSON nesting exceeds the safe limit of {0} levels. Use a less deeply nested value.", error.maxDepth.toLocaleString());
  }
  if (error instanceof JsonContainerScanLimitError) {
    return vscode.l10n.t(
      "The surrounding text contains more than {0} potential JSON containers. Use a smaller document or open one JSONL/NDJSON line.",
      error.maxSpans.toLocaleString(),
    );
  }
  if (error instanceof JsonValueNodeLimitError) {
    return vscode.l10n.t(
      "JSON data contains more than {0} value nodes in total. You can raise `{1}` in Settings, or split the data into JSONL/NDJSON lines.",
      error.maxNodes.toLocaleString(),
      `${SECTION}.maxValueNodes`,
    );
  }
  if (error instanceof JsonCandidateLimitError) {
    return vscode.l10n.t(
      "More than {0} JSON candidates were found. Use a smaller document or open one JSONL/NDJSON line.",
      error.maxCandidates.toLocaleString(),
    );
  }
  return error.message;
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Last-resort reporting so a failed command or Webview action is never silent. */
export function reportUnexpectedError(action: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`[Nested JSON Tree] ${action} failed`, error);
  void vscode.window.showErrorMessage(vscode.l10n.t("Nested JSON Tree: {0} failed: {1}", action, detail));
}

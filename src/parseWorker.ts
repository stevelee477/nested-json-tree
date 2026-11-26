import { parentPort } from "node:worker_threads";
import {
  InputTooLargeError,
  JsonCandidate,
  JsonCandidateLimitError,
  JsonContainerScanLimitError,
  JsonNestingTooDeepError,
  JsonParseOptions,
  JsonValueNodeLimitError,
  assertInputSize,
  parseJsonCandidates,
  parseNestedJsonCandidates,
} from "./parser";

export type ParseWorkerMode = "candidates" | "nested";

export interface ParseWorkerRequest {
  id: number;
  mode?: ParseWorkerMode;
  text: string;
  options: JsonParseOptions;
  /** True when the host already validated `assertInputSize(text)` before IPC. */
  sizeChecked?: boolean;
}

export type SerializedLimitError =
  | { kind: "InputTooLargeError"; actualBytes: number }
  | { kind: "JsonNestingTooDeepError"; maxDepth: number }
  | { kind: "JsonContainerScanLimitError"; maxSpans: number }
  | { kind: "JsonValueNodeLimitError"; maxNodes: number }
  | { kind: "JsonCandidateLimitError"; maxCandidates: number };

export type ParseWorkerResponse =
  | { id: number; ok: true; candidates: JsonCandidate[] }
  | { id: number; ok: false; limitError?: SerializedLimitError; errorMessage?: string };

function serializeLimitError(error: unknown): SerializedLimitError | undefined {
  if (error instanceof InputTooLargeError) {
    return { kind: "InputTooLargeError", actualBytes: error.actualBytes };
  }
  if (error instanceof JsonNestingTooDeepError) {
    return { kind: "JsonNestingTooDeepError", maxDepth: error.maxDepth };
  }
  if (error instanceof JsonContainerScanLimitError) {
    return { kind: "JsonContainerScanLimitError", maxSpans: error.maxSpans };
  }
  if (error instanceof JsonValueNodeLimitError) {
    return { kind: "JsonValueNodeLimitError", maxNodes: error.maxNodes };
  }
  if (error instanceof JsonCandidateLimitError) {
    return { kind: "JsonCandidateLimitError", maxCandidates: error.maxCandidates };
  }
  return undefined;
}

parentPort?.on("message", (request: ParseWorkerRequest) => {
  try {
    if (!request.sizeChecked) {
      assertInputSize(request.text);
    }
    const candidates = request.mode === "nested"
      ? parseNestedJsonCandidates(request.text, request.options)
      : parseJsonCandidates(request.text, request.options);
    parentPort?.postMessage({ id: request.id, ok: true, candidates } satisfies ParseWorkerResponse);
  } catch (error: unknown) {
    const limitError = serializeLimitError(error);
    if (limitError !== undefined) {
      parentPort?.postMessage({ id: request.id, ok: false, limitError } satisfies ParseWorkerResponse);
    } else {
      const errorMessage = error instanceof Error ? error.message : String(error);
      parentPort?.postMessage({ id: request.id, ok: false, errorMessage } satisfies ParseWorkerResponse);
    }
  }
});

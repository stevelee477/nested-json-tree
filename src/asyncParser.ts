import { existsSync } from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import {
  InputTooLargeError,
  JsonCandidate,
  JsonCandidateLimitError,
  JsonContainerScanLimitError,
  JsonNestingTooDeepError,
  JsonParseOptions,
  JsonProcessingLimitError,
  JsonValueNodeLimitError,
  assertInputSize,
  parseJsonCandidates,
} from "./parser";
import type { ParseWorkerRequest, ParseWorkerResponse, SerializedLimitError } from "./parseWorker";

export const WORKER_PARSE_THRESHOLD_CHARS = 250_000;

interface PendingRequest {
  resolve: (candidates: JsonCandidate[]) => void;
  reject: (error: Error) => void;
}

let activeWorker: Worker | undefined;
let nextRequestId = 1;
const pending = new Map<number, PendingRequest>();

function deserializeLimitError(error: SerializedLimitError): JsonProcessingLimitError {
  switch (error.kind) {
    case "InputTooLargeError":
      return new InputTooLargeError(error.actualBytes);
    case "JsonNestingTooDeepError":
      return new JsonNestingTooDeepError(error.maxDepth);
    case "JsonContainerScanLimitError":
      return new JsonContainerScanLimitError(error.maxSpans);
    case "JsonValueNodeLimitError":
      return new JsonValueNodeLimitError(error.maxNodes);
    case "JsonCandidateLimitError":
      return new JsonCandidateLimitError(error.maxCandidates);
  }
}

function rejectAllPending(error: Error): void {
  for (const request of pending.values()) request.reject(error);
  pending.clear();
}

function getWorker(): Worker | undefined {
  if (activeWorker !== undefined) return activeWorker;
  const workerPath = path.join(__dirname, "parseWorker.js");
  if (!existsSync(workerPath)) return undefined;

  const worker = new Worker(workerPath);
  worker.unref();
  worker.on("message", (response: ParseWorkerResponse) => {
    const entry = pending.get(response.id);
    if (entry === undefined) return;
    pending.delete(response.id);
    if (pending.size === 0) worker.unref();
    if (response.ok) {
      entry.resolve(response.candidates);
    } else if (response.limitError !== undefined) {
      entry.reject(deserializeLimitError(response.limitError));
    } else {
      entry.reject(new Error(response.errorMessage ?? "Worker parse failed."));
    }
  });
  worker.on("error", (error: Error) => {
    if (activeWorker === worker) activeWorker = undefined;
    rejectAllPending(error);
  });
  worker.on("exit", (code) => {
    if (activeWorker === worker) activeWorker = undefined;
    if (pending.size > 0) {
      rejectAllPending(new Error(`Parse worker exited unexpectedly with code ${code}.`));
    }
  });
  activeWorker = worker;
  return worker;
}

/**
 * Parses large JSON documents on a reusable Node worker thread so the Extension
 * Host stays responsive; smaller inputs run synchronously without IPC overhead.
 */
export async function parseJsonCandidatesAsync(
  text: string,
  options: JsonParseOptions = {},
): Promise<JsonCandidate[]> {
  assertInputSize(text);
  if (text.length < WORKER_PARSE_THRESHOLD_CHARS) {
    return parseJsonCandidates(text, options);
  }
  const worker = getWorker();
  if (worker === undefined) {
    return parseJsonCandidates(text, options);
  }
  const id = nextRequestId;
  nextRequestId += 1;
  return new Promise<JsonCandidate[]>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.ref();
    const request: ParseWorkerRequest = { id, text, options };
    worker.postMessage(request);
  });
}

export async function disposeParseWorker(): Promise<void> {
  const worker = activeWorker;
  activeWorker = undefined;
  rejectAllPending(new Error("Parse worker disposed."));
  if (worker !== undefined) {
    await worker.terminate();
  }
}

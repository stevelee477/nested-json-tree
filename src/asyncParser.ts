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
  parseNestedJsonCandidates,
} from "./parser";
import type { ParseWorkerMode, ParseWorkerRequest, ParseWorkerResponse, SerializedLimitError } from "./parseWorker";

export const WORKER_PARSE_THRESHOLD_CHARS = 250_000;
export const DEFAULT_WORKER_IDLE_TIMEOUT_MS = 60_000;

interface PendingRequest {
  resolve: (candidates: JsonCandidate[]) => void;
  reject: (error: Error) => void;
}

let activeWorker: Worker | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let workerIdleTimeoutMs = DEFAULT_WORKER_IDLE_TIMEOUT_MS;
let nextRequestId = 1;
const pending = new Map<number, PendingRequest>();

function clearIdleTimer(): void {
  if (idleTimer !== undefined) {
    clearTimeout(idleTimer);
    idleTimer = undefined;
  }
}

function scheduleIdleTermination(worker: Worker): void {
  clearIdleTimer();
  idleTimer = setTimeout(() => {
    idleTimer = undefined;
    if (activeWorker === worker && pending.size === 0) {
      activeWorker = undefined;
      void worker.terminate();
    }
  }, workerIdleTimeoutMs);
  idleTimer.unref();
}

/**
 * Configures how long an idle parse worker is kept alive before terminating so
 * large V8 heaps are reclaimed after idle periods. Exposed for unit tests.
 */
export function setParseWorkerIdleTimeoutMs(timeoutMs: number): void {
  workerIdleTimeoutMs = Number.isFinite(timeoutMs)
    ? Math.max(0, Math.trunc(timeoutMs))
    : DEFAULT_WORKER_IDLE_TIMEOUT_MS;
  if (activeWorker !== undefined && pending.size === 0) {
    scheduleIdleTermination(activeWorker);
  }
}

export function getParseWorkerIdleTimeoutMs(): number {
  return workerIdleTimeoutMs;
}

export function hasActiveParseWorker(): boolean {
  return activeWorker !== undefined;
}

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
    if (pending.size === 0) {
      worker.unref();
      scheduleIdleTermination(worker);
    }
    if (response.ok) {
      entry.resolve(response.candidates);
    } else if (response.limitError !== undefined) {
      entry.reject(deserializeLimitError(response.limitError));
    } else {
      entry.reject(new Error(response.errorMessage ?? "Worker parse failed."));
    }
  });
  worker.on("error", (error: Error) => {
    if (activeWorker === worker) {
      activeWorker = undefined;
      clearIdleTimer();
    }
    rejectAllPending(error);
  });
  worker.on("exit", (code) => {
    if (activeWorker === worker) {
      activeWorker = undefined;
      clearIdleTimer();
    }
    if (pending.size > 0) {
      rejectAllPending(new Error(`Parse worker exited unexpectedly with code ${code}.`));
    }
  });
  activeWorker = worker;
  return worker;
}

function runOnWorkerOrSync(
  mode: ParseWorkerMode,
  text: string,
  options: JsonParseOptions,
  syncFallback: (input: string, opts: JsonParseOptions) => JsonCandidate[],
): Promise<JsonCandidate[]> {
  assertInputSize(text);
  if (text.length < WORKER_PARSE_THRESHOLD_CHARS) {
    return Promise.resolve(syncFallback(text, options));
  }
  const worker = getWorker();
  if (worker === undefined) {
    return Promise.resolve(syncFallback(text, options));
  }
  clearIdleTimer();
  const id = nextRequestId;
  nextRequestId += 1;
  return new Promise<JsonCandidate[]>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.ref();
    const request: ParseWorkerRequest = { id, mode, text, options, sizeChecked: true };
    worker.postMessage(request);
  });
}

/**
 * Parses large JSON documents on a reusable Node worker thread so the Extension
 * Host stays responsive; smaller inputs run synchronously without IPC overhead.
 */
export async function parseJsonCandidatesAsync(
  text: string,
  options: JsonParseOptions = {},
): Promise<JsonCandidate[]> {
  return runOnWorkerOrSync("candidates", text, options, parseJsonCandidates);
}

/**
 * Unwraps and parses large nested/escaped JSON strings on the reusable worker
 * thread; smaller strings run synchronously on the calling thread.
 */
export async function parseNestedJsonCandidatesAsync(
  text: string,
  options: JsonParseOptions = {},
): Promise<JsonCandidate[]> {
  return runOnWorkerOrSync("nested", text, options, parseNestedJsonCandidates);
}

export async function disposeParseWorker(): Promise<void> {
  clearIdleTimer();
  const worker = activeWorker;
  activeWorker = undefined;
  rejectAllPending(new Error("Parse worker disposed."));
  if (worker !== undefined) {
    await worker.terminate();
  }
}

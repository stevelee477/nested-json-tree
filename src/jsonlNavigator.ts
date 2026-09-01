import {
  JsonCandidate,
  JsonProcessingLimitError,
  assertInputSize,
  parseJsonCandidates,
} from "./parser";

export interface JsonlLineSource {
  readonly lineCount: number;
  lineAt(lineNumber: number): string;
}

export interface JsonlRecord {
  lineNumber: number;
  candidates: JsonCandidate[];
  skippedLines: number;
}

export type JsonlNavigationResult =
  | { status: "found"; record: JsonlRecord }
  | { status: "not-found"; scannedLines: number }
  | { status: "cancelled"; scannedLines: number };

export interface JsonlNavigationOptions {
  batchSize?: number;
  isCancelled?: () => boolean;
  parseLine?: (text: string) => JsonCandidate[];
  yieldToEventLoop?: () => Promise<void>;
}

const DEFAULT_SCAN_BATCH_SIZE = 250;

/**
 * Finds one valid JSONL record without joining or parsing the full document.
 * Empty, invalid, and resource-limited lines are skipped. Work is yielded in
 * bounded batches so a long invalid region does not monopolize the Extension
 * Host event loop.
 */
export async function findJsonlRecord(
  source: JsonlLineSource,
  startLine: number,
  direction: -1 | 1,
  options: JsonlNavigationOptions = {},
): Promise<JsonlNavigationResult> {
  const batchSize = Number.isFinite(options.batchSize)
    ? Math.max(1, Math.trunc(options.batchSize as number))
    : DEFAULT_SCAN_BATCH_SIZE;
  const isCancelled = options.isCancelled ?? (() => false);
  const parseLine = options.parseLine ?? ((text: string) => {
    assertInputSize(text);
    return parseJsonCandidates(text);
  });
  const yieldToEventLoop = options.yieldToEventLoop ?? yieldToExtensionHost;
  let scannedLines = 0;
  let lineNumber = startLine;

  while (lineNumber >= 0 && lineNumber < source.lineCount) {
    if (isCancelled()) return { status: "cancelled", scannedLines };

    let candidates: JsonCandidate[];
    try {
      candidates = parseLine(source.lineAt(lineNumber));
    } catch (error) {
      if (error instanceof JsonProcessingLimitError) candidates = [];
      else throw error;
    }
    scannedLines += 1;
    if (candidates.length > 0) {
      return {
        status: "found",
        record: {
          lineNumber,
          candidates,
          skippedLines: scannedLines - 1,
        },
      };
    }

    lineNumber += direction;
    if (scannedLines % batchSize === 0) {
      await yieldToEventLoop();
    }
  }

  return { status: "not-found", scannedLines };
}

function yieldToExtensionHost(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

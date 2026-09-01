import assert from "node:assert/strict";
import test from "node:test";
import { findJsonlRecord } from "../jsonlNavigator";
import { JsonProcessingLimitError, parseJsonCandidates } from "../parser";

function lines(...values: string[]) {
  return {
    lineCount: values.length,
    lineAt: (lineNumber: number) => values[lineNumber],
  };
}

test("finds the next valid JSONL record while skipping empty and invalid lines", async () => {
  const result = await findJsonlRecord(
    lines('{"first":1}', "", "not json", '{"next":2}'),
    1,
    1,
  );

  assert.equal(result.status, "found");
  if (result.status !== "found") return;
  assert.equal(result.record.lineNumber, 3);
  assert.equal(result.record.skippedLines, 2);
  assert.deepEqual(result.record.candidates[0].value, { next: 2 });
});

test("finds previous records and stops at document boundaries", async () => {
  const source = lines('{"first":1}', "", '{"last":3}');
  const previous = await findJsonlRecord(source, 1, -1);
  const beforeStart = await findJsonlRecord(source, -1, -1);
  const afterEnd = await findJsonlRecord(source, source.lineCount, 1);

  assert.equal(previous.status, "found");
  if (previous.status === "found") assert.equal(previous.record.lineNumber, 0);
  assert.deepEqual(beforeStart, { status: "not-found", scannedLines: 0 });
  assert.deepEqual(afterEnd, { status: "not-found", scannedLines: 0 });
});

test("yields between bounded scan batches", async () => {
  let yields = 0;
  const result = await findJsonlRecord(lines("", "", "", "", '{"ok":true}'), 0, 1, {
    batchSize: 2,
    yieldToEventLoop: async () => {
      yields += 1;
    },
  });

  assert.equal(result.status, "found");
  assert.equal(yields, 2);
});

test("cancels a long scan after yielding", async () => {
  let cancelled = false;
  const result = await findJsonlRecord(lines("", "", "", ""), 0, 1, {
    batchSize: 2,
    isCancelled: () => cancelled,
    yieldToEventLoop: async () => {
      cancelled = true;
    },
  });

  assert.deepEqual(result, { status: "cancelled", scannedLines: 2 });
});

test("skips lines rejected by parser resource limits", async () => {
  class TestLimitError extends JsonProcessingLimitError {}
  const result = await findJsonlRecord(lines("oversized", '{"ok":true}'), 0, 1, {
    parseLine: (text) => {
      if (text === "oversized") throw new TestLimitError("limited");
      return parseJsonCandidates(text);
    },
  });

  assert.equal(result.status, "found");
  if (result.status === "found") {
    assert.equal(result.record.lineNumber, 1);
    assert.equal(result.record.skippedLines, 1);
  }
});

test("does not hide unexpected parser errors", async () => {
  await assert.rejects(
    findJsonlRecord(lines("boom"), 0, 1, {
      parseLine: () => {
        throw new Error("unexpected");
      },
    }),
    /unexpected/,
  );
});

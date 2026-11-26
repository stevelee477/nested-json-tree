import assert from "node:assert/strict";
import test from "node:test";
import { jsonTreeToValue } from "../jsonTree";
import {
  candidateMatchesFilter,
  findJsonlRecord,
  lineMightMatchFilter,
  parseJsonlFilter,
  searchJsonlLines,
} from "../jsonlNavigator";
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
  assert.deepEqual(jsonTreeToValue(result.record.candidates[0].tree), { next: 2 });
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


test("JSONL navigation includes recoverable lines and multiple values on a line", async () => {
  const result = await findJsonlRecord(lines("noise", '{"id":1,"bad":oops} {"next":2}'), 0, 1);
  assert.equal(result.status, "found");
  if (result.status !== "found") return;
  assert.equal(result.record.lineNumber, 1);
  assert.deepEqual(result.record.candidates.map((candidate) => jsonTreeToValue(candidate.tree)), [{ id: 1 }, { next: 2 }]);
  assert.ok(result.record.candidates[0].recovery);
  assert.equal(result.record.candidates[1].recovery, undefined);
});

test("parseJsonlFilter, lineMightMatchFilter, and filtered navigation support text and key=value terms", async () => {
  const filter = parseJsonlFilter('level=ERROR user.id=42 msg="order failed"');
  assert.ok(filter);
  assert.equal(filter.terms.length, 3);

  const source = lines(
    '{"level":"INFO","user":{"id":42},"msg":"order failed"}',
    '{"level":"ERROR","user":{"id":420},"msg":"order failed"}',
    '{"level":"ERROR","user":{"id":42},"msg":"order \\u0066ailed for item"}',
  );
  assert.equal(lineMightMatchFilter(source.lineAt(0), filter), false);
  // Escaped line bypasses pre-check so decoded string matches still work.
  assert.equal(lineMightMatchFilter(source.lineAt(2), filter), true);
  assert.equal(candidateMatchesFilter(parseJsonCandidates(source.lineAt(1))[0], filter), false);

  const found = await findJsonlRecord(source, 0, 1, { filter });
  assert.equal(found.status, "found");
  if (found.status !== "found") return;
  assert.equal(found.record.lineNumber, 2);
  assert.equal(found.record.skippedLines, 2);

  const listed = await searchJsonlLines(source, { filter });
  assert.equal(listed.status, "done");
  assert.deepEqual(listed.matches.map((m) => m.lineNumber), [2]);
});

test("lineMightMatchFilter skips non-matching lines with JSON escapes while keeping 100% recall on escaped quotes, slashes, and newlines", async () => {
  const logLines: string[] = [];
  for (let i = 0; i < 500; i += 1) {
    logLines.push(`{"level":"INFO","payload":"{\\"req\\":${i},\\"msg\\":\\"line 1\\\\nline 2\\"}"}`);
  }
  // Line 500: escaped quotes (`\"`), escaped slashes (`\/`), and escaped newline (`\n`)
  logLines.push(
    '{"level":"ERROR","url":"https:\\/\\/api.example.com\\/v1","detail":"order \\"failed\\"\\nretry","payload":"{\\"code\\":503}"}',
  );

  const filter = parseJsonlFilter('level=error "https://api.example.com/v1" \'order "failed"\' 503');
  assert.ok(filter);

  assert.equal(lineMightMatchFilter(logLines[0], filter), false);
  assert.equal(lineMightMatchFilter(logLines[500], filter), true);

  let parsedCount = 0;
  const result = await searchJsonlLines(lines(...logLines), {
    filter,
    parseLine: (text) => {
      parsedCount += 1;
      return parseJsonCandidates(text);
    },
  });

  assert.equal(result.status, "done");
  assert.deepEqual(result.matches.map((m) => m.lineNumber), [500]);
  // All 500 non-matching lines with \" and \n escapes skipped AST parsing completely!
  assert.equal(parsedCount, 1);
});

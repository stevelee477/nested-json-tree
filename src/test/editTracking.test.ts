import assert from "node:assert/strict";
import test from "node:test";
import { TextChange, countLineBreaks, trackLine, trackRange } from "../editTracking";

/** Builds a change for a document whose lines are all `width` characters plus "\n". */
function change(rangeOffset: number, rangeLength: number, text: string, width = 9): TextChange {
  const lineOf = (offset: number) => Math.floor(offset / (width + 1));
  return {
    rangeOffset,
    rangeLength,
    textLength: text.length,
    startLine: lineOf(rangeOffset),
    endLine: lineOf(rangeOffset + rangeLength),
    insertedLineBreaks: countLineBreaks(text),
  };
}

test("a selection range shifts with edits before it and ignores edits after it", () => {
  assert.deepEqual(trackRange(20, 30, [change(5, 0, "abc")]), { kind: "shifted", start: 23, end: 33 });
  assert.deepEqual(trackRange(20, 30, [change(0, 10, "")]), { kind: "shifted", start: 10, end: 20 });
  assert.deepEqual(trackRange(20, 30, [change(40, 5, "xyz")]), { kind: "shifted", start: 20, end: 30 });
  // Insertions exactly at a boundary stay outside the range.
  assert.deepEqual(trackRange(20, 30, [change(20, 0, "<"), change(30, 0, ">")]), { kind: "shifted", start: 21, end: 31 });
});

test("edits inside a selection resize it and request a re-parse", () => {
  assert.deepEqual(trackRange(20, 30, [change(22, 2, "12345")]), { kind: "edited", start: 20, end: 33 });
  assert.deepEqual(
    trackRange(20, 30, [change(25, 1, ""), change(2, 0, "ab")]),
    { kind: "edited", start: 22, end: 31 },
    "multiple changes apply in document order",
  );
});

test("an edit across a selection boundary loses the range", () => {
  assert.deepEqual(trackRange(20, 30, [change(18, 4, "")]), { kind: "lost" });
  assert.deepEqual(trackRange(20, 30, [change(28, 5, "x")]), { kind: "lost" });
  assert.deepEqual(trackRange(20, 30, [change(10, 30, "")]), { kind: "lost" });
});

test("a JSONL line follows insertions and deletions above it", () => {
  // Lines are 10 characters (9 + newline); line 5 starts at offset 50.
  assert.deepEqual(trackLine(5, [change(0, 0, "new\n")]), { kind: "shifted", line: 6 });
  assert.deepEqual(trackLine(5, [change(10, 20, "")]), { kind: "shifted", line: 3 });
  assert.deepEqual(trackLine(5, [change(80, 3, "a\nb\n")]), { kind: "unchanged", line: 5 });
  assert.deepEqual(trackLine(5, [change(0, 0, "x\r\ny\rz\n")]), { kind: "shifted", line: 8 });
});

test("editing, merging, or deleting the tracked JSONL line is reported", () => {
  assert.deepEqual(trackLine(5, [change(52, 3, "abc")]), { kind: "edited", line: 5 });
  assert.deepEqual(trackLine(5, [change(0, 0, "\n"), change(52, 1, "")]), { kind: "edited", line: 6 });
  // Deleting the line break before line 5 merges it into line 4.
  assert.deepEqual(trackLine(5, [change(49, 1, "")]), { kind: "edited", line: 4 });
  // A deletion spanning lines 4–6 removes line 5 entirely.
  assert.deepEqual(trackLine(5, [change(45, 20, "")]), { kind: "deleted", line: 4 });
});

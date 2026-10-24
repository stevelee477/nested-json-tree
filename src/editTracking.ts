/**
 * Maps a tracked range or line through one document change event. Pure, so it
 * can be tested without VS Code. Offsets and lines refer to the document
 * before the event, as in `TextDocumentContentChangeEvent`; changes in one
 * event never overlap.
 */

export interface TextChange {
  rangeOffset: number;
  rangeLength: number;
  textLength: number;
  startLine: number;
  endLine: number;
  /** Line breaks in the inserted text. */
  insertedLineBreaks: number;
}

export type RangeUpdate =
  /** Only text outside the range changed; its content is identical. */
  | { kind: "shifted"; start: number; end: number }
  /** Text strictly inside the range changed. */
  | { kind: "edited"; start: number; end: number }
  /** A change straddled a boundary, so the range can no longer be identified. */
  | { kind: "lost" };

export function trackRange(start: number, end: number, changes: readonly TextChange[]): RangeUpdate {
  let shift = 0;
  let insideDelta = 0;
  let edited = false;
  for (const change of [...changes].sort((left, right) => left.rangeOffset - right.rangeOffset)) {
    const changeStart = change.rangeOffset;
    const changeEnd = change.rangeOffset + change.rangeLength;
    const delta = change.textLength - change.rangeLength;
    // Insertions exactly at a boundary land outside the range.
    if (changeEnd <= start) shift += delta;
    else if (changeStart >= end) continue;
    else if (changeStart >= start && changeEnd <= end) {
      insideDelta += delta;
      edited = true;
    } else {
      return { kind: "lost" };
    }
  }
  const next = { start: start + shift, end: end + shift + insideDelta };
  return edited ? { kind: "edited", ...next } : { kind: "shifted", ...next };
}

export type LineUpdate =
  | { kind: "unchanged"; line: number }
  /** Lines above were added or removed; the line's text is identical. */
  | { kind: "shifted"; line: number }
  /** The line's text changed, possibly by merging with a neighbor. */
  | { kind: "edited"; line: number }
  /** A multi-line deletion removed the whole line. */
  | { kind: "deleted"; line: number };

export function trackLine(line: number, changes: readonly TextChange[]): LineUpdate {
  let shift = 0;
  let touched: { kind: "edited" | "deleted"; line: number } | undefined;
  for (const change of [...changes].sort((left, right) => left.rangeOffset - right.rangeOffset)) {
    const delta = change.insertedLineBreaks - (change.endLine - change.startLine);
    if (change.endLine < line) {
      shift += delta;
    } else if (change.startLine > line) {
      continue;
    } else if (change.startLine < line && change.endLine > line) {
      touched = { kind: "deleted", line: change.startLine + shift };
    } else {
      // A change ending on this line merges it into the change's first line.
      touched = { kind: "edited", line: Math.min(change.startLine, line) + shift };
    }
  }
  if (touched !== undefined) return touched;
  return shift === 0 ? { kind: "unchanged", line } : { kind: "shifted", line: line + shift };
}

/** Counts `\n`, `\r\n`, and lone `\r` line breaks. */
export function countLineBreaks(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\n") count += 1;
    else if (char === "\r") {
      count += 1;
      if (text[index + 1] === "\n") index += 1;
    }
  }
  return count;
}

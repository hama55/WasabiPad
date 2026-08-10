import type { EditManyItem, Pos } from "./api";

export interface LineIndentPlan {
  edits: EditManyItem[];
  nextAnchor: Pos;
  nextCaret: Pos;
  fromLine: number;
  primaryIndex: number;
}

const before = (left: Pos, right: Pos) =>
  left.line < right.line || (left.line === right.line && left.col <= right.col);

export function selectedLineRange(anchor: Pos, caret: Pos): { first: number; last: number } | null {
  if (anchor.line === caret.line && anchor.col === caret.col) return null;
  const [start, end] = before(anchor, caret) ? [anchor, caret] : [caret, anchor];
  if (start.col !== 0) return null;
  const last = end.line - Number(end.col === 0);
  return last < start.line ? null : { first: start.line, last };
}

export function selectedLineRangeForUnindent(anchor: Pos, caret: Pos): { first: number; last: number } {
  if (anchor.line === caret.line && anchor.col === caret.col) {
    return { first: anchor.line, last: anchor.line };
  }
  const [start, end] = before(anchor, caret) ? [anchor, caret] : [caret, anchor];
  return {
    first: start.line,
    last: Math.max(start.line, end.line - Number(end.line > start.line && end.col === 0)),
  };
}

export function newlineWithLeadingTabs(line: string): string {
  return `\n${line.match(/^\t*/)?.[0] ?? ""}`;
}

export function planLineIndent(anchor: Pos, caret: Pos): LineIndentPlan | null {
  const range = selectedLineRange(anchor, caret);
  if (!range) return null;
  const edits = Array.from({ length: range.last - range.first + 1 }, (_, index) => {
    const pos = { line: range.first + index, col: 0 };
    return { start: pos, end: pos, text: "\t" };
  });
  const move = (pos: Pos): Pos => ({
    line: pos.line,
    col: pos.line >= range.first && pos.line <= range.last && pos.col > 0 ? pos.col + 1 : pos.col,
  });
  return {
    edits,
    nextAnchor: move(anchor),
    nextCaret: move(caret),
    fromLine: range.first,
    primaryIndex: Math.max(0, Math.min(edits.length - 1, caret.line - range.first)),
  };
}

export function planLineUnindent(
  anchor: Pos,
  caret: Pos,
  lines: string[],
  range = selectedLineRangeForUnindent(anchor, caret),
): LineIndentPlan | null {
  const edits = lines.flatMap((line, index) => {
    if (!line.startsWith("\t")) return [];
    const row = range.first + index;
    return [{ start: { line: row, col: 0 }, end: { line: row, col: 1 }, text: "" }];
  });
  if (!edits.length) return null;
  const changedLines = new Set(edits.map((edit) => edit.start.line));
  const move = (pos: Pos): Pos => ({
    line: pos.line,
    col: changedLines.has(pos.line) && pos.col > 0 ? pos.col - 1 : pos.col,
  });
  return {
    edits,
    nextAnchor: move(anchor),
    nextCaret: move(caret),
    fromLine: range.first,
    primaryIndex: Math.max(0, edits.findIndex((edit) => edit.start.line === caret.line)),
  };
}

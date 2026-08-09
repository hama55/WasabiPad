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

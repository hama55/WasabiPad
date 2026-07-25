import type { EditManyItem, Pos } from "./api";

export interface TrackedRange {
  start: Pos;
  end: Pos;
}

const compare = (a: Pos, b: Pos) => a.line - b.line || a.col - b.col;

function insertedEnd(start: Pos, text: string): Pos {
  const lines = text.split("\n");
  if (lines.length === 1) return { line: start.line, col: start.col + [...text].length };
  return { line: start.line + lines.length - 1, col: [...lines.at(-1)!].length };
}

function transformMarker(pos: Pos, edit: EditManyItem, bias: "left" | "right"): Pos {
  const { start, end, text } = edit;
  const beforeStart = compare(pos, start) < 0;
  const afterEnd = compare(pos, end) > 0;
  if (beforeStart) return pos;

  const inserted = insertedEnd(start, text);
  if (compare(start, end) === 0 && compare(pos, start) === 0) {
    return bias === "left" ? start : inserted;
  }
  if (!afterEnd && compare(pos, end) < 0) {
    return bias === "left" ? start : inserted;
  }
  if (pos.line === end.line) {
    return { line: inserted.line, col: inserted.col + pos.col - end.col };
  }
  return { line: inserted.line + pos.line - end.line, col: pos.col };
}

export function transformTrackedRange(range: TrackedRange, edits: EditManyItem[]): TrackedRange {
  const ordered = [...edits].sort((a, b) => compare(b.start, a.start));
  return ordered.reduce(
    (current, edit) => ({
      start: transformMarker(current.start, edit, "left"),
      end: transformMarker(current.end, edit, "right"),
    }),
    range,
  );
}

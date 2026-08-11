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

export interface MarkdownFenceState {
  char: "`" | "~";
  length: number;
}

interface MarkdownLinePrefix {
  indent: string;
  quote: string;
  list: {
    next: string;
    empty: boolean;
    emptyLine: string;
  } | null;
  table: boolean;
}

function leadingWhitespace(line: string): string {
  return line.match(/^[\t ]*/)?.[0] ?? "";
}

function fenceAtStart(line: string): { indent: string; marker: string; rest: string } | null {
  const match = line.match(/^([\t ]{0,3})(`{3,}|~{3,})(.*)$/);
  return match ? { indent: match[1], marker: match[2], rest: match[3] } : null;
}

function markdownLinePrefix(line: string): MarkdownLinePrefix {
  const indent = line.match(/^\t*/)?.[0] ?? "";
  const withoutIndent = line.slice(indent.length);
  const quote = withoutIndent.match(/^(?:> ?)+/)?.[0] ?? "";
  const content = withoutIndent.slice(quote.length);
  const unordered = content.match(/^([-+*]) /);
  const ordered = content.match(/^(\d+)\. /);
  const listBase = unordered?.[0] ?? ordered?.[0];

  if (listBase) {
    const task = content.slice(listBase.length).match(/^\[[ xX]\](?: |$)/)?.[0] ?? "";
    const body = content.slice(listBase.length + task.length);
    const marker = unordered
      ? `${unordered[1]} `
      : `${Number.parseInt(ordered![1], 10) + 1}. `;
    return {
      indent,
      quote,
      list: {
        next: `${indent}${quote}${marker}${task ? "[ ] " : ""}`,
        empty: body.trim() === "",
        emptyLine: `${indent}${quote}`,
      },
      table: false,
    };
  }

  return { indent, quote, list: null, table: content.startsWith("|") };
}

export function markdownFenceState(lines: readonly string[]): MarkdownFenceState | null {
  let state: MarkdownFenceState | null = null;
  for (const line of lines) {
    const fence = fenceAtStart(line);
    if (!fence) continue;
    const char = fence.marker[0] as "`" | "~";
    if (!state) {
      state = { char, length: fence.marker.length };
    } else if (state.char === char && fence.marker.length >= state.length && fence.rest.trim() === "") {
      state = null;
    }
  }
  return state;
}

function isFenceBoundary(line: string, state: MarkdownFenceState | null): boolean {
  const fence = fenceAtStart(line);
  if (!fence) return false;
  if (!state) return true;
  return state.char === fence.marker[0]
    && fence.marker.length >= state.length
    && fence.rest.trim() === "";
}

export function markdownLineHasStructure(line: string): boolean {
  const prefix = markdownLinePrefix(line);
  return Boolean(prefix.list || prefix.quote || prefix.table);
}

export function markdownEmptyListPrefix(line: string): string | null {
  const list = markdownLinePrefix(line).list;
  return list?.empty ? list.emptyLine : null;
}

export function newlineWithMarkdownContinuation(
  line: string,
  fenceState: MarkdownFenceState | null = null,
): string {
  if (isFenceBoundary(line, fenceState)) return "\n";
  if (fenceState) return `\n${leadingWhitespace(line)}`;

  const prefix = markdownLinePrefix(line);
  if (prefix.list) return `\n${prefix.list.next}`;
  if (prefix.quote) return `\n${prefix.indent}${prefix.quote}`;
  if (prefix.table) return `\n${prefix.indent}${prefix.quote}| `;

  const indent = leadingWhitespace(line);
  return `\n${indent.startsWith("\t") || indent.length >= 4 ? indent : ""}`;
}

export interface MarkdownFenceInsertion {
  text: string;
  caretLineOffset: number;
  caretCol: number;
}

export function autoCloseMarkdownFence(
  line: string,
  startCol: number,
  endCol: number,
  inserted: string,
  fenceState: MarkdownFenceState | null,
): MarkdownFenceInsertion | null {
  if (!inserted || startCol !== endCol) return null;
  const prefix = [...line].slice(0, startCol).join("");
  const suffix = [...line].slice(endCol).join("");
  if (suffix || fenceState) return null;
  const candidate = `${prefix}${inserted}`;
  const fence = fenceAtStart(candidate);
  if (!fence || fence.rest) return null;
  const { indent, marker } = fence;
  return {
    text: `${inserted}\n${indent}\n${indent}${marker}`,
    caretLineOffset: 1,
    caretCol: indent.length,
  };
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

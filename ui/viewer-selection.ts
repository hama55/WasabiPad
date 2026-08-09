import type { ViewerSelection } from "./api";
import { comparePos } from "./editor-math";
import {
  csvCellSourceOffsetAtDisplayOffset,
  csvSourcePositionAtOffset,
} from "./csv-viewer";
import { DEFAULT_CSV_DELIMITER } from "./viewer-delimiter";

export function isCollapsedViewerSelection(selection: ViewerSelection | null): boolean {
  return !!selection
    && selection.start.line === selection.end.line
    && selection.start.col === selection.end.col;
}

export function textOffsetWithin(element: HTMLElement, node: Node, offset: number): number {
  if (node === element) {
    return [...element.childNodes].slice(0, offset)
      .reduce((length, child) => length + (child.textContent?.length ?? 0), 0);
  }
  const range = document.createRange();
  range.selectNodeContents(element);
  range.setEnd(node, offset);
  return range.toString().length;
}

function markdownPositionAtOffset(block: HTMLElement, offset: number) {
  const start = Number(block.dataset.sourceStart);
  const end = Number(block.dataset.sourceEnd);
  const sourceText = block.dataset.sourceText;
  const text = block.textContent ?? "";
  const limit = Math.max(0, Math.min(text.length, offset));
  if (sourceText !== undefined) {
    let rawOffset = 0;
    for (let index = 0; index < limit; index++) {
      const match = sourceText.indexOf(text[index], rawOffset);
      if (match < 0) break;
      rawOffset = match + 1;
    }
    if (limit < text.length) {
      const match = sourceText.indexOf(text[limit], rawOffset);
      if (match >= 0) rawOffset = match;
    }
    return csvSourcePositionAtOffset(sourceText, start, rawOffset);
  }
  const prefix = text.slice(0, limit);
  const lines = prefix.split(/\r\n|\r|\n/);
  return {
    line: Math.min(Math.max(start, end - 1), start + lines.length - 1),
    col: lines.at(-1)!.length,
  };
}

export function sourcePositionFromPoint(
  node: Node,
  offset: number,
): { line: number; col: number } | null {
  const element = node.nodeType === Node.ELEMENT_NODE
    ? node as Element
    : node.parentElement;
  const lineNumber = element?.closest<HTMLElement>(".viewer-line-number");
  if (lineNumber) return { line: Number(lineNumber.dataset.sourceLine), col: 0 };
  const cell = element?.closest<HTMLElement>("[data-source-column]");
  const row = cell?.closest<HTMLElement>("[data-source-line][data-source-csv]");
  if (cell && row) {
    const line = Number(row.dataset.sourceLine);
    const raw = row.dataset.sourceCsv ?? "";
    const column = Number(cell.dataset.sourceColumn ?? 0);
    const displayOffset = textOffsetWithin(cell, node, offset);
    const rawOffset = csvCellSourceOffsetAtDisplayOffset(
      raw,
      column,
      displayOffset,
      row.dataset.delimiter ?? DEFAULT_CSV_DELIMITER,
    );
    return csvSourcePositionAtOffset(raw, line, rawOffset);
  }
  const block = element?.closest<HTMLElement>("[data-source-start][data-source-end]");
  if (!block) return null;
  return markdownPositionAtOffset(block, textOffsetWithin(block, node, offset));
}

export function viewerSelectionFromDom(content: HTMLElement): ViewerSelection | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !selection.anchorNode || !selection.focusNode) return null;
  if (!content.contains(selection.anchorNode) || !content.contains(selection.focusNode)) return null;
  const anchor = sourcePositionFromPoint(selection.anchorNode, selection.anchorOffset);
  const focus = sourcePositionFromPoint(selection.focusNode, selection.focusOffset);
  if (!anchor || !focus) return null;
  return comparePos(anchor, focus) <= 0
    ? { start: anchor, end: focus }
    : { start: focus, end: anchor };
}

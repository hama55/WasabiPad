import type { Pos, ViewerSelection } from "./api";
import { comparePos } from "./editor-math";
import {
  csvCellSourceOffsetAtDisplayOffset,
  csvSourcePositionAtOffset,
} from "./csv-viewer";
import { DEFAULT_CSV_DELIMITER } from "./viewer-delimiter";
import {
  MARKDOWN_SOURCE_OFFSET_END,
  MARKDOWN_SOURCE_OFFSET_START,
  markdownSourceOffsetForDisplayOffset,
  markdownSourcePositionAtOffset,
} from "./viewer-markdown-source-map";

export type ViewerSelectionWithCaret = ViewerSelection & { caret?: Pos };

function markdownBreakOffsetAtPoint(node: Node, offset: number): number | null {
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const element = node as Element;
  const selector = `br[${MARKDOWN_SOURCE_OFFSET_START}][${MARKDOWN_SOURCE_OFFSET_END}]`;
  if (element.matches(selector)) return Number(element.getAttribute(MARKDOWN_SOURCE_OFFSET_START));

  const next = element.childNodes[offset];
  if (next?.nodeType === Node.ELEMENT_NODE && (next as Element).matches(selector)) {
    return Number((next as Element).getAttribute(MARKDOWN_SOURCE_OFFSET_START));
  }
  const previous = element.childNodes[offset - 1];
  if (previous?.nodeType === Node.ELEMENT_NODE && (previous as Element).matches(selector)) {
    return Number((previous as Element).getAttribute(MARKDOWN_SOURCE_OFFSET_END));
  }
  return null;
}

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
  const lineBreakOffset = markdownBreakOffsetAtPoint(node, offset);
  if (lineBreakOffset !== null) {
    const source = element?.closest<HTMLElement>("[data-markdown-source]")?.dataset.markdownSource;
    if (source !== undefined && Number.isFinite(lineBreakOffset)) {
      return markdownSourcePositionAtOffset(source, lineBreakOffset);
    }
  }
  const sourceSpan = element?.closest<HTMLElement>(
    `[${MARKDOWN_SOURCE_OFFSET_START}][${MARKDOWN_SOURCE_OFFSET_END}]`,
  );
  if (!sourceSpan) return null;
  const source = sourceSpan.closest<HTMLElement>("[data-markdown-source]")?.dataset.markdownSource;
  if (source === undefined) return null;
  const start = Number(sourceSpan.getAttribute(MARKDOWN_SOURCE_OFFSET_START));
  const end = Number(sourceSpan.getAttribute(MARKDOWN_SOURCE_OFFSET_END));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const displayLength = sourceSpan.textContent?.length ?? 0;
  const displayOffset = textOffsetWithin(sourceSpan, node, offset);
  const sourceOffset = markdownSourceOffsetForDisplayOffset(start, end, displayLength, displayOffset);
  return markdownSourcePositionAtOffset(source, sourceOffset);
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

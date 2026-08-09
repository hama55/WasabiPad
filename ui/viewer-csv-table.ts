import type { ViewerSelection } from "./api";
import { comparePos } from "./editor-math";
import {
  CSV_LINE_NUMBER_WIDTH,
  csvCellBoundsForColumn,
  csvCellOffsetAt,
  csvColumnAt,
  parseCsvSource,
  csvSourceOffsetAtPosition,
  csvSourcePositionAtOffset,
  type CsvSourceRow,
} from "./csv-viewer";
import { isCollapsedViewerSelection } from "./viewer-selection";

export const MAX_TABLE_ROWS = 10_000;
export const MAX_TABLE_COLUMNS = 200;

export interface CsvTableRenderOptions {
  text: string;
  delimiter: string;
  selection: ViewerSelection | null;
  columnWidths: number[];
  onColumnResize: (
    event: PointerEvent,
    table: HTMLTableElement,
    columns: HTMLTableColElement[],
    columnIndex: number,
  ) => void;
}

export interface CsvTableRenderResult {
  table: HTMLTableElement;
  rows: HTMLTableRowElement[];
  values: string[][];
  maxColumns: number;
  errors: { message: string }[];
}

function csvCellPositions(sourceRow: CsvSourceRow, columnIndex: number, delimiter: string) {
  const bounds = csvCellBoundsForColumn(sourceRow.text, columnIndex, delimiter);
  return {
    start: csvSourcePositionAtOffset(sourceRow.text, sourceRow.line, bounds.start),
    end: csvSourcePositionAtOffset(sourceRow.text, sourceRow.line, bounds.end),
  };
}

function csvCellSelected(
  sourceRow: CsvSourceRow,
  columnIndex: number,
  selection: ViewerSelection | null,
  delimiter: string,
) {
  if (!selection || isCollapsedViewerSelection(selection)) return false;
  const cell = csvCellPositions(sourceRow, columnIndex, delimiter);
  return comparePos(selection.start, cell.end) < 0
    && comparePos(selection.end, cell.start) > 0;
}

function csvRowSelected(
  sourceRow: CsvSourceRow,
  selection: ViewerSelection | null,
  delimiter: string,
) {
  if (!selection || isCollapsedViewerSelection(selection)) return false;
  const rowStart = { line: sourceRow.line, col: 0 };
  const rowEnd = csvSourcePositionAtOffset(sourceRow.text, sourceRow.line, sourceRow.text.length);
  if (comparePos(selection.start, rowEnd) >= 0 || comparePos(selection.end, rowStart) <= 0) return false;

  const selectedCells = sourceRow.values
    .slice(0, MAX_TABLE_COLUMNS)
    .map((_, index) => csvCellPositions(sourceRow, index, delimiter))
    .filter((cell) => comparePos(selection.start, cell.end) < 0
      && comparePos(selection.end, cell.start) > 0);
  return selectedCells.length !== 1
    || comparePos(selection.start, selectedCells[0].start) < 0
    || comparePos(selection.end, selectedCells[0].end) > 0;
}

function appendCsvCaret(
  cell: HTMLElement,
  value: string,
  sourceRow: CsvSourceRow,
  columnIndex: number,
  selection: ViewerSelection | null,
  delimiter: string,
) {
  const rowEnd = csvSourcePositionAtOffset(sourceRow.text, sourceRow.line, sourceRow.text.length);
  const position = selection?.start;
  const positionInRow = position
    && comparePos(position, { line: sourceRow.line, col: 0 }) >= 0
    && comparePos(position, rowEnd) <= 0;
  if (!selection || !isCollapsedViewerSelection(selection) || !positionInRow) {
    cell.textContent = value;
    return;
  }
  const sourceOffset = csvSourceOffsetAtPosition(sourceRow.text, sourceRow.line, selection.start);
  const sourceColumn = csvColumnAt(sourceRow.text, sourceOffset, delimiter);
  if (sourceColumn !== columnIndex) {
    cell.textContent = value;
    return;
  }
  const offset = Math.max(0, Math.min(value.length, csvCellOffsetAt(
    sourceRow.text,
    sourceOffset,
    delimiter,
  )));
  const caret = document.createElement("span");
  caret.className = "viewer-caret";
  caret.setAttribute("aria-hidden", "true");
  cell.append(
    document.createTextNode(value.slice(0, offset)),
    caret,
    document.createTextNode(value.slice(offset)),
  );
}

function createCsvColumnGroup(
  table: HTMLTableElement,
  columnCount: number,
  columnWidths: number[],
): HTMLTableColElement[] {
  const group = document.createElement("colgroup");
  const lineNumber = document.createElement("col");
  lineNumber.className = "viewer-line-number-column";
  lineNumber.style.width = `${CSV_LINE_NUMBER_WIDTH}px`;
  group.appendChild(lineNumber);
  const columns = Array.from({ length: columnCount }, (_, index) => {
    const column = document.createElement("col");
    const width = columnWidths[index];
    if (width) column.style.width = width + "px";
    group.appendChild(column);
    return column;
  });
  table.appendChild(group);
  if (columns.length && columnWidths.length >= columns.length) {
    table.style.tableLayout = "fixed";
    table.style.width = "max-content";
  }
  return columns;
}

export function renderCsvTable(options: CsvTableRenderOptions): CsvTableRenderResult {
  const parsed = parseCsvSource(options.text, options.delimiter);
  const sourceRows = parsed.rows;
  const values = sourceRows.map((row) => row.values);
  const table = document.createElement("table");
  table.className = "viewer-grid";
  const body = document.createElement("tbody");
  const fragment = document.createDocumentFragment();
  const rows: HTMLTableRowElement[] = [];
  const maxColumns = values.reduce((max, row) => Math.max(max, row.length), 0);
  const columns = createCsvColumnGroup(table, Math.min(maxColumns, MAX_TABLE_COLUMNS), options.columnWidths);

  values.slice(0, MAX_TABLE_ROWS).forEach((row, rowIndex) => {
    const sourceRow = sourceRows[rowIndex] ?? { values: row, text: "", line: rowIndex };
    const tr = document.createElement("tr");
    tr.dataset.sourceLine = String(sourceRow.line);
    tr.dataset.sourceCsv = sourceRow.text;
    tr.dataset.delimiter = options.delimiter;
    const lineNumber = document.createElement(rowIndex === 0 ? "th" : "td");
    lineNumber.className = "viewer-line-number";
    lineNumber.textContent = String(rowIndex + 1);
    lineNumber.dataset.sourceLine = String(sourceRow.line);
    tr.appendChild(lineNumber);
    row.slice(0, MAX_TABLE_COLUMNS).forEach((value, columnIndex) => {
      const cell = document.createElement(rowIndex === 0 ? "th" : "td");
      cell.dataset.sourceColumn = String(columnIndex);
      appendCsvCaret(cell, value, sourceRow, columnIndex, options.selection, options.delimiter);
      cell.classList.toggle(
        "viewer-source-selected",
        csvCellSelected(sourceRow, columnIndex, options.selection, options.delimiter),
      );
      tr.appendChild(cell);
      if (rowIndex === 0 && columns[columnIndex]) {
        const handle = document.createElement("span");
        handle.className = "viewer-column-resizer";
        handle.setAttribute("aria-hidden", "true");
        handle.addEventListener("pointerdown", (event) =>
          options.onColumnResize(event, table, columns, columnIndex));
        cell.appendChild(handle);
      }
    });
    tr.classList.toggle("viewer-source-selected", csvRowSelected(sourceRow, options.selection, options.delimiter));
    rows.push(tr);
    fragment.appendChild(tr);
  });
  body.appendChild(fragment);
  table.appendChild(body);
  return {
    table,
    rows,
    values,
    maxColumns,
    errors: parsed.errors,
  };
}

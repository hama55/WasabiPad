import type { ViewerSelection } from "./api";
import Papa from "papaparse";

export const CSV_MIN_COLUMN_WIDTH = 48;
export const CSV_LINE_NUMBER_WIDTH = 64;

export function decodeDelimiter(value: string) {
  return value === "\\t" ? "\t" : value;
}

export interface CsvCellBounds {
  start: number;
  end: number;
}

export interface CsvSourceRow {
  values: string[];
  text: string;
  line: number;
}

export interface CsvCellSourceBounds extends CsvCellBounds {
  valueStart: number;
  valueEnd: number;
}

export function csvCellBoundsForColumns(line: string, delimiterValue: string): CsvCellBounds[] {
  const delimiter = decodeDelimiter(delimiterValue);
  const bounds: CsvCellBounds[] = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    if (line[index] === '"') {
      if (quoted && line[index + 1] === '"') index++;
      else quoted = !quoted;
    } else if (!quoted && line.startsWith(delimiter, index)) {
      bounds.push({ start, end: index });
      start = index + delimiter.length;
      index += delimiter.length - 1;
    }
  }
  bounds.push({ start, end: line.length });
  return bounds;
}

export function csvColumnAt(line: string, column: number, delimiterValue: string) {
  const bounds = csvCellBoundsForColumns(line, delimiterValue);
  const index = bounds.findIndex(({ end }) => column <= end);
  return index < 0 ? Math.max(0, bounds.length - 1) : index;
}

export function csvCellBounds(line: string, column: number, delimiterValue: string): CsvCellBounds {
  return csvCellBoundsForColumn(line, csvColumnAt(line, column, delimiterValue), delimiterValue);
}

export function csvCellBoundsForColumn(line: string, target: number, delimiterValue: string): CsvCellBounds {
  return csvCellBoundsForColumns(line, delimiterValue)[target]
    ?? { start: line.length, end: line.length };
}

export function csvCellSourceBoundsForColumn(
  line: string,
  target: number,
  delimiterValue: string,
): CsvCellSourceBounds {
  const bounds = csvCellBoundsForColumn(line, target, delimiterValue);
  const quoted = line[bounds.start] === '"';
  return {
    ...bounds,
    valueStart: bounds.start + (quoted ? 1 : 0),
    valueEnd: Math.max(
      bounds.start + (quoted ? 1 : 0),
      bounds.end - (quoted && line[bounds.end - 1] === '"' ? 1 : 0),
    ),
  };
}

function forEachCsvCellValueSegment(
  line: string,
  bounds: CsvCellSourceBounds,
  visit: (start: number, end: number, displayOffset: number) => void,
) {
  let displayOffset = 0;
  for (let index = bounds.valueStart; index < bounds.valueEnd;) {
    const end = line[index] === '"' && line[index + 1] === '"' ? index + 2 : index + 1;
    visit(index, end, displayOffset++);
    index = end;
  }
}

export function csvCellOffsetAt(line: string, column: number, delimiterValue: string): number {
  const bounds = csvCellSourceBoundsForColumn(line, csvColumnAt(line, column, delimiterValue), delimiterValue);
  const limit = Math.max(bounds.start, Math.min(bounds.end, column));
  let offset = 0;
  forEachCsvCellValueSegment(line, bounds, (start) => {
    if (start < limit) offset++;
  });
  return offset;
}

export function csvCellSourceOffsetAtDisplayOffset(
  line: string,
  target: number,
  displayOffset: number,
  delimiterValue: string,
): number {
  const bounds = csvCellSourceBoundsForColumn(line, target, delimiterValue);
  const wanted = Math.max(0, displayOffset);
  let result: number | undefined;
  forEachCsvCellValueSegment(line, bounds, (start, _end, displayed) => {
    if (result === undefined && displayed === wanted) result = start;
  });
  return result ?? bounds.valueEnd;
}

export function csvSourcePositionAtOffset(text: string, startLine: number, offset: number) {
  const limit = Math.max(0, Math.min(text.length, offset));
  let line = startLine;
  let col = 0;
  for (let index = 0; index < limit; index++) {
    if (text[index] === "\r") {
      if (text[index + 1] === "\n") index++;
      line++;
      col = 0;
    } else if (text[index] === "\n") {
      line++;
      col = 0;
    } else {
      col++;
    }
  }
  return { line, col };
}

export function csvSourceOffsetAtPosition(text: string, startLine: number, target: { line: number; col: number }) {
  const wantedLine = Math.max(startLine, target.line);
  const wantedCol = Math.max(0, target.col);
  let line = startLine;
  let col = 0;
  for (let index = 0; index <= text.length; index++) {
    if (line === wantedLine && col >= wantedCol) return index;
    if (index === text.length) break;
    if (text[index] === "\r") {
      if (text[index + 1] === "\n") index++;
      line++;
      col = 0;
    } else if (text[index] === "\n") {
      line++;
      col = 0;
    } else {
      col++;
    }
  }
  return text.length;
}

export function parseCsvSource(text: string, delimiterValue: string): {
  rows: CsvSourceRow[];
  errors: Papa.ParseError[];
} {
  const rows: CsvSourceRow[] = [];
  const errors: Papa.ParseError[] = [];
  let cursor = 0;
  let line = 0;
  Papa.parse<string[]>(text, {
    delimiter: decodeDelimiter(delimiterValue),
    skipEmptyLines: false,
    step: (result) => {
      const record = text.slice(cursor, result.meta.cursor);
      const raw = record.replace(/(?:\r\n|\r|\n)$/, "");
      rows.push({ values: result.data, text: raw, line });
      errors.push(...result.errors);
      line += (record.match(/\r\n|\r|\n/g) ?? []).length;
      cursor = result.meta.cursor;
    },
  });
  return { rows, errors };
}

export function resizedCsvColumnWidth(startWidth: number, deltaX: number): number {
  return Math.max(CSV_MIN_COLUMN_WIDTH, Math.round(startWidth + deltaX));
}

export function isSingleCsvCellSelection(
  line: string,
  selection: ViewerSelection | null,
  delimiterValue: string,
) {
  if (!selection || selection.start.line !== selection.end.line) return false;
  return csvColumnAt(line, selection.start.col, delimiterValue)
    === csvColumnAt(line, selection.end.col, delimiterValue);
}

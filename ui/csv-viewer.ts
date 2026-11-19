import type { ViewerSelection } from "./api";
import Papa from "papaparse";
import { csvDelimiterOptions, DEFAULT_CSV_DELIMITER } from "./viewer-delimiter";

export const CSV_MIN_COLUMN_WIDTH = 12;
export const CSV_LINE_NUMBER_WIDTH = 64;

export function decodeDelimiter(value = DEFAULT_CSV_DELIMITER) {
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
  const bounds: CsvCellBounds[] = [];
  let start = 0;
  forEachDelimiter(line, delimiterValue, (index, length) => {
    bounds.push({ start, end: index });
    start = index + length;
  });
  bounds.push({ start, end: line.length });
  return bounds;
}

function forEachDelimiter(text: string, value: string, visit: (index: number, length: number) => void) {
  const delimiters = csvDelimiterOptions(value).map(decodeDelimiter).sort((a, b) => b.length - a.length);
  if (!delimiters.length) return;
  let fieldStart = 0;
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    if (quoted) {
      if (text[index] === '"') {
        if (text[index + 1] === '"') index++;
        else quoted = false;
      }
      continue;
    }
    if (index === fieldStart && text[index] === '"') {
      quoted = true;
      continue;
    }
    if (text[index] === "\r" || text[index] === "\n") fieldStart = index + 1;
    const delimiter = delimiters.find((item) => text.startsWith(item, index));
    if (!delimiter) continue;
    visit(index, delimiter.length);
    fieldStart = index + delimiter.length;
    index = fieldStart - 1;
  }
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
  const quoted = !!delimiterValue && line[bounds.start] === '"';
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
  if (!delimiterValue) return Math.max(0, Math.min(line.length, column));
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
  if (!delimiterValue) return Math.max(0, Math.min(line.length, displayOffset));
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
  if (!delimiterValue) {
    const lines = text ? text.split(/\r\n|\r|\n/) : [];
    return { rows: lines.map((text, line) => ({ values: [text], text, line })), errors };
  }
  let input = text;
  let delimiter = decodeDelimiter(delimiterValue);
  const offsets = new Map<number, number>();
  if (delimiterValue.startsWith("\n")) {
    delimiter = "\uE000";
    const used = new Set(text);
    for (let codePoint = 0xE000; used.has(delimiter); codePoint++) {
      delimiter = String.fromCodePoint(codePoint + 1);
    }
    input = "";
    let start = 0;
    forEachDelimiter(text, delimiterValue, (index, length) => {
      input += text.slice(start, index) + delimiter;
      start = index + length;
      offsets.set(input.length, start - input.length);
    });
    input += text.slice(start);
  }
  const changes = offsets.entries();
  let change = changes.next();
  let shift = 0;
  let cursor = 0;
  let line = 0;
  Papa.parse<string[]>(input, {
    delimiter,
    skipEmptyLines: false,
    step: (result) => {
      while (!change.done && change.value[0] <= result.meta.cursor) {
        shift = change.value[1];
        change = changes.next();
      }
      const end = result.meta.cursor + shift;
      const record = text.slice(cursor, end);
      const raw = record.replace(/(?:\r\n|\r|\n)$/, "");
      rows.push({ values: result.data, text: raw, line });
      errors.push(...result.errors);
      line += (record.match(/\r\n|\r|\n/g) ?? []).length;
      cursor = end;
    },
  });
  return { rows, errors };
}

export function resizedCsvColumnWidth(startWidth: number, deltaX: number): number {
  return Math.max(CSV_MIN_COLUMN_WIDTH, Math.round(startWidth + deltaX));
}

export function fitCsvColumnWidths(natural: number[], viewportWidth: number): number[] {
  const available = Math.floor(viewportWidth) - CSV_LINE_NUMBER_WIDTH;
  let min = 32;
  let max = 520;
  while (min < max) {
    const cap = Math.ceil((min + max) / 2);
    const total = natural.reduce((sum, width) => sum + Math.min(width, cap), 0);
    if (total <= available) min = cap;
    else max = cap - 1;
  }
  return natural.map((width) => Math.min(width, min));
}

export function encodeCsvCell(value: string, delimiter: string, original: string): string {
  const separators = csvDelimiterOptions(delimiter).map(decodeDelimiter);
  if (!separators.length) return value;
  const quote = original.startsWith('"') || /["\r\n]/.test(value)
    || separators.some((separator) => separator.length > 1 || value.includes(separator));
  return quote ? '"' + value.replaceAll('"', '""') + '"' : value;
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

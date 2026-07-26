import type { ViewerSelection } from "./api";

export function decodeDelimiter(value: string) {
  return value === "\\t" ? "\t" : value;
}

export function csvColumnAt(line: string, column: number, delimiterValue: string) {
  const delimiter = decodeDelimiter(delimiterValue);
  let cell = 0;
  let quoted = false;
  for (let index = 0; index < line.length && index < column; index++) {
    if (line[index] === '"') {
      if (quoted && line[index + 1] === '"') index++;
      else quoted = !quoted;
    } else if (!quoted && line.startsWith(delimiter, index)) {
      cell++;
      index += delimiter.length - 1;
    }
  }
  return cell;
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

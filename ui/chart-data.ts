export function parseChartNumber(value: string): number | null {
  const normalized = value.trim().replaceAll(",", "").replace(/%$/, "");
  if (!normalized) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

export function chartColumnLabel(headers: string[], index: number): string {
  return headers[index]?.trim() || `列 ${index + 1}`;
}

export function numericColumnIndexes(rows: string[][]): number[] {
  const width = rows[0]?.length ?? 0;
  return Array.from({ length: width }, (_, index) => index).filter((index) => {
    const values = rows.slice(1, 101).map((row) => row[index] ?? "").filter((value) => value.trim());
    return values.length > 0 && values.every((value) => parseChartNumber(value) !== null);
  });
}

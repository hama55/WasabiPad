// グラフ種別の定義はここが単一の定義。viewer.ts は base/stacked/dataset をそのまま Chart.js へ渡す。
export type ChartTypeId =
  | "line-point" | "line" | "scatter" | "step" | "area" | "bar" | "bar-stacked";

export interface ChartTypeSpec {
  label: string;
  base: "line" | "bar";
  stacked?: boolean;
  pointRadius?: number;
  showLine?: boolean;
  stepped?: boolean;
  fill?: boolean;
}

export const CHART_TYPES: Record<ChartTypeId, ChartTypeSpec> = {
  "line-point": { label: "折れ線（点付き）", base: "line", pointRadius: 2 },
  line: { label: "折れ線（点なし）", base: "line", pointRadius: 0 },
  scatter: { label: "散布図（点のみ）", base: "line", pointRadius: 3, showLine: false },
  step: { label: "階段状折れ線", base: "line", pointRadius: 0, stepped: true },
  area: { label: "面グラフ（塗りつぶし）", base: "line", pointRadius: 0, fill: true },
  bar: { label: "棒グラフ", base: "bar" },
  "bar-stacked": { label: "積み上げ棒グラフ", base: "bar", stacked: true },
};

export const DEFAULT_CHART_TYPE: ChartTypeId = "line-point";

export function isChartTypeId(value: string): value is ChartTypeId {
  return value in CHART_TYPES;
}

// 点が多いと折れ線が点で埋まるので間引く。ただし点だけで描く種別は間引くと何も見えなくなる
export function chartPointRadius(spec: ChartTypeSpec, rowCount: number): number {
  const radius = spec.pointRadius ?? 0;
  if (spec.showLine === false) return radius;
  return rowCount > 300 ? 0 : radius;
}

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

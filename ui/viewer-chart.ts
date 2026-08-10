import Chart, { type ChartDataset } from "chart.js/auto";
import {
  chartColumnLabel,
  chartPointRadius,
  CHART_TYPES,
  DEFAULT_CHART_TYPE,
  isChartTypeId,
  histogramData,
  numericColumnIndexes,
  parseChartNumber,
  type ChartTypeId,
} from "./chart-data";

type ChartInstance = Chart<"line" | "bar", (number | null)[], string>;
type ViewerChartDataset = ChartDataset<"line" | "bar", (number | null)[]> & { columnIndex: number };

interface ChartColumns {
  x: number;
  y: number[];
  reverseX: boolean;
  type: ChartTypeId;
}

export interface ViewerChartOptions {
  panel: HTMLElement;
  title: HTMLElement;
  canvas: HTMLCanvasElement;
  content: HTMLElement;
  run: (operation: () => void) => void;
  onClose: () => void;
}

export class ViewerChartController {
  private rows: string[][] = [];
  private chart: ChartInstance | null = null;
  private columns: ChartColumns | null = null;

  constructor(private readonly options: ViewerChartOptions) {}

  setRows(rows: string[][]) {
    this.rows = rows;
  }

  refresh() {
    if (this.columns) this.render();
  }

  clear() {
    this.rows = [];
    this.close();
  }

  openDialog() {
    if (this.rows.length < 2) return;
    const headers = this.rows[0];
    const width = this.rows.reduce((max, row) => Math.max(max, row.length), 0);
    const overlay = document.createElement("div");
    overlay.className = "viewer-dialog-overlay";
    const dialog = document.createElement("div");
    dialog.className = "viewer-dialog";
    const heading = document.createElement("h2");
    heading.textContent = "グラフ作成";

    const typeLabel = document.createElement("label");
    typeLabel.textContent = "グラフの種類";
    const typeSelect = document.createElement("select");
    Object.entries(CHART_TYPES).forEach(([id, spec]) => {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = spec.label;
      typeSelect.appendChild(option);
    });
    typeSelect.value = this.columns?.type ?? DEFAULT_CHART_TYPE;
    typeLabel.appendChild(typeSelect);

    const xLabel = document.createElement("label");
    xLabel.textContent = "X軸";
    const xSelect = document.createElement("select");
    Array.from({ length: width }, (_, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = chartColumnLabel(headers, index);
      xSelect.appendChild(option);
    });
    xSelect.value = String(this.columns?.x ?? 0);
    xLabel.appendChild(xSelect);

    const reverseLabel = document.createElement("label");
    reverseLabel.className = "chart-reverse-option";
    const reverseInput = document.createElement("input");
    reverseInput.type = "checkbox";
    reverseInput.checked = this.columns?.reverseX ?? false;
    reverseLabel.append(reverseInput, document.createTextNode("X軸を反転"));

    const yTitle = document.createElement("div");
    yTitle.className = "viewer-dialog-label";
    yTitle.textContent = "Y軸";
    const yGrid = document.createElement("div");
    yGrid.className = "chart-column-grid";
    const numeric = numericColumnIndexes(this.rows);
    const defaultY = this.columns?.y
      ?? numeric.filter((index) => index !== Number(xSelect.value)).slice(0, 1);
    const checks = Array.from({ length: width }, (_, index) => {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = String(index);
      input.checked = defaultY.includes(index);
      label.append(input, document.createTextNode(chartColumnLabel(headers, index)));
      yGrid.appendChild(label);
      return input;
    });
    const error = document.createElement("div");
    error.className = "viewer-dialog-error";

    const updateChecks = () => {
      const x = Number(xSelect.value);
      checks.forEach((check, index) => {
        check.disabled = index === x;
        if (check.disabled) check.checked = false;
      });
    };
    const updateType = () => {
      const requiresY = !isChartTypeId(typeSelect.value) || CHART_TYPES[typeSelect.value].requiresY !== false;
      yTitle.hidden = !requiresY;
      yGrid.hidden = !requiresY;
      if (!requiresY) error.textContent = "";
    };
    xSelect.addEventListener("change", updateChecks);
    typeSelect.addEventListener("change", updateType);
    updateChecks();
    updateType();

    const buttons = document.createElement("div");
    buttons.className = "viewer-dialog-buttons";
    const cancel = document.createElement("button");
    cancel.textContent = "キャンセル";
    const create = document.createElement("button");
    create.className = "primary";
    create.textContent = "作成";
    buttons.append(cancel, create);
    dialog.append(heading, typeLabel, xLabel, reverseLabel, yTitle, yGrid, error, buttons);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    let closed = false;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      finish();
    };
    const finish = () => {
      if (closed) return;
      closed = true;
      window.removeEventListener("keydown", onKey, true);
      overlay.remove();
    };
    cancel.addEventListener("click", finish);
    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay) finish();
    });
    window.addEventListener("keydown", onKey, true);
    create.addEventListener("click", () => {
      const y = checks.filter((check) => check.checked).map((check) => Number(check.value));
      const type = isChartTypeId(typeSelect.value) ? typeSelect.value : DEFAULT_CHART_TYPE;
      if (CHART_TYPES[type].requiresY !== false && !y.length) {
        error.textContent = "Y軸を1列以上選択してください";
        return;
      }
      this.columns = {
        x: Number(xSelect.value),
        y: CHART_TYPES[type].requiresY === false ? [] : y,
        reverseX: reverseInput.checked,
        type,
      };
      finish();
      this.options.run(() => this.render());
    });
  }

  render() {
    if (!this.columns || this.rows.length < 2) return;
    const headers = this.rows[0];
    const rows = this.rows.slice(1);
    if (this.columns.reverseX) rows.reverse();
    const style = getComputedStyle(document.documentElement);
    const foreground = style.getPropertyValue("--fg").trim();
    const grid = style.getPropertyValue("--border-strong").trim();
    const hidden = new Map<number, boolean>();
    this.chart?.data.datasets.forEach((dataset) => {
      const column = Number((dataset as typeof dataset & { columnIndex?: number }).columnIndex);
      hidden.set(column, !this.chart!.isDatasetVisible(this.chart!.data.datasets.indexOf(dataset)));
    });

    const spec = CHART_TYPES[this.columns.type];
    const color = (index: number) => ["#4fc3f7", "#ffb74d", "#81c784", "#e57373", "#ba68c8", "#fff176", "#4dd0e1", "#f06292"][index % 8];
    let labels: string[];
    let datasets: ViewerChartDataset[];
    if (spec.histogram) {
      const histogram = histogramData(rows.map((row) => row[this.columns!.x] ?? ""));
      labels = histogram.labels;
      const histogramColor = color(0);
      datasets = [{
        label: chartColumnLabel(headers, this.columns.x),
        data: histogram.values,
        borderColor: histogramColor,
        backgroundColor: `${histogramColor}99`,
        borderWidth: 1,
        columnIndex: this.columns.x,
        hidden: hidden.get(this.columns.x) ?? false,
      }];
    } else {
      datasets = this.columns.y.map((column, index) => {
        const datasetColor = color(index);
        return {
          label: chartColumnLabel(headers, column),
          data: rows.map((row) => parseChartNumber(row[column] ?? "")),
          borderColor: datasetColor,
          backgroundColor: spec.fill ? `${datasetColor}55` : datasetColor,
          pointRadius: chartPointRadius(spec, rows.length),
          borderWidth: 2,
          spanGaps: false,
          showLine: spec.showLine,
          stepped: spec.stepped ?? false,
          fill: spec.fill ?? false,
          columnIndex: column,
          hidden: hidden.get(column) ?? false,
        };
      });
      labels = rows.map((row) => row[this.columns!.x] ?? "");
    }

    this.chart?.destroy();
    this.chart = new Chart<"line" | "bar", (number | null)[], string>(this.options.canvas, {
      type: spec.base,
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { labels: { color: foreground } } },
        scales: {
          x: { stacked: spec.stacked ?? false, ticks: { color: foreground }, grid: { color: grid } },
          y: { stacked: spec.stacked ?? false, ticks: { color: foreground }, grid: { color: grid } },
        },
      },
    });
    this.options.title.textContent = `${spec.label}: ${chartColumnLabel(headers, this.columns.x)}${
      spec.requiresY === false ? "" : ` × ${this.columns.y.map((column) => chartColumnLabel(headers, column)).join(", ")}`
    }`;
    this.options.content.hidden = true;
    this.options.panel.hidden = false;
  }

  close() {
    const wasOpen = this.chart !== null || this.columns !== null;
    this.options.panel.hidden = true;
    this.options.content.hidden = false;
    this.chart?.destroy();
    this.chart = null;
    this.columns = null;
    if (wasOpen) this.options.onClose();
  }
}

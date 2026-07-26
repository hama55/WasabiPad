import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import Chart from "chart.js/auto";
import MarkdownIt from "markdown-it";
import Papa from "papaparse";
import { takeViewerPayload, type ViewerFormat, type ViewerPayload, type ViewerSelection } from "./api";
import { DEFAULT_EDITOR_CONFIG } from "./editor-config";
import { VIEWER_FORMAT_LABELS, formatTitleBar } from "./format";
import { chartColumnLabel, numericColumnIndexes, parseChartNumber } from "./chart-data";

const MAX_TABLE_ROWS = 10_000;
const MAX_TABLE_COLUMNS = 200;
const VIEWER_THEME_KEY = "viewerTheme";
const CHART_COLORS = ["#4fc3f7", "#ffb74d", "#81c784", "#e57373", "#ba68c8", "#fff176", "#4dd0e1", "#f06292"];

// 等幅フォントの定義はエディタ既定値ただ一つ。CSSは値を持たない。
document.documentElement.style.setProperty("--font-mono", DEFAULT_EDITOR_CONFIG.fontFamily);

const win = getCurrentWindow();
const content = document.getElementById("viewer-content")!;
const title = document.getElementById("viewer-title")!;
const summary = document.getElementById("viewer-summary")!;
const themeButton = document.getElementById("viewer-theme")!;
const contextMenu = document.getElementById("viewer-context-menu")!;
const chartPanel = document.getElementById("chart-panel")!;
const chartTitle = document.getElementById("chart-title")!;
const chartCanvas = document.getElementById("chart-canvas") as HTMLCanvasElement;
const delimiterControl = document.getElementById("viewer-delimiter")!;
const delimiterInput = document.getElementById("viewer-delimiter-input") as HTMLInputElement;

let currentFormat: ViewerFormat = "csv";
let currentRows: string[][] = [];
let currentText = "";
let currentSelection: ViewerSelection | null = null;
let chart: Chart<"line", (number | null)[], string> | null = null;
let chartColumns: { x: number; y: number[]; reverseX: boolean } | null = null;

function applyTheme(theme = localStorage.getItem(VIEWER_THEME_KEY)) {
  const value = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = value;
  themeButton.textContent = value === "dark" ? "ダーク" : "ライト";
  localStorage.setItem(VIEWER_THEME_KEY, value);
  if (chartColumns) renderChart();
}

async function syncMaxIcon() {
  const maximized = await win.isMaximized();
  const button = document.getElementById("win-max")!;
  button.textContent = String.fromCharCode(maximized ? 0xe923 : 0xe922);
  button.title = maximized ? "元に戻す" : "最大化";
}

function bindWindowControls() {
  document.getElementById("win-min")!.addEventListener("click", () => { void win.minimize(); });
  document.getElementById("win-max")!.addEventListener("click", async () => {
    await win.toggleMaximize();
    await syncMaxIcon();
  });
  document.getElementById("win-close")!.addEventListener("click", () => { void win.close(); });
  title.addEventListener("dblclick", async () => {
    await win.toggleMaximize();
    await syncMaxIcon();
  });
  void win.onResized(() => { void syncMaxIcon(); });
  void syncMaxIcon();
}

function renderTable(text: string) {
  const parsed = Papa.parse<string[]>(text, {
    delimiter: delimiterInput.value,
    skipEmptyLines: false,
  });
  currentRows = parsed.data;
  const table = document.createElement("table");
  table.className = "viewer-grid";
  const body = document.createElement("tbody");
  const fragment = document.createDocumentFragment();

  currentRows.slice(0, MAX_TABLE_ROWS).forEach((row, rowIndex) => {
    const tr = document.createElement("tr");
    const lineNumber = document.createElement(rowIndex === 0 ? "th" : "td");
    lineNumber.className = "viewer-line-number";
    lineNumber.textContent = String(rowIndex + 1);
    tr.appendChild(lineNumber);
    row.slice(0, MAX_TABLE_COLUMNS).forEach((value, columnIndex) => {
      const cell = document.createElement(rowIndex === 0 ? "th" : "td");
      cell.textContent = value;
      cell.classList.toggle("viewer-source-selected", csvCellSelected(text, rowIndex, columnIndex));
      tr.appendChild(cell);
    });
    tr.classList.toggle("viewer-source-selected", csvRowSelected(rowIndex));
    fragment.appendChild(tr);
  });
  body.appendChild(fragment);
  table.appendChild(body);
  content.replaceChildren(table);

  const maxColumns = currentRows.reduce((max, row) => Math.max(max, row.length), 0);
  const truncated = currentRows.length > MAX_TABLE_ROWS || maxColumns > MAX_TABLE_COLUMNS;
  summary.classList.toggle("warning", parsed.errors.length > 0);
  summary.title = parsed.errors.map((error) => error.message).join("\n");
  summary.textContent = `${currentRows.length.toLocaleString()}行 × ${maxColumns.toLocaleString()}列${
    truncated ? "（表示上限を超えた部分は省略）" : ""
  }`;
  if (chartColumns) renderChart();
}

function renderMarkdown(text: string) {
  currentRows = [];
  closeChart();
  const article = document.createElement("article");
  const markdown = new MarkdownIt({ html: false, linkify: true, typographer: false });
  const tokens = markdown.parse(text, {});
  tokens.forEach((token) => {
    if (token.nesting === 1 && token.map) {
      token.attrSet("data-source-start", String(token.map[0]));
      token.attrSet("data-source-end", String(token.map[1]));
    }
  });
  article.innerHTML = markdown.renderer.render(tokens, markdown.options, {});
  article.querySelectorAll<HTMLElement>("[data-source-start]").forEach((element) => {
    const start = Number(element.dataset.sourceStart);
    const end = Number(element.dataset.sourceEnd);
    element.classList.toggle("viewer-source-selected", markdownBlockSelected(start, end));
  });
  article.querySelectorAll("a").forEach((link) => {
    link.target = "_blank";
    link.rel = "noreferrer";
  });
  content.replaceChildren(article);
  summary.classList.remove("warning");
  summary.title = "";
  summary.textContent = `${text.length.toLocaleString()}文字`;
}

function renderPayload(payload: ViewerPayload) {
  currentFormat = payload.format;
  currentText = payload.text;
  currentSelection = payload.selection;
  title.textContent = formatTitleBar(VIEWER_FORMAT_LABELS[payload.format]);
  void win.setTitle(title.textContent);
  delimiterControl.hidden = payload.format !== "csv";
  if (payload.format === "markdown") renderMarkdown(payload.text);
  else renderTable(payload.text);
}

function csvRowSelected(rowIndex: number) {
  if (!currentSelection) return false;
  const { start, end } = currentSelection;
  if (start.line === end.line && start.col === end.col) return rowIndex === start.line;
  return rowIndex >= start.line && (rowIndex < end.line || (rowIndex === end.line && end.col > 0));
}

function csvCellSelected(text: string, rowIndex: number, columnIndex: number) {
  if (!currentSelection || !csvRowSelected(rowIndex)) return false;
  const { start, end } = currentSelection;
  if (start.line !== end.line || start.line !== rowIndex) return true;
  return columnIndex === csvColumnAt(text.split("\n")[rowIndex] ?? "", start.col);
}

function csvColumnAt(line: string, column: number) {
  const delimiter = delimiterInput.value;
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

function markdownBlockSelected(start: number, end: number) {
  if (!currentSelection) return false;
  const { start: selectionStart, end: selectionEnd } = currentSelection;
  const lastSelectedLine = selectionStart.line === selectionEnd.line && selectionStart.col === selectionEnd.col
    ? selectionEnd.line
    : selectionEnd.line - Number(selectionEnd.col === 0);
  return start <= lastSelectedLine && end > selectionStart.line;
}

function showContextMenu(x: number, y: number) {
  contextMenu.replaceChildren();
  const item = document.createElement("button");
  item.textContent = "グラフを作成...";
  item.addEventListener("click", () => {
    contextMenu.hidden = true;
    openChartDialog();
  });
  contextMenu.appendChild(item);
  contextMenu.hidden = false;
  contextMenu.style.left = "0";
  contextMenu.style.top = "0";
  const rect = contextMenu.getBoundingClientRect();
  contextMenu.style.left = `${Math.min(x, window.innerWidth - rect.width - 4)}px`;
  contextMenu.style.top = `${Math.min(y, window.innerHeight - rect.height - 4)}px`;
}

function openChartDialog() {
  if (currentRows.length < 2) return;
  const headers = currentRows[0];
  const width = currentRows.reduce((max, row) => Math.max(max, row.length), 0);
  const overlay = document.createElement("div");
  overlay.className = "viewer-dialog-overlay";
  const dialog = document.createElement("div");
  dialog.className = "viewer-dialog";
  const heading = document.createElement("h2");
  heading.textContent = "グラフ作成";

  const xLabel = document.createElement("label");
  xLabel.textContent = "X軸";
  const xSelect = document.createElement("select");
  Array.from({ length: width }, (_, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = chartColumnLabel(headers, index);
    xSelect.appendChild(option);
  });
  xSelect.value = String(chartColumns?.x ?? 0);
  xLabel.appendChild(xSelect);

  const reverseLabel = document.createElement("label");
  reverseLabel.className = "chart-reverse-option";
  const reverseInput = document.createElement("input");
  reverseInput.type = "checkbox";
  reverseInput.checked = chartColumns?.reverseX ?? false;
  reverseLabel.append(reverseInput, document.createTextNode("X軸を反転"));

  const yTitle = document.createElement("div");
  yTitle.className = "viewer-dialog-label";
  yTitle.textContent = "Y軸";
  const yGrid = document.createElement("div");
  yGrid.className = "chart-column-grid";
  const numeric = numericColumnIndexes(currentRows);
  const defaultY = chartColumns?.y ?? numeric.filter((index) => index !== Number(xSelect.value)).slice(0, 1);
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
  xSelect.addEventListener("change", updateChecks);
  updateChecks();

  const buttons = document.createElement("div");
  buttons.className = "viewer-dialog-buttons";
  const cancel = document.createElement("button");
  cancel.textContent = "キャンセル";
  const create = document.createElement("button");
  create.className = "primary";
  create.textContent = "作成";
  buttons.append(cancel, create);
  dialog.append(heading, xLabel, reverseLabel, yTitle, yGrid, error, buttons);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const finish = () => overlay.remove();
  cancel.addEventListener("click", finish);
  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay) finish();
  });
  create.addEventListener("click", () => {
    const y = checks.filter((check) => check.checked).map((check) => Number(check.value));
    if (!y.length) {
      error.textContent = "Y軸を1列以上選択してください";
      return;
    }
    chartColumns = { x: Number(xSelect.value), y, reverseX: reverseInput.checked };
    finish();
    renderChart();
  });
}

function renderChart() {
  if (!chartColumns || currentRows.length < 2) return;
  const headers = currentRows[0];
  const rows = currentRows.slice(1);
  if (chartColumns.reverseX) rows.reverse();
  const style = getComputedStyle(document.documentElement);
  const foreground = style.getPropertyValue("--fg").trim();
  const grid = style.getPropertyValue("--border-strong").trim();
  const hidden = new Map<number, boolean>();
  chart?.data.datasets.forEach((dataset) => {
    const column = Number((dataset as typeof dataset & { columnIndex?: number }).columnIndex);
    hidden.set(column, !chart!.isDatasetVisible(chart!.data.datasets.indexOf(dataset)));
  });

  const datasets = chartColumns.y.map((column, index) => ({
    label: chartColumnLabel(headers, column),
    data: rows.map((row) => parseChartNumber(row[column] ?? "")),
    borderColor: CHART_COLORS[index % CHART_COLORS.length],
    backgroundColor: CHART_COLORS[index % CHART_COLORS.length],
    pointRadius: rows.length > 300 ? 0 : 2,
    borderWidth: 2,
    spanGaps: false,
    columnIndex: column,
    hidden: hidden.get(column) ?? false,
  }));
  const labels = rows.map((row) => row[chartColumns!.x] ?? "");

  chart?.destroy();
  chart = new Chart(chartCanvas, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { color: foreground } },
      },
      scales: {
        x: { ticks: { color: foreground }, grid: { color: grid } },
        y: { ticks: { color: foreground }, grid: { color: grid } },
      },
    },
  });
  chartTitle.textContent = `${chartColumnLabel(headers, chartColumns.x)} × ${chartColumns.y.map((column) => chartColumnLabel(headers, column)).join(", ")}`;
  content.hidden = true;
  chartPanel.hidden = false;
}

function closeChart() {
  chartPanel.hidden = true;
  content.hidden = false;
  chart?.destroy();
  chart = null;
  chartColumns = null;
}

async function start() {
  applyTheme();
  bindWindowControls();
  themeButton.addEventListener("click", () => {
    applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
  });
  delimiterInput.addEventListener("input", () => {
    if (!delimiterInput.value || currentFormat !== "csv") return;
    renderTable(currentText);
  });
  document.getElementById("chart-close")!.addEventListener("click", closeChart);
  content.addEventListener("contextmenu", (event) => {
    if (currentFormat === "markdown" || !(event.target as Element).closest(".viewer-grid")) return;
    event.preventDefault();
    showContextMenu(event.clientX, event.clientY);
  });
  document.addEventListener("mousedown", (event) => {
    if (!contextMenu.contains(event.target as Node)) contextMenu.hidden = true;
  });
  await listen<ViewerPayload>("viewer-update", (event) => {
    renderPayload(event.payload);
  });
  try {
    renderPayload(await takeViewerPayload(win.label));
  } catch (error) {
    title.textContent = formatTitleBar("表示できませんでした");
    const message = document.createElement("p");
    message.className = "viewer-error";
    message.textContent = String(error);
    content.replaceChildren(message);
  }
}

window.addEventListener("storage", (event) => {
  if (event.key === VIEWER_THEME_KEY) applyTheme(event.newValue);
});

void start();

import { getCurrentWindow } from "@tauri-apps/api/window";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Chart from "chart.js/auto";
import MarkdownIt from "markdown-it";
import Papa from "papaparse";
import { takeViewerPayload, type ViewerFormat, type ViewerPayload, type ViewerSelection } from "./api";
import { VIEWER_FORMAT_LABELS, formatFontFamily, formatTitleBar } from "./format";
import { basename } from "./path";
import { getSetting, initSettings, setSetting } from "./settings";
import { clampFontSize, promptFontFamily, promptFontSize as promptFontSizeDialog } from "./font-controls";
import {
  chartColumnLabel,
  chartPointRadius,
  CHART_TYPES,
  DEFAULT_CHART_TYPE,
  isChartTypeId,
  numericColumnIndexes,
  parseChartNumber,
  type ChartTypeId,
} from "./chart-data";
import { csvColumnAt, decodeDelimiter, isSingleCsvCellSelection } from "./csv-viewer";
import { resolveAssetPath } from "./viewer-assets";
import { normalizeTheme, THEME_STORAGE_KEY } from "./theme";

const MAX_TABLE_ROWS = 10_000;
const MAX_TABLE_COLUMNS = 200;
const CHART_COLORS = ["#4fc3f7", "#ffb74d", "#81c784", "#e57373", "#ba68c8", "#fff176", "#4dd0e1", "#f06292"];

await initSettings();

const win = getCurrentWindow();
const content = document.getElementById("viewer-content")!;
const title = document.getElementById("viewer-title")!;
const summary = document.getElementById("viewer-summary")!;
const themeButton = document.getElementById("viewer-theme")!;
const fontButton = document.getElementById("viewer-font")!;
const fontSizeButton = document.getElementById("viewer-font-size")!;
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
let currentSourcePath: string | null = null;
let chart: Chart<"line" | "bar", (number | null)[], string> | null = null;
let chartColumns: { x: number; y: number[]; reverseX: boolean; type: ChartTypeId } | null = null;
let fontFamily = getSetting("fontFamily");
let fontSize = getSetting("fontSize");

function applyFont(family: string, size: number, persist = true) {
  fontFamily = family;
  fontSize = size;
  document.documentElement.style.setProperty("--font-mono", family);
  document.documentElement.style.setProperty("--viewer-font-size", `${size}px`);
  fontButton.textContent = formatFontFamily(family);
  fontSizeButton.textContent = `${size}px`;
  if (persist) {
    setSetting("fontFamily", family);
    setSetting("fontSize", size);
  }
}

async function promptFont() {
  const family = await promptFontFamily(fontFamily);
  if (family) applyFont(family, fontSize);
}

async function promptFontSize() {
  const size = await promptFontSizeDialog(fontSize);
  if (size !== null) applyFont(fontFamily, size);
}

function onViewerWheel(event: WheelEvent) {
  if (!event.ctrlKey) return;
  event.preventDefault();
  if (event.deltaY) applyFont(fontFamily, clampFontSize(fontSize + (event.deltaY < 0 ? 1 : -1)));
}

function applyTheme(theme = localStorage.getItem(THEME_STORAGE_KEY)) {
  const value = normalizeTheme(theme);
  document.documentElement.dataset.theme = value;
  themeButton.textContent = value === "dark" ? "ダーク" : "ライト";
  localStorage.setItem(THEME_STORAGE_KEY, value);
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
  fontButton.addEventListener("click", () => void promptFont());
  fontSizeButton.addEventListener("click", () => void promptFontSize());
  content.addEventListener("wheel", onViewerWheel, { passive: false });
  void win.onResized(() => { void syncMaxIcon(); });
  void syncMaxIcon();
}

function renderTable(text: string) {
  const sourceLines = text.split(/\r?\n/);
  const parsed = Papa.parse<string[]>(text, {
    delimiter: decodeDelimiter(delimiterInput.value),
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
      cell.classList.toggle("viewer-source-selected", csvCellSelected(sourceLines[rowIndex] ?? "", rowIndex, columnIndex));
      tr.appendChild(cell);
    });
    tr.classList.toggle("viewer-source-selected", csvRowSelected(sourceLines[rowIndex] ?? "", rowIndex));
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

// 生HTMLは <img> だけ通す。他のタグは今まで通り文字列として見せる。
const IMG_ONLY = /^<img\b[^>]*>$/i;
const IMG_ATTRIBUTES = ["src", "alt", "title", "width", "height"];

function renderRawHtml(raw: string, escape: (text: string) => string): string {
  if (!IMG_ONLY.test(raw.trim())) return escape(raw);
  // template の中身は不活性なので、この時点で画像取得もハンドラ実行も起きない
  const template = document.createElement("template");
  template.innerHTML = raw.trim();
  const img = template.content.firstElementChild;
  if (!(img instanceof HTMLImageElement)) return escape(raw);
  for (const name of img.getAttributeNames()) {
    if (!IMG_ATTRIBUTES.includes(name.toLowerCase())) img.removeAttribute(name);
  }
  return img.outerHTML;
}

function renderMarkdown(text: string) {
  currentRows = [];
  closeChart();
  const article = document.createElement("article");
  const markdown = new MarkdownIt({ html: true, linkify: true, typographer: false });
  const rawHtml = (tokens: { content: string }[], index: number) =>
    renderRawHtml(tokens[index].content, markdown.utils.escapeHtml);
  markdown.renderer.rules.html_block = rawHtml;
  markdown.renderer.rules.html_inline = rawHtml;
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
  article.querySelectorAll("img").forEach((image) => {
    const resolved = resolveAssetPath(currentSourcePath, image.getAttribute("src") ?? "");
    if (resolved) image.src = convertFileSrc(resolved);
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
  currentSourcePath = payload.source_path;
  const sourceName = payload.source_path ? basename(payload.source_path) : "";
  title.textContent = formatTitleBar(`${sourceName ? `${sourceName} — ` : ""}${VIEWER_FORMAT_LABELS[payload.format]}`);
  void win.setTitle(title.textContent);
  delimiterControl.hidden = payload.format !== "csv";
  if (payload.format === "markdown") renderMarkdown(payload.text);
  else renderTable(payload.text);
}

function csvRowSelected(line: string, rowIndex: number) {
  if (!csvSourceLineSelected(rowIndex) || !currentSelection) return false;
  const { start } = currentSelection;
  if (rowIndex === start.line && isSingleCsvCellSelection(line, currentSelection, delimiterInput.value)) {
    return false;
  }
  return true;
}

function csvCellSelected(line: string, rowIndex: number, columnIndex: number) {
  if (!currentSelection || !csvSourceLineSelected(rowIndex)) return false;
  const { start, end } = currentSelection;
  if (start.line !== end.line || start.line !== rowIndex) return true;
  return columnIndex === csvColumnAt(line, start.col, delimiterInput.value);
}

function csvSourceLineSelected(rowIndex: number) {
  if (!currentSelection) return false;
  const { start, end } = currentSelection;
  if (start.line === end.line && start.col === end.col) return rowIndex === start.line;
  return rowIndex >= start.line && (rowIndex < end.line || (rowIndex === end.line && end.col > 0));
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

  const typeLabel = document.createElement("label");
  typeLabel.textContent = "グラフの種類";
  const typeSelect = document.createElement("select");
  Object.entries(CHART_TYPES).forEach(([id, spec]) => {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = spec.label;
    typeSelect.appendChild(option);
  });
  typeSelect.value = chartColumns?.type ?? DEFAULT_CHART_TYPE;
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
  dialog.append(heading, typeLabel, xLabel, reverseLabel, yTitle, yGrid, error, buttons);
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
    const type = isChartTypeId(typeSelect.value) ? typeSelect.value : DEFAULT_CHART_TYPE;
    chartColumns = { x: Number(xSelect.value), y, reverseX: reverseInput.checked, type };
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

  const spec = CHART_TYPES[chartColumns.type];
  const datasets = chartColumns.y.map((column, index) => {
    const color = CHART_COLORS[index % CHART_COLORS.length];
    return {
      label: chartColumnLabel(headers, column),
      data: rows.map((row) => parseChartNumber(row[column] ?? "")),
      borderColor: color,
      // 面グラフは重ねて見るため半透明にする (それ以外は棒/点の塗りとして不透明のまま)
      backgroundColor: spec.fill ? `${color}55` : color,
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
  const labels = rows.map((row) => row[chartColumns!.x] ?? "");

  chart?.destroy();
  chart = new Chart(chartCanvas, {
    type: spec.base,
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
        x: { stacked: spec.stacked ?? false, ticks: { color: foreground }, grid: { color: grid } },
        y: { stacked: spec.stacked ?? false, ticks: { color: foreground }, grid: { color: grid } },
      },
    },
  });
  chartTitle.textContent = `${spec.label}: ${chartColumnLabel(headers, chartColumns.x)} × ${chartColumns.y.map((column) => chartColumnLabel(headers, column)).join(", ")}`;
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
  try {
    applyTheme();
bindWindowControls();
applyFont(fontFamily, fontSize, false);
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
  if (event.key === THEME_STORAGE_KEY) applyTheme(event.newValue);
});

void start();

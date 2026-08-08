import { getCurrentWindow } from "@tauri-apps/api/window";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Chart from "chart.js/auto";
import MarkdownIt from "markdown-it";
import Papa from "papaparse";
import { EVENT_NAMES, readArchiveAsset, takeViewerPayload, type ViewerFormat, type ViewerPayload, type ViewerSelection } from "./api";
import { formatFontFamily } from "./format";
import { createViewerFormatHandlers, isViewerFormat, VIEWER_FORMATS } from "./viewer-formats";
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
import { resolveArchiveAssetEntry, resolveAssetPath } from "./viewer-assets";
import { normalizeTheme, THEME_STORAGE_KEY } from "./theme";
import { showError } from "./dialogs";
import { WindowControls } from "./window-controls";
import { reportWindowOperationError, runWindowOperation } from "./window-operation";
import { imageMimeType } from "./image-formats";
import {
  markdownBlockSelected,
  markdownHighlightTargets,
  renderRawHtml,
  scrollMarkdownCaret,
} from "./viewer-markdown";
import { scrollViewerCaret } from "./viewer-scroll";
import { createViewerChartMenuItem } from "./viewer-context-menu";
import { INLINE_PREVIEW_MESSAGES } from "./inline-preview";
import { isViewerPayload } from "./viewer-payload";

const MAX_TABLE_ROWS = 10_000;
const MAX_TABLE_COLUMNS = 200;
const CHART_COLORS = ["#4fc3f7", "#ffb74d", "#81c784", "#e57373", "#ba68c8", "#fff176", "#4dd0e1", "#f06292"];

await initSettings();

const isInlineViewer = new URLSearchParams(window.location.search).get("inline") === "1";
const win = isInlineViewer ? null : getCurrentWindow();
const content = document.getElementById("viewer-content")!;
const title = document.getElementById("viewer-title-text")!;
const formatSelect = document.getElementById("viewer-format") as HTMLSelectElement;
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
let currentArchivePath: string | null = null;
let currentArchiveEntry: string | null = null;
let renderGeneration = 0;
let archiveAssetUrls: string[] = [];
let chart: Chart<"line" | "bar", (number | null)[], string> | null = null;
let chartColumns: { x: number; y: number[]; reverseX: boolean; type: ChartTypeId } | null = null;
let fontFamily = getSetting("fontFamily");
let fontSize = getSetting("previewFontSize");

function postToParent(message: unknown) {
  window.parent.postMessage(message, window.location.origin);
}

function populateFormatSelect() {
  formatSelect.replaceChildren(...Object.values(VIEWER_FORMATS).map((spec) => {
    const option = document.createElement("option");
    option.value = spec.id;
    option.textContent = spec.title;
    return option;
  }));
}

function scrollCsvRows(rows: HTMLElement[], selection: ViewerSelection | null) {
  scrollViewerCaret(rows, selection, (_row, index) => ({ start: index, end: index + 1 }));
}

function applyFontFamily(family: string, persist = true) {
  fontFamily = family;
  document.documentElement.style.setProperty("--font-mono", family);
  fontButton.textContent = formatFontFamily(family);
  if (persist) {
    if (isInlineViewer) {
      postToParent({
        type: INLINE_PREVIEW_MESSAGES.FONT_CHANGE_MESSAGE,
        family,
      });
    } else {
      setSetting("fontFamily", family);
    }
  }
}

function applyFontSize(size: number, persist = true) {
  fontSize = size;
  document.documentElement.style.setProperty("--viewer-font-size", `${size}px`);
  fontSizeButton.textContent = `${size}px`;
  if (persist) setSetting("previewFontSize", size);
}

function applyFont(family: string, size: number, persist = true) {
  applyFontFamily(family, persist);
  applyFontSize(size, persist);
}

async function promptFont() {
  const family = await promptFontFamily(fontFamily);
  if (family) applyFontFamily(family);
}

async function promptFontSize() {
  const size = await promptFontSizeDialog(fontSize);
  if (size !== null) applyFontSize(size);
}

function onViewerWheel(event: WheelEvent) {
  if (!event.ctrlKey) return;
  event.preventDefault();
  if (event.deltaY) applyFontSize(clampFontSize(fontSize + (event.deltaY < 0 ? 1 : -1)));
}

function applyTheme(theme = localStorage.getItem(THEME_STORAGE_KEY)) {
  const value = normalizeTheme(theme);
  document.documentElement.dataset.theme = value;
  themeButton.textContent = value === "dark" ? "ダーク" : "ライト";
  localStorage.setItem(THEME_STORAGE_KEY, value);
  if (chartColumns) renderChart();
}

function reportWindowError(title: string, error: unknown) {
  void reportWindowOperationError(showError, title, error);
}

function runViewerOperation(title: string, operation: () => void | Promise<unknown>) {
  runWindowOperation(showError, title, operation);
}

function bindViewerControls() {
  fontButton.addEventListener("click", () => runViewerOperation("フォントを変更できませんでした", promptFont));
  fontSizeButton.addEventListener("click", () => runViewerOperation("文字サイズを変更できませんでした", promptFontSize));
  content.addEventListener("wheel", onViewerWheel, { passive: false });
  formatSelect.addEventListener("change", () => {
    if (!isInlineViewer) return;
    const format = formatSelect.value;
    if (!isViewerFormat(format)) return;
    postToParent({
      type: INLINE_PREVIEW_MESSAGES.FORMAT_CHANGE_MESSAGE,
      format,
    });
  });
}

function renderTable(text: string) {
  renderGeneration++;
  revokeArchiveAssetUrls();
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
  const rows: HTMLTableRowElement[] = [];

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
    rows.push(tr);
    fragment.appendChild(tr);
  });
  body.appendChild(fragment);
  table.appendChild(body);
  content.replaceChildren(table);
  scrollCsvRows(rows, currentSelection);

  const maxColumns = currentRows.reduce((max, row) => Math.max(max, row.length), 0);
  const truncated = currentRows.length > MAX_TABLE_ROWS || maxColumns > MAX_TABLE_COLUMNS;
  summary.classList.toggle("warning", parsed.errors.length > 0);
  summary.title = parsed.errors.map((error) => error.message).join("\n");
  summary.textContent = `${currentRows.length.toLocaleString()}行 × ${maxColumns.toLocaleString()}列${
    truncated ? "（表示上限を超えた部分は省略）" : ""
  }`;
  if (chartColumns) renderChart();
}

function revokeArchiveAssetUrls() {
  archiveAssetUrls.forEach((url) => URL.revokeObjectURL(url));
  archiveAssetUrls = [];
}

async function loadArchiveImages(
  article: HTMLElement,
  generation: number,
  archivePath: string | null,
  archiveEntry: string | null,
) {
  const images = [...article.querySelectorAll<HTMLImageElement>("img")];
  await Promise.all(images.map(async (image) => {
    try {
      const src = image.getAttribute("src") ?? "";
      const entry = resolveArchiveAssetEntry(archiveEntry, src);
      if (archivePath && archiveEntry && entry) {
        try {
          const bytes = await readArchiveAsset(archivePath, entry);
          if (generation !== renderGeneration) return;
          const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: imageMimeType(src) }));
          archiveAssetUrls.push(url);
          image.src = url;
          await waitForImageLayout(image);
        } catch {
          if (generation !== renderGeneration) return;
          image.removeAttribute("src");
          image.alt = `${image.alt || "画像"}（読み込めません）`;
        }
        return;
      }
      const resolved = resolveAssetPath(currentSourcePath, src);
      if (resolved && generation === renderGeneration) {
        image.src = convertFileSrc(resolved);
        await waitForImageLayout(image);
      }
    } catch {
      if (generation !== renderGeneration) return;
      image.removeAttribute("src");
      image.alt = `${image.alt || "画像"}（読み込めません）`;
    }
  }));
}

async function waitForImageLayout(image: HTMLImageElement) {
  if (!image.getAttribute("src")) return;
  if (!image.complete) {
    await new Promise<void>((resolve) => {
      let timeout: number | undefined;
      const finish = () => {
        window.clearTimeout(timeout);
        image.removeEventListener("load", finish);
        image.removeEventListener("error", finish);
        resolve();
      };
      image.addEventListener("load", finish, { once: true });
      image.addEventListener("error", finish, { once: true });
      timeout = window.setTimeout(finish, 2000);
      if (image.complete) finish();
    });
  }
  try {
    await image.decode?.();
  } catch {
    // 壊れた画像でも本文の中央スクロールは継続する。
  }
}

async function renderMarkdown(text: string) {
  const generation = ++renderGeneration;
  const archivePath = currentArchivePath;
  const archiveEntry = currentArchiveEntry;
  const selection = currentSelection;
  revokeArchiveAssetUrls();
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
  const sourceElements = [...article.querySelectorAll<HTMLElement>("[data-source-start]")];
  const highlightTargets = markdownHighlightTargets(sourceElements);
  highlightTargets.forEach((element) => {
    const start = Number(element.dataset.sourceStart);
    const end = Number(element.dataset.sourceEnd);
    element.classList.toggle("viewer-source-selected", markdownBlockSelected(selection, start, end));
  });
  article.querySelectorAll("a").forEach((link) => {
    link.target = "_blank";
    link.rel = "noreferrer";
  });
  content.replaceChildren(article);
  summary.classList.remove("warning");
  summary.title = "";
  summary.textContent = `${text.length.toLocaleString()}文字`;
  await loadArchiveImages(article, generation, archivePath, archiveEntry);
  // 画像の高さが確定する前にスクロールすると、読込後のレイアウト変化で中央位置が崩れる。
  if (generation === renderGeneration) scrollMarkdownCaret(highlightTargets, selection);
}

const VIEWER_HANDLERS = createViewerFormatHandlers({
  csv: renderTable,
  markdown: renderMarkdown,
});

function renderPayload(payload: ViewerPayload) {
  if (!isViewerPayload(payload)) throw new Error("ビューのデータが不正です");
  currentFormat = payload.format;
  currentText = payload.text;
  currentSelection = payload.selection;
  currentSourcePath = payload.source_path;
  currentArchivePath = payload.archive_path;
  currentArchiveEntry = payload.archive_entry;
  const handler = VIEWER_HANDLERS[payload.format];
  formatSelect.value = payload.format;
  title.textContent = VIEWER_FORMATS[payload.format].title;
  document.title = title.textContent;
  if (!isInlineViewer) runViewerOperation("タイトルを更新できませんでした", () => win!.setTitle(title.textContent));
  delimiterControl.hidden = !handler.supportsDelimiter;
  runViewerOperation("ビューを描画できませんでした", () => handler.render(payload.text));
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

function showContextMenu(x: number, y: number) {
  contextMenu.replaceChildren();
  const item = createViewerChartMenuItem(() => {
    contextMenu.hidden = true;
    runViewerOperation("グラフ設定を開けませんでした", openChartDialog);
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
    runViewerOperation("グラフを描画できませんでした", renderChart);
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
  if (currentFormat === "csv") {
    scrollCsvRows([...content.querySelectorAll<HTMLTableRowElement>(".viewer-grid tbody > tr")], currentSelection);
  }
}

async function start() {
  try {
    if (isInlineViewer) document.body.classList.add("inline-viewer");
    applyTheme();
    if (!isInlineViewer) new WindowControls(document.body, win!, title, { onError: reportWindowError });
    populateFormatSelect();
    bindViewerControls();
    applyFont(fontFamily, fontSize, false);
    themeButton.addEventListener("click", () => {
      runViewerOperation("配色を変更できませんでした", () => {
        applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
      });
    });
    delimiterInput.addEventListener("input", () => {
      const handler = VIEWER_HANDLERS[currentFormat];
      if (!delimiterInput.value || !handler.supportsDelimiter) return;
      runViewerOperation("ビューを再描画できませんでした", () => VIEWER_HANDLERS[currentFormat].render(currentText));
    });
    document.getElementById("chart-close")!.addEventListener("click", () => {
      runViewerOperation("グラフを閉じられませんでした", closeChart);
    });
    content.addEventListener("contextmenu", (event) => {
      if (!VIEWER_HANDLERS[currentFormat].supportsChart || !(event.target as Element).closest(".viewer-grid")) return;
      event.preventDefault();
      runViewerOperation("グラフメニューを表示できませんでした", () => showContextMenu(event.clientX, event.clientY));
    });
    document.addEventListener("mousedown", (event) => {
      if (!contextMenu.contains(event.target as Node)) contextMenu.hidden = true;
    });
    if (isInlineViewer) {
      window.addEventListener("message", (event) => {
        if (event.source !== window.parent || event.origin !== window.location.origin) return;
        if (event.data?.type === INLINE_PREVIEW_MESSAGES.PAYLOAD_MESSAGE) {
          if (!isViewerPayload(event.data.payload)) return;
          runViewerOperation("ビューを更新できませんでした", () => renderPayload(event.data.payload));
          return;
        }
        if (event.data?.type === INLINE_PREVIEW_MESSAGES.DELIMITER_MESSAGE) {
          if (typeof event.data.delimiter !== "string") return;
          delimiterInput.value = event.data.delimiter;
          if (!delimiterInput.value || !VIEWER_HANDLERS[currentFormat].supportsDelimiter) return;
          runViewerOperation("ビューを再描画できませんでした", () => VIEWER_HANDLERS[currentFormat].render(currentText));
          return;
        }
        if (event.data?.type === INLINE_PREVIEW_MESSAGES.FONT_MESSAGE) {
          if (typeof event.data.family !== "string") return;
          applyFontFamily(event.data.family, false);
          return;
        }
      });
      postToParent({ type: INLINE_PREVIEW_MESSAGES.READY_MESSAGE });
    } else {
      await listen<ViewerPayload>(EVENT_NAMES.viewerUpdate, (event) => {
        runViewerOperation("ビューを更新できませんでした", () => renderPayload(event.payload));
      });
      renderPayload(await takeViewerPayload(win!.label));
    }
  } catch (error) {
    title.textContent = "表示できませんでした";
    const message = document.createElement("p");
    message.className = "viewer-error";
    message.textContent = String(error);
    content.replaceChildren(message);
  }
}

window.addEventListener("storage", (event) => {
  if (event.key === THEME_STORAGE_KEY) {
    runViewerOperation("配色を同期できませんでした", () => applyTheme(event.newValue));
  }
});

void start();

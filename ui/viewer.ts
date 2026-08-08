import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import Chart from "chart.js/auto";
import MarkdownIt from "markdown-it";
import Papa from "papaparse";
import { EVENT_NAMES, takeViewerPayload, type ViewerFormat, type ViewerPayload, type ViewerSelection } from "./api";
import { formatFontFamily } from "./format";
import { basename } from "./path";
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
import {
  csvCellBoundsForColumn,
  csvCellOffsetAt,
  csvColumnAt,
  decodeDelimiter,
  isSingleCsvCellSelection,
  resizedCsvColumnWidth,
} from "./csv-viewer";
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
import { INLINE_PREVIEW_MESSAGES } from "./inline-preview-protocol";
import { isViewerPayload } from "./viewer-payload";
import { imageUrlFromArchive, imageUrlFromPath, revokeImageUrl } from "./viewer-image-source";
import { createImagePreview, markImageLoadFailure } from "./viewer-image";
import { createAsyncUnlisten } from "./async-unlisten";

const MAX_TABLE_ROWS = 10_000;
const MAX_TABLE_COLUMNS = 200;
const CHART_COLORS = ["#4fc3f7", "#ffb74d", "#81c784", "#e57373", "#ba68c8", "#fff176", "#4dd0e1", "#f06292"];

await initSettings();

const isInlineViewer = new URLSearchParams(window.location.search).get("inline") === "1";
const win = isInlineViewer ? null : getCurrentWindow();
const content = document.getElementById("viewer-content")!;
const title = document.getElementById("viewer-title-text")!;
const formatSelect = document.getElementById("viewer-format") as HTMLSelectElement;
const fullscreenButton = document.getElementById("viewer-fullscreen") as HTMLButtonElement;
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
let csvColumnWidths: number[] = [];
let fontFamily = getSetting("fontFamily");
let fontSize = getSetting("previewFontSize");
const viewerUpdateListener = createAsyncUnlisten();
let windowControls: WindowControls | null = null;

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

function isCollapsedSelection(selection: ViewerSelection | null): boolean {
  return !!selection
    && selection.start.line === selection.end.line
    && selection.start.col === selection.end.col;
}

function comparePositions(left: { line: number; col: number }, right: { line: number; col: number }) {
  return left.line - right.line || left.col - right.col;
}

function textOffsetWithin(element: HTMLElement, node: Node, offset: number): number {
  if (node === element) {
    return [...element.childNodes].slice(0, offset)
      .reduce((length, child) => length + (child.textContent?.length ?? 0), 0);
  }
  const range = document.createRange();
  range.selectNodeContents(element);
  range.setEnd(node, offset);
  return range.toString().length;
}

function sourcePositionFromPoint(node: Node, offset: number, endPoint: boolean): { line: number; col: number } | null {
  const element = node.nodeType === Node.ELEMENT_NODE
    ? node as Element
    : node.parentElement;
  const cell = element?.closest<HTMLElement>("[data-source-line]");
  if (cell) {
    const line = Number(cell.dataset.sourceLine);
    const valueStart = Number(cell.dataset.sourceValueStart ?? 0);
    const valueEnd = Number(cell.dataset.sourceValueEnd ?? valueStart);
    const cellOffset = textOffsetWithin(cell, node, offset);
    return {
      line,
      col: Math.max(valueStart, Math.min(valueEnd, valueStart + cellOffset)),
    };
  }
  const block = element?.closest<HTMLElement>("[data-source-start][data-source-end]");
  if (!block) return null;
  const line = Number(block.dataset.sourceEnd ?? block.dataset.sourceStart);
  return { line: endPoint ? line : Number(block.dataset.sourceStart), col: 0 };
}

function viewerSelectionFromDom(): ViewerSelection | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !selection.anchorNode || !selection.focusNode) return null;
  if (!content.contains(selection.anchorNode) || !content.contains(selection.focusNode)) return null;
  const anchor = sourcePositionFromPoint(selection.anchorNode, selection.anchorOffset, false);
  const focus = sourcePositionFromPoint(selection.focusNode, selection.focusOffset, !selection.isCollapsed);
  if (!anchor || !focus) return null;
  return comparePositions(anchor, focus) <= 0
    ? { start: anchor, end: focus }
    : { start: focus, end: anchor };
}

function notifyParentOfSelection() {
  if (!isInlineViewer) return;
  const selection = viewerSelectionFromDom();
  if (!selection) return;
  postToParent({
    type: INLINE_PREVIEW_MESSAGES.SELECTION_CHANGE_MESSAGE,
    selection,
  });
}

function appendCsvCaret(cell: HTMLElement, value: string, sourceLine: string, rowIndex: number, columnIndex: number) {
  if (!currentSelection || !isCollapsedSelection(currentSelection)
    || currentSelection.start.line !== rowIndex
    || csvColumnAt(sourceLine, currentSelection.start.col, delimiterInput.value) !== columnIndex) {
    cell.textContent = value;
    return;
  }
  const offset = Math.max(0, Math.min(value.length, csvCellOffsetAt(
    sourceLine,
    currentSelection.start.col,
    delimiterInput.value,
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

function createCsvColumnGroup(table: HTMLTableElement, columnCount: number): HTMLTableColElement[] {
  const group = document.createElement("colgroup");
  const lineNumber = document.createElement("col");
  lineNumber.className = "viewer-line-number-column";
  group.appendChild(lineNumber);
  const columns = Array.from({ length: columnCount }, (_, index) => {
    const column = document.createElement("col");
    const width = csvColumnWidths[index];
    if (width) column.style.width = width + "px";
    group.appendChild(column);
    return column;
  });
  table.appendChild(group);
  if (columns.length && csvColumnWidths.length >= columns.length) {
    table.style.tableLayout = "fixed";
    table.style.width = "max-content";
  }
  return columns;
}

function startCsvColumnResize(
  event: PointerEvent,
  table: HTMLTableElement,
  columns: HTMLTableColElement[],
  columnIndex: number,
) {
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  const handle = event.currentTarget as HTMLElement;
  const header = handle.parentElement;
  if (!header) return;
  const startWidth = header.getBoundingClientRect().width;
  const startX = event.clientX;
  if (csvColumnWidths.length < columns.length) {
    const cells = [...table.rows[0]?.cells ?? []];
    csvColumnWidths = columns.map((_, index) => csvColumnWidths[index]
      ?? cells[index + 1]?.getBoundingClientRect().width
      ?? startWidth);
  }
  table.style.tableLayout = "fixed";
  table.style.width = "max-content";
  const update = (clientX: number) => {
    const width = resizedCsvColumnWidth(startWidth, clientX - startX);
    csvColumnWidths[columnIndex] = width;
    columns[columnIndex].style.width = width + "px";
  };
  const finish = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", finish);
    document.body.classList.remove("viewer-resizing");
  };
  const onMove = (move: PointerEvent) => update(move.clientX);
  document.body.classList.add("viewer-resizing");
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", finish, { once: true });
  window.addEventListener("pointercancel", finish, { once: true });
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

function setFullscreenButton(fullscreen: boolean) {
  fullscreenButton.textContent = fullscreen ? "↙" : "⛶";
  const label = fullscreen ? "元の表示に戻す" : "プレビューを全画面表示";
  fullscreenButton.title = label;
  fullscreenButton.setAttribute("aria-label", label);
  fullscreenButton.setAttribute("aria-pressed", String(fullscreen));
}

function disposeViewer() {
  viewerUpdateListener.dispose();
  windowControls?.dispose();
  windowControls = null;
  revokeArchiveAssetUrls();
  closeChart();
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
  setFullscreenButton(false);
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
  fullscreenButton.addEventListener("click", () => {
    if (isInlineViewer) postToParent({ type: INLINE_PREVIEW_MESSAGES.FULLSCREEN_CHANGE_MESSAGE });
  });
  document.addEventListener("selectionchange", notifyParentOfSelection);
  content.addEventListener("mouseup", notifyParentOfSelection);
  content.addEventListener("keyup", notifyParentOfSelection);
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
  const maxColumns = currentRows.reduce((max, row) => Math.max(max, row.length), 0);
  const columns = createCsvColumnGroup(table, Math.min(maxColumns, MAX_TABLE_COLUMNS));

  currentRows.slice(0, MAX_TABLE_ROWS).forEach((row, rowIndex) => {
    const tr = document.createElement("tr");
    tr.dataset.sourceLine = String(rowIndex);
    const lineNumber = document.createElement(rowIndex === 0 ? "th" : "td");
    lineNumber.className = "viewer-line-number";
    lineNumber.textContent = String(rowIndex + 1);
    lineNumber.dataset.sourceLine = String(rowIndex);
    tr.appendChild(lineNumber);
    row.slice(0, MAX_TABLE_COLUMNS).forEach((value, columnIndex) => {
      const cell = document.createElement(rowIndex === 0 ? "th" : "td");
      const sourceLine = sourceLines[rowIndex] ?? "";
      const cellBounds = csvCellBoundsForColumn(sourceLine, columnIndex, delimiterInput.value);
      cell.dataset.sourceLine = String(rowIndex);
      cell.dataset.sourceStart = String(cellBounds.start);
      cell.dataset.sourceEnd = String(cellBounds.end);
      const quoted = sourceLine[cellBounds.start] === '"';
      const valueStart = cellBounds.start + (quoted ? 1 : 0);
      const valueEnd = Math.max(valueStart, cellBounds.end - (quoted && sourceLine[cellBounds.end - 1] === '"' ? 1 : 0));
      cell.dataset.sourceValueStart = String(valueStart);
      cell.dataset.sourceValueEnd = String(valueEnd);
      appendCsvCaret(cell, value, sourceLine, rowIndex, columnIndex);
      cell.classList.toggle("viewer-source-selected", csvCellSelected(sourceLine, rowIndex, columnIndex));
      tr.appendChild(cell);
      if (rowIndex === 0 && columns[columnIndex]) {
        const handle = document.createElement("span");
        handle.className = "viewer-column-resizer";
        handle.setAttribute("aria-hidden", "true");
        handle.addEventListener("pointerdown", (event) =>
          startCsvColumnResize(event, table, columns, columnIndex));
        cell.appendChild(handle);
      }
    });
    tr.classList.toggle("viewer-source-selected", csvRowSelected(sourceLines[rowIndex] ?? "", rowIndex));
    rows.push(tr);
    fragment.appendChild(tr);
  });
  body.appendChild(fragment);
  table.appendChild(body);
  content.replaceChildren(table);
  scrollCsvRows(rows, currentSelection);

  const truncated = currentRows.length > MAX_TABLE_ROWS || maxColumns > MAX_TABLE_COLUMNS;
  summary.classList.toggle("warning", parsed.errors.length > 0);
  summary.title = parsed.errors.map((error) => error.message).join("\n");
  summary.textContent = `${currentRows.length.toLocaleString()}行 × ${maxColumns.toLocaleString()}列${
    truncated ? "（表示上限を超えた部分は省略）" : ""
  }`;
  if (chartColumns) renderChart();
}

function revokeArchiveAssetUrls() {
  archiveAssetUrls.forEach((url) => revokeImageUrl(url));
  archiveAssetUrls = [];
}

function retainArchiveAssetUrl(url: string, generation: number): boolean {
  if (generation !== renderGeneration) {
    revokeImageUrl(url);
    return false;
  }
  archiveAssetUrls.push(url);
  return true;
}

function releaseArchiveAssetUrl(url: string) {
  archiveAssetUrls = archiveAssetUrls.filter((current) => current !== url);
  revokeImageUrl(url);
}

async function loadArchiveImages(
  article: HTMLElement,
  generation: number,
  archivePath: string | null,
  archiveEntry: string | null,
) {
  const images = [...article.querySelectorAll<HTMLImageElement>("img")];
  await Promise.all(images.map(async (image) => {
    let archiveUrl: string | null = null;
    let keepArchiveUrl = false;
    try {
      const src = image.getAttribute("src") ?? "";
      const entry = resolveArchiveAssetEntry(archiveEntry, src);
      if (archivePath && archiveEntry && entry) {
        archiveUrl = await imageUrlFromArchive(archivePath, entry, imageMimeType(src));
        if (!retainArchiveAssetUrl(archiveUrl, generation)) {
          archiveUrl = null;
          return;
        }
        image.src = archiveUrl;
        await waitForImageLayout(image);
        keepArchiveUrl = true;
        return;
      }
      const resolved = resolveAssetPath(currentSourcePath, src);
      if (resolved && generation === renderGeneration) {
        image.src = imageUrlFromPath(resolved);
        await waitForImageLayout(image);
      }
    } catch (error) {
      if (generation !== renderGeneration) return;
      markImageLoadFailure(image);
      throw error;
    } finally {
      if (archiveUrl && (!keepArchiveUrl || generation !== renderGeneration)) {
        releaseArchiveAssetUrl(archiveUrl);
      }
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

async function renderImage(_text: string) {
  const generation = ++renderGeneration;
  const sourcePath = currentSourcePath;
  const archivePath = currentArchivePath;
  const archiveEntry = currentArchiveEntry;
  revokeArchiveAssetUrls();
  currentRows = [];
  closeChart();

  const name = basename(archiveEntry ?? sourcePath ?? "image");
  const { wrapper, image } = createImagePreview(name);
  content.replaceChildren(wrapper);
  summary.classList.remove("warning");
  summary.title = "";
  summary.textContent = name;

  let archiveUrl: string | null = null;
  let keepArchiveUrl = false;
  try {
    if (archivePath && archiveEntry) {
      archiveUrl = await imageUrlFromArchive(archivePath, archiveEntry, imageMimeType(archiveEntry));
      if (!retainArchiveAssetUrl(archiveUrl, generation)) {
        archiveUrl = null;
        return;
      }
      image.src = archiveUrl;
    } else if (sourcePath && generation === renderGeneration) {
      image.src = imageUrlFromPath(sourcePath);
    } else {
      markImageLoadFailure(image, name);
      return;
    }
    await waitForImageLayout(image);
    keepArchiveUrl = true;
  } catch (error) {
    if (generation !== renderGeneration) return;
    markImageLoadFailure(image, name);
    throw error;
  } finally {
    if (archiveUrl && (!keepArchiveUrl || generation !== renderGeneration)) {
      releaseArchiveAssetUrl(archiveUrl);
    }
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
    const selected = markdownBlockSelected(selection, start, end);
    element.classList.toggle("viewer-source-selected", !isCollapsedSelection(selection) && selected);
    element.classList.toggle("viewer-caret-line", isCollapsedSelection(selection) && selected);
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
  image: renderImage,
});

function renderPayload(payload: ViewerPayload) {
  if (!isViewerPayload(payload)) throw new Error("ビューのデータが不正です");
  if (payload.format !== currentFormat
    || payload.source_path !== currentSourcePath
    || payload.archive_path !== currentArchivePath
    || payload.archive_entry !== currentArchiveEntry) {
    csvColumnWidths = [];
  }
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
  if (!csvSourceLineSelected(rowIndex) || !currentSelection || isCollapsedSelection(currentSelection)) return false;
  const { start } = currentSelection;
  if (rowIndex === start.line && isSingleCsvCellSelection(line, currentSelection, delimiterInput.value)) {
    return false;
  }
  return true;
}

function csvCellSelected(line: string, rowIndex: number, columnIndex: number) {
  if (!currentSelection || isCollapsedSelection(currentSelection) || !csvSourceLineSelected(rowIndex)) return false;
  const { start, end } = currentSelection;
  if (start.line !== end.line || start.line !== rowIndex) return true;
  return columnIndex === csvColumnAt(line, start.col, delimiterInput.value);
}

function csvSourceLineSelected(rowIndex: number) {
  if (!currentSelection || isCollapsedSelection(currentSelection)) return false;
  const { start, end } = currentSelection;
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
    if (!isInlineViewer) windowControls = new WindowControls(document.body, win!, title, { onError: reportWindowError });
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
        if (event.data?.type === INLINE_PREVIEW_MESSAGES.FULLSCREEN_STATE_MESSAGE) {
          if (typeof event.data.fullscreen !== "boolean") return;
          setFullscreenButton(event.data.fullscreen);
          return;
        }
      });
      postToParent({ type: INLINE_PREVIEW_MESSAGES.READY_MESSAGE });
    } else {
      viewerUpdateListener.set(await listen<ViewerPayload>(EVENT_NAMES.viewerUpdate, (event) => {
        runViewerOperation("ビューを更新できませんでした", () => renderPayload(event.payload));
      }));
      renderPayload(await takeViewerPayload(win!.label));
    }
  } catch (error) {
    disposeViewer();
    title.textContent = "表示できませんでした";
    const message = document.createElement("p");
    message.className = "viewer-error";
    message.textContent = String(error);
    content.replaceChildren(message);
  }
}

window.addEventListener("beforeunload", disposeViewer, { once: true });
window.addEventListener("storage", (event) => {
  if (event.key === THEME_STORAGE_KEY) {
    runViewerOperation("配色を同期できませんでした", () => applyTheme(event.newValue));
  }
});

void start();

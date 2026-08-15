import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { EVENT_NAMES, openInDefaultBrowser, takeViewerPayload, type ViewerFormat, type ViewerPayload, type ViewerSelection } from "./api";
import { formatFontFamily } from "./format";
import { basename } from "./path";
import { createViewerFormatHandlers, isViewerFormat, viewerFormatSpec } from "./viewer-formats";
import { getSetting, initSettings, setSetting } from "./settings";
import { clampFontSize, promptFontFamily, promptFontSize as promptFontSizeDialog } from "./font-controls";
import {
  csvColumnAt,
  csvSourceOffsetAtPosition,
  csvSourcePositionAtOffset,
} from "./csv-viewer";
import { startCsvColumnResize as bindCsvColumnResize } from "./csv-column-resize";
import { resolveArchiveAssetEntry, resolveAssetPath } from "./viewer-assets";
import { normalizeTheme, THEME_STORAGE_KEY } from "./theme";
import { showError } from "./dialogs";
import { WindowControls } from "./window-controls";
import { reportWindowOperationError, runWindowOperation } from "./window-operation";
import { imageExtensionOf, imageMimeType } from "./image-formats";
import {
  scrollMarkdownCaret,
} from "./viewer-markdown";
import { scrollViewerCaret, scrollViewerCell } from "./viewer-scroll";
import { createViewerBrowserMenuItem, createViewerChartMenuItem, createViewerDelimiterMenuItem } from "./viewer-context-menu";
import {
  DEFAULT_CSV_DELIMITER,
} from "./viewer-delimiter";
import { openViewerDelimiterDialog } from "./viewer-delimiter-dialog";
import { INLINE_PREVIEW_MESSAGES } from "./inline-preview-protocol";
import { isViewerPayload } from "./viewer-payload";
import {
  imageUrlFromArchive,
  imageUrlFromPath,
  imageUrlFromPathWithCacheBust,
  imageUrlFromText,
  revokeImageUrl,
} from "./viewer-image-source";
import {
  bindImagePan,
  createImagePreview,
  DEFAULT_IMAGE_ZOOM,
  markImageLoadFailure,
  setImageZoom,
  zoomImageByWheel,
} from "./viewer-image";
import { createPdfPreview, markPdfLoadFailure } from "./viewer-pdf";
import { createHtmlPreview } from "./viewer-html";
import { createAsyncUnlisten } from "./async-unlisten";
import { comparePos } from "./editor-math";
import {
  viewerSelectionFromDom,
  type ViewerSelectionWithCaret,
} from "./viewer-selection";
import { createViewerFormatButtons, syncViewerFormatButtons } from "./viewer-format-buttons";
import { ViewerAssetTracker } from "./viewer-asset-tracker";
import {
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  renderCsvTable,
} from "./viewer-csv-table";
import { ViewerChartController } from "./viewer-chart";
import { renderMarkdownDocument } from "./viewer-markdown-renderer";

await initSettings((error) => showError("設定を読み込めませんでした", error));

const isInlineViewer = new URLSearchParams(window.location.search).get("inline") === "1";
const win = isInlineViewer ? null : getCurrentWindow();
const content = document.getElementById("viewer-content")!;
const title = document.getElementById("viewer-title-text")!;
const formatButtons = document.getElementById("viewer-format")!;
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
delimiterInput.value ||= DEFAULT_CSV_DELIMITER;

let currentFormat: ViewerFormat = "csv";
let currentRows: string[][] = [];
let currentText = "";
let currentSelection: ViewerSelectionWithCaret | null = null;
let currentSourcePath: string | null = null;
let currentArchivePath: string | null = null;
let currentArchiveEntry: string | null = null;
let renderGeneration = 0;
let imageZoom = DEFAULT_IMAGE_ZOOM;
let disposeImagePan: (() => void) | null = null;
const archiveAssetTracker = new ViewerAssetTracker(revokeImageUrl);
let csvColumnWidths: number[] = [];
let fontFamily = getSetting("fontFamily");
let fontSize = getSetting("previewFontSize");
const viewerUpdateListener = createAsyncUnlisten();
let windowControls: WindowControls | null = null;

function postToParent(message: unknown) {
  window.parent.postMessage(message, window.location.origin);
}

function scrollCsvRows(rows: HTMLElement[], selection: ViewerSelection | null) {
  scrollViewerCaret(rows, selection, (_row, index) => ({ start: index, end: index + 1 }));
  scrollViewerCell(rows, selection, (row, current) => {
    const sourceLine = Number(row.dataset.sourceLine);
    const sourceText = row.dataset.sourceCsv ?? "";
    if (!Number.isFinite(sourceLine)) return null;
    const rowStart = { line: sourceLine, col: 0 };
    const rowEnd = csvSourcePositionAtOffset(sourceText, sourceLine, sourceText.length);
    if (comparePos(current.end, rowStart) < 0 || comparePos(current.end, rowEnd) > 0) return null;
    const sourceOffset = csvSourceOffsetAtPosition(sourceText, sourceLine, current.end);
    const column = csvColumnAt(sourceText, sourceOffset, row.dataset.delimiter ?? delimiterInput.value);
    return row.querySelector<HTMLElement>(`[data-source-column="${column}"]`);
  });
}

function notifyParentOfSelection() {
  if (!isInlineViewer) return;
  const selection = viewerSelectionFromDom(content);
  if (!selection) return;
  postToParent({
    type: INLINE_PREVIEW_MESSAGES.SELECTION_CHANGE_MESSAGE,
    selection,
  });
}

function startCsvColumnResize(
  event: PointerEvent,
  table: HTMLTableElement,
  columns: HTMLTableColElement[],
  columnIndex: number,
) {
  if (event.button !== 0) return;
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
  bindCsvColumnResize(event, {
    startWidth,
    startX,
    update: (width) => {
      table.style.tableLayout = "fixed";
      table.style.width = "max-content";
      if (!columns[columnIndex]) return;
      columns[columnIndex].style.width = width + "px";
      csvColumnWidths[columnIndex] = width;
    },
    setResizing: (active) => {
      document.body.classList.toggle("viewer-resizing", active);
    },
    onError: (error) => reportWindowError("CSV列幅を変更できませんでした", error),
  });
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
  disposeImagePan?.();
  disposeImagePan = null;
  try {
    viewerUpdateListener.dispose();
  } catch (error) {
    console.error("ビュー更新の購読解除に失敗しました", error);
  }
  try {
    windowControls?.dispose();
  } catch (error) {
    console.error("ウィンドウ操作の後始末に失敗しました", error);
  } finally {
    windowControls = null;
  }
  try {
    revokeArchiveAssetUrls();
  } catch (error) {
    console.error("画像URLの後始末に失敗しました", error);
  }
  try {
    chartController.clear();
  } catch (error) {
    console.error("グラフの後始末に失敗しました", error);
  }
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
  if (currentFormat === "image") {
    const image = content.querySelector<HTMLImageElement>(".viewer-image");
    if (image && event.deltaY) {
      imageZoom = zoomImageByWheel(image, imageZoom, event.deltaY);
      const source = currentArchiveEntry ?? currentSourcePath ?? "image";
      summary.textContent = `${basename(source)} ${Math.round(imageZoom * 100)}%`;
    }
    return;
  }
  if (event.deltaY) applyFontSize(clampFontSize(fontSize + (event.deltaY < 0 ? 1 : -1)));
}

function applyTheme(theme = localStorage.getItem(THEME_STORAGE_KEY)) {
  const value = normalizeTheme(theme);
  document.documentElement.dataset.theme = value;
  themeButton.textContent = value === "dark" ? "ダーク" : "ライト";
  localStorage.setItem(THEME_STORAGE_KEY, value);
  chartController.refresh();
}

function reportWindowError(title: string, error: unknown) {
  void reportWindowOperationError(showError, title, error);
}

function runViewerOperation(title: string, operation: () => void | Promise<unknown>) {
  runWindowOperation(showError, title, operation);
}

const chartController = new ViewerChartController({
  panel: chartPanel,
  title: chartTitle,
  canvas: chartCanvas,
  content,
  run: (operation) => runViewerOperation("グラフを描画できませんでした", operation),
  onClose: () => {
    if (currentFormat === "csv") {
      scrollCsvRows([...content.querySelectorAll<HTMLTableRowElement>(".viewer-grid tbody > tr")], currentSelection);
    }
  },
});

function bindViewerControls() {
  setFullscreenButton(false);
  fontButton.addEventListener("click", () => runViewerOperation("フォントを変更できませんでした", promptFont));
  fontSizeButton.addEventListener("click", () => runViewerOperation("文字サイズを変更できませんでした", promptFontSize));
  content.addEventListener("wheel", onViewerWheel, { passive: false });
  fullscreenButton.addEventListener("click", () => {
    runViewerOperation("全画面表示を変更できませんでした", () => {
      if (isInlineViewer) postToParent({ type: INLINE_PREVIEW_MESSAGES.FULLSCREEN_CHANGE_MESSAGE });
    });
  });
  const notifySelection = () => runViewerOperation(
    "プレビューの選択位置を通知できませんでした",
    notifyParentOfSelection,
  );
  document.addEventListener("selectionchange", notifySelection);
  content.addEventListener("mouseup", notifySelection);
  content.addEventListener("keyup", notifySelection);
}

function renderTable(text: string) {
  renderGeneration++;
  revokeArchiveAssetUrls();
  const rendered = renderCsvTable({
    text,
    delimiter: delimiterInput.value,
    selection: currentSelection,
    columnWidths: csvColumnWidths,
    onColumnResize: (event, table, columns, columnIndex) => runViewerOperation(
      "CSV列幅の変更を開始できませんでした",
      () => startCsvColumnResize(event, table, columns, columnIndex),
    ),
  });
  currentRows = rendered.values;
  chartController.setRows(currentRows);
  content.replaceChildren(rendered.table);
  scrollCsvRows(rendered.rows, currentSelection);

  const truncated = currentRows.length > MAX_TABLE_ROWS || rendered.maxColumns > MAX_TABLE_COLUMNS;
  summary.classList.toggle("warning", rendered.errors.length > 0);
  summary.title = rendered.errors.map((error) => error.message).join("\n");
  summary.textContent = `${currentRows.length.toLocaleString()}行 × ${rendered.maxColumns.toLocaleString()}列${
    truncated ? "（表示上限を超えた部分は省略）" : ""
  }`;
  chartController.refresh();
}

function revokeArchiveAssetUrls() {
  archiveAssetTracker.revokeAll();
}

function retainArchiveAssetUrl(url: string, generation: number): boolean {
  return archiveAssetTracker.retain(url, generation, renderGeneration);
}

function releaseArchiveAssetUrl(url: string) {
  archiveAssetTracker.release(url);
}

async function loadArchiveImages(
  article: HTMLElement,
  generation: number,
  archivePath: string | null,
  archiveEntry: string | null,
) {
  const images = [...article.querySelectorAll<HTMLImageElement>("img")];
  for (const image of images) {
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
        image.src = imageUrlFromPathWithCacheBust(resolved, generation);
        await waitForImageLayout(image);
      }
    } catch {
      if (generation !== renderGeneration) return;
      markImageLoadFailure(image);
      // 壊れた1枚で、同じ文書内の後続画像まで止めない。
    } finally {
      if (archiveUrl && (!keepArchiveUrl || generation !== renderGeneration)) {
        releaseArchiveAssetUrl(archiveUrl);
      }
    }
  }
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

interface AssetPreviewTarget {
  wrapper: HTMLElement;
  setSource: (url: string) => void;
  waitForReady?: () => Promise<void>;
  markFailure: () => void;
}

async function renderAssetPreview(
  name: string,
  mimeType: string,
  createTarget: () => AssetPreviewTarget,
  sourceText?: string,
  cacheBustFile = false,
) {
  const generation = ++renderGeneration;
  const sourcePath = currentSourcePath;
  const archivePath = currentArchivePath;
  const archiveEntry = currentArchiveEntry;
  revokeArchiveAssetUrls();
  currentRows = [];
  chartController.clear();

  const target = createTarget();
  content.replaceChildren(target.wrapper);
  summary.classList.remove("warning");
  summary.title = "";
  summary.textContent = currentFormat === "image" ? `${name} ${Math.round(imageZoom * 100)}%` : name;

  let assetUrl: string | null = null;
  let keepAssetUrl = false;
  try {
    if (sourceText !== undefined) {
      assetUrl = imageUrlFromText(sourceText, mimeType);
      if (!retainArchiveAssetUrl(assetUrl, generation)) {
        assetUrl = null;
        return;
      }
      target.setSource(assetUrl);
    } else if (archivePath && archiveEntry) {
      assetUrl = await imageUrlFromArchive(archivePath, archiveEntry, mimeType);
      if (!retainArchiveAssetUrl(assetUrl, generation)) {
        assetUrl = null;
        return;
      }
      target.setSource(assetUrl);
    } else if (sourcePath && generation === renderGeneration) {
      target.setSource(cacheBustFile
        ? imageUrlFromPathWithCacheBust(sourcePath, generation)
        : imageUrlFromPath(sourcePath));
    } else {
      target.markFailure();
      return;
    }
    await target.waitForReady?.();
    keepAssetUrl = true;
  } catch (error) {
    if (generation !== renderGeneration) return;
    target.markFailure();
    throw error;
  } finally {
    if (assetUrl && (!keepAssetUrl || generation !== renderGeneration)) {
      releaseArchiveAssetUrl(assetUrl);
    }
  }
}

async function renderImage(text: string) {
  const source = currentArchiveEntry ?? currentSourcePath ?? "image";
  const name = basename(source);
  const mimeType = imageMimeType(source);
  const editedSvg = imageExtensionOf(source) === "svg" ? text : undefined;
  return renderAssetPreview(name, mimeType, () => {
    const { wrapper, image } = createImagePreview(name);
    disposeImagePan = bindImagePan(image, content);
    return {
      wrapper,
      setSource: (url) => { image.src = url; },
      waitForReady: async () => {
        await waitForImageLayout(image);
        setImageZoom(image, imageZoom);
      },
      markFailure: () => markImageLoadFailure(image, name),
    };
  }, editedSvg, true);
}

async function renderPdf(_text: string) {
  const name = basename(currentArchiveEntry ?? currentSourcePath ?? "document.pdf");
  return renderAssetPreview(name, "application/pdf", () => {
    const { wrapper, frame } = createPdfPreview(name);
    return {
      wrapper,
      setSource: (url) => { frame.src = url; },
      markFailure: () => markPdfLoadFailure(frame, name),
    };
  });
}

function htmlBaseUrl(sourcePath: string | null): string | null {
  if (!sourcePath) return null;
  try {
    return new URL(".", imageUrlFromPath(sourcePath)).toString();
  } catch {
    return null;
  }
}

function renderHtml(text: string) {
  const generation = ++renderGeneration;
  const sourcePath = currentSourcePath;
  revokeArchiveAssetUrls();
  currentRows = [];
  chartController.clear();

  const name = basename(sourcePath ?? currentArchiveEntry ?? "document.html");
  const { wrapper } = createHtmlPreview({
    name,
    html: text,
    baseUrl: htmlBaseUrl(sourcePath),
    onContextMenu: (x, y) => {
      if (generation !== renderGeneration || !sourcePath) return;
      runViewerOperation("既定のブラウザで開けませんでした", () => showContextMenu(x, y));
    },
  });
  content.replaceChildren(wrapper);
  summary.classList.remove("warning");
  summary.title = "";
  summary.textContent = name;
}

async function renderMarkdown(text: string) {
  const generation = ++renderGeneration;
  const archivePath = currentArchivePath;
  const archiveEntry = currentArchiveEntry;
  const selection = currentSelection;
  revokeArchiveAssetUrls();
  currentRows = [];
  chartController.clear();
  const { article, highlightTargets } = renderMarkdownDocument(text, selection);
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
  pdf: renderPdf,
  html: renderHtml,
});

function renderPayload(payload: ViewerPayload) {
  if (!isViewerPayload(payload)) throw new Error("ビューのデータが不正です");
  const sourceChanged = payload.source_path !== currentSourcePath
    || payload.archive_path !== currentArchivePath
    || payload.archive_entry !== currentArchiveEntry;
  if (payload.format !== currentFormat
    || sourceChanged) {
    csvColumnWidths = [];
  }
  if (sourceChanged) imageZoom = DEFAULT_IMAGE_ZOOM;
  currentFormat = payload.format;
  currentText = payload.text;
  currentSelection = payload.selection as ViewerSelectionWithCaret | null;
  currentSourcePath = payload.source_path;
  currentArchivePath = payload.archive_path;
  currentArchiveEntry = payload.archive_entry;
  disposeImagePan?.();
  disposeImagePan = null;
  const handler = VIEWER_HANDLERS[payload.format];
  syncViewerFormatButtons(formatButtons, payload.format, currentArchiveEntry ?? currentSourcePath);
  const formatSpec = viewerFormatSpec(payload.format);
  title.textContent = formatSpec.title;
  document.title = title.textContent;
  if (!isInlineViewer) runViewerOperation("タイトルを更新できませんでした", () => win!.setTitle(title.textContent));
  delimiterControl.hidden = !formatSpec.supportsDelimiter;
  runViewerOperation("ビューを描画できませんでした", () => handler.render(payload.text));
}

function openDelimiterDialog() {
  openViewerDelimiterDialog({
    value: delimiterInput.value,
    onApply: (value) => {
      delimiterInput.value = value;
      if (isInlineViewer) {
        postToParent({
          type: INLINE_PREVIEW_MESSAGES.DELIMITER_CHANGE_MESSAGE,
          delimiter: value,
        });
      }
      runViewerOperation("ビューを再描画できませんでした", () => VIEWER_HANDLERS[currentFormat].render(currentText));
    },
  });
}

function showContextMenu(x: number, y: number) {
  contextMenu.replaceChildren();
  const formatSpec = viewerFormatSpec(currentFormat);
  if (formatSpec.supportsDelimiter) {
    contextMenu.appendChild(createViewerDelimiterMenuItem(() => {
      contextMenu.hidden = true;
      runViewerOperation("区切り文字設定を開けませんでした", openDelimiterDialog);
    }));
  }
  if (formatSpec.supportsChart) {
    contextMenu.appendChild(createViewerChartMenuItem(() => {
      contextMenu.hidden = true;
      runViewerOperation("グラフ設定を開けませんでした", () => chartController.openDialog());
    }));
  }
  if (formatSpec.supportsDefaultBrowser && currentSourcePath) {
    const path = currentSourcePath;
    contextMenu.appendChild(createViewerBrowserMenuItem(() => {
      contextMenu.hidden = true;
      runViewerOperation("既定のブラウザで開けませんでした", () => openInDefaultBrowser(path));
    }));
  }
  if (!contextMenu.childElementCount) {
    contextMenu.hidden = true;
    return;
  }
  contextMenu.hidden = false;
  contextMenu.style.left = "0";
  contextMenu.style.top = "0";
  const rect = contextMenu.getBoundingClientRect();
  contextMenu.style.left = `${Math.min(x, window.innerWidth - rect.width - 4)}px`;
  contextMenu.style.top = `${Math.min(y, window.innerHeight - rect.height - 4)}px`;
}

async function start() {
  try {
    if (isInlineViewer) document.body.classList.add("inline-viewer");
    applyTheme();
    if (!isInlineViewer) windowControls = new WindowControls(document.body, win!, title, { onError: reportWindowError });
    createViewerFormatButtons(formatButtons, (format) => {
      runViewerOperation("表示形式を変更できませんでした", () => {
        if (!isInlineViewer || !isViewerFormat(format)) return;
        postToParent({
          type: INLINE_PREVIEW_MESSAGES.FORMAT_CHANGE_MESSAGE,
          format,
        });
      });
    });
    bindViewerControls();
    applyFont(fontFamily, fontSize, false);
    themeButton.addEventListener("click", () => {
      runViewerOperation("配色を変更できませんでした", () => {
        applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
      });
    });
    delimiterInput.addEventListener("input", () => {
      if (!delimiterInput.value || !viewerFormatSpec(currentFormat).supportsDelimiter) return;
      if (isInlineViewer) {
        postToParent({
          type: INLINE_PREVIEW_MESSAGES.DELIMITER_CHANGE_MESSAGE,
          delimiter: delimiterInput.value,
        });
      }
      runViewerOperation("ビューを再描画できませんでした", () => VIEWER_HANDLERS[currentFormat].render(currentText));
    });
    document.getElementById("chart-close")!.addEventListener("click", () => {
      runViewerOperation("グラフを閉じられませんでした", () => chartController.close());
    });
    content.addEventListener("contextmenu", (event) => {
      const target = event.target as Element;
      if (viewerFormatSpec(currentFormat).supportsChart && target.closest(".viewer-grid")) {
        event.preventDefault();
        runViewerOperation("グラフメニューを表示できませんでした", () => showContextMenu(event.clientX, event.clientY));
      } else if (viewerFormatSpec(currentFormat).supportsDefaultBrowser
        && currentSourcePath && target.closest(".viewer-html-wrap")) {
        event.preventDefault();
        runViewerOperation("HTMLメニューを表示できませんでした", () => showContextMenu(event.clientX, event.clientY));
      }
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
          if (!delimiterInput.value || !viewerFormatSpec(currentFormat).supportsDelimiter) return;
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

void start().catch((error) => {
  console.error("ビューの起動処理に失敗しました", error);
});

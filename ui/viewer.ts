import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { EVENT_NAMES, openExternalUrl, openInDefaultBrowser, takeViewerPayload, type ViewerFormat, type ViewerPayload, type ViewerSelection } from "./api";
import { formatFontFamily } from "./format";
import { basename } from "./path";
import { isViewerFormat, viewerFormatSpec } from "./viewer-formats";
import { getSetting, initSettings, setSetting } from "./settings";
import { clampFontSize, promptFontFamily, promptFontSize as promptFontSizeDialog } from "./font-controls";
import {
  csvColumnAt,
  csvSourceOffsetAtPosition,
  csvSourcePositionAtOffset,
} from "./csv-viewer";
import { startCsvColumnResize as bindCsvColumnResize } from "./csv-column-resize";
import {
  isExternalMarkdownLink,
  isLocalMarkdownLinkCandidate,
  isSameDocumentMarkdownLink,
  markdownFragmentOf,
  resolveArchiveAssetEntry,
  resolveAssetPath,
} from "./viewer-assets";
import { normalizeTheme, THEME_STORAGE_KEY } from "./theme";
import { showError } from "./dialogs";
import { WindowControls } from "./window-controls";
import { reportWindowOperationError, runWindowOperation } from "./window-operation";
import { imageExtensionOf, imageMimeType } from "./image-formats";
import {
  scrollMarkdownFragment,
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
  imageUrlFromFile,
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
import { createViewerFormatButtons, syncViewerActionButtons, syncViewerFormatButtons } from "./viewer-format-buttons";
import { ViewerAssetTracker } from "./viewer-asset-tracker";
import {
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  renderCsvTable,
} from "./viewer-csv-table";
import { ViewerChartController } from "./viewer-chart";
import { renderMarkdownDocument } from "./viewer-markdown-renderer";
import { type WindowLayoutCoordinator, type WindowViewport } from "./window-layout";
import { createWindowLayoutRuntime, type WindowLayoutRuntime } from "./window-layout-runtime";

await initSettings((error) => showError("設定を読み込めませんでした", error));

const isInlineViewer = new URLSearchParams(window.location.search).get("inline") === "1";
const win = isInlineViewer ? null : getCurrentWindow();
const content = document.getElementById("viewer-content")!;
const viewerMain = content.parentElement as HTMLElement;
const title = document.getElementById("viewer-title-text")!;
const formatButtons = document.getElementById("viewer-format")!;
const actionButtons = document.getElementById("viewer-csv-actions")!;
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
let currentEffectiveExtension: string | null = null;
let currentArchivePath: string | null = null;
let currentArchiveEntry: string | null = null;
let pendingMarkdownFragment: string | null = null;
let markdownReadyForFragment = false;
let renderGeneration = 0;
let imageZoom = DEFAULT_IMAGE_ZOOM;
let disposeImagePan: (() => void) | null = null;
const archiveAssetTracker = new ViewerAssetTracker(revokeImageUrl);
let csvColumnWidths: number[] = [];
let fontFamily = getSetting("fontFamily");
let fontSize = getSetting("previewFontSize");
const viewerUpdateListener = createAsyncUnlisten();
const viewerDomListeners = new AbortController();
let windowControls: WindowControls | null = null;
let viewerLayoutCoordinator: WindowLayoutCoordinator | null = null;
let viewerLayoutRuntime: WindowLayoutRuntime | null = null;
let viewerDisposed = false;

interface ViewerRenderState {
  format: ViewerFormat;
  text: string;
  selection: ViewerSelectionWithCaret | null;
  sourcePath: string | null;
  effectiveExtension: string | null;
  archivePath: string | null;
  archiveEntry: string | null;
}

function archiveFormatExtension(extension: string | null, archiveEntry: string | null): boolean {
  return !!archiveEntry && !!extension
    && ["zip", "7z", "xlsx", "xls"].includes(extension.toLowerCase());
}

function currentViewerRenderState(): ViewerRenderState {
  return {
    format: currentFormat,
    text: currentText,
    selection: currentSelection,
    sourcePath: currentSourcePath,
    effectiveExtension: currentEffectiveExtension,
    archivePath: currentArchivePath,
    archiveEntry: currentArchiveEntry,
  };
}

function viewerRenderStateOf(payload: ViewerPayload): ViewerRenderState {
  return {
    format: payload.format,
    text: payload.text,
    selection: payload.selection as ViewerSelectionWithCaret | null,
    sourcePath: payload.source_path,
    effectiveExtension: payload.effective_extension,
    archivePath: payload.archive_path,
    archiveEntry: payload.archive_entry,
  };
}

function publishViewerRenderState(state: ViewerRenderState, nextImageZoom: number) {
  currentFormat = state.format;
  currentText = state.text;
  currentSelection = state.selection;
  currentSourcePath = state.sourcePath;
  currentEffectiveExtension = state.effectiveExtension;
  currentArchivePath = state.archivePath;
  currentArchiveEntry = state.archiveEntry;
  imageZoom = nextImageZoom;
  const classificationSource = state.effectiveExtension && !archiveFormatExtension(state.effectiveExtension, state.archiveEntry)
    ? `${state.archiveEntry ?? state.sourcePath ?? "source"}.${state.effectiveExtension}`
    : state.archiveEntry ?? state.sourcePath;
  syncViewerFormatButtons(formatButtons, state.format, classificationSource);
  syncViewerActionButtons(actionButtons, state.format);
  const formatSpec = viewerFormatSpec(state.format);
  title.textContent = formatSpec.title;
  document.title = title.textContent;
  if (!isInlineViewer) runViewerOperation("タイトルを更新できませんでした", () => win!.setTitle(title.textContent));
  delimiterControl.hidden = !formatSpec.supportsDelimiter;
  markdownReadyForFragment = state.format === "markdown" ? markdownReadyForFragment : false;
  if (state.format !== "markdown") pendingMarkdownFragment = null;
}

function beginRender(): number {
  const generation = ++renderGeneration;
  content.querySelectorAll<HTMLElement>(":scope > .viewer-pending").forEach((pending) => pending.remove());
  content.classList.add("viewer-loading");
  viewerMain.classList.add("viewer-loading");
  content.setAttribute("aria-busy", "true");
  return generation;
}

function finishRender(generation: number) {
  if (generation !== renderGeneration) return;
  content.classList.remove("viewer-loading");
  viewerMain.classList.remove("viewer-loading");
  content.removeAttribute("aria-busy");
}

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
  if (!isInlineViewer || content.classList.contains("viewer-loading")) return;
  const selection = viewerSelectionFromDom(content);
  if (!selection) return;
  postToParent({
    type: INLINE_PREVIEW_MESSAGES.SELECTION_CHANGE_MESSAGE,
    selection,
  });
}

function notifyMarkdownLink(event: MouseEvent) {
  if (currentFormat !== "markdown" || content.classList.contains("viewer-loading")) return;
  const target = event.target instanceof Element ? event.target : null;
  const link = target?.closest<HTMLAnchorElement>("a");
  const href = link?.getAttribute("href") ?? "";
  if (!href) return;
  const fragment = markdownFragmentOf(href);
  if (fragment !== null && isSameDocumentMarkdownLink(currentSourcePath, href)) {
    event.preventDefault();
    const article = content.querySelector<HTMLElement>("article");
    if (article) scrollMarkdownFragment(article, fragment);
    return;
  }
  if (!event.ctrlKey && !event.metaKey) return;
  const external = isExternalMarkdownLink(href);
  if (!isInlineViewer) {
    if (!external) return;
    event.preventDefault();
    runViewerOperation("既定のブラウザで開けませんでした", () => openExternalUrl(href));
    return;
  }
  if (currentArchivePath && !external) return;
  if (!external && !isLocalMarkdownLinkCandidate(href)) return;
  event.preventDefault();
  postToParent({
    type: INLINE_PREVIEW_MESSAGES.MARKDOWN_LINK_MESSAGE,
    href,
    newTab: true,
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
  if (viewerDisposed) return;
  viewerDisposed = true;
  renderGeneration += 1;
  disposeImagePan?.();
  disposeImagePan = null;
  content.classList.remove("viewer-loading");
  viewerMain.classList.remove("viewer-loading");
  content.removeAttribute("aria-busy");
  viewerDomListeners.abort();
  viewerLayoutRuntime?.dispose();
  viewerLayoutRuntime = null;
  viewerLayoutCoordinator = null;
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
  if (!event.ctrlKey || content.classList.contains("viewer-loading")) return;
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
  if (viewerDisposed) return;
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

function refreshViewerLayout() {
  if (currentFormat === "image") {
    const image = content.querySelector<HTMLImageElement>(".viewer-image");
    if (image) setImageZoom(image, imageZoom);
  }
  if (currentFormat === "csv") {
    scrollCsvRows([...content.querySelectorAll<HTMLTableRowElement>(".viewer-grid tbody > tr")], currentSelection);
  }
  chartController.refresh();
}

viewerLayoutRuntime = createWindowLayoutRuntime(window, {
  measure: (): WindowViewport => {
    const rect = viewerMain.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  },
  apply: () => runViewerOperation("ビューのレイアウトを更新できませんでした", refreshViewerLayout),
});
viewerLayoutCoordinator = viewerLayoutRuntime.coordinator;

const delimiterActionButton = createViewerDelimiterMenuItem(() => {
  runViewerOperation("区切り文字設定を開けませんでした", openDelimiterDialog);
});
const chartActionButton = createViewerChartMenuItem(() => {
  runViewerOperation("グラフ設定を開けませんでした", () => chartController.openDialog());
});
actionButtons.replaceChildren(delimiterActionButton, chartActionButton);

function bindViewerControls() {
  setFullscreenButton(false);
  fontButton.addEventListener("click", () => runViewerOperation("フォントを変更できませんでした", promptFont), {
    signal: viewerDomListeners.signal,
  });
  fontSizeButton.addEventListener("click", () => runViewerOperation("文字サイズを変更できませんでした", promptFontSize), {
    signal: viewerDomListeners.signal,
  });
  content.addEventListener("wheel", onViewerWheel, { passive: false, signal: viewerDomListeners.signal });
  fullscreenButton.addEventListener("click", () => {
    runViewerOperation("全画面表示を変更できませんでした", () => {
      if (isInlineViewer) postToParent({ type: INLINE_PREVIEW_MESSAGES.FULLSCREEN_CHANGE_MESSAGE });
    });
  }, { signal: viewerDomListeners.signal });
  const notifySelection = () => runViewerOperation(
    "プレビューの選択位置を通知できませんでした",
    notifyParentOfSelection,
  );
  document.addEventListener("selectionchange", notifySelection, { signal: viewerDomListeners.signal });
  content.addEventListener("mouseup", notifySelection, { signal: viewerDomListeners.signal });
  content.addEventListener("keyup", notifySelection, { signal: viewerDomListeners.signal });
  content.addEventListener("click", notifyMarkdownLink, { signal: viewerDomListeners.signal });
}

function renderTable(text: string, state: ViewerRenderState = currentViewerRenderState()): boolean {
  const generation = beginRender();
  const previousDisposeImagePan = disposeImagePan;
  const sameSource = state.sourcePath === currentSourcePath
    && state.effectiveExtension === currentEffectiveExtension
    && state.archivePath === currentArchivePath
    && state.archiveEntry === currentArchiveEntry;
  try {
    const rendered = renderCsvTable({
      text,
      delimiter: delimiterInput.value,
      selection: state.selection,
      columnWidths: state.format === currentFormat && sameSource ? csvColumnWidths : [],
      onColumnResize: (event, table, columns, columnIndex) => runViewerOperation(
        "CSV列幅の変更を開始できませんでした",
        () => startCsvColumnResize(event, table, columns, columnIndex),
      ),
    });
    currentRows = rendered.values;
    chartController.setRows(currentRows);
    content.replaceChildren(rendered.table);
    previousDisposeImagePan?.();
    disposeImagePan = null;
    revokeArchiveAssetUrls();
    scrollCsvRows(rendered.rows, state.selection);

    const truncated = currentRows.length > MAX_TABLE_ROWS || rendered.maxColumns > MAX_TABLE_COLUMNS;
    summary.classList.toggle("warning", rendered.errors.length > 0);
    summary.title = rendered.errors.map((error) => error.message).join("\n");
    summary.textContent = `${currentRows.length.toLocaleString()}行 × ${rendered.maxColumns.toLocaleString()}列${
      truncated ? "（表示上限を超えた部分は省略）" : ""
    }`;
    chartController.refresh();
    return generation === renderGeneration;
  } finally {
    finishRender(generation);
  }
}

function revokeArchiveAssetUrls() {
  archiveAssetTracker.revokeAll();
}

function retainAssetUrl(url: string, generation: number): boolean {
  return archiveAssetTracker.retain(url, generation, renderGeneration);
}

function releaseAssetUrl(url: string) {
  archiveAssetTracker.release(url);
}

async function loadArchiveImages(
  article: HTMLElement,
  generation: number,
  sourcePath: string | null,
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
        if (!retainAssetUrl(archiveUrl, generation)) {
          archiveUrl = null;
          return;
        }
        image.src = archiveUrl;
        const ready = await waitForImageLayout(image);
        if (!ready) {
          if (generation === renderGeneration) markImageLoadFailure(image);
          continue;
        }
        keepArchiveUrl = true;
        continue;
      }
      const resolved = resolveAssetPath(sourcePath, src);
      if (resolved && generation === renderGeneration) {
        image.src = imageUrlFromPathWithCacheBust(resolved, generation);
        if (!await waitForImageLayout(image)) markImageLoadFailure(image);
      }
    } catch {
      if (generation !== renderGeneration) return;
      markImageLoadFailure(image);
      // 壊れた1枚で、同じ文書内の後続画像まで止めない。
    } finally {
      if (archiveUrl && (!keepArchiveUrl || generation !== renderGeneration)) {
        releaseAssetUrl(archiveUrl);
      }
    }
  }
}

async function waitForImageLayout(image: HTMLImageElement): Promise<boolean> {
  if (!image.getAttribute("src")) return false;
  let loaded = image.complete && image.naturalWidth > 0;
  if (!image.complete) {
    loaded = await new Promise<boolean>((resolve) => {
      let timeout: number | undefined;
      const finish = (ready: boolean) => {
        window.clearTimeout(timeout);
        image.removeEventListener("load", onLoad);
        image.removeEventListener("error", onError);
        resolve(ready);
      };
      const onLoad = () => finish(true);
      const onError = () => finish(false);
      image.addEventListener("load", onLoad, { once: true });
      image.addEventListener("error", onError, { once: true });
      timeout = window.setTimeout(() => finish(false), 2000);
      if (image.complete) finish(image.naturalWidth > 0);
    });
  }
  try {
    if (image.decode) {
      await image.decode();
      loaded = true;
    }
  } catch {
    // 壊れた画像でも本文の中央スクロールは継続する。
    loaded = false;
  }
  return loaded;
}

function waitForFrameLayout(frame: HTMLIFrameElement): Promise<boolean> {
  return new Promise((resolve) => {
    let timeout: number | undefined;
    const finish = (ready: boolean) => {
      window.clearTimeout(timeout);
      frame.removeEventListener("load", onLoad);
      frame.removeEventListener("error", onError);
      resolve(ready);
    };
    const onLoad = () => finish(true);
    const onError = () => finish(false);
    frame.addEventListener("load", onLoad, { once: true });
    frame.addEventListener("error", onError, { once: true });
    timeout = window.setTimeout(() => finish(false), 2000);
  });
}

function replaceWithViewerError(wrapper: HTMLElement, label: string) {
  const message = document.createElement("p");
  message.className = "viewer-error";
  message.textContent = `${label}（読み込めません）`;
  wrapper.replaceChildren(message);
}

interface AssetPreviewTarget {
  wrapper: HTMLElement;
  setSource: (url: string) => void;
  waitForReady?: () => Promise<boolean | void>;
  markFailure: () => void;
  dispose?: () => void;
  activate?: () => void;
}

async function renderAssetPreview(
  name: string,
  mimeType: string,
  createTarget: () => AssetPreviewTarget,
  sourceText?: string,
  cacheBustFile = false,
  state: ViewerRenderState = currentViewerRenderState(),
  nextImageZoom = imageZoom,
): Promise<boolean> {
  const generation = beginRender();
  const previousDisposeImagePan = disposeImagePan;
  const sourcePath = state.sourcePath;
  const archivePath = state.archivePath;
  const archiveEntry = state.archiveEntry;
  let target: AssetPreviewTarget | null = null;
  let assetUrl: string | null = null;
  let keepAssetUrl = false;
  let committed = false;
  try {
    target = createTarget();
    target.wrapper.classList.add("viewer-pending");
    content.appendChild(target.wrapper);
    const discardTarget = () => {
      target?.dispose?.();
      target?.wrapper.remove();
    };
    const commitTarget = (activate = true) => {
      if (!target) return;
      currentRows = [];
      chartController.clear();
      target.wrapper.classList.remove("viewer-pending");
      content.replaceChildren(target.wrapper);
      previousDisposeImagePan?.();
      disposeImagePan = null;
      if (activate) target.activate?.();
      else target.dispose?.();
      archiveAssetTracker.revokeStale(generation);
      summary.classList.remove("warning");
      summary.title = "";
      summary.textContent = state.format === "image" ? `${name} ${Math.round(nextImageZoom * 100)}%` : name;
      committed = true;
    };

    if (sourceText !== undefined) {
      assetUrl = imageUrlFromText(sourceText, mimeType);
      if (!retainAssetUrl(assetUrl, generation)) {
        assetUrl = null;
        discardTarget();
        return false;
      }
      target.setSource(assetUrl);
    } else if (archivePath && archiveEntry) {
      assetUrl = await imageUrlFromArchive(archivePath, archiveEntry, mimeType);
      if (!retainAssetUrl(assetUrl, generation)) {
        assetUrl = null;
        discardTarget();
        return false;
      }
      target.setSource(assetUrl);
    } else if (sourcePath && state.effectiveExtension) {
      assetUrl = await imageUrlFromFile(sourcePath, mimeType);
      if (!retainAssetUrl(assetUrl, generation)) {
        assetUrl = null;
        discardTarget();
        return false;
      }
      target.setSource(assetUrl);
    } else if (sourcePath && generation === renderGeneration) {
      target.setSource(cacheBustFile
        ? imageUrlFromPathWithCacheBust(sourcePath, generation)
        : imageUrlFromPath(sourcePath));
    } else {
      target.markFailure();
      if (generation === renderGeneration) commitTarget(false);
      else discardTarget();
      return committed;
    }
    const ready = await target.waitForReady?.();
    if (ready === false) target.markFailure();
    if (generation !== renderGeneration) {
      discardTarget();
      return false;
    }
    commitTarget(ready !== false);
    keepAssetUrl = ready !== false;
    return committed;
  } catch (error) {
    if (generation !== renderGeneration) {
      target?.dispose?.();
      target?.wrapper.remove();
      return false;
    }
    if (!target || committed) throw error;
    target.markFailure();
    target.wrapper.classList.remove("viewer-pending");
    content.replaceChildren(target.wrapper);
    previousDisposeImagePan?.();
    disposeImagePan = null;
    currentRows = [];
    chartController.clear();
    target.dispose?.();
    archiveAssetTracker.revokeStale(generation);
    summary.classList.remove("warning");
    summary.title = "";
    summary.textContent = name;
    committed = true;
    return true;
  } finally {
    if (assetUrl && (!keepAssetUrl || generation !== renderGeneration)) {
      releaseAssetUrl(assetUrl);
    }
    finishRender(generation);
  }
}

async function renderImage(
  text: string,
  state: ViewerRenderState = currentViewerRenderState(),
  nextImageZoom = imageZoom,
): Promise<boolean> {
  const source = state.archiveEntry ?? state.sourcePath ?? "image";
  const name = basename(source);
  const classificationSource = state.effectiveExtension
    ? `${source}.${state.effectiveExtension}`
    : source;
  const mimeType = imageMimeType(classificationSource);
  const editedSvg = imageExtensionOf(classificationSource) === "svg" ? text : undefined;
  return renderAssetPreview(name, mimeType, () => {
    const { wrapper, image } = createImagePreview(name);
    const dispose = bindImagePan(image, content);
    return {
      wrapper,
      setSource: (url) => { image.src = url; },
      waitForReady: async () => {
        const ready = await waitForImageLayout(image);
        if (ready) setImageZoom(image, nextImageZoom);
        return ready;
      },
      markFailure: () => markImageLoadFailure(image, name),
      dispose,
      activate: () => { disposeImagePan = dispose; },
    };
  }, editedSvg, true, state, nextImageZoom);
}

async function renderPdf(
  _text: string,
  state: ViewerRenderState = currentViewerRenderState(),
): Promise<boolean> {
  const name = basename(state.archiveEntry ?? state.sourcePath ?? "document.pdf");
  return renderAssetPreview(name, "application/pdf", () => {
    const { wrapper, frame } = createPdfPreview(name);
    return {
      wrapper,
      setSource: (url) => { frame.src = url; },
      waitForReady: () => waitForFrameLayout(frame),
      markFailure: () => {
        markPdfLoadFailure(frame, name);
        replaceWithViewerError(wrapper, name);
      },
      dispose: () => frame.remove(),
    };
  }, undefined, false, state);
}

function htmlBaseUrl(sourcePath: string | null): string | null {
  if (!sourcePath) return null;
  try {
    return new URL(".", imageUrlFromPath(sourcePath)).toString();
  } catch {
    return null;
  }
}

async function renderHtml(
  text: string,
  state: ViewerRenderState = currentViewerRenderState(),
): Promise<boolean> {
  const generation = beginRender();
  const previousDisposeImagePan = disposeImagePan;
  try {
    const sourcePath = state.sourcePath;
    const name = basename(sourcePath ?? state.archiveEntry ?? "document.html");
    const { wrapper } = createHtmlPreview({
      name,
      html: text,
      baseUrl: htmlBaseUrl(sourcePath),
      onContextMenu: (x, y) => {
        if (generation !== renderGeneration || !sourcePath) return;
        runViewerOperation("既定のブラウザで開けませんでした", () => showContextMenu(x, y));
      },
    });
    const frame = wrapper.querySelector<HTMLIFrameElement>(".viewer-html");
    wrapper.classList.add("viewer-pending");
    content.appendChild(wrapper);
    const ready = frame ? await waitForFrameLayout(frame) : true;
    if (!ready) replaceWithViewerError(wrapper, name);
    if (generation !== renderGeneration) {
      wrapper.remove();
      return false;
    }
    wrapper.classList.remove("viewer-pending");
    content.replaceChildren(wrapper);
    previousDisposeImagePan?.();
    disposeImagePan = null;
    currentRows = [];
    chartController.clear();
    revokeArchiveAssetUrls();
    summary.classList.remove("warning");
    summary.title = "";
    summary.textContent = name;
    return true;
  } finally {
    finishRender(generation);
  }
}

async function renderMarkdown(
  text: string,
  state: ViewerRenderState = currentViewerRenderState(),
): Promise<boolean> {
  const generation = beginRender();
  const previousDisposeImagePan = disposeImagePan;
  const previousMarkdownReadyForFragment = markdownReadyForFragment;
  const previousPendingMarkdownFragment = pendingMarkdownFragment;
  let committed = false;
  try {
    const sourcePath = state.sourcePath;
    const archivePath = state.archivePath;
    const archiveEntry = state.archiveEntry;
    const selection = state.selection;
    markdownReadyForFragment = false;
    const initialFragment = pendingMarkdownFragment;
    pendingMarkdownFragment = null;
    const { article, highlightTargets } = renderMarkdownDocument(text, selection, {
      sourcePath,
      archivePath,
    });
    article.classList.add("viewer-pending");
    content.appendChild(article);
    await loadArchiveImages(article, generation, sourcePath, archivePath, archiveEntry);
    // 画像の高さが確定する前にスクロールすると、読込後のレイアウト変化で中央位置が崩れる。
    if (generation === renderGeneration) {
      article.classList.remove("viewer-pending");
      content.replaceChildren(article);
      previousDisposeImagePan?.();
      disposeImagePan = null;
      currentRows = [];
      chartController.clear();
      archiveAssetTracker.revokeStale(generation);
      summary.classList.remove("warning");
      summary.title = "";
      summary.textContent = `${text.length.toLocaleString()}文字`;
      scrollMarkdownCaret(highlightTargets, selection);
      const fragment = pendingMarkdownFragment ?? initialFragment;
      if (fragment !== null) {
        scrollMarkdownFragment(article, fragment);
        pendingMarkdownFragment = null;
      }
      markdownReadyForFragment = true;
      committed = true;
      return true;
    } else {
      article.remove();
      return false;
    }
  } finally {
    if (!committed && generation === renderGeneration) {
      markdownReadyForFragment = previousMarkdownReadyForFragment;
      pendingMarkdownFragment = previousPendingMarkdownFragment;
    }
    finishRender(generation);
  }
}

type ViewerStateRenderer = (
  text: string,
  state: ViewerRenderState,
  nextImageZoom: number,
) => boolean | Promise<boolean>;

const VIEWER_RENDERERS: Record<ViewerFormat, ViewerStateRenderer> = {
  csv: renderTable,
  markdown: renderMarkdown,
  image: renderImage,
  pdf: renderPdf,
  html: renderHtml,
};

async function renderViewerState(state: ViewerRenderState, nextImageZoom: number): Promise<boolean> {
  if (viewerDisposed) return false;
  return VIEWER_RENDERERS[state.format](state.text, state, nextImageZoom);
}

function renderCurrentViewer(): Promise<boolean> {
  if (viewerDisposed) return Promise.resolve(false);
  const state = currentViewerRenderState();
  return renderViewerState(state, imageZoom);
}

async function renderPayload(payload: ViewerPayload) {
  if (!isViewerPayload(payload)) throw new Error("ビューのデータが不正です");
  const previousState = currentViewerRenderState();
  const nextState = viewerRenderStateOf(payload);
  const sourceChanged = nextState.sourcePath !== previousState.sourcePath
    || nextState.effectiveExtension !== previousState.effectiveExtension
    || nextState.archivePath !== previousState.archivePath
    || nextState.archiveEntry !== previousState.archiveEntry;
  const formatChanged = nextState.format !== previousState.format;
  const nextImageZoom = sourceChanged ? DEFAULT_IMAGE_ZOOM : imageZoom;
  const committed = await renderViewerState(nextState, nextImageZoom);
  if (viewerDisposed || !committed) return;
  if (formatChanged || sourceChanged) csvColumnWidths = [];
  publishViewerRenderState(nextState, nextImageZoom);
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
      runViewerOperation("ビューを再描画できませんでした", renderCurrentViewer);
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
      runViewerOperation(
        "既定のブラウザで開けませんでした",
        () => openInDefaultBrowser(path, currentEffectiveExtension),
      );
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
    if (!isInlineViewer) {
      windowControls = new WindowControls(document.body, win!, title, {
        onError: reportWindowError,
        onGeometryChange: () => viewerLayoutCoordinator?.request(),
        onStateChange: (state) => {
          if (state !== "minimized") viewerLayoutCoordinator?.request();
        },
      });
    }
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
    }, { signal: viewerDomListeners.signal });
    delimiterInput.addEventListener("input", () => {
      if (!delimiterInput.value || !viewerFormatSpec(currentFormat).supportsDelimiter) return;
      if (isInlineViewer) {
        postToParent({
          type: INLINE_PREVIEW_MESSAGES.DELIMITER_CHANGE_MESSAGE,
          delimiter: delimiterInput.value,
        });
      }
      runViewerOperation("ビューを再描画できませんでした", renderCurrentViewer);
    }, { signal: viewerDomListeners.signal });
    document.getElementById("chart-close")!.addEventListener("click", () => {
      runViewerOperation("グラフを閉じられませんでした", () => chartController.close());
    }, { signal: viewerDomListeners.signal });
    content.addEventListener("contextmenu", (event) => {
      if (content.classList.contains("viewer-loading")) return;
      const target = event.target as Element;
      if (viewerFormatSpec(currentFormat).supportsChart && target.closest(".viewer-grid")) {
        event.preventDefault();
        runViewerOperation("グラフメニューを表示できませんでした", () => showContextMenu(event.clientX, event.clientY));
      } else if (viewerFormatSpec(currentFormat).supportsDefaultBrowser
        && currentSourcePath && target.closest(".viewer-html-wrap")) {
        event.preventDefault();
        runViewerOperation("HTMLメニューを表示できませんでした", () => showContextMenu(event.clientX, event.clientY));
      }
    }, { signal: viewerDomListeners.signal });
    document.addEventListener("mousedown", (event) => {
      if (!contextMenu.contains(event.target as Node)) contextMenu.hidden = true;
    }, { signal: viewerDomListeners.signal });
    if (isInlineViewer) {
      window.addEventListener("message", (event) => {
        if (event.source !== window.parent || event.origin !== window.location.origin) return;
        if (event.data?.type === INLINE_PREVIEW_MESSAGES.PAYLOAD_MESSAGE) {
          if (!isViewerPayload(event.data.payload)) return;
          runViewerOperation("ビューを更新できませんでした", () => renderPayload(event.data.payload));
          return;
        }
        if (event.data?.type === INLINE_PREVIEW_MESSAGES.MARKDOWN_FRAGMENT_MESSAGE) {
          if (typeof event.data.fragment !== "string") return;
          const fragment = event.data.fragment;
          pendingMarkdownFragment = fragment;
          if (!content.classList.contains("viewer-loading")
            && currentFormat === "markdown" && markdownReadyForFragment) {
            const article = content.querySelector<HTMLElement>("article");
            if (article) {
              scrollMarkdownFragment(article, fragment);
              pendingMarkdownFragment = null;
            }
          }
          return;
        }
        if (event.data?.type === INLINE_PREVIEW_MESSAGES.DELIMITER_MESSAGE) {
          if (typeof event.data.delimiter !== "string") return;
          delimiterInput.value = event.data.delimiter;
          if (!delimiterInput.value || !viewerFormatSpec(currentFormat).supportsDelimiter) return;
          runViewerOperation("ビューを再描画できませんでした", renderCurrentViewer);
          return;
        }
        if (event.data?.type === INLINE_PREVIEW_MESSAGES.FONT_MESSAGE) {
          if (typeof event.data.family !== "string") return;
          applyFontFamily(event.data.family, false);
          return;
        }
        if (event.data?.type === INLINE_PREVIEW_MESSAGES.FONT_SIZE_MESSAGE) {
          if (typeof event.data.size !== "number") return;
          applyFontSize(event.data.size, false);
          return;
        }
        if (event.data?.type === INLINE_PREVIEW_MESSAGES.FULLSCREEN_STATE_MESSAGE) {
          if (typeof event.data.fullscreen !== "boolean") return;
          setFullscreenButton(event.data.fullscreen);
          return;
        }
      }, { signal: viewerDomListeners.signal });
      postToParent({ type: INLINE_PREVIEW_MESSAGES.READY_MESSAGE });
    } else {
      viewerUpdateListener.set(await listen<ViewerPayload>(EVENT_NAMES.viewerUpdate, (event) => {
        runViewerOperation("ビューを更新できませんでした", () => renderPayload(event.payload));
      }));
      await renderPayload(await takeViewerPayload(win!.label));
    }
    viewerLayoutCoordinator?.refresh();
    if (!isInlineViewer) await win!.show();
    viewerLayoutCoordinator?.request();
  } catch (error) {
    disposeViewer();
    title.textContent = "表示できませんでした";
    const message = document.createElement("p");
    message.className = "viewer-error";
    message.textContent = String(error);
    content.replaceChildren(message);
    if (!isInlineViewer) {
      try {
        await win!.show();
      } catch (showError) {
        reportWindowError("ビューを表示できませんでした", showError);
      }
    }
  }
}

window.addEventListener("beforeunload", disposeViewer, { once: true, signal: viewerDomListeners.signal });
window.addEventListener("storage", (event) => {
  if (event.key === THEME_STORAGE_KEY) {
    runViewerOperation("配色を同期できませんでした", () => applyTheme(event.newValue));
  }
}, { signal: viewerDomListeners.signal });

void start().catch((error) => {
  console.error("ビューの起動処理に失敗しました", error);
});

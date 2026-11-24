import { getCurrentWindow } from "@tauri-apps/api/window";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  EVENT_NAMES,
  openExternalUrl,
  openInDefaultBrowser,
  readSqlitePreview,
  readGitHistory,
  readGitFiles,
  readGitDiff,
  readGitBranches,
  readGitWorktreeFiles,
  readGitWorktreeDiff,
  takeViewerPayload,
  readDiagramAsset,
  readArchiveAsset,
  registerHtmlPreview,
  releaseHtmlPreview,
  registerExternalHtmlPreview,
  releaseExternalHtmlPreview,
  registerPdfPreview,
  releasePdfPreview,
  type ViewerFormat,
  type ViewerPayload,
  type ViewerSelection,
} from "./api";
import { isArchiveFormat } from "./generated/Protocol";
import { formatFontFamily } from "./format";
import { basename } from "./path";
import { isViewerFormat, viewerFormatSpec } from "./viewer-formats";
import { getSetting, initSettings, isValidMarkdownLineHeight, setSetting } from "./settings";
import { clampFontSize, promptFontFamily, promptFontSize as promptFontSizeDialog } from "./font-controls";
import {
  csvColumnAt,
  csvCellBoundsForColumn,
  CSV_LINE_NUMBER_WIDTH,
  encodeCsvCell,
  fitCsvColumnWidths,
  csvSourceOffsetAtPosition,
  csvSourcePositionAtOffset,
} from "./csv-viewer";
import { startCsvColumnResize as bindCsvColumnResize } from "./csv-column-resize";
import {
  resolveArchiveAssetEntry,
  resolveAssetPath,
} from "./viewer-assets";
import { normalizeTheme, THEME_STORAGE_KEY } from "./theme";
import { showError } from "./dialogs";
import { WindowControls } from "./window-controls";
import { reportWindowOperationError, runWindowOperation } from "./window-operation";
import { imageExtensionOf, imageMimeType } from "./image-formats";
import {
  applyMarkdownHeadingUnderlinesMessage,
  applyMarkdownHeadingUnderlinesToRoot,
  handleMarkdownLinkClick,
  scrollMarkdownFragment,
  scrollMarkdownCaret,
} from "./viewer-markdown";
import { scrollViewerCaret, scrollViewerCell } from "./viewer-scroll";
import {
  createViewerBrowserMenuItem,
  createViewerNewTabMenuItem,
  createViewerChartMenuItem,
  createViewerDelimiterMenuItem,
} from "./viewer-context-menu";
import {
  DEFAULT_CSV_DELIMITER,
} from "./viewer-delimiter";
import { openViewerDelimiterDialog } from "./viewer-delimiter-dialog";
import {
  INLINE_PREVIEW_MESSAGES,
  type ExternalPreviewHeaderSourceKind,
  type PreviewStatus,
} from "./inline-preview-protocol";
import { isViewerPayload } from "./viewer-payload";
import {
  createArchiveAssetSession,
  imageUrlFromArchive,
  imageUrlFromFile,
  imageUrlFromPath,
  imageUrlFromPathWithCacheBust,
  imageUrlFromText,
  revokeImageUrl,
} from "./viewer-image-source";
import { scheduleMarkdownImageLoads } from "./viewer-markdown-images";
import { composeDiagramPreview } from "./diagram-assets";
import { createDiagramAssetReader, isDiagramSvgPath } from "./diagram-asset-reader";
import {
  bindImagePan,
  createImagePreview,
  DEFAULT_IMAGE_ZOOM,
  markImageLoadFailure,
  setImageZoom,
  zoomImageByWheel,
} from "./viewer-image";
import { createPdfPreview, markPdfLoadFailure } from "./viewer-pdf";
import { createVideoPreview } from "./viewer-video";
import { createHtmlPreview } from "./viewer-html";
import {
  bindExternalSourceNavigation,
  bindExternalPreviewPreferences,
  commitTrustedExternalHtmlPreview,
  createTrustedExternalHtmlPreview,
  externalOutputFormatOf,
  resolveExternalOutputSource,
} from "./viewer-external-output";
import { createSqlitePreviewController, type SqlitePreviewController } from "./viewer-sqlite";
import { createGitPreviewController } from "./viewer-git";
import { createAsyncUnlisten } from "./async-unlisten";
import { comparePos } from "./editor-math";
import {
  viewerSelectionFromDom,
  type ViewerSelectionWithCaret,
} from "./viewer-selection";
import { createViewerFormatButtons, syncViewerActionButtons, syncViewerFormatButtons } from "./viewer-format-buttons";
import { ViewerAssetTracker } from "./viewer-asset-tracker";
import { isFindShortcut } from "./commands";
import {
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  renderCsvTable,
} from "./viewer-csv-table";
import { ViewerChartController } from "./viewer-chart";
import { MARKDOWN_IMAGE_SOURCE_ATTRIBUTE, renderMarkdownDocument } from "./viewer-markdown-renderer";
import { type WindowLayoutCoordinator, type WindowViewport } from "./window-layout";
import { createWindowLayoutRuntime, type WindowLayoutRuntime } from "./window-layout-runtime";

await initSettings((error) => showError("設定を読み込めませんでした", error));

const isInlineViewer = new URLSearchParams(window.location.search).get("inline") === "1";
const win = isInlineViewer ? null : getCurrentWindow();
const content = document.getElementById("viewer-content")!;
const csvCellEditor = document.createElement("textarea");
csvCellEditor.id = "viewer-csv-cell-editor";
csvCellEditor.rows = 1;
csvCellEditor.wrap = "off";
csvCellEditor.hidden = true;
csvCellEditor.disabled = true;
csvCellEditor.readOnly = true;
csvCellEditor.setAttribute("aria-label", "セル編集欄");
csvCellEditor.placeholder = "セルを選択";
content.before(csvCellEditor);
const viewerMain = content.parentElement as HTMLElement;
const title = document.getElementById("viewer-title-text")!;
const formatButtons = document.getElementById("viewer-format")!;
const actionButtons = document.getElementById("viewer-csv-actions")!;
const fullscreenButton = document.getElementById("viewer-fullscreen") as HTMLButtonElement;
const previewCloseButton = document.getElementById("viewer-close") as HTMLButtonElement;
const previewRefreshButton = document.getElementById("viewer-refresh") as HTMLButtonElement;
const htmlModeButton = document.getElementById("viewer-html-mode") as HTMLButtonElement | null;
let dynamicHtml = false;

function syncHtmlModeButton() {
  if (!htmlModeButton) return;
  htmlModeButton.hidden = currentFormat !== "html" || currentExternalOutputPath !== null;
  htmlModeButton.textContent = dynamicHtml ? "静的表示に戻す" : "動的表示";
  htmlModeButton.setAttribute("aria-pressed", String(dynamicHtml));
  if (!htmlModeButton.hidden) {
    const trigger = formatButtons.querySelector(".viewer-format-trigger");
    if (trigger) trigger.textContent = `${dynamicHtml ? "html(動的)" : viewerFormatSpec("html").title} ▾`;
  }
}

htmlModeButton?.addEventListener("click", () => {
  dynamicHtml = !dynamicHtml;
  syncHtmlModeButton();
  if (isInlineViewer) postToParent({ type: INLINE_PREVIEW_MESSAGES.HTML_MODE_CHANGE_MESSAGE, dynamic: dynamicHtml });
  runViewerOperation("HTML の表示を切り替えられませんでした", renderCurrentViewer);
});
const outputFolderButton = document.getElementById("viewer-output-folder") as HTMLButtonElement;
let outputFolderAvailable = false;
const externalSavedBadge = document.getElementById("viewer-external-saved-badge")!;
const externalSaveButton = document.getElementById("viewer-external-save") as HTMLButtonElement;
let externalSourceKind: ExternalPreviewHeaderSourceKind | null = null;
let externalSaving = false;
const previewStatusBanner = document.getElementById("viewer-external-status")!;
let previewStatus: PreviewStatus | null = null;

externalSaveButton.addEventListener("click", () => {
  if (!isInlineViewer || externalSaveButton.hidden || externalSaveButton.disabled) return;
  postToParent({ type: INLINE_PREVIEW_MESSAGES.SAVE_EXTERNAL_PREVIEW_MESSAGE });
});

function syncPreviewStatus() {
  syncHtmlModeButton();
  const external = previewStatus ? previewStatus.kind !== "standard" : !!currentExternalOutputPath;
  const externalError = previewStatus?.error === true;
  const externalBusy = previewStatus?.busy === true;
  const kind = document.getElementById("viewer-preview-kind");
  if (kind) kind.textContent = external ? "外部プレビュー" : "標準プレビュー";
  externalSavedBadge.hidden = !isInlineViewer || !external || externalSourceKind !== "saved";
  externalSaveButton.hidden = !isInlineViewer || !external;
  externalSaveButton.disabled = !isInlineViewer
    || !external
    || externalSourceKind !== "temporary"
    || externalBusy
    || externalError
    || externalSaving;
  previewStatusBanner.hidden = previewStatus === null;
  previewStatusBanner.textContent = previewStatus?.message ?? "";
  previewRefreshButton.disabled = previewStatus?.busy ?? false;
  previewRefreshButton.hidden = !isInlineViewer || (!external && currentFormat !== "video" && currentFormat !== "git");
  const refreshLabel = external ? "外部プレビューを更新" : currentFormat === "git" ? "Git履歴を更新" : "動画プレビューを更新";
  previewRefreshButton.title = refreshLabel;
  previewRefreshButton.setAttribute("aria-label", refreshLabel);
  outputFolderButton.hidden = !isInlineViewer || !external;
  outputFolderButton.disabled = !outputFolderAvailable;
}
const summary = document.getElementById("viewer-summary")!;
const themeButton = document.getElementById("viewer-theme")!;
const fontButton = document.getElementById("viewer-font")!;
const fontSizeButton = document.getElementById("viewer-font-size")!;
const contextMenu = document.getElementById("viewer-context-menu")!;
const chartPanel = document.getElementById("chart-panel")!;
const chartTitle = document.getElementById("chart-title")!;
const chartCanvas = document.getElementById("chart-canvas") as HTMLCanvasElement;
let delimiter = DEFAULT_CSV_DELIMITER;

let currentFormat: ViewerFormat = "csv";
let currentRows: string[][] = [];
let currentText = "";
let currentSelection: ViewerSelectionWithCaret | null = null;
let currentSourcePath: string | null = null;
let currentEffectiveExtension: string | null = null;
let currentArchivePath: string | null = null;
let currentArchiveEntry: string | null = null;
let currentExternalOutputPath: string | null = null;
let currentExternalRenderId: string | undefined;
let externalSourceNavigationController: AbortController | null = null;
let pendingMarkdownFragment: string | null = null;
let markdownReadyForFragment = false;
let renderGeneration = 0;
let renderAbortController = new AbortController();
let imageZoom = DEFAULT_IMAGE_ZOOM;
let disposeImagePan: (() => void) | null = null;
let disposeSqlitePreview: (() => void) | null = null;
let releaseActiveExternalHtmlPreview: (() => void) | null = null;
let releaseActivePdfPreview: (() => void) | null = null;
let gitPreview: ReturnType<typeof createGitPreviewController> | null = null;
let videoPreview: ReturnType<typeof createVideoPreview> | null = null;
let previewVisible = true;
const archiveAssetTracker = new ViewerAssetTracker(revokeImageUrl);
const archiveAssetSession = createArchiveAssetSession();
let csvColumnWidths: number[] = [];
let editableCsv = false;
let csvEditToken: number | undefined;
let selectedCsvCell: HTMLTableCellElement | null = null;

function selectCsvCell(cell: HTMLTableCellElement | null) {
  selectedCsvCell?.classList.remove("viewer-csv-cell-active");
  selectedCsvCell = cell;
  cell?.classList.add("viewer-csv-cell-active");
  const value = (cell?.textContent ?? "").replace(/\r\n|\r/g, "\n");
  if (csvCellEditor.defaultValue !== value || !cell) csvCellEditor.value = value;
  csvCellEditor.defaultValue = value;
  csvCellEditor.disabled = !cell;
}
let fontFamily = getSetting("fontFamily");
let fontSize = getSetting("previewFontSize");
let markdownSoftBreaks = getSetting("markdownSoftBreaks");
let markdownLineHeight = getSetting("markdownLineHeight");
let markdownHeadingUnderlines = getSetting("markdownHeadingUnderlines");
const viewerUpdateListener = createAsyncUnlisten();
const viewerDomListeners = new AbortController();
let windowControls: WindowControls | null = null;
let viewerLayoutCoordinator: WindowLayoutCoordinator | null = null;
let viewerLayoutRuntime: WindowLayoutRuntime | null = null;
let viewerDisposed = false;

interface ViewerRenderState {
  renderId?: string;
  format: ViewerFormat;
  text: string;
  selection: ViewerSelectionWithCaret | null;
  sourcePath: string | null;
  effectiveExtension: string | null;
  archivePath: string | null;
  archiveEntry: string | null;
  externalOutputPath: string | null;
}

function archiveFormatExtension(extension: string | null, archiveEntry: string | null): boolean {
  return !!archiveEntry && isArchiveFormat(extension);
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
    externalOutputPath: currentExternalOutputPath,
    renderId: currentExternalRenderId,
  };
}

function viewerRenderStateOf(payload: ViewerPayload, renderId?: string): ViewerRenderState {
  return {
    format: payload.format,
    text: payload.text,
    selection: payload.selection as ViewerSelectionWithCaret | null,
    sourcePath: payload.source_path,
    effectiveExtension: payload.effective_extension,
    archivePath: payload.archive_path,
    archiveEntry: payload.archive_entry,
    externalOutputPath: payload.external_output_path ?? null,
    renderId,
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
  currentExternalOutputPath = state.externalOutputPath;
  currentExternalRenderId = state.renderId;
  if (!state.externalOutputPath) {
    externalSourceNavigationController?.abort();
    externalSourceNavigationController = null;
  }
  syncPreviewStatus();
  imageZoom = nextImageZoom;
  const classificationSource = state.effectiveExtension && !archiveFormatExtension(state.effectiveExtension, state.archiveEntry)
    ? `${state.archiveEntry ?? state.sourcePath ?? "source"}.${state.effectiveExtension}`
    : state.archiveEntry ?? state.sourcePath;
  syncViewerFormatButtons(formatButtons, state.format, classificationSource, state.archivePath !== null || state.archiveEntry !== null);
  syncHtmlModeButton();
  syncViewerActionButtons(actionButtons, state.format);
  csvCellEditor.hidden = state.format !== "csv" || !!state.externalOutputPath;
  if (csvCellEditor.hidden) selectCsvCell(null);
  const formatSpec = viewerFormatSpec(state.format);
  title.textContent = formatSpec.title;
  document.title = title.textContent;
  if (!isInlineViewer) runViewerOperation("タイトルを更新できませんでした", () => win!.setTitle(title.textContent));
  markdownReadyForFragment = state.format === "markdown" ? markdownReadyForFragment : false;
  if (state.format !== "markdown") pendingMarkdownFragment = null;
}

function beginRender(): number {
  renderAbortController.abort();
  renderAbortController = new AbortController();
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
    const column = csvColumnAt(sourceText, sourceOffset, row.dataset.delimiter ?? delimiter);
    return row.querySelector<HTMLElement>(`[data-source-column="${column}"]`);
  });
}

function notifyParentOfSelection(target?: EventTarget | null) {
  if (!isInlineViewer || content.classList.contains("viewer-loading")) return;
  const selection = viewerSelectionFromDom(content, target);
  if (!selection) return;
  postToParent({
    type: INLINE_PREVIEW_MESSAGES.SELECTION_CHANGE_MESSAGE,
    selection,
  });
}

function notifyMarkdownLink(event: MouseEvent) {
  if (currentFormat !== "markdown" || content.classList.contains("viewer-loading")) return;
  handleMarkdownLinkClick(event, {
    content,
    currentSourcePath,
    currentArchivePath,
    isInlineViewer,
    onOpenExternal: (href) => {
      runViewerOperation("既定のブラウザで開けませんでした", () => openExternalUrl(href));
    },
    onPostInlineLink: (href) => {
      postToParent({
        type: INLINE_PREVIEW_MESSAGES.MARKDOWN_LINK_MESSAGE,
        href,
        newTab: true,
      });
    },
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
      if (!columns[columnIndex]) return;
      columns[columnIndex].style.width = width + "px";
      csvColumnWidths[columnIndex] = width;
      table.style.minWidth = "0";
      table.style.width = CSV_LINE_NUMBER_WIDTH + csvColumnWidths.slice(0, columns.length).reduce((sum, value) => sum + value, 0) + "px";
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

function applyMarkdownLineHeight(value: number) {
  markdownLineHeight = value;
  document.documentElement.style.setProperty("--markdown-line-height", String(value));
}

function applyMarkdownHeadingUnderlines(enabled: boolean) {
  markdownHeadingUnderlines = applyMarkdownHeadingUnderlinesToRoot(document.documentElement, enabled);
}

function applyFont(family: string, size: number, persist = true) {
  applyFontFamily(family, persist);
  applyFontSize(size, persist);
}

function setFullscreenButton(fullscreen: boolean) {
  fullscreenButton.textContent = fullscreen ? "" : "⛶";
  if (fullscreen) {
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 16 16");
    icon.setAttribute("width", "16");
    icon.setAttribute("height", "16");
    icon.setAttribute("aria-hidden", "true");
    const corners = document.createElementNS(icon.namespaceURI, "path");
    corners.setAttribute("d", "M2 5h3V2m9 3h-3V2M2 11h3v3m9-3h-3v3");
    corners.setAttribute("fill", "none");
    corners.setAttribute("stroke", "currentColor");
    corners.setAttribute("stroke-width", "1.5");
    icon.append(corners);
    fullscreenButton.append(icon);
  }
  const label = fullscreen ? "元の表示に戻す" : "プレビューを全画面表示";
  fullscreenButton.title = label;
  fullscreenButton.setAttribute("aria-label", label);
  fullscreenButton.setAttribute("aria-pressed", String(fullscreen));
}

function replaceActiveScopedPreviews(
  nextExternalHtml: (() => void) | null = null,
  nextPdf: (() => void) | null = null,
) {
  const previousExternalHtml = releaseActiveExternalHtmlPreview;
  const previousPdf = releaseActivePdfPreview;
  releaseActiveExternalHtmlPreview = nextExternalHtml;
  releaseActivePdfPreview = nextPdf;
  if (previousExternalHtml && previousExternalHtml !== nextExternalHtml) previousExternalHtml();
  if (previousPdf && previousPdf !== nextPdf) previousPdf();
}

function disposeViewer() {
  gitPreview?.dispose();
  gitPreview = null;
  if (viewerDisposed) return;
  viewerDisposed = true;
  externalSourceNavigationController?.abort();
  externalSourceNavigationController = null;
  replaceActiveScopedPreviews(null, null);
  renderAbortController.abort();
  renderGeneration += 1;
  disposeImagePan?.();
  disposeImagePan = null;
  disposeSqlitePreview?.();
  disposeSqlitePreview = null;
  videoPreview?.dispose();
  videoPreview = null;
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
    archiveAssetSession.dispose();
  } catch (error) {
    console.error("アーカイブ資産の後始末に失敗しました", error);
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
const autoWidthButton = document.createElement("button");
autoWidthButton.type = "button";
autoWidthButton.dataset.viewerAction = "auto-width";
autoWidthButton.textContent = "幅を自動調整";
autoWidthButton.addEventListener("click", () => {
  runViewerOperation("CSV列幅を調整できませんでした", () => {
    const table = content.querySelector<HTMLTableElement>(".viewer-grid");
    const cells = table?.rows[0]?.cells;
    const canvas = document.createElement("canvas").getContext("2d");
    if (!table || !cells || !canvas) return;
    const style = getComputedStyle(table);
    canvas.font = style.fontSize + " " + style.fontFamily;
    const natural = Array<number>(table.querySelectorAll("col").length - 1).fill(32);
    for (const row of currentRows.slice(0, MAX_TABLE_ROWS)) {
      row.slice(0, natural.length).forEach((value, index) => {
        if (natural[index] >= 520) return;
        for (const line of value.split(/\r\n|\r|\n/)) {
          natural[index] = Math.min(520, Math.max(natural[index], Math.ceil(canvas.measureText(line).width) + 20));
        }
      });
    }
    csvColumnWidths = fitCsvColumnWidths(natural, content.clientWidth);
    return renderCurrentViewer();
  });
});
actionButtons.replaceChildren(delimiterActionButton, autoWidthButton, chartActionButton);

function bindViewerControls() {
  document.addEventListener("keydown", (event) => {
    if (isFindShortcut(event)) event.preventDefault();
  }, { capture: true, signal: viewerDomListeners.signal });
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
  previewCloseButton.addEventListener("click", () => {
    if (isInlineViewer) postToParent({
      type: INLINE_PREVIEW_MESSAGES.CLOSE_MESSAGE,
      return_focus: previewCloseButton.matches(":focus-visible"),
    });
  }, { signal: viewerDomListeners.signal });
  previewRefreshButton.addEventListener("click", () => {
    if (isInlineViewer && !previewStatus?.busy && (previewStatus || currentExternalOutputPath || currentFormat === "video" || currentFormat === "git")) {
      postToParent({ type: INLINE_PREVIEW_MESSAGES.REFRESH_MESSAGE });
    }
  }, { signal: viewerDomListeners.signal });
  outputFolderButton.addEventListener("click", () => {
    if (isInlineViewer && !outputFolderButton.hidden && !outputFolderButton.disabled) {
      postToParent({ type: INLINE_PREVIEW_MESSAGES.REVEAL_OUTPUT_MESSAGE });
    }
  }, { signal: viewerDomListeners.signal });
  const notifySelection = (event: Event) => runViewerOperation(
    "プレビューの選択位置を通知できませんでした",
    () => notifyParentOfSelection(event.target),
  );
  document.addEventListener("selectionchange", notifySelection, { signal: viewerDomListeners.signal });
  content.addEventListener("mouseup", notifySelection, { signal: viewerDomListeners.signal });
  content.addEventListener("keyup", notifySelection, { signal: viewerDomListeners.signal });
  content.addEventListener("click", notifyMarkdownLink, { signal: viewerDomListeners.signal });
  content.addEventListener("click", (event) => {
    if (currentFormat !== "csv" || !(event.target instanceof Element)
      || event.target.closest(".viewer-column-resizer")) return;
    selectCsvCell(event.target.closest<HTMLTableCellElement>(".viewer-grid [data-source-column]"));
    if (selectedCsvCell) csvCellEditor.value = csvCellEditor.defaultValue;
  }, { signal: viewerDomListeners.signal });
  csvCellEditor.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      csvCellEditor.value = csvCellEditor.defaultValue;
      csvCellEditor.setCustomValidity("");
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && editableCsv) {
      event.preventDefault();
      postToParent({ type: INLINE_PREVIEW_MESSAGES.CSV_SAVE_MESSAGE, token: csvEditToken });
      return;
    }
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    const cell = selectedCsvCell;
    const row = cell?.parentElement;
    const raw = row?.dataset.sourceCsv;
    if (!editableCsv || !cell || raw === undefined || csvCellEditor.value === csvCellEditor.defaultValue) return;
    if (!delimiter && csvCellEditor.value.includes("\n")) {
      csvCellEditor.setCustomValidity("区切り文字を指定していない場合、セルに改行を入力できません");
      csvCellEditor.reportValidity();
      return;
    }
    const { start, end } = csvCellBoundsForColumn(raw, Number(cell.dataset.sourceColumn), delimiter);
    postToParent({
      type: INLINE_PREVIEW_MESSAGES.CSV_EDIT_MESSAGE,
      token: csvEditToken, row: raw, line: Number(row?.dataset.sourceLine), start, end,
      text: encodeCsvCell(csvCellEditor.value, delimiter, raw.slice(start, end)),
    });
  }, { signal: viewerDomListeners.signal });
  csvCellEditor.addEventListener("input", () => csvCellEditor.setCustomValidity(""), { signal: viewerDomListeners.signal });
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
      delimiter,
      selection: state.selection,
      columnWidths: state.format === currentFormat && sameSource ? csvColumnWidths : [],
      onColumnResize: (event, table, columns, columnIndex) => runViewerOperation(
        "CSV列幅の変更を開始できませんでした",
        () => startCsvColumnResize(event, table, columns, columnIndex),
      ),
    });
    currentRows = rendered.values;
    chartController.setRows(currentRows);
    const line = sameSource ? selectedCsvCell?.parentElement?.dataset.sourceLine : undefined;
    const column = selectedCsvCell?.dataset.sourceColumn;
    content.replaceChildren(rendered.table);
    const selectedRow = line === undefined ? undefined : rendered.rows.find((row) => row.dataset.sourceLine === line);
    selectCsvCell(selectedRow?.cells[Number(column) + 1] ?? null);
    previousDisposeImagePan?.();
    disposeImagePan = null;
    replaceActiveScopedPreviews(null, null);
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
  await scheduleMarkdownImageLoads(images, async (image) => {
    let archiveUrl: string | null = null;
    let keepArchiveUrl = false;
    try {
      if (generation !== renderGeneration) return;
      const src = image.getAttribute(MARKDOWN_IMAGE_SOURCE_ATTRIBUTE)
        ?? image.getAttribute("src")
        ?? "";
      if ((sourcePath || archivePath && archiveEntry) && isDiagramSvgPath(src)) {
        const readImage = createDiagramAssetReader({ sourcePath: sourcePath ?? archivePath!, archivePath, archiveEntry }, { readLocal: readDiagramAsset, readArchive: readArchiveAsset });
        const bytes = await readImage(src);
        const preview = await composeDiagramPreview(new TextDecoder().decode(bytes), (relative) => readImage(relative, src));
        if (!preview) throw new Error("図の編集情報がありません");
        if (generation !== renderGeneration) return;
        archiveUrl = imageUrlFromText(preview.svg, "image/svg+xml");
        if (!retainAssetUrl(archiveUrl, generation)) { archiveUrl = null; return; }
        image.src = archiveUrl;
        if (preview.missing.length) image.title = "背景画像が見つからないか、読み込めません";
        if (!await waitForImageLayout(image)) { if (generation === renderGeneration) markImageLoadFailure(image); return; }
        keepArchiveUrl = true;
        return;
      }
      const entry = resolveArchiveAssetEntry(archiveEntry, src);
      if (archivePath && archiveEntry && entry) {
        archiveUrl = await archiveAssetSession.imageUrlFromArchive(archivePath, entry, imageMimeType(src));
        if (!retainAssetUrl(archiveUrl, generation)) {
          archiveUrl = null;
          return;
        }
        image.src = archiveUrl;
        const ready = await waitForImageLayout(image);
        if (!ready) {
          if (generation === renderGeneration) markImageLoadFailure(image);
          return;
        }
        keepArchiveUrl = true;
        return;
      }
      const resolved = resolveAssetPath(sourcePath, src);
      if (resolved && generation === renderGeneration) {
        // 通常ファイル画像はWebViewのファイルURLで読み、IPCで全バイトを複製しない。
        // 外部キャッシュはPDF/画像ビューとアーカイブ展開資産に限定する。
        image.src = imageUrlFromPathWithCacheBust(resolved, generation);
        if (!await waitForImageLayout(image) && generation === renderGeneration) {
          markImageLoadFailure(image);
        }
      } else if (src && generation === renderGeneration) {
        if (/^(?:https?:|data:|blob:)/i.test(src)) {
          // data:/http(s): など、ローカル解決の対象外だったURLは既存のMarkdown挙動を保つ。
          image.src = src;
        } else {
          markImageLoadFailure(image);
        }
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
  }, { isPriority: imageIsNearViewport });
}

function imageIsNearViewport(image: HTMLImageElement): boolean {
  const rect = image.getBoundingClientRect();
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  const margin = Math.max(viewportHeight, 800);
  return rect.top <= viewportHeight + margin && rect.bottom >= -margin;
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
  sourceText?: string | (() => Promise<string>),
  cacheBustFile = false,
  state: ViewerRenderState = currentViewerRenderState(),
  nextImageZoom = imageZoom,
  prepareLocalUrl?: (sourcePath: string, generation: number) => Promise<{ url: string; release: () => void } | null>,
): Promise<boolean> {
  const generation = beginRender();
  const previousDisposeImagePan = disposeImagePan;
  const sourcePath = state.sourcePath;
  const archivePath = state.archivePath;
  const archiveEntry = state.archiveEntry;
  let target: AssetPreviewTarget | null = null;
  let assetUrl: string | null = null;
  let keepAssetUrl = false;
  let pendingScopedRelease: (() => void) | null = null;
  let adoptedScopedRelease = false;
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
      replaceActiveScopedPreviews(null, activate ? pendingScopedRelease : null);
      if (activate && pendingScopedRelease) adoptedScopedRelease = true;
      archiveAssetTracker.revokeStale(generation);
      summary.classList.remove("warning");
      summary.title = "";
      summary.textContent = state.format === "image" ? `${name} ${Math.round(nextImageZoom * 100)}%` : name;
      committed = true;
    };

    const preparedSourceText = typeof sourceText === "function" ? await sourceText() : sourceText;
    if (preparedSourceText !== undefined) {
      assetUrl = imageUrlFromText(preparedSourceText, mimeType);
      if (!retainAssetUrl(assetUrl, generation)) {
        assetUrl = null;
        discardTarget();
        return false;
      }
      target.setSource(assetUrl);
    } else if (archivePath && archiveEntry) {
      assetUrl = state.format === "image"
        ? await archiveAssetSession.imageUrlFromArchive(archivePath, archiveEntry, mimeType)
        : await imageUrlFromArchive(archivePath, archiveEntry, mimeType);
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
      if (prepareLocalUrl) {
        const prepared = await prepareLocalUrl(sourcePath, generation);
        if (!prepared || generation !== renderGeneration) {
          prepared?.release();
          discardTarget();
          return false;
        }
        pendingScopedRelease = prepared.release;
        target.setSource(prepared.url);
      } else {
        target.setSource(cacheBustFile
          ? imageUrlFromPathWithCacheBust(sourcePath, generation)
          : imageUrlFromPath(sourcePath));
      }
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
    replaceActiveScopedPreviews(null, null);
    archiveAssetTracker.revokeStale(generation);
    summary.classList.remove("warning");
    summary.title = "";
    summary.textContent = name;
    committed = true;
    return true;
  } finally {
    if (pendingScopedRelease && (!adoptedScopedRelease || generation !== renderGeneration)) {
      pendingScopedRelease();
    }
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
  const previewSvg = editedSvg && isDiagramSvgPath(source) ? async () => {
    const readDiagramImage = createDiagramAssetReader(
      { sourcePath: state.sourcePath ?? state.archivePath ?? source, archivePath: state.archivePath, archiveEntry: state.archiveEntry },
      { readLocal: readDiagramAsset, readArchive: readArchiveAsset },
    );
    const preview = await composeDiagramPreview(editedSvg, (relative) => readDiagramImage(relative));
    return preview?.svg ?? editedSvg;
  } : editedSvg;
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
  }, previewSvg, true, state, nextImageZoom);
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
  }, undefined, false, state, imageZoom, async (sourcePath, generation) => {
    const id = window.crypto.randomUUID();
    await registerPdfPreview(id, sourcePath);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      void releasePdfPreview(id).catch((error) => console.warn("PDFプレビューを解放できませんでした", error));
    };
    if (generation !== renderGeneration) {
      release();
      return null;
    }
    return { url: `${convertFileSrc(id, "wasabi-pdf")}/document.pdf`, release };
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

async function renderHtml(
  text: string,
  state: ViewerRenderState = currentViewerRenderState(),
): Promise<boolean> {
  const generation = beginRender();
  const signal = renderAbortController.signal;
  const previousDisposeImagePan = disposeImagePan;
  try {
    const sourcePath = state.sourcePath;
    const name = basename(sourcePath ?? state.archiveEntry ?? "document.html");
    let dynamicUrl: string | undefined;
    if (dynamicHtml) {
      const id = window.crypto.randomUUID();
      await registerHtmlPreview(id, text, state.archivePath ? null : sourcePath);
      const release = () => {
        void releaseHtmlPreview(id).catch((error) => console.warn("HTML プレビューを解放できませんでした", error));
      };
      if (signal.aborted) {
        release();
        return false;
      }
      signal.addEventListener("abort", release, { once: true });
      dynamicUrl = `${convertFileSrc(id, "wasabi-html")}/__wasabipad_document__.html`;
    }
    const { wrapper } = createHtmlPreview({
      name,
      html: text,
      baseUrl: htmlBaseUrl(sourcePath),
      dynamicUrl,
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
    replaceActiveScopedPreviews(null, null);
    revokeArchiveAssetUrls();
    summary.classList.remove("warning");
    summary.title = "";
    summary.textContent = name;
    return true;
  } finally {
    finishRender(generation);
  }
}

async function renderExternalOutput(
  state: ViewerRenderState,
  requireLoadedOutput = false,
): Promise<boolean> {
  const outputPath = state.externalOutputPath;
  if (!outputPath) return false;
  const generation = beginRender();
  const renderSignal = renderAbortController.signal;
  const previousDisposeImagePan = disposeImagePan;
  let wrapper: HTMLElement | null = null;
  let dispose: (() => void) | undefined;
  let pendingExternalHtmlRelease: (() => void) | null = null;
  let adoptedExternalHtmlRelease = false;
  try {
    const format = externalOutputFormatOf(outputPath);
    if (format === "html") {
      const id = window.crypto.randomUUID();
      await registerExternalHtmlPreview(id, outputPath);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        void releaseExternalHtmlPreview(id).catch((error) =>
          console.warn("外部HTMLプレビューを解放できませんでした", error));
      };
      pendingExternalHtmlRelease = release;
      if (generation !== renderGeneration || renderSignal.aborted) {
        return false;
      }
      const preview = createTrustedExternalHtmlPreview(outputPath, id);
      wrapper = preview.wrapper;
      if (!await commitTrustedExternalHtmlPreview(
        content,
        wrapper,
        preview.frame,
        () => generation === renderGeneration,
        renderSignal,
      )) return false;
      replaceActiveScopedPreviews(release, null);
      adoptedExternalHtmlRelease = true;
      externalSourceNavigationController?.abort();
      externalSourceNavigationController = new AbortController();
      if (isInlineViewer && state.renderId) {
        bindExternalSourceNavigation(preview.frame, state.renderId,
          postToParent, externalSourceNavigationController.signal);
        bindExternalPreviewPreferences(preview.frame, state.renderId,
          postToParent, externalSourceNavigationController.signal);
      }
    } else {
      const source = resolveExternalOutputSource(outputPath);
      const preview = createImagePreview(basename(outputPath));
      wrapper = preview.wrapper;
      dispose = bindImagePan(preview.image, content);
      wrapper.classList.add("viewer-pending");
      content.appendChild(wrapper);
      preview.image.src = source.url;
      const ready = await waitForImageLayout(preview.image);
      if (!ready && requireLoadedOutput) {
        dispose?.();
        wrapper.remove();
        return false;
      }
      if (!ready) markImageLoadFailure(preview.image, basename(outputPath));
      if (generation !== renderGeneration) {
        dispose?.();
        wrapper.remove();
        return false;
      }
      wrapper.classList.remove("viewer-pending");
      content.replaceChildren(wrapper);
      replaceActiveScopedPreviews(null, null);
      disposeImagePan = dispose;
    }
    currentRows = [];
    chartController.clear();
    previousDisposeImagePan?.();
    if (format === "html") disposeImagePan = null;
    revokeArchiveAssetUrls();
    summary.classList.remove("warning");
    summary.title = "";
    summary.textContent = basename(outputPath);
    return true;
  } catch (error) {
    if (generation !== renderGeneration) {
      dispose?.();
      wrapper?.remove();
      return false;
    }
    if (requireLoadedOutput) {
      dispose?.();
      wrapper?.remove();
      return false;
    }
    if (wrapper) {
      wrapper.classList.remove("viewer-pending");
      replaceWithViewerError(wrapper, basename(outputPath));
      content.replaceChildren(wrapper);
      previousDisposeImagePan?.();
      disposeImagePan = null;
      replaceActiveScopedPreviews(null, null);
      summary.classList.add("warning");
      summary.textContent = String(error);
      return true;
    }
    throw error;
  } finally {
    if (pendingExternalHtmlRelease && !adoptedExternalHtmlRelease) {
      pendingExternalHtmlRelease();
    }
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
      breaks: markdownSoftBreaks,
    });
    if (generation !== renderGeneration) {
      article.remove();
      return false;
    }
    article.classList.remove("viewer-pending");
    content.replaceChildren(article);
    previousDisposeImagePan?.();
    disposeImagePan = null;
    currentRows = [];
    chartController.clear();
    replaceActiveScopedPreviews(null, null);
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
    void loadArchiveImages(article, generation, sourcePath, archivePath, archiveEntry)
      .catch((error) => {
        if (generation === renderGeneration) {
          console.error("Markdown画像の読み込みに失敗しました", error);
        }
      });
    return true;
  } finally {
    if (!committed && generation === renderGeneration) {
      markdownReadyForFragment = previousMarkdownReadyForFragment;
      pendingMarkdownFragment = previousPendingMarkdownFragment;
    }
    finishRender(generation);
  }
}

async function renderSqlite(
  _text: string,
  state: ViewerRenderState,
): Promise<boolean> {
  const generation = beginRender();
  disposeSqlitePreview?.();
  disposeSqlitePreview = null;
  disposeImagePan?.();
  disposeImagePan = null;
  currentRows = [];
  chartController.clear();
  replaceActiveScopedPreviews(null, null);
  revokeArchiveAssetUrls();
  let controller: SqlitePreviewController | null = null;
  try {
    if (!state.sourcePath || state.archivePath !== null || state.archiveEntry !== null) {
      replaceWithViewerError(content, "SQLiteプレビューには実ファイルのパスが必要です");
      summary.classList.add("warning");
      summary.textContent = "SQLiteを読み込めません";
      return true;
    }
    controller = createSqlitePreviewController(content, summary, state.sourcePath, {
      read: readSqlitePreview,
      getRowLimit: () => getSetting("sqlitePreviewRows"),
    });
    disposeSqlitePreview = controller.dispose;
    return await controller.load();
  } finally {
    if (generation !== renderGeneration) controller?.dispose();
    finishRender(generation);
  }
}

function renderVideo(_text: string, state: ViewerRenderState): boolean {
  const generation = beginRender();
  disposeImagePan?.();
  disposeImagePan = null;
  currentRows = [];
  chartController.clear();
  replaceActiveScopedPreviews(null, null);
  revokeArchiveAssetUrls();
  try {
    if (!state.sourcePath || state.archivePath !== null || state.archiveEntry !== null) {
      replaceWithViewerError(content, "動画プレビューには通常ファイルのパスが必要です");
      return true;
    }
    const name = basename(state.sourcePath);
    videoPreview = createVideoPreview(name, imageUrlFromPathWithCacheBust(state.sourcePath, generation));
    if (!previewVisible) videoPreview.stop();
    content.replaceChildren(videoPreview.wrapper);
    summary.classList.remove("warning");
    summary.title = "";
    summary.textContent = name;
    return true;
  } finally {
    finishRender(generation);
  }
}

async function renderGit(text: string, state: ViewerRenderState): Promise<boolean> {
  const generation = beginRender();
  gitPreview?.dispose();
  disposeImagePan?.();
  disposeImagePan = null;
  chartController.clear();
  currentRows = [];
  replaceActiveScopedPreviews(null, null);
  revokeArchiveAssetUrls();
  let controller: ReturnType<typeof createGitPreviewController> | null = null;
  try {
    if (!state.sourcePath || state.archivePath !== null || state.archiveEntry !== null) throw new Error("Git履歴には実 .git 項目が必要です");
    const input = JSON.parse(text);
    if (typeof input.token !== "string") throw new Error("Git履歴の表示データが不正です");
    controller = createGitPreviewController(content, summary, state.sourcePath, {
      history: readGitHistory, files: readGitFiles, diff: readGitDiff,
      branches: readGitBranches, worktreeFiles: readGitWorktreeFiles, worktreeDiff: readGitWorktreeDiff,
      getRatio: () => getSetting("gitPreviewRatio"),
      saveRatio: ratio => setSetting("gitPreviewRatio", ratio),
    });
    gitPreview = controller;
    summary.classList.remove("warning");
    summary.textContent = "Git履歴";
    return await controller.load();
  } catch (error) {
    if (generation === renderGeneration) replaceWithViewerError(content, String(error));
    return generation === renderGeneration;
  } finally {
    if (generation !== renderGeneration) controller?.dispose();
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
  sqlite: renderSqlite,
  video: renderVideo,
  git: renderGit,
};

async function renderViewerState(
  state: ViewerRenderState,
  nextImageZoom: number,
  requireLoadedOutput = false,
): Promise<boolean> {
  if (viewerDisposed) return false;
  videoPreview?.dispose();
  videoPreview = null;
  if (state.externalOutputPath) return renderExternalOutput(state, requireLoadedOutput);
  return VIEWER_RENDERERS[state.format](state.text, state, nextImageZoom);
}

function renderCurrentViewer(): Promise<boolean> {
  if (viewerDisposed) return Promise.resolve(false);
  const state = currentViewerRenderState();
  return renderViewerState(state, imageZoom);
}

async function renderPayload(payload: ViewerPayload, requireLoadedOutput = false, renderId?: string, inlineHtmlMode?: boolean): Promise<boolean> {
  if (!isViewerPayload(payload)) throw new Error("ビューのデータが不正です");
  const previousState = currentViewerRenderState();
  const nextState = viewerRenderStateOf(payload, renderId);
  const sourceChanged = nextState.sourcePath !== previousState.sourcePath
    || nextState.effectiveExtension !== previousState.effectiveExtension
    || nextState.archivePath !== previousState.archivePath
    || nextState.archiveEntry !== previousState.archiveEntry
    || nextState.externalOutputPath !== previousState.externalOutputPath;
  const formatChanged = nextState.format !== previousState.format;
  if (inlineHtmlMode !== undefined) dynamicHtml = inlineHtmlMode;
  else if (sourceChanged) dynamicHtml = false;
  if (nextState.format !== "git") { gitPreview?.dispose(); gitPreview = null; }
  const nextImageZoom = sourceChanged ? DEFAULT_IMAGE_ZOOM : imageZoom;
  if (sourceChanged) archiveAssetSession.clearCachedAssets();
  if (nextState.format !== "sqlite") {
    disposeSqlitePreview?.();
    disposeSqlitePreview = null;
  }
  const committed = await renderViewerState(nextState, nextImageZoom, requireLoadedOutput);
  if (viewerDisposed || !committed) return false;
  if (formatChanged || sourceChanged) csvColumnWidths = [];
  publishViewerRenderState(nextState, nextImageZoom);
  return true;
}

function openDelimiterDialog() {
  openViewerDelimiterDialog({
    value: delimiter,
    onApply: (value) => {
      applyDelimiter(value);
    },
  });
}

function applyDelimiter(value: string) {
  if (value === delimiter) return;
  selectCsvCell(null);
  csvColumnWidths = [];
  delimiter = value;
  if (isInlineViewer) {
    postToParent({
      type: INLINE_PREVIEW_MESSAGES.DELIMITER_CHANGE_MESSAGE,
      delimiter: value,
    });
  }
  runViewerOperation("ビューを再描画できませんでした", renderCurrentViewer);
}

function showContextMenu(x: number, y: number, gitFile?: HTMLButtonElement) {
  contextMenu.replaceChildren();
  if (gitFile && currentFormat === "git" && currentSourcePath && !gitFile.closest("[inert]")) {
    const { file, commit } = gitFile.dataset;
    const path = currentSourcePath;
    const token = JSON.parse(currentText).token;
    contextMenu.append(createViewerNewTabMenuItem(() => {
      contextMenu.hidden = true;
      if (gitFile.isConnected && !gitFile.closest("[inert]")) postToParent({ type: INLINE_PREVIEW_MESSAGES.GIT_OPEN_FILE_MESSAGE, token, path, commit, file });
    }));
  }
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
  if (formatSpec.supportsDefaultBrowser && currentSourcePath && !currentExternalOutputPath) {
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
    const notifyFormatChange = (format: ViewerFormat) => {
      runViewerOperation("表示形式を変更できませんでした", () => {
        if (!isInlineViewer || !isViewerFormat(format)) return;
        postToParent({
          type: INLINE_PREVIEW_MESSAGES.FORMAT_CHANGE_MESSAGE,
          format,
        });
      });
    };
    createViewerFormatButtons(formatButtons, notifyFormatChange, viewerDomListeners.signal);
    bindViewerControls();
    applyFont(fontFamily, fontSize, false);
    applyMarkdownLineHeight(markdownLineHeight);
    applyMarkdownHeadingUnderlines(markdownHeadingUnderlines);
    themeButton.addEventListener("click", () => {
      runViewerOperation("配色を変更できませんでした", () => {
        applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
      });
    }, { signal: viewerDomListeners.signal });
    document.getElementById("chart-close")!.addEventListener("click", () => {
      runViewerOperation("グラフを閉じられませんでした", () => chartController.close());
    }, { signal: viewerDomListeners.signal });
    content.addEventListener("contextmenu", (event) => {
      if (content.classList.contains("viewer-loading")) return;
      const target = event.target as Element;
      const gitFile = target.closest<HTMLButtonElement>("button[data-file][data-commit]");
      if (currentFormat === "git" && gitFile) {
        event.preventDefault();
        showContextMenu(event.clientX, event.clientY, gitFile);
      } else if (viewerFormatSpec(currentFormat).supportsChart && target.closest(".viewer-grid")) {
        event.preventDefault();
        runViewerOperation("グラフメニューを表示できませんでした", () => showContextMenu(event.clientX, event.clientY));
      } else if (viewerFormatSpec(currentFormat).supportsDefaultBrowser
        && currentSourcePath && !currentExternalOutputPath && target.closest(".viewer-html-wrap")) {
        event.preventDefault();
        runViewerOperation("HTMLメニューを表示できませんでした", () => showContextMenu(event.clientX, event.clientY));
      }
    }, { signal: viewerDomListeners.signal });
    document.addEventListener("mousedown", (event) => {
      if (!contextMenu.contains(event.target as Node)) contextMenu.hidden = true;
    }, { signal: viewerDomListeners.signal });
    // PDF/画像の資産取得を待つ間も、空のビューア（読込み中…）を先に表示する。
    if (!isInlineViewer) await win!.show();
    if (isInlineViewer) {
      window.addEventListener("message", (event) => {
        if (event.source !== window.parent || event.origin !== window.location.origin) return;
        if (event.data?.type === INLINE_PREVIEW_MESSAGES.OUTPUT_FOLDER_STATE_MESSAGE) {
          if (typeof event.data.available !== "boolean") return;
          outputFolderAvailable = event.data.available;
          syncPreviewStatus();
          return;
        }
        if (event.data?.type === INLINE_PREVIEW_MESSAGES.EXTERNAL_SAVE_STATE_MESSAGE) {
          const sourceKind = event.data.sourceKind;
          if ((sourceKind !== null && sourceKind !== "temporary" && sourceKind !== "saved" && sourceKind !== "sibling")
            || typeof event.data.saving !== "boolean") return;
          externalSourceKind = sourceKind;
          externalSaving = event.data.saving;
          syncPreviewStatus();
          return;
        }
        if (event.data?.type === INLINE_PREVIEW_MESSAGES.PREVIEW_STATUS_MESSAGE) {
          const status = event.data.status;
          if (status !== null && (typeof status?.message !== "string" || typeof status?.busy !== "boolean"
            || (status.kind !== undefined && status.kind !== "standard" && status.kind !== "external")
            || (status.error !== undefined && typeof status.error !== "boolean"))) return;
          previewStatus = status;
          syncPreviewStatus();
          return;
        }
        if (event.data?.type === INLINE_PREVIEW_MESSAGES.VISIBILITY_MESSAGE) {
          if (typeof event.data.visible !== "boolean" || typeof event.data.reset !== "boolean") return;
          previewVisible = event.data.visible;
          gitPreview?.setVisible(previewVisible);
          if (!previewVisible) videoPreview?.stop(event.data.reset);
          return;
        }
        if (event.data?.type === INLINE_PREVIEW_MESSAGES.REFRESH_MESSAGE) {
          if (currentFormat === "git") runViewerOperation("Git履歴を更新できませんでした", () => gitPreview?.refresh());
          return;
        }
        if (event.data?.type === INLINE_PREVIEW_MESSAGES.PAYLOAD_MESSAGE) {
          if (!isViewerPayload(event.data.payload)) return;
          csvEditToken = typeof event.data.csv_edit_token === "number" ? event.data.csv_edit_token : undefined;
          const renderId = event.data.render_id;
          if (typeof renderId === "string") {
            runViewerOperation("ビューを更新できませんでした", async () => {
              try {
                const rendered = await renderPayload(event.data.payload, true, renderId, event.data.dynamic_html === true);
                postToParent({
                  type: rendered
                    ? INLINE_PREVIEW_MESSAGES.DISPLAY_COMMITTED_MESSAGE
                    : INLINE_PREVIEW_MESSAGES.DISPLAY_FAILED_MESSAGE,
                  render_id: renderId,
                });
              } catch (error) {
                postToParent({
                  type: INLINE_PREVIEW_MESSAGES.DISPLAY_FAILED_MESSAGE,
                  render_id: renderId,
                });
                throw error;
              }
            });
            return;
          }
          runViewerOperation("ビューを更新できませんでした", () =>
            renderPayload(event.data.payload, false, undefined, event.data.dynamic_html === true));
          return;
        }
        if (event.data?.type === INLINE_PREVIEW_MESSAGES.CLEAR_MESSAGE) {
          if (typeof event.data.render_id !== "string") return;
          const generation = beginRender();
          externalSourceNavigationController?.abort();
          externalSourceNavigationController = null;
          replaceActiveScopedPreviews(null, null);
          revokeArchiveAssetUrls();
          archiveAssetSession.clearCachedAssets();
          gitPreview?.dispose();
          gitPreview = null;
          disposeSqlitePreview?.();
          disposeSqlitePreview = null;
          videoPreview?.dispose();
          videoPreview = null;
          disposeImagePan?.();
          disposeImagePan = null;
          chartController.clear();
          currentRows = [];
          selectCsvCell(null);
          csvCellEditor.hidden = true;
          csvCellEditor.readOnly = true;
          csvEditToken = undefined;
          editableCsv = false;
          content.replaceChildren();
          previewRefreshButton.hidden = true;
          externalSourceKind = null;
          externalSaving = false;
          externalSavedBadge.hidden = true;
          externalSaveButton.hidden = true;
          externalSaveButton.disabled = true;
          summary.classList.remove("warning");
          summary.textContent = "";
          finishRender(generation);
          postToParent({
            type: INLINE_PREVIEW_MESSAGES.CLEARED_MESSAGE,
            render_id: event.data.render_id,
          });
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
        if (event.data?.type === INLINE_PREVIEW_MESSAGES.MARKDOWN_SOFT_BREAKS_MESSAGE) {
          if (typeof event.data.enabled !== "boolean") return;
          if (markdownSoftBreaks === event.data.enabled) return;
          markdownSoftBreaks = event.data.enabled;
          if (currentFormat === "markdown") {
            runViewerOperation("ビューを更新できませんでした", renderCurrentViewer);
          }
          return;
        }
        if (event.data?.type === INLINE_PREVIEW_MESSAGES.MARKDOWN_LINE_HEIGHT_MESSAGE) {
          const lineHeight = event.data.lineHeight;
          if (!isValidMarkdownLineHeight(lineHeight)) return;
          if (markdownLineHeight === lineHeight) return;
          applyMarkdownLineHeight(lineHeight);
          return;
        }
        if (event.data?.type === INLINE_PREVIEW_MESSAGES.MARKDOWN_HEADING_UNDERLINES_MESSAGE) {
          markdownHeadingUnderlines = applyMarkdownHeadingUnderlinesMessage(
            document.documentElement,
            markdownHeadingUnderlines,
            event.data,
          );
          return;
        }
        if (event.data?.type === INLINE_PREVIEW_MESSAGES.DELIMITER_MESSAGE) {
          if (typeof event.data.delimiter !== "string" || delimiter === event.data.delimiter) return;
          selectCsvCell(null);
          csvColumnWidths = [];
          delimiter = event.data.delimiter;
          if (!viewerFormatSpec(currentFormat).supportsDelimiter) return;
          runViewerOperation("ビューを再描画できませんでした", renderCurrentViewer);
          return;
        }
        if (event.data?.type === INLINE_PREVIEW_MESSAGES.OPEN_DELIMITER_MESSAGE) {
          if (currentFormat === "csv") openDelimiterDialog();
          return;
        }
        if (event.data?.type === INLINE_PREVIEW_MESSAGES.CSV_EDIT_STATE_MESSAGE) {
          editableCsv = event.data.editable === true;
          csvCellEditor.readOnly = !editableCsv;
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
        if (event.data?.type === INLINE_PREVIEW_MESSAGES.FOCUS_CLOSE_MESSAGE) {
          previewCloseButton.focus();
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

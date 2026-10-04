// アプリの組み立て場所。ここでは部品の生成と配線だけを行い、
// 文書の状態は DocumentController、画面の状態は各部品が持つ。
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { desktopDir, join as joinPath, tempDir } from "@tauri-apps/api/path";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { writeText as writeClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import * as api from "./api";
import type { GitPreviewTarget } from "./viewer-git";
import { applyDocumentLoadProgress } from "./document-load-progress";
import type { EditorPorts } from "./editor";
import { EditingSurfaceHost } from "./editing-surface-host";
import type { InlinePreviewPorts } from "./inline-preview";
import { WorkspaceHost } from "./workspace-host";
import type { StatusBarPorts } from "./statusbar";
import { WindowChrome } from "./window-chrome";
import { canPollExternalDocument, ExternalWatch } from "./external-watch";
import { confirmExternalMerge, isExternalMergeRetryError } from "./external-merge";
import {
  FolderActions,
  openInOtherApp,
  revealInExplorer,
  type FolderActionsServices,
} from "./folder-actions";
import {
  DocumentController,
  SAVE_EXTENSIONS,
  type DocumentControllerServices,
} from "./document-controller";
import { showError } from "./dialogs";
import { confirmMessage, confirmSaveDiscard, promptFields, showLog } from "./prompt";
import { promptSaveFormat, saveFormatFields, saveFormatFromValues } from "./save-format";
import { isPasswordCancelled, withArchivePassword } from "./archive-password";
import { archiveRelOf } from "./archive-path";
import { joinWindowsRoot } from "./path";
import { createCommandRegistry, globalCommandForEvent, runFindForTarget } from "./commands";
import { TabManager } from "./tabs";
import {
  getSetting,
  clampSidebarWidth,
  flushSettings,
  initSettings,
  loadSearchOptions,
  resetUserSettings,
  saveSearchOptions,
  setSetting,
} from "./settings";
import { normalizeTheme, THEME_STORAGE_KEY } from "./theme";
import {
  createSettingsOpener,
  openSettingsModal,
  returnToSettings,
  type SettingsModalState,
  type SettingsPanelPorts,
} from "./settings-panel";
import { searchResultGoto } from "./search-results";
import { runAsyncBoundary, reportUnhandledRejection } from "./async-boundary";
import { openPath as openPathInTabs } from "./path-opener";
import { promptRegisteredCommand, saveRegisteredCommand } from "./registered-command-menu";
import type { CommandValueKind, RegisteredCommand } from "./registered-commands";
import { promptExternalPreviewAdapter } from "./external-preview-adapter-dialog";
import {
  externalPreviewAdapterForPath,
  parseExternalPreviewArguments,
  previewSelectionForAdapter,
  type ExternalPreviewAdapter,
} from "./external-preview-adapter-model";
import { promptAndSaveRegisteredString } from "./registered-string-dialog";
import { openSearchSettings as openSearchSettingsDialog } from "./search-settings-dialog";
import {
  isAssetViewerFormat,
  resolveSqlitePreviewAction,
  sourcePathForViewer,
  viewerFormatForAutomaticPreview,
  viewerFormatForPreviewToggle,
  type SqlitePreviewFallback,
} from "./viewer-formats";
import { classificationPathOf, documentPathOf, isFolderDraftInfo, type DocumentSession } from "./session";
import {
  effectivePreviewFormat,
  isCurrentPreviewDocument,
  isPreviewFullscreen,
  isPreviewShown,
  isPreviewOpenButtonShown,
  isPreviewSplitterShown,
  PREVIEW_MIN_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MIN_WIDTH,
  PANE_SPLITTER_WIDTH,
  resolvePaneVisibility,
  shouldResendPreviewOnRestore,
  shouldKeepPreviewFullscreen,
  type PreviewDocument,
  type PreviewPlacement,
  resolvePreviewPlacement,
  previewSplitSize,
} from "./preview-layout";
import { bindPreviewResize } from "./preview-resize";
import {
  PREVIEW_TOGGLE_DEFAULT_WIDTH,
  isPreviewTogglePeekPoint,
  paneToggleView,
  previewToggleLeft,
  sidebarToggleLeft,
} from "./pane-toggle";
import { reportErrorSafely } from "./report-error";
import { processExternalWindowRequests } from "./external-window-request";
import { canCloseWindow } from "./close-request";
import { createAsyncUnlisten } from "./async-unlisten";
import { markdownLinkActionOf } from "./markdown-link-navigation";
import { type WindowViewport } from "./window-layout";
import { createWindowLayoutRuntime, type WindowLayoutRuntime } from "./window-layout-runtime";
import { createExternalPreviewOutputLifecycle, createPreviewReplacementLifecycle } from "./preview-replacement";

const win = getCurrentWindow();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const externalPreviewLogButton = $("external-preview-log");
let externalPreviewLastLog: string | null = null;

function setExternalPreviewLog(log: string | null) {
  externalPreviewLastLog = log;
  externalPreviewLogButton.hidden = log === null;
}

externalPreviewLogButton.addEventListener("click", () => {
  if (externalPreviewLastLog !== null) {
    void showLog("外部プレビュー実行ログ", externalPreviewLastLog);
  }
});

window.addEventListener("error", () => runBackground("画面を再表示できませんでした", () => win.show()), { once: true });
window.addEventListener("unhandledrejection", (event) => {
  reportUnhandledRejection(event, (error) => reportBackgroundError("予期しない非同期エラーが発生しました", error));
});

// 以降のモジュール初期化は設定値を同期的に読むため、ここで一度だけ待つ
await initSettings((error) => reportBackgroundError("設定を読み込めませんでした", error));
try {
  await api.externalPreviewCleanupStale(getSetting("externalPreviewTemporaryDirectories"));
} catch (error) {
  console.warn("外部プレビューの古い一時生成物を削除できませんでした", error);
}
let windowRequest: api.WindowRequest;
try {
  windowRequest = await api.initialWindowRequest();
} catch (error) {
  await reportBackgroundError("起動引数を取得できませんでした", error);
  windowRequest = { secondary: false, path: null, goto: null, selectedRelPath: null, viewState: null };
}
const secondaryInstance = windowRequest.secondary;

const editorHost = $("editorhost");
const mainEl = $("main");
const sidebarEl = $("sidebar");
const splitter = $("splitter");
const previewSplitter = $("preview-splitter");
const previewEl = $("preview");
const previewToggle = $<HTMLButtonElement>("preview-toggle");
const previewOpenButtons = Array.from(mainEl.querySelectorAll<HTMLButtonElement>("[data-preview-placement]"));
const loading = $("loading");
const loadingMessage = $("loading-message");
document.documentElement.style.setProperty("--sidebar-default-width", `${SIDEBAR_DEFAULT_WIDTH}px`);
document.documentElement.style.setProperty("--sidebar-min-width", `${SIDEBAR_MIN_WIDTH}px`);
document.documentElement.style.setProperty("--pane-splitter-width", `${PANE_SPLITTER_WIDTH}px`);
mainEl.style.setProperty("--preview-min-width", `${PREVIEW_MIN_WIDTH}px`);
mainEl.style.setProperty("--preview-toggle-width", `${PREVIEW_TOGGLE_DEFAULT_WIDTH}px`);

let sidebarAvailable = false;
let sidebarCollapsed = false;
let previewAvailable = false;
let previewCollapsed = false;
let previewFullscreen = false;
let previewFullscreenTabId: string | null = null;
let previewPlacement = resolvePreviewPlacement(getSetting("previewOpenPlacement"), getSetting("previewLastPlacement"));
let previewRightRatio = getSetting("previewRightRatio");
let previewVerticalRatio = getSetting("previewVerticalRatio");
let currentLine = 1;
let tabs: TabManager;
let sidebar: WorkspaceHost["sidebar"];
let addressbar: WorkspaceHost["addressbar"];
let favbar: WorkspaceHost["favbar"];
let fileStatusbar: WorkspaceHost["fileStatusbar"];
let editingStatusbar: EditingSurfaceHost["statusbar"];
let inlinePreview: EditingSurfaceHost["preview"];
let editor: EditingSurfaceHost["editor"];
let settingsPorts: SettingsPanelPorts;
let restoringEditorFont = true;
let previewingEditorFont = false;
let imageCleanupTimer: number | undefined;
let externalRequestChain = Promise.resolve();
const workspaceSearchListener = createAsyncUnlisten();
const documentLoadListener = createAsyncUnlisten();
const externalWindowListener = createAsyncUnlisten();
const dragDropListener = createAsyncUnlisten();
let layoutRuntime: WindowLayoutRuntime | null = null;

function setLoading(active: boolean, message = "読み込み中…") {
  if (active && (previewDocument?.format === "video" || previewDocument?.format === "git")) inlinePreview.setVisibility(false, true);
  loading.hidden = !active;
  loadingMessage.textContent = message;
  editorHost.setAttribute("aria-busy", String(active));
}

function scheduleImageCleanup() {
  window.clearTimeout(imageCleanupTimer);
  const path = doc.current.savePath;
  if (!path) return;
  const archiveRelPath = archiveRelOf(doc.current.selectedRelPath);
  imageCleanupTimer = window.setTimeout(() => {
    imageCleanupTimer = undefined;
    if (doc.current.savePath !== path) return;
    void withArchivePassword(archiveRelPath, () => api.cleanupUnusedImages(path))
      .catch((error) => reportBackgroundError("不要な画像を削除できませんでした", error));
  }, 400);
}

async function reportBackgroundError(title: string, error: unknown) {
  await reportErrorSafely(showError, title, error);
}

function runBackground(
  title: string,
  operation: () => void | Promise<unknown>,
  onError: (error: unknown) => void | Promise<void> = (error) => reportBackgroundError(title, error),
) {
  runAsyncBoundary(() => Promise.resolve().then(operation), onError);
}

async function launchNewWindow(request: Partial<api.WindowRequest> = {}): Promise<boolean> {
  try {
    await api.launchNewInstance({
      secondary: true,
      path: null,
      goto: null,
      selectedRelPath: null,
      viewState: null,
      ...request,
    });
    return true;
  } catch (error) {
    await reportBackgroundError("新規ウィンドウを開けませんでした", error);
    return false;
  }
}

function drainExternalWindowRequests() {
  externalRequestChain = externalRequestChain.then(async () => {
    const requests = await api.takePendingWindowRequests();
    await processExternalWindowRequests(requests, {
      open: (path, goto) => tabs.open(path, goto),
      show: () => win.show(),
      focus: () => win.setFocus(),
      onError: (error) => reportBackgroundError("外部からファイルを開けませんでした", error),
    });
  }).catch((error) => reportBackgroundError("外部からの起動要求を処理できませんでした", error));
}

function setSidebar(on: boolean, label = "") {
  sidebarAvailable = on;
  updateSidebarVisibility();
  editingStatusbar.setMode(label);
}

function measuredMainWidth(): number {
  const width = mainEl.getBoundingClientRect().width;
  return Number.isFinite(width) && width > 0 ? width : 0;
}

function setSidebarWidth(width: unknown) {
  sidebarEl.style.width = `${clampSidebarWidth(width)}px`;
}

function readSidebarWidth(): number {
  const width = Number.parseFloat(sidebarEl.style.width);
  return Number.isFinite(width) ? clampSidebarWidth(width) : clampSidebarWidth(getSetting("sidebarWidth"));
}

function paneVisibilityAt(mainWidth: number) {
  const sidebarWidth = Number.parseFloat(sidebarEl.style.width)
    || Math.max(SIDEBAR_MIN_WIDTH, sidebarEl.getBoundingClientRect().width || SIDEBAR_DEFAULT_WIDTH);
  const mainHeight = mainEl.getBoundingClientRect().height;
  const initial = resolvePaneVisibility({
    mainWidth, mainHeight, previewPlacement, sidebarAvailable, sidebarCollapsed, sidebarWidth,
    previewAvailable, previewCollapsed, fullscreen: previewFullscreen,
  });
  const splitWidth = mainWidth - (initial.sidebarShown ? sidebarWidth + PANE_SPLITTER_WIDTH : 0);
  return resolvePaneVisibility({
    mainWidth,
    mainHeight,
    previewPlacement,
    sidebarAvailable,
    sidebarCollapsed,
    sidebarWidth,
    previewAvailable,
    previewCollapsed,
    previewWidth: previewSplitSize(splitWidth, previewRightRatio, "right"),
    fullscreen: previewFullscreen,
  });
}

function applyPaneVisibility(mainWidth: number) {
  if (!Number.isFinite(mainWidth) || mainWidth <= 0) {
    layoutRuntime?.coordinator.request();
    return;
  }
  const layout = paneVisibilityAt(mainWidth);
  const sidebarShown = layout.sidebarShown;
  sidebarEl.hidden = !sidebarShown;
  splitter.hidden = !sidebarShown;
  const sidebarToggle = $<HTMLButtonElement>("sidebar-toggle");
  const sidebarView = paneToggleView("sidebar", sidebarShown);
  sidebarToggle.hidden = !sidebarAvailable;
  sidebarToggle.textContent = sidebarView.icon;
  sidebarToggle.title = sidebarView.title;
  sidebarToggle.setAttribute("aria-label", sidebarView.title);
  sidebarToggle.style.left = `${sidebarToggleLeft(
    sidebarShown,
    sidebarEl.getBoundingClientRect().width,
    sidebarToggle.offsetWidth || PREVIEW_TOGGLE_DEFAULT_WIDTH,
  )}px`;

  const previewState = {
    available: previewAvailable,
    collapsed: !layout.previewShown,
    fullscreen: layout.fullscreen,
  };
  const previewShown = isPreviewShown(previewState);
  const fullscreen = isPreviewFullscreen(previewState);
  const returnFocusToCloseButton = previewShown && previewOpenButtons.some((button) => button.matches(":focus-visible"));
  previewEl.hidden = !previewShown;
  inlinePreview.setVisibility(previewShown, previewCollapsed);
  previewSplitter.hidden = !isPreviewSplitterShown(previewState);
  mainEl.classList.toggle("preview-fullscreen", fullscreen);
  mainEl.classList.toggle("preview-vertical", previewShown && !fullscreen && previewPlacement !== "right");
  mainEl.dataset.previewPlacement = previewPlacement;
  mainEl.style.setProperty("--visible-sidebar-width", `${sidebarShown ? readSidebarWidth() : 0}px`);
  mainEl.style.setProperty("--visible-sidebar-splitter", `${sidebarShown ? PANE_SPLITTER_WIDTH : 0}px`);
  const splitWidth = mainWidth - (sidebarShown ? readSidebarWidth() + PANE_SPLITTER_WIDTH : 0);
  const splitHeight = mainEl.getBoundingClientRect().height;
  previewEl.style.width = previewPlacement === "right"
    ? `${previewSplitSize(splitWidth, previewRightRatio, "right")}px` : "auto";
  previewEl.style.height = previewPlacement === "right" ? "auto"
    : `${previewSplitSize(splitHeight, previewVerticalRatio, previewPlacement)}px`;
  mainEl.style.setProperty("--preview-height", previewEl.style.height);
  previewSplitter.setAttribute("aria-orientation", previewPlacement === "right" ? "vertical" : "horizontal");
  previewSplitter.setAttribute("aria-label", previewPlacement === "right" ? "プレビュー幅" : "プレビュー高さ");
  inlinePreview.setFullscreen(fullscreen);
  const mainRect = mainEl.getBoundingClientRect();
  const editorRect = editorHost.getBoundingClientRect();
  mainEl.style.setProperty("--preview-editor-top", `${editorRect.top - mainRect.top}px`);
  mainEl.style.setProperty("--preview-editor-height", `${editorRect.height}px`);
  mainEl.style.setProperty("--preview-editor-bottom", `${mainRect.bottom - editorRect.bottom}px`);
  for (const button of previewOpenButtons) {
    const placement = button.dataset.previewPlacement as PreviewPlacement;
    button.hidden = !isPreviewOpenButtonShown(previewState, previewPlacement, placement);
    button.style.left = `${previewToggleLeft(
      false, mainRect.left, editorRect.right, editorRect.right - mainRect.left,
      button.offsetWidth || PREVIEW_TOGGLE_DEFAULT_WIDTH,
    )}px`;
  }
  if (returnFocusToCloseButton) inlinePreview.focusCloseButton();
}

function updateSidebarVisibility() {
  const width = measuredMainWidth();
  if (width <= 0) {
    layoutRuntime?.coordinator.request();
    return;
  }
  applyPaneVisibility(width);
}

function updatePreviewVisibility() {
  const width = measuredMainWidth();
  if (width <= 0) {
    layoutRuntime?.coordinator.request();
    return;
  }
  applyPaneVisibility(width);
}

const inlinePreviewPorts = {
  onClose: closePreview,
  onRefresh: () => runBackground("プレビューを更新できませんでした", () => {
    if (previewDocument?.format === "git") inlinePreview.refreshGit();
    else if (previewDocument?.format === "video") inlinePreview.resend();
    else return refreshExternalPreview();
  }),
  onGitState: (token, path, state) => {
    if (gitPreviewTarget?.token === token && gitPreviewTarget.path === path) gitPreviewTarget.state = state;
  },
  onAvailabilityChange: (available, label) => {
    if (available) {
      previewReplacementLifecycle.onAvailable(
        label,
        openingPreviewRequestGeneration,
        invalidatePreviewRequest,
      );
    } else {
      const isActiveView = previewReplacementLifecycle.onUnavailable(
        label,
        previewRequestGeneration,
        invalidatePreviewRequest,
      );
      if (!isActiveView) return;
    }
    previewAvailable = available;
    if (available) previewCollapsed = false;
    updatePreviewVisibility();
  },
  onExternalOutputReleased: (path) => externalPreviewOutputLifecycle.discardGeneratedOutput(path),
  onFormatChange: (format) => openPreviewFormat(
    doc.current,
    documentPathOf(doc.current),
    format,
    null,
    { sqliteMismatch: "keep", keepPreviewRange: true, errorTitle: "ビューを切り替えられませんでした" },
  ),
  onDelimiterChange: (delimiter) => inlinePreview.setDelimiter(delimiter),
  onFontFamilyChange: (family) => editor.setFont(family, getSetting("fontSize"), "family"),
  onSelectionChange: (selection) =>
    runBackground("エディタの位置を同期できませんでした", () => editor.goToPreview(selection)),
  onMarkdownLink: (href, newTab) => {
    const sourceTabId = previewDocument?.ownerTabId ?? tabs?.state.activeId ?? null;
    return runBackground(
      "Markdownリンクを開けませんでした",
      async () => {
        const sourcePath = previewDocument?.ownerTabId === sourceTabId
          ? sourcePathForViewer(previewDocument.format, doc.current.savePath, doc.current.displayPath)
          : doc.current.savePath;
        const action = markdownLinkActionOf(sourcePath, href, newTab);
        if (action.kind === "external") {
          await api.openExternalUrl(action.href);
          return;
        }
        if (action.kind === "unchanged") return;
        if (action.kind === "unresolved") throw new Error(action.message);
        if (!action.newTab) {
          if (!await openPathInTabs(tabs, action.path, false)) {
            throw new Error("リンク先ファイルが見つかりません");
          }
          return;
        }
        if (!await tabs.openMarkdownLink(action.path, sourceTabId, action.fragment)) {
          throw new Error("リンク先ファイルが見つかりません");
        }
      },
    );
  },
  onFullscreenChange: () => {
    previewFullscreen = !previewFullscreen;
    previewFullscreenTabId = previewFullscreen ? tabs.state.activeId : null;
    if (previewFullscreen) previewCollapsed = false;
    updatePreviewVisibility();
  },
  onError: (error) => reportBackgroundError("プレビュー通知を処理できませんでした", error),
} satisfies InlinePreviewPorts;

let previewDocument: (PreviewDocument & { externalAdapter?: ExternalPreviewAdapter }) | null = null;
let gitPreviewTarget: (GitPreviewTarget & { token: string }) | null = null;
let gitSelectionGeneration = 0;
let previewRequestGeneration = 0;
const previewReplacementLifecycle = createPreviewReplacementLifecycle();
const externalPreviewOutputLifecycle = createExternalPreviewOutputLifecycle(cleanupExternalPreviewOutput);
let externalPreviewRequestId: string | null = null;
let openingPreviewRequestGeneration: number | null = null;
let externalPreviewRefreshPending = false;
let pendingPreviewClear: Promise<void> = Promise.resolve();

function cleanupExternalPreviewOutput(path: string | null) {
  if (!path) return;
  void api.externalPreviewCleanup(path).catch((error) => {
    console.warn("外部プレビューの一時生成物を削除できませんでした", error);
  });
}

function cancelPendingExternalPreviewRequest() {
  const oldRequestId = externalPreviewRequestId;
  externalPreviewRequestId = null;
  if (!oldRequestId) return;
  void api.externalPreviewCancel(oldRequestId).catch((error) => {
    console.warn("外部プレビューの実行を取り消せませんでした", error);
  });
}

function clearDisplayedExternalPreviewOutput() {
  inlinePreview?.setExternalOutputPath(null);
  externalPreviewOutputLifecycle.replaceDisplayedOutput(null);
}

function clearExternalPreviewOutput() {
  cancelPendingExternalPreviewRequest();
  openingPreviewRequestGeneration = null;
  inlinePreview?.setExternalStatus(null);
  clearDisplayedExternalPreviewOutput();
}

function invalidatePreviewRequest(clearSelection = true) {
  previewRequestGeneration++;
  clearExternalPreviewOutput();
  if (!clearSelection) return;
  previewDocument = null;
  editingStatusbar.setPreviewFormat(null);
}

function externalPreviewInputPath(session: Readonly<DocumentSession>): string | null {
  if (!session.savePath || session.archivePath !== null || session.archiveEntry !== null) return null;
  if (isFolderDraftInfo({ path: session.displayPath, folder_root: session.folderRoot })) return null;
  return session.savePath;
}

function clearPreview(session: Readonly<DocumentSession>) {
  const retiredOutputPath = externalPreviewOutputLifecycle.displayedOutputPath();
  previewReplacementLifecycle.finish(previewRequestGeneration);
  previewRequestGeneration++;
  openingPreviewRequestGeneration = null;
  cancelPendingExternalPreviewRequest();
  inlinePreview.setExternalStatus(null);
  inlinePreview.setPendingExternalOutputPath(null);
  inlinePreview.setSourcePath(null, session.archivePath, session.archiveEntry);
  previewDocument = null;
  previewFullscreen = false;
  previewFullscreenTabId = null;
  editingStatusbar.setPreviewFormat(null);
  pendingPreviewClear = inlinePreview.clear().then(() => {
    if (retiredOutputPath && externalPreviewOutputLifecycle.displayedOutputPath() === retiredOutputPath
      && !inlinePreview.mayReferenceExternalOutputPath(retiredOutputPath)) clearDisplayedExternalPreviewOutput();
  });
  if (!previewAvailable) clearDisplayedExternalPreviewOutput();
}

function openPreviewFormat(
  session: Readonly<DocumentSession>,
  path: string,
  format: api.ViewerFormat,
  fragment: string | null = null,
  options: {
    sqliteMismatch?: SqlitePreviewFallback;
    keepPreviewRange?: boolean;
    errorTitle?: string;
    externalAdapter?: ExternalPreviewAdapter;
    placement?: PreviewPlacement;
  } = {},
) {
  const {
    sqliteMismatch = "markdown",
    keepPreviewRange = false,
    errorTitle = "ビューを表示できませんでした",
    externalAdapter,
  } = options;
  if (externalAdapter && previewReplacementLifecycle.isReplacing()
    && previewDocument?.externalAdapter?.id === externalAdapter.id
    && isCurrentPreviewDocument(previewDocument, tabs?.state.activeId ?? null, path)) return;
  if (options.placement || !previewAvailable || previewCollapsed) {
    selectPreviewPlacement(options.placement);
  }
  openingPreviewRequestGeneration = null;
  cancelPendingExternalPreviewRequest();
  const previousPreviewDocument = previewDocument;
  const document: PreviewDocument & { externalAdapter?: ExternalPreviewAdapter } = {
    ownerTabId: tabs?.state.activeId ?? null,
    path,
    format,
  };
  if (externalAdapter) document.externalAdapter = externalAdapter;
  const requestGeneration = ++previewRequestGeneration;
  const pendingViewerOpenCancellation = previewReplacementLifecycle.begin(
    requestGeneration,
    async () => {
      await pendingPreviewClear;
      await editor.cancelPendingTextViewerOpens();
    },
  );
  const isCurrentRequest = () => requestGeneration === previewRequestGeneration
    && document.ownerTabId === (tabs?.state.activeId ?? null)
    && document.path === (format === "git" ? gitPreviewTarget?.path : documentPathOf(doc.current));
  if (externalAdapter || format === "git") {
    previewDocument = document;
    openingPreviewRequestGeneration = requestGeneration;
  } else inlinePreview.setExternalStatus(null);
  const restoreAfterDecline = () => {
    if (!isCurrentRequest()) return;
    previewDocument = previousPreviewDocument;
    inlinePreview.setExternalStatus(null);
    if (!previousPreviewDocument) clearPreview(session);
  };
  runBackground(errorTitle, async () => {
    let requestId: string | null = null;
    let generatedOutputPath: string | null = null;
    try {
      await pendingViewerOpenCancellation;
      if (!isCurrentRequest()) return;
      let resolvedFormat = format;
      let effectiveExtension = session.effectiveExtension;
      if (externalAdapter) {
        inlinePreview.setExternalStatus({
          message: getSetting("trustedExternalPreviewAdapterIds").includes(externalAdapter.id)
            ? externalPreviewOutputLifecycle.displayedOutputPath() ? "更新中…" : "変換中…"
            : "実行確認待ち…",
          busy: true,
        });
        previewCollapsed = false;
        updatePreviewVisibility();
        const inputPath = externalPreviewInputPath(session);
        if (!inputPath) throw new Error("外部プレビューは保存済みの通常ファイルだけに対応しています");
        if (!getSetting("trustedExternalPreviewAdapterIds").includes(externalAdapter.id)) {
          const isSelectedAdapterCurrent = () => {
            const classificationPath = classificationPathOf(session);
            const selectedAdapter = externalPreviewAdapterForPath(
              classificationPath,
              getSetting("externalPreviewAdapters"),
              getSetting("externalPreviewAdapterSelections"),
            );
            return selectedAdapter !== null
              && selectedAdapter.id === externalAdapter.id
              && selectedAdapter.command === externalAdapter.command
              && selectedAdapter.args === externalAdapter.args
              && previewSelectionForAdapter(
                selectedAdapter,
                viewerFormatForAutomaticPreview(classificationPath) !== null,
              ) === "external";
          };
          const approved = await confirmMessage(
            "外部プレビューの実行確認",
            "実行を許可すると、実行ファイルまたは引数を編集するまで確認を省略します。信頼できる場合だけ続行してください。\n\n"
              + "実行ファイル: " + externalAdapter.command + "\n引数: " + externalAdapter.args,
            "信頼して実行",
          );
          if (!approved || !isCurrentRequest() || !isSelectedAdapterCurrent()) {
            restoreAfterDecline();
            return;
          }
          setSetting("trustedExternalPreviewAdapterIds", [
            ...getSetting("trustedExternalPreviewAdapterIds"),
            externalAdapter.id,
          ]);
          await flushSettings();
          if (!isCurrentRequest() || !isSelectedAdapterCurrent()) {
            restoreAfterDecline();
            return;
          }
        }
        inlinePreview.setExternalStatus({
          message: externalPreviewOutputLifecycle.displayedOutputPath() ? "更新中…" : "変換中…",
          busy: true,
        });
        requestId = window.crypto.randomUUID();
        externalPreviewRequestId = requestId;
        generatedOutputPath = await api.externalPreviewGenerate({
          inputPath,
          executable: externalAdapter.command,
          args: parseExternalPreviewArguments(externalAdapter.args),
          outputFormat: externalAdapter.outputFormat,
          requestId,
          workRoot: getSetting("externalPreviewTemporaryDirectory"),
        });
        if (externalPreviewRequestId === requestId) externalPreviewRequestId = null;
        if (!isCurrentRequest()) {
          externalPreviewOutputLifecycle.discardGeneratedOutput(
            generatedOutputPath,
            inlinePreview.mayReferenceExternalOutputPath(generatedOutputPath),
          );
          return;
        }
        setExternalPreviewLog(null);
        inlinePreview.setExternalStatus({ message: "読み込み中…", busy: true });
        resolvedFormat = externalAdapter.outputFormat === "svg" ? "image" : "html";
        effectiveExtension = null;
      }
      if (format === "sqlite") {
        const action = await resolveSqlitePreviewAction(
          sqlitePreviewSourcePath(session),
          sqliteMismatch,
          api.probeSqlitePreview,
        );
        if (!isCurrentRequest()) return;
        if (action === "keep") {
          previewDocument = previousPreviewDocument;
          return;
        }
        if (action === "clear") {
          clearPreview(session);
          return;
        }
        if (action === "markdown") {
          resolvedFormat = action;
          document.format = action;
          effectiveExtension = null;
        }
      }
      if (!isCurrentRequest()) return;
      inlinePreview.setSourcePath(
        resolvedFormat === "git" ? path : sourcePathForViewer(resolvedFormat, session.savePath, session.displayPath),
        resolvedFormat === "git" ? null : session.archivePath,
        resolvedFormat === "git" ? null : session.archiveEntry,
        resolvedFormat === "git" ? null : effectiveExtension,
      );
      inlinePreview.setPendingExternalOutputPath(generatedOutputPath);
      openingPreviewRequestGeneration = requestGeneration;
      const openedLabel = await editor.openTextViewer(
        resolvedFormat,
        keepPreviewRange,
        resolvedFormat === "sqlite",
        true,
        generatedOutputPath,
        isCurrentRequest,
      );
      if (!isCurrentRequest()) {
        if (generatedOutputPath) {
          externalPreviewOutputLifecycle.discardGeneratedOutput(
            generatedOutputPath,
            inlinePreview.mayReferenceExternalOutputPath(generatedOutputPath),
          );
        }
        return;
      }
      if (openedLabel === null || !previewReplacementLifecycle.isActive(openedLabel)) {
        if (externalAdapter) throw new Error("外部プレビューの表示を完了できませんでした");
        return;
      }

      if (!isCurrentRequest()) return;
      if (generatedOutputPath) {
        if (!externalPreviewOutputLifecycle.replaceDisplayedOutput(generatedOutputPath, isCurrentRequest)) {
          externalPreviewOutputLifecycle.discardGeneratedOutput(
            generatedOutputPath,
            inlinePreview.mayReferenceExternalOutputPath(generatedOutputPath),
          );
          return;
        }
        inlinePreview.setExternalOutputPath(generatedOutputPath);
      } else {
        clearDisplayedExternalPreviewOutput();
      }
      previewDocument = document;
      if (resolvedFormat === "git" && gitPreviewTarget?.collapsed) {
        previewCollapsed = true;
        updatePreviewVisibility();
      }
      inlinePreview.setExternalStatus(null);
      editingStatusbar.setPreviewFormat(resolvedFormat);
      if (fragment !== null && resolvedFormat === "markdown") inlinePreview.setMarkdownFragment(fragment);
    } catch (error) {
      if (requestId && externalPreviewRequestId === requestId) cancelPendingExternalPreviewRequest();
      if (generatedOutputPath) {
        externalPreviewOutputLifecycle.discardGeneratedOutput(
          generatedOutputPath,
          inlinePreview.mayReferenceExternalOutputPath(generatedOutputPath),
        );
      }
      throw error;
    } finally {
      if (isCurrentRequest()) inlinePreview.setPendingExternalOutputPath(externalPreviewOutputLifecycle.displayedOutputPath());
      previewReplacementLifecycle.finish(requestGeneration);
      if (openingPreviewRequestGeneration === requestGeneration) openingPreviewRequestGeneration = null;
      if (requestId && externalPreviewRequestId === requestId) externalPreviewRequestId = null;
    }
  }, externalAdapter ? async (error) => {
    if (!isCurrentRequest()) return;
    const detail = error instanceof Error ? error.message : String(error);
    setExternalPreviewLog(detail);
    inlinePreview.setExternalStatus({
      message: "変換失敗: " + detail + "\n「更新」から再試行できます。ログは上部の「実行ログ」から確認できます。",
      busy: false,
    });
  } : undefined);
}

function sqlitePreviewSourcePath(session: Readonly<DocumentSession>): string | null {
  if (session.archivePath !== null || session.archiveEntry !== null) return null;
  if (isFolderDraftInfo({ path: session.displayPath, folder_root: session.folderRoot })) return null;
  return sourcePathForViewer("sqlite", session.savePath, session.displayPath);
}

async function openGitPreview(relPath: string) {
  const generation = ++gitSelectionGeneration;
  const session = doc.current;
  if (!session.folderRoot) return;
  const owner = tabs.state.activeId;
  const documentPath = documentPathOf(session);
  const path = await joinPath(session.folderRoot, relPath);
  if (generation !== gitSelectionGeneration || tabs.state.activeId !== owner || documentPathOf(doc.current) !== documentPath) return;
  if (gitPreviewTarget?.path === path) {
    gitPreviewTarget.collapsed = false;
    openPreview();
    return;
  }
  gitPreviewTarget = { path, documentPath, state: null, collapsed: false, token: window.crypto.randomUUID() };
  openPreviewFormat(session, path, "git");
}

async function navigateTreeEntry(relPath: string, openAs?: api.OpenAs) {
  ++gitSelectionGeneration;
  const target = gitPreviewTarget;
  const owner = tabs.state.activeId;
  const opened = await tabs.navigateEntry(relPath, openAs);
  if (opened && target && owner === tabs.state.activeId && gitPreviewTarget === target) {
    gitPreviewTarget = null;
    syncPreviewDocument(doc.current, true);
  }
  return opened;
}

function syncPreviewDocument(session: Readonly<DocumentSession>, force = false, fragment: string | null = null) {
  const path = documentPathOf(session);
  const activeTabId = tabs?.state.activeId ?? null;
  if (gitPreviewTarget) {
    if (gitPreviewTarget.documentPath === path) {
      if (!isCurrentPreviewDocument(previewDocument, activeTabId, gitPreviewTarget.path)) {
        openPreviewFormat(session, gitPreviewTarget.path, "git");
      }
      return;
    }
    gitPreviewTarget = null;
  }
  if (previewDocument?.format === "video" && !isCurrentPreviewDocument(previewDocument, activeTabId, path)) {
    inlinePreview.setVisibility(false, true);
  }
  const classificationPath = classificationPathOf(session);
  const standardFormat = viewerFormatForAutomaticPreview(classificationPath);
  if (standardFormat === "video" && (session.archivePath !== null || session.archiveEntry !== null)) {
    clearPreview(session);
    return;
  }
  const externalAdapter = externalPreviewAdapterForPath(
    classificationPath,
    getSetting("externalPreviewAdapters"),
    getSetting("externalPreviewAdapterSelections"),
  );
  const externalSelection = previewSelectionForAdapter(externalAdapter, standardFormat !== null);
  if (previewAvailable
    && externalAdapter
    && externalSelection === "external"
    && externalPreviewInputPath(session)) {
    if (!force && isCurrentPreviewDocument(previewDocument, activeTabId, path)) return;
    openPreviewFormat(
      session,
      path,
      externalAdapter.outputFormat === "svg" ? "image" : "html",
      fragment,
      { sqliteMismatch: "clear", externalAdapter },
    );
    return;
  }
  const format = effectivePreviewFormat(
    path,
    standardFormat,
    activeTabId,
    previewDocument,
  );
  if (previewFullscreen && !shouldKeepPreviewFullscreen(
    previewFullscreenTabId,
    tabs?.state.activeId ?? null,
    format !== null,
  )) {
    previewFullscreen = false;
    previewFullscreenTabId = null;
  }
  const isAssetPreview = isAssetViewerFormat(format);
  if (format === "sqlite" && !sqlitePreviewSourcePath(session)) {
    clearPreview(session);
    return;
  }
  if (!force && isCurrentPreviewDocument(previewDocument, activeTabId, path) && (!isAssetPreview || format === "video")) return;
  if (!format) {
    clearPreview(session);
    return;
  }
  openPreviewFormat(session, path, format, fragment, {
    sqliteMismatch: format === "sqlite" ? "clear" : "markdown",
  });
}

// ---- 編集・プレビュー側 ----
const editingStatusbarPorts = {
  onGoTo: (line) => editor.goTo(line, 0),
  onFontFamily: (family) => editor.setFont(family, getSetting("fontSize"), "family"),
  onFontSize: (size) => editor.setFont(getSetting("fontFamily"), size, "size"),
  onPreviewFontFamily: (family) => previewEditorFont(family, getSetting("fontSize"), "family"),
  onPreviewFontSize: (size) => previewEditorFont(getSetting("fontFamily"), size, "size"),
  onPreviewDelimiter: (delimiter) => inlinePreview.setDelimiter(delimiter),
  onWrap: (on) => editor.setWrap(on),
  onIndent: (size) => {
    setSetting("indentSize", size);
    editor.setTabSize(size);
  },
  onReadEncoding: async (encoding) => {
    if (doc.current.dirty && !(await confirmReloadDiscardingEdits())) return false;
    return doc.reloadWithEncoding(encoding);
  },
  onError: showError,
} satisfies StatusBarPorts;
function applyTheme(theme: ReturnType<typeof normalizeTheme>) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem(THEME_STORAGE_KEY, theme);
}

applyTheme(normalizeTheme(localStorage.getItem(THEME_STORAGE_KEY)));
window.addEventListener("storage", (event) => {
  if (event.key === THEME_STORAGE_KEY) applyTheme(normalizeTheme(event.newValue));
});

const registeredCommandPorts = {
  promptFields,
  runExternalCommand: api.runExternalCommand,
  writeClipboardText,
};

function openRegisteredStringSettings(current?: string) {
  runSettingsChild("登録文字列を保存できませんでした", () =>
    promptAndSaveRegisteredString(promptFields, current));
}

function openRegisteredCommandSettings(kind: CommandValueKind, current?: RegisteredCommand) {
  runSettingsChild("登録コマンドを保存できませんでした", async () => {
    const value = await promptRegisteredCommand(
      registeredCommandPorts,
      current === undefined ? "コマンドを登録" : "登録コマンドを編集",
      kind,
      current,
    );
    if (!value) return;
    await saveRegisteredCommand(kind, value, current);
  });
}

function openExternalPreviewAdapterSettings(current?: ExternalPreviewAdapter, onSaved?: () => void) {
  runBackground("外部プレビューを保存できませんでした", async () => {
    const value = await promptExternalPreviewAdapter({ promptFields }, current);
    if (!value) return;
    if (current) {
      const selections = { ...getSetting("externalPreviewAdapterSelections") };
      for (const [extension, id] of Object.entries(selections)) {
        if (id === current.id && !value.extensions.includes(extension)) delete selections[extension];
      }
      setSetting("externalPreviewAdapterSelections", selections);
    }
    if (current && (current.command !== value.command || current.args !== value.args)) {
      setSetting("trustedExternalPreviewAdapterIds",
        getSetting("trustedExternalPreviewAdapterIds").filter((id) => id !== current.id));
    }
    const adapters = getSetting("externalPreviewAdapters");
    setSetting("externalPreviewAdapters", current
      ? adapters.map((adapter) => adapter === current ? value : adapter)
      : [...adapters, value]);
    await flushSettings();
    onSaved?.();
  });
}

function runSettingsChild(title: string, operation: () => void | Promise<void>) {
  void runBackground(title, () => returnToSettings(operation, openSettings));
}

function openSearchSettingsFromSettings() {
  openSearchSettingsDialog(loadSearchOptions(), {
    onChange: (options) => {
      saveSearchOptions(options);
      sidebar?.setSearchOptions(options);
    },
    onClose: openSettings,
  });
}

function previewEditorFont(family: string, size: number, changed: "family" | "size") {
  previewingEditorFont = true;
  try {
    editor.setFont(family, size, changed);
  } finally {
    previewingEditorFont = false;
  }
  if (changed === "family") inlinePreview.setFontFamily(family);
}

const editorPorts = {
  onDocChange: (lineCount, edits) => {
    doc.onEdit(lineCount);
    editingStatusbar.setLineCount(lineCount);
    sidebar?.refreshWorkspaceSearch(doc.current.selectedRelPath, edits ?? []);
    scheduleImageCleanup();
  },
  onCursor: (line, col) => {
    currentLine = line;
    editingStatusbar.setCursor(line, col);
    tabs?.syncCursor(line - 1);
  },
  onFontChange: (family, size, changed) => {
    if (previewingEditorFont) return;
    editingStatusbar.setFont(family, size);
    if (changed !== "size") inlinePreview.setFontFamily(family);
    if (!restoringEditorFont) {
      if (changed !== "size") setSetting("fontFamily", family);
      if (changed !== "family") setSetting("fontSize", size);
    }
  },
  registeredCommandPorts,
  openExternally: (path) => openInOtherApp(path),
  openInNewTab: () => runBackground("新規タブで開けませんでした", () => tabs.openCurrentInNewTab()),
  openInNewWindow: (path) => runBackground("新規ウィンドウで開けませんでした", () => launchNewWindow({ path })),
  openAs: (openAs) => runBackground("指定した形式で開けませんでした", () => tabs.openCurrentAs(openAs)),
  revealInExplorer: (path, isDir) => revealInExplorer(path, isDir),
  onError: (message, error) => showError(message, error),
  togglePreview: () => openPreview(),
  cancelPendingViewerOpen: () => inlinePreview.cancelPendingExternalOpen(),
  openViewer: async (format, text, selection, sqliteHeaderChecked = false, externalOutputPath, isCurrentRequest = () => true) => {
    if (openingPreviewRequestGeneration === null && (!previewAvailable || previewCollapsed)) selectPreviewPlacement();
    const session = doc.current;
    const path = documentPathOf(session);
    const ownerTabId = tabs?.state.activeId ?? null;
    if (format === "git") {
      if (!gitPreviewTarget || !isCurrentRequest()) return null;
      text = JSON.stringify({ token: gitPreviewTarget.token, state: gitPreviewTarget.state });
      selection = null;
    }
    if (format === "video") {
      if (session.archivePath !== null || session.archiveEntry !== null) return null;
      inlinePreview.setSourcePath(sourcePathForViewer(format, session.savePath, session.displayPath));
    }
    let sqliteRequestGeneration = previewRequestGeneration;
    const isCurrentSqliteRequest = () => sqliteRequestGeneration === previewRequestGeneration
      && ownerTabId === (tabs?.state.activeId ?? null)
      && path === documentPathOf(doc.current)
      && isCurrentRequest();
    if (format === "sqlite") {
      const sourcePath = sqlitePreviewSourcePath(session);
      if (!sourcePath) throw new Error("SQLiteプレビューには実ファイルのパスが必要です");
      if (!sqliteHeaderChecked) {
        sqliteRequestGeneration = ++previewRequestGeneration;
        const action = await resolveSqlitePreviewAction(sourcePath, "keep", api.probeSqlitePreview);
        if (action !== "sqlite" || !isCurrentSqliteRequest()) return null;
      } else if (!isCurrentSqliteRequest()) {
        return null;
      }
      inlinePreview.setSourcePath(
        sourcePath,
        session.archivePath,
        session.archiveEntry,
        session.effectiveExtension,
      );
    }
    const label = await inlinePreview.open(format, text, selection, externalOutputPath, isCurrentRequest);
    if (!isCurrentRequest()) return null;
    editingStatusbar.setPreviewFormat(format);
    if (format === "sqlite" && isCurrentSqliteRequest()) {
      previewDocument = { ownerTabId, path, format };
    } else if (openingPreviewRequestGeneration === null
      && isCurrentPreviewDocument(previewDocument, ownerTabId, path)) {
      previewDocument.format = format;
    }
    return label;
  },
  updateViewer: (label, text, selection) => inlinePreview.update(label, text, selection),
  closeViewer: (label) => inlinePreview.close(label),
  saveImage: async (bytes, mimeType) => {
    return withArchivePassword(
      archiveRelOf(doc.current.selectedRelPath),
      () => api.savePastedImage(bytes, mimeType),
    );
  },
} satisfies EditorPorts;

const editingSurfaceHost = new EditingSurfaceHost(
  { editor: editorHost, preview: previewEl, statusbar: $("editing-statusbar") },
  { editor: editorPorts, preview: inlinePreviewPorts, statusbar: editingStatusbarPorts },
);
editor = editingSurfaceHost.editor;
inlinePreview = editingSurfaceHost.preview;
editingStatusbar = editingSurfaceHost.statusbar;

layoutRuntime = createWindowLayoutRuntime(window, {
  measure: (): WindowViewport => {
    const rect = mainEl.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  },
  apply: (viewport) => {
    try {
      applyPaneVisibility(viewport.width);
      editor.syncWindowGeometry();
    } catch (error) {
      void reportBackgroundError("画面レイアウトを更新できませんでした", error);
    }
  },
});

function applySettingsToUi() {
  setSidebarWidth(getSetting("sidebarWidth"));
  restoringEditorFont = true;
  editor.setFont(getSetting("fontFamily"), getSetting("fontSize"));
  restoringEditorFont = false;
  editor.setTabSize(editingStatusbar.setIndent(getSetting("indentSize")));
  inlinePreview.setFontFamily(getSetting("fontFamily"));
  inlinePreview.setFontSize(getSetting("previewFontSize"));
  inlinePreview.setMarkdownSoftBreaks(getSetting("markdownSoftBreaks"));
  inlinePreview.setMarkdownLineHeight(getSetting("markdownLineHeight"));
  inlinePreview.setMarkdownHeadingUnderlines(getSetting("markdownHeadingUnderlines"));
  sidebar?.setSearchOptions(loadSearchOptions());
  previewRightRatio = getSetting("previewRightRatio");
  previewVerticalRatio = getSetting("previewVerticalRatio");
  updatePreviewVisibility();
}

applySettingsToUi();

settingsPorts = {
  getTheme: () => normalizeTheme(document.documentElement.getAttribute("data-theme")),
  setTheme: applyTheme,
  getSetting,
  setSetting,
  applyFontFamily: (family) => editor.setFont(family, getSetting("fontSize"), "family"),
  applyFontSize: (size) => editor.setFont(getSetting("fontFamily"), size, "size"),
  applyIndent: (size) => {
    editor.setTabSize(size);
    editingStatusbar.setIndent(size);
  },
  applyPreviewFontSize: (size) => inlinePreview.setFontSize(size),
  applyMarkdownSoftBreaks: (enabled) => inlinePreview.setMarkdownSoftBreaks(enabled),
  applyMarkdownLineHeight: (value) => inlinePreview.setMarkdownLineHeight(value),
  applyMarkdownHeadingUnderlines: (enabled) => inlinePreview.setMarkdownHeadingUnderlines(enabled),
  pickPreviewCacheDirectory: async (defaultPath?: string) => {
    try {
      const selected = await openDialog({ directory: true, multiple: false, defaultPath });
      return typeof selected === "string" ? selected : null;
    } catch (error) {
      await reportBackgroundError("プレビューキャッシュ保存場所を選べませんでした", error);
      return null;
    }
  },
  pickExternalPreviewTemporaryDirectory: async (defaultPath?: string) => {
    try {
      const initialPath = defaultPath ?? await joinPath(await tempDir(), "WasabiPad", "external-preview");
      const selected = await openDialog({ directory: true, multiple: false, defaultPath: initialPath });
      return typeof selected === "string" ? selected : null;
    } catch (error) {
      await reportBackgroundError("外部プレビュー一時ファイル保存先を選べませんでした", error);
      return null;
    }
  },
  flushSettings: async () => {
    try {
      await flushSettings();
    } catch (error) {
      await reportBackgroundError("外部プレビュー一時保存先を保存できませんでした", error);
      throw error;
    }
  },
  clearPreviewCache: async () => {
    try {
      await api.clearPreviewCache(getSetting("previewCacheDirectory"));
    } catch (error) {
      await reportBackgroundError("プレビューキャッシュを削除できませんでした", error);
    }
  },
  getPreviewCacheInfo: async () => {
    try {
      return await api.getPreviewCacheInfo(getSetting("previewCacheDirectory"));
    } catch (error) {
      console.error("プレビューキャッシュの情報を取得できませんでした", error);
      return null;
    }
  },
  openSearchSettings: openSearchSettingsFromSettings,
  openRegisteredString: openRegisteredStringSettings,
  openRegisteredCommand: openRegisteredCommandSettings,
  openExternalPreviewAdapter: openExternalPreviewAdapterSettings,
  confirmReset: () => confirmMessage(
    "設定を初期化",
    "アプリ設定を初期値へ戻します。再開タブは保持されます。",
    "初期化",
  ),
  resetSettings: () => {
    resetUserSettings();
    applyTheme("dark");
    applySettingsToUi();
  },
};

let settingsModalState: SettingsModalState | undefined;
const openSettings = createSettingsOpener((onClose) => {
  const initialState = settingsModalState;
  settingsModalState = undefined;
  return openSettingsModal(settingsPorts, (state) => {
    settingsModalState = state;
    onClose();
  }, initialState);
});

const workspaceHost = new WorkspaceHost(
  {
    topbar: $("topbar"),
    sidebar: sidebarEl,
    favbar: $("favbar"),
    fileStatusbar: $("file-statusbar"),
  },
  {
    addressbar: {
      onOpen: (path, newTab) => runBackground("開けませんでした", () => openPathInTabs(tabs, path, newTab)),
      onSave: () => runBackground("保存できませんでした", () => doc.save()),
      onSaveAs: () => runBackground("名前を付けて保存できませんでした", () => doc.saveAs()),
      onNew: () => runBackground("新規ウィンドウを開けませんでした", launchNewWindow),
      onFind: () => editor.openSearch(),
      onPick: () => runBackground("ファイルを開けませんでした", () => pickAndOpen(false)),
      onFavorite: () => runBackground("お気に入りに追加できませんでした", () => favbar.addCurrent()),
      onSettings: openSettings,
    },
    sidebar: {
      onSelect: async (relPath, newTab) => {
        if (newTab) return openInNewTab(relPath);
        return navigateTreeEntry(relPath);
      },
      onGitPreview: openGitPreview,
      onContextMenu: (x, y, target, selected) => folderActions.showContextMenu(x, y, target, selected),
      onFileCommand: (command, selected) => folderActions.executeCommand(command, selected),
      onRenameEntry: (relPath, newName) => folderActions.renameEntry(relPath, newName),
      isCut: (relPath) => folderActions.isCut(relPath),
      onExpandArchive: (relPath) =>
        withArchivePassword(relPath, () => api.listArchiveEntries(relPath)),
      onExpandFolder: (relDir) => api.listFolderEntries(relDir),
      onDropEntries: (request) => folderActions.dropEntries(request),
      onUndoLastDrop: () => folderActions.undoLastDrop(),
      onCreateFolder: (relDir) => folderActions.createFolder(relDir),
      onCreateNote: (relDir) => folderActions.createNote(relDir),
      onTreeError: async (error) => {
        if (!isPasswordCancelled(error)) await showError("フォルダを展開できませんでした", error);
      },
      onSearch: (pat, options, searchId) => api.workspaceSearch(pat, options, searchId),
      onCancel: (searchId) => api.workspaceSearchCancel(searchId),
      onCancelError: (error) => showError("検索を中止できませんでした", error),
      onError: (error) => showError("フォルダを検索できませんでした", error),
      onOptionsChange: saveSearchOptions,
      onClear: () => editor.setFindHighlightQuery("", false),
      onOpen: async (result, newTab, query) => {
        if (newTab) {
          if (!(await openInNewTab(result.rel_path, searchResultGoto(result)))) return false;
        } else if (!(await navigateTreeEntry(result.rel_path))) {
          return false;
        }
        // 当たった長さは backend が返す範囲から取る。正規表現や大小の畳み込みでは
        // 入力したパターンの長さと一致しない。
        const [, length] = result.highlights[0] ?? [0, 0];
        if (result.is_filename) {
          editor.setFindHighlightQuery("", false);
          if (!newTab) editor.goTo(result.line, result.col);
        } else {
          editor.setFindHighlightQuery(query.pat, query.matchCase, query.useRegex, query.wholeWord);
          if (!newTab) await editor.selectRange(result.line, result.col, result.col + length);
        }
        return true;
      },
      onReplace: async (result, replacement) => {
        if (result.is_filename) return false;
        if (!(await navigateTreeEntry(result.rel_path))) return false;
        const [, length] = result.highlights[0] ?? [0, 0];
        if (!length) return false;
        return editor.replaceRange(result.line, result.col, result.col + length, replacement);
      },
    },
    favbar: {
      onOpen: (path, newTab) => runBackground("お気に入りを開けませんでした", () => openPathInTabs(tabs, path, newTab)),
      onOpenInNewWindow: (path) => launchNewWindow({ path }),
      onAddGroupToTabs: (items) => tabs.addLinks(items),
      revealInExplorer,
      currentFile: () => addressbar.path || null,
      onError: (error) => showError("お気に入りを移動できませんでした", error),
    },
  },
  loadSearchOptions(),
);
addressbar = workspaceHost.addressbar;
sidebar = workspaceHost.sidebar;
favbar = workspaceHost.favbar;
fileStatusbar = workspaceHost.fileStatusbar;

// 検索の途中経過。確定を待たずに届いた分から並べる
void api.onWorkspaceSearchBatch((batch) => runBackground("検索結果を画面へ反映できませんでした", () =>
  sidebar.acceptSearchBatch(batch.search_id, batch.results)
))
  .then((unlisten) => workspaceSearchListener.set(unlisten))
  .catch((error) => reportBackgroundError("検索結果の受信を開始できませんでした", error));

// フォルダビュー由来の relPath は、独立したファイルタブ用の絶対パスへ戻す
void api.onDocumentLoadProgress((progress) => {
  applyDocumentLoadProgress(loading, loadingMessage, progress);
})
  .then((unlisten) => documentLoadListener.set(unlisten))
  .catch((error) => reportBackgroundError("読み込み進捗の受信を開始できませんでした", error));

async function openInNewTab(relPath: string, goto?: api.Pos): Promise<boolean> {
  const root = doc.current.folderRoot;
  if (!root) return false;
  return tabs.openInNewTab(joinWindowsRoot(root, relPath), goto);
}

const windowChrome = new WindowChrome($("titlebar"), win, {
  onCloseRequest: () => canCloseWindow({
    saveForExit: (onProceed) => tabs.saveForExit(onProceed),
    flushSettings,
    onSettingsError: (error) => showError("設定を保存できませんでした", error),
  }),
  onGeometryChange: () => layoutRuntime?.coordinator.request(),
  onStateChange: (state) => {
    if (state !== "minimized") layoutRuntime?.coordinator.request();
  },
  onError: showError,
}, $("save-notice"));

const cacheAwareDocumentApi = {
  ...api,
  selectEntry: (relPath: string, openAs?: api.OpenAs) =>
    api.selectEntry(relPath, openAs, getSetting("previewCacheDirectory")),
};

const doc: DocumentController = new DocumentController({
  editor,
  statusbar: editingStatusbar,
  fileStatusbar,
  addressbar,
  sidebar,
  setSidebar,
  setLoading,
  setTitle: (title) => windowChrome.setTitle(title),
  onDocumentChange: (session, keepViewers = false) => {
    tabs?.syncActive(session);
    syncPreviewDocument(session, !keepViewers, tabs?.takeActiveFragment() ?? null);
  },
  onSessionChange: (session) => {
    tabs?.syncActive(session);
    syncPreviewDocument(session);
  },
  hideExternalBanner: () => externalWatch.hide(),
  pickSavePath: async (defaultPath) => {
    const path = await saveDialog({
      filters: [
        ...SAVE_EXTENSIONS.map(({ name, extension }) => ({ name, extensions: [extension] })),
        { name: "すべて", extensions: ["*"] },
      ],
      defaultPath,
    });
    return path ?? null;
  },
}, {
  api: cacheAwareDocumentApi,
  showError,
  confirmSaveDiscard,
  promptFields,
  promptSaveFormat,
  saveFormatFields,
  saveFormatFromValues,
  isPasswordCancelled,
  withArchivePassword,
} satisfies DocumentControllerServices);

function applyExternalInfo(info: api.DocInfo) {
  const line = currentLine;
  doc.applyDocInfo(info, true);
  editor.goTo(line - 1, 0);
}

function applyExternalMetadata(info: api.DocInfo) {
  fileStatusbar.setByteSize(info.byte_len, info.is_huge);
  fileStatusbar.setModifiedAt(info.modified_at);
}

const externalWatch = new ExternalWatch($("external-banner"), {
  canPoll: () => canPollExternalDocument(doc.current) && loading.hidden,
  isDirty: () => doc.current.dirty,
  onReload: applyExternalInfo,
  onNotice: (text) => windowChrome.notify(text),
  onError: showError,
  onIgnore: (info) => {
    applyExternalMetadata(info);
    editor.focus();
  },
  onConflict: async (preview, subscribe) => {
    const choice = await confirmExternalMerge(preview, subscribe);
    if (!choice) return false;
    try {
      if (choice === "merge") {
        const info = await api.mergeExternal();
        const line = currentLine;
        doc.applyMergedDocInfo(info);
        editor.goTo(line - 1, 0);
        windowChrome.notify("外部の変更をマージしました。内容を確認して保存してください");
      } else if (choice === "keep") {
        const info = await api.ackExternal();
        applyExternalMetadata(info);
        editor.focus();
      } else {
        applyExternalInfo(await api.reloadFromDisk());
      }
      return true;
    } catch (error) {
      if (choice === "merge" && isExternalMergeRetryError(error)) {
        windowChrome.notify("外部ファイルが再変更されたため、最新の差分を確認してください");
        return "retry";
      }
      await showError("外部変更を解決できませんでした", error);
      return false;
    }
  },
}, api);
window.addEventListener("beforeunload", () => {
  clearExternalPreviewOutput();
  workspaceSearchListener.dispose();
  documentLoadListener.dispose();
  externalWindowListener.dispose();
  dragDropListener.dispose();
  layoutRuntime?.dispose();
  layoutRuntime = null;
  windowChrome.dispose();
  externalWatch.dispose();
  favbar.dispose();
});

const folderActions = new FolderActions(doc, {
  sidebar,
  onOpenInNewTab: (relPath, goto) => runBackground("新規タブで開けませんでした", () => openInNewTab(relPath, goto)),
  onOpenInNewWindow: (path, goto) => launchNewWindow({ path, goto: goto ?? null }),
  onOpenAs: (relPath, openAs) => {
    runBackground("指定した形式で開けませんでした", () => navigateTreeEntry(relPath, openAs));
  },
  onAddFavorite: (path) => runBackground("お気に入りに追加できませんでした", () => favbar.addExternal(path)),
  onSetStartupPath: (path) => setSetting("startupPath", path),
  onOpenPath: (path) => {
    runBackground("開けませんでした", () => openPathInTabs(tabs, path));
  },
}, {
  api: cacheAwareDocumentApi,
  showError,
  confirmMessage,
  promptFields,
  registeredCommandPorts: {
    runExternalCommand: api.runExternalCommand,
    writeClipboardText,
  },
  getStartupPath: () => getSetting("startupPath"),
  revealInExplorer,
  openInOtherApp,
  onClipboardChange: () => sidebar.refreshFileOperationState(),
  writeClipboardText,
  onRebasePath: (rebase) => tabs?.rebasePaths(rebase),
} satisfies FolderActionsServices);

// ---- 配線 ----
function confirmReloadDiscardingEdits(): Promise<boolean> {
  return confirmMessage(
    "文字コードを指定して再読込",
    "未保存の変更を破棄して、元ファイルを再読込する",
    "再読込"
  );
}

async function pickAndOpen(directory: boolean) {
  try {
    const path = await openDialog({ directory });
    if (typeof path === "string") await tabs.navigatePath(path);
  } catch (error) {
    await reportBackgroundError("ファイルを開けませんでした", error);
  }
}

const commands = createCommandRegistry({
  newFile: () => tabs.newBlank(),
  openFile: () => { void pickAndOpen(false); },
  openFolder: () => { void pickAndOpen(true); },
  save: () => doc.save(),
  saveAs: () => doc.saveAs(),
  refresh: () => externalWatch.refresh(),
  quit: () => win.close(),
  find: () => editor.openSearch(),
  reopenClosedTab: () => tabs.reopenLastClosed(),
});

$("toggle-bars").addEventListener("click", () => {
  $("navbars").hidden = !$("navbars").hidden;
});
$("sidebar-toggle").addEventListener("click", () => {
  const currentlyShown = paneVisibilityAt(measuredMainWidth()).sidebarShown;
  // 幅不足による自動退避中は、利用者の開いた状態を保持する。
  if (currentlyShown || sidebarCollapsed) sidebarCollapsed = !sidebarCollapsed;
  updateSidebarVisibility();
});
function closePreview(returnFocusToOpenButton = false) {
  const layoutWidth = measuredMainWidth();
  if (!Number.isFinite(layoutWidth) || layoutWidth <= 0 || !paneVisibilityAt(layoutWidth).previewShown) return;
  ++gitSelectionGeneration;
  if (previewDocument?.externalAdapter && (previewReplacementLifecycle.isReplacing() || externalPreviewRefreshPending)) {
    clearPreview(doc.current);
    runBackground("プレビューの表示待ちを取り消せませんでした", () => editor.cancelPendingTextViewerOpens());
  }
  if (gitPreviewTarget && previewReplacementLifecycle.isReplacing()) clearPreview(doc.current);
  previewCollapsed = true;
  if (gitPreviewTarget) {
    gitPreviewTarget.collapsed = true;
    invalidatePreviewRequest(false);
    runBackground("プレビューの表示待ちを取り消せませんでした", () => editor.cancelPendingTextViewerOpens());
  }
  previewFullscreen = false;
  previewFullscreenTabId = null;
  updatePreviewVisibility();
  if (returnFocusToOpenButton) {
    previewOpenButtons.find((button) => button.dataset.previewPlacement === previewPlacement)?.focus();
  }
}

function selectPreviewPlacement(placement?: PreviewPlacement) {
  previewPlacement = placement ?? resolvePreviewPlacement(getSetting("previewOpenPlacement"), getSetting("previewLastPlacement"));
  if (getSetting("previewLastPlacement") !== previewPlacement) setSetting("previewLastPlacement", previewPlacement);
}

function openPreview(placement?: PreviewPlacement) {
  if (paneVisibilityAt(measuredMainWidth()).previewShown) {
    if (!placement || placement === previewPlacement) return;
    selectPreviewPlacement(placement);
    updatePreviewVisibility();
    return;
  }
  if (gitPreviewTarget && (!previewAvailable || previewDocument?.format !== "git")) {
    gitPreviewTarget.collapsed = false;
    openPreviewFormat(doc.current, gitPreviewTarget.path, "git", null, { placement });
    return;
  }
  if (!previewAvailable) {
    const session = doc.current;
    const path = documentPathOf(session);
    const classificationPath = classificationPathOf(session);
    const standardFormat = viewerFormatForAutomaticPreview(classificationPath);
    const adapter = externalPreviewAdapterForPath(
      classificationPath,
      getSetting("externalPreviewAdapters"),
      getSetting("externalPreviewAdapterSelections"),
    );
    const selection = previewSelectionForAdapter(adapter, standardFormat !== null);
    if (adapter && selection === "external" && externalPreviewInputPath(session)) {
      openPreviewFormat(
        session,
        path,
        adapter.outputFormat === "svg" ? "image" : "html",
        null,
        { sqliteMismatch: "clear", externalAdapter: adapter, placement },
      );
      return;
    }
    const format = viewerFormatForPreviewToggle(classificationPath);
    if (format) openPreviewFormat(session, path, format, null, { placement });
    return;
  }
  selectPreviewPlacement(placement);
  previewCollapsed = false;
  if (gitPreviewTarget) gitPreviewTarget.collapsed = false;
  updatePreviewVisibility();
  if (shouldResendPreviewOnRestore(previewDocument?.format ?? null)) inlinePreview.resend();
}

for (const button of previewOpenButtons) {
  button.addEventListener("click", () => openPreview(button.dataset.previewPlacement as PreviewPlacement));
}

// プレビュー切替は本文上へ常駐させず、エディタと縦スクロールバーの境界へ
// ポインターを近づけたときだけ見せる。キーボード操作中はfocus-visibleで表示する。
let previewToggleHovered = false;
let previewTogglePeekTimer: number | undefined;
function showPreviewTogglePeek() {
  window.clearTimeout(previewTogglePeekTimer);
  previewTogglePeekTimer = undefined;
  mainEl.classList.add("preview-toggle-peek");
}
function hidePreviewTogglePeekLater() {
  window.clearTimeout(previewTogglePeekTimer);
  previewTogglePeekTimer = window.setTimeout(() => {
    previewTogglePeekTimer = undefined;
    if (!previewToggleHovered && !previewOpenButtons.includes(document.activeElement as HTMLButtonElement)) {
      mainEl.classList.remove("preview-toggle-peek");
    }
  }, 450);
}
function pointerNearPreviewBoundary(clientX: number): boolean {
  const boundary = editorHost.getBoundingClientRect().right;
  return isPreviewTogglePeekPoint(
    clientX,
    boundary,
    previewToggle.offsetWidth || PREVIEW_TOGGLE_DEFAULT_WIDTH,
  );
}
mainEl.addEventListener("pointermove", (event) => {
  if (pointerNearPreviewBoundary(event.clientX)) showPreviewTogglePeek();
  else if (!previewToggleHovered) hidePreviewTogglePeekLater();
});

mainEl.addEventListener("pointerleave", hidePreviewTogglePeekLater);
for (const button of previewOpenButtons) {
  button.addEventListener("pointerenter", () => {
    previewToggleHovered = true;
    showPreviewTogglePeek();
  });
  button.addEventListener("pointerleave", () => {
    previewToggleHovered = false;
    hidePreviewTogglePeekLater();
  });
  button.addEventListener("focus", showPreviewTogglePeek);
  button.addEventListener("blur", hidePreviewTogglePeekLater);
}
document.addEventListener("contextmenu", (e) => e.preventDefault());

// サイドバー幅のドラッグ変更
splitter.addEventListener("mousedown", (e) => {
  e.preventDefault();
  const move = (ev: MouseEvent) => {
    setSidebarWidth(ev.clientX);
    updateSidebarVisibility();
  };
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    const width = Number.parseFloat(sidebarEl.style.width);
    if (Number.isFinite(width)) setSetting("sidebarWidth", clampSidebarWidth(width));
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
});

// プレビューの分割軸に沿ってドラッグし、右幅と上下共通の高さを別々に保存する。
bindPreviewResize(previewSplitter, {
  placement: () => previewPlacement,
  bounds: () => {
    const main = mainEl.getBoundingClientRect();
    return { left: editorHost.getBoundingClientRect().left, right: main.right, top: main.top, bottom: main.bottom };
  },
  setSize: (size) => {
    const main = mainEl.getBoundingClientRect();
    const total = previewPlacement === "right" ? main.right - editorHost.getBoundingClientRect().left : main.height;
    const ratio = size / (total - PANE_SPLITTER_WIDTH);
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) return;
    if (previewPlacement === "right") previewRightRatio = ratio;
    else previewVerticalRatio = ratio;
    updatePreviewVisibility();
  },
  onStart: () => {
    document.body.classList.add("preview-resizing");
    document.body.classList.toggle("preview-resizing-vertical", previewPlacement !== "right");
  },
  onStop: () => {
    document.body.classList.remove("preview-resizing", "preview-resizing-vertical");
    setSetting("previewRightRatio", previewRightRatio);
    setSetting("previewVerticalRatio", previewVerticalRatio);
  },
});

// グローバルショートカット（検索はフォーカス領域へ振り分ける）
window.addEventListener("keydown", (e) => {
  const command = globalCommandForEvent(commands, e);
  if (!command) return;
  e.preventDefault();
  runBackground(`${command.label}を実行できませんでした`, () => {
    if (command === commands.find) {
      runFindForTarget(e.target, {
        openEditorSearch: () => editor.openSearch(),
        focusWorkspaceSearch: () => sidebar.focusWorkspaceSearch(),
      });
      return;
    }
    return command.run();
  });
});

// お気に入りバー上へのdropは登録、それ以外は従来どおり開く
void getCurrentWebview().onDragDropEvent((ev) => {
  if (ev.payload.type !== "drop" || ev.payload.paths.length === 0) return;
  const scale = window.devicePixelRatio || 1;
  const cssX = ev.payload.position.x / scale;
  const cssY = ev.payload.position.y / scale;
  if (document.elementFromPoint(cssX, cssY)?.closest("#favbar")) {
    void favbar.addDropped(ev.payload.paths, cssX, cssY)
      .catch((error) => reportBackgroundError("お気に入りへ追加できませんでした", error));
  } else {
    void tabs.open(ev.payload.paths[0])
      .catch((error) => reportBackgroundError("ドロップしたファイルを開けませんでした", error));
  }
}).then((unlisten) => dragDropListener.set(unlisten))
  .catch((error) => reportBackgroundError("ファイルのドロップを受信できませんでした", error));

// フォルダビューは他アプリによる増減を拾うため定期的に取り直す
let folderRefreshRunning = false;
let folderRefreshErrorReported = false;
window.setInterval(async () => {
  fileStatusbar.refreshModifiedAt();
  if (!doc.current.folderRoot || folderRefreshRunning) return;
  folderRefreshRunning = true;
  try {
    await sidebar.refreshFolderEntries();
    folderRefreshErrorReported = false;
  } catch (error) {
    // 一時的に列挙できなくても、次の周期で再試行する。
    if (!folderRefreshErrorReported) {
      folderRefreshErrorReported = true;
      await reportBackgroundError("フォルダ一覧を更新できませんでした", error);
    }
  } finally {
    folderRefreshRunning = false;
  }
}, 3000);

// ---- 起動 ----
try {
  layoutRuntime?.coordinator.refresh();
  await windowChrome.syncWindowState();
} catch (error) {
  await reportBackgroundError("ウィンドウ状態を取得できませんでした", error);
}
// 以降はファイルエラーなどでユーザー操作待ちになるため、先に操作可能な画面を出す。
try {
  await win.show();
  layoutRuntime?.coordinator.request();
} catch (error) {
  await reportBackgroundError("ウィンドウを表示できませんでした", error);
}
try {
  await favbar.init();
} catch (error) {
  await reportBackgroundError("お気に入りを読み込めませんでした", error);
}
const startupPath = getSetting("startupPath");
tabs = new TabManager($("tabs"), doc, {
  onChange: (state) => {
    if (!secondaryInstance) setSetting("openTabs", state);
  },
  workspace: {
    capture: () => ({ ...sidebar.captureViewState(), fileTreeWidth: readSidebarWidth(), gitPreview: gitPreviewTarget ? { ...gitPreviewTarget } : null }),
    reset: () => { ++gitSelectionGeneration; gitPreviewTarget = null; sidebar.resetViewState(); },
    restore: async (state) => {
      const owner = tabs.state.activeId;
      setSidebarWidth(state?.fileTreeWidth ?? getSetting("sidebarWidth"));
      updateSidebarVisibility();
      await sidebar.restoreViewState(state);
      if (tabs.state.activeId !== owner) return;
      if (state?.gitPreview) {
        gitPreviewTarget = { ...state.gitPreview, token: window.crypto.randomUUID(), documentPath: documentPathOf(doc.current) };
        openPreviewFormat(doc.current, gitPreviewTarget.path, "git");
      }
    },
  },
  findHighlight: {
    capture: () => editor.captureFindHighlightQuery(),
    restore: (query) => editor.restoreFindHighlightQuery(query),
  },
  onError: (error, message = "タブを操作できませんでした") => reportBackgroundError(message, error),
  onDetach: (request) => launchNewWindow(request),
  onOpenInNewWindow: (request) => launchNewWindow(request),
  defaultMemoDirectory: desktopDir,
  revealInExplorer,
}, {
  ...registeredCommandPorts,
});
const storedTabs = secondaryInstance ? { tabs: [], activeId: null } : getSetting("openTabs");
try {
  await tabs.init(
    storedTabs,
    windowRequest.path,
    secondaryInstance ? null : startupPath,
    windowRequest.goto ?? undefined,
    windowRequest.selectedRelPath ?? undefined,
    windowRequest.viewState ?? undefined,
  );
} catch (error) {
  await reportBackgroundError("タブを復元できませんでした", error);
  try {
    await tabs.init({ tabs: [], activeId: null }, null, null);
  } catch (fallbackError) {
    await reportBackgroundError("空の文書を開始できませんでした", fallbackError);
  }
}

async function refreshExternalPreview() {
  if (previewReplacementLifecycle.isReplacing() || externalPreviewRefreshPending) return;
  const opened = previewDocument;
  const adapter = opened?.externalAdapter;
  if (!opened || !adapter
    || !isCurrentPreviewDocument(opened, tabs.state.activeId, documentPathOf(doc.current))) return;

  const refreshGeneration = previewRequestGeneration;
  externalPreviewRefreshPending = true;
  try {
    if (doc.current.dirty) {
      const save = await confirmMessage(
        "外部プレビューを更新",
        "未保存の編集を保存してからプレビューを更新しますか？",
        "保存して更新",
      );
      if (!save || previewDocument !== opened || refreshGeneration !== previewRequestGeneration) return;
      if (!await doc.save() || doc.current.dirty) return;
    }

    if (refreshGeneration !== previewRequestGeneration || previewDocument !== opened
      || !isCurrentPreviewDocument(opened, tabs.state.activeId, documentPathOf(doc.current))) return;
    openPreviewFormat(doc.current, documentPathOf(doc.current), opened.format, null, {
      keepPreviewRange: true,
      errorTitle: "外部プレビューを更新できませんでした",
      externalAdapter: adapter,
    });
  } finally {
    externalPreviewRefreshPending = false;
  }
}

try {
  const unlisten = await api.onExternalWindowRequest(drainExternalWindowRequests);
  externalWindowListener.set(unlisten);
  drainExternalWindowRequests();
} catch (error) {
  await reportBackgroundError("外部からの起動要求を受信できませんでした", error);
}
doc.updateTitle();

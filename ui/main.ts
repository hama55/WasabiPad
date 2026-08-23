// アプリの組み立て場所。ここでは部品の生成と配線だけを行い、
// 文書の状態は DocumentController、画面の状態は各部品が持つ。
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { desktopDir } from "@tauri-apps/api/path";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { writeText as writeClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import * as api from "./api";
import { applyDocumentLoadProgress } from "./document-load-progress";
import { VirtualEditor } from "./editor";
import { Sidebar } from "./sidebar";
import { FavBar } from "./favbar";
import { AddressBar } from "./addressbar";
import { StatusBar } from "./statusbar";
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
import { confirmMessage, confirmSaveDiscard, promptFields } from "./prompt";
import { promptSaveFormat, saveFormatFields, saveFormatFromValues } from "./save-format";
import { isPasswordCancelled, withArchivePassword } from "./archive-password";
import { archiveRelOf } from "./archive-path";
import { joinWindowsRoot } from "./path";
import { createCommandRegistry, globalCommandForEvent } from "./commands";
import { TabManager } from "./tabs";
import {
  getSetting,
  flushSettings,
  initSettings,
  loadSearchOptions,
  resetUserSettings,
  saveSearchOptions,
  setSetting,
} from "./settings";
import { normalizeTheme, THEME_STORAGE_KEY } from "./theme";
import { openSettingsMenu, openSettingsModal, type SettingsCloseHandle, type SettingsPanelPorts } from "./settings-panel";
import { searchResultGoto } from "./search-results";
import { runAsyncBoundary, reportUnhandledRejection } from "./async-boundary";
import { openPath as openPathInTabs } from "./path-opener";
import { InlinePreview } from "./inline-preview";
import {
  isAssetViewerFormat,
  sourcePathForViewer,
  viewerFormatForPath,
  viewerFormatForPreviewToggle,
} from "./viewer-formats";
import { documentPathOf, type DocumentSession } from "./session";
import {
  effectivePreviewFormat,
  isCurrentPreviewDocument,
  isPreviewFullscreen,
  isPreviewShown,
  isPreviewSplitterShown,
  PREVIEW_MIN_WIDTH,
  shouldKeepPreviewFullscreen,
  type PreviewDocument,
} from "./preview-layout";
import { bindPreviewResize } from "./preview-resize";
import { paneToggleView, previewToggleLeft, sidebarToggleLeft } from "./pane-toggle";
import { reportErrorSafely } from "./report-error";
import { processExternalWindowRequests } from "./external-window-request";
import { canCloseWindow } from "./close-request";
import { createAsyncUnlisten } from "./async-unlisten";
import { markdownLinkActionOf } from "./markdown-link-navigation";

const win = getCurrentWindow();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
window.addEventListener("error", () => runBackground("画面を再表示できませんでした", () => win.show()), { once: true });
window.addEventListener("unhandledrejection", (event) => {
  reportUnhandledRejection(event, (error) => reportBackgroundError("予期しない非同期エラーが発生しました", error));
});

// 以降のモジュール初期化は設定値を同期的に読むため、ここで一度だけ待つ
await initSettings((error) => reportBackgroundError("設定を読み込めませんでした", error));
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
const loading = $("loading");
const loadingMessage = $("loading-message");
mainEl.style.setProperty("--preview-min-width", `${PREVIEW_MIN_WIDTH}px`);

let sidebarAvailable = false;
let sidebarCollapsed = false;
let previewAvailable = false;
let previewCollapsed = false;
let previewFullscreen = false;
let previewFullscreenTabId: string | null = null;
let currentLine = 1;
let tabs: TabManager;
let sidebar: Sidebar;
let settingsMenu: SettingsCloseHandle | null = null;
let settingsPorts: SettingsPanelPorts;
let restoringEditorFont = true;
let imageCleanupTimer: number | undefined;
let externalRequestChain = Promise.resolve();
const workspaceSearchListener = createAsyncUnlisten();
const documentLoadListener = createAsyncUnlisten();
const externalWindowListener = createAsyncUnlisten();
const dragDropListener = createAsyncUnlisten();

function setLoading(active: boolean, message = "読み込み中…") {
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

function runBackground(title: string, operation: () => void | Promise<unknown>) {
  runAsyncBoundary(() => Promise.resolve().then(operation), (error) => reportBackgroundError(title, error));
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
  statusbar.setMode(label);
}

function updateSidebarVisibility() {
  const shown = sidebarAvailable && !sidebarCollapsed;
  sidebarEl.hidden = !shown;
  splitter.hidden = !shown;
  const toggle = $<HTMLButtonElement>("sidebar-toggle");
  const view = paneToggleView("sidebar", shown);
  toggle.hidden = !sidebarAvailable;
  toggle.textContent = view.icon;
  toggle.title = view.title;
  toggle.setAttribute("aria-label", toggle.title);
  toggle.style.left = `${sidebarToggleLeft(shown, sidebarEl.getBoundingClientRect().width)}px`;
}

function updatePreviewVisibility() {
  const state = { available: previewAvailable, collapsed: previewCollapsed, fullscreen: previewFullscreen };
  const shown = isPreviewShown(state);
  const fullscreen = isPreviewFullscreen(state);
  previewEl.hidden = !shown;
  previewSplitter.hidden = !isPreviewSplitterShown(state);
  mainEl.classList.toggle("preview-fullscreen", fullscreen);
  inlinePreview.setFullscreen(fullscreen);
  const view = paneToggleView("preview", shown);
  previewToggle.hidden = false;
  previewToggle.textContent = view.icon;
  previewToggle.title = view.title;
  previewToggle.setAttribute("aria-label", previewToggle.title);
  const mainRect = mainEl.getBoundingClientRect();
  previewToggle.style.left = `${previewToggleLeft(
    shown,
    mainRect.left,
    previewEl.getBoundingClientRect().left,
    mainEl.clientWidth,
    previewToggle.offsetWidth,
  )}px`;
}

const inlinePreview = new InlinePreview(previewEl, {
  onAvailabilityChange: (available) => {
    previewAvailable = available;
    if (!available) {
      previewDocument = null;
      statusbar.setPreviewFormat(null);
    }
    if (available) previewCollapsed = false;
    updatePreviewVisibility();
  },
  onFormatChange: (format) => runBackground("ビューを切り替えられませんでした", () => editor.openTextViewer(format, true)),
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
});

let previewDocument: PreviewDocument | null = null;
function runPreviewBackground(
  document: PreviewDocument,
  title: string,
  operation: () => void | Promise<unknown>,
) {
  previewDocument = document;
  runBackground(title, async () => {
    try {
      await operation();
    } catch (error) {
      if (previewDocument === document) previewDocument = null;
      throw error;
    }
  });
}

function openPreviewFormat(
  session: Readonly<DocumentSession>,
  path: string,
  format: api.ViewerFormat,
  fragment: string | null = null,
) {
  const sourcePath = sourcePathForViewer(format, session.savePath, session.displayPath);
  inlinePreview.setSourcePath(sourcePath, session.archivePath, session.archiveEntry);
  statusbar.setPreviewFormat(format);
  runPreviewBackground(
    { ownerTabId: tabs?.state.activeId ?? null, path, format },
    "ビューを表示できませんでした",
    async () => {
      await editor.openTextViewer(format);
      if (fragment !== null && format === "markdown") inlinePreview.setMarkdownFragment(fragment);
    },
  );
}

function syncPreviewDocument(session: Readonly<DocumentSession>, force = false, fragment: string | null = null) {
  const path = documentPathOf(session);
  const activeTabId = tabs?.state.activeId ?? null;
  const format = effectivePreviewFormat(path, viewerFormatForPath(path), activeTabId, previewDocument);
  if (previewFullscreen && !shouldKeepPreviewFullscreen(
    previewFullscreenTabId,
    tabs?.state.activeId ?? null,
    format !== null,
  )) {
    previewFullscreen = false;
    previewFullscreenTabId = null;
  }
  const isAssetPreview = isAssetViewerFormat(format);
  if (!force && isCurrentPreviewDocument(previewDocument, activeTabId, path) && !isAssetPreview) return;
  if (!format) {
    inlinePreview.setSourcePath(null, session.archivePath, session.archiveEntry);
    previewDocument = null;
    statusbar.setPreviewFormat(null);
    inlinePreview.clear();
    return;
  }
  openPreviewFormat(session, path, format, fragment);
}

// ---- 部品 ----
const statusbar = new StatusBar($("statusbar"), {
  onGoTo: (line) => editor.goTo(line, 0),
  onFontFamily: (family) => editor.setFont(family, getSetting("fontSize"), "family"),
  onFontSize: (size) => editor.setFont(getSetting("fontFamily"), size, "size"),
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
});
statusbar.restoreTheme(localStorage.getItem(THEME_STORAGE_KEY));
window.addEventListener("storage", (event) => {
  if (event.key === THEME_STORAGE_KEY) statusbar.restoreTheme(event.newValue);
});

const addressbar = new AddressBar($("topbar"), {
  onOpen: (path, newTab) => runBackground("開けませんでした", () => openPathInTabs(tabs, path, newTab)),
  onSave: () => runBackground("保存できませんでした", () => doc.save()),
  onSaveAs: () => runBackground("名前を付けて保存できませんでした", () => doc.saveAs()),
  onNew: () => runBackground("新規ウィンドウを開けませんでした", launchNewWindow),
  onFind: () => editor.openSearch(),
  onPick: () => runBackground("ファイルを開けませんでした", () => pickAndOpen(false)),
  onFavorite: () => runBackground("お気に入りに追加できませんでした", () => favbar.addCurrent()),
  onSettings: () => openSettings(),
});

const registeredCommandPorts = {
  promptFields,
  runExternalCommand: api.runExternalCommand,
  writeClipboardText,
};

// 部品どうしが相互に参照するため、型注釈で推論の循環を切る
const editor: VirtualEditor = new VirtualEditor(editorHost, {
  onDocChange: (lineCount, edits) => {
    doc.onEdit(lineCount);
    statusbar.setLineCount(lineCount);
    sidebar?.refreshWorkspaceSearch(doc.current.selectedRelPath, edits ?? []);
    scheduleImageCleanup();
  },
  onCursor: (line, col) => {
    currentLine = line;
    statusbar.setCursor(line, col);
    tabs?.syncCursor(line - 1);
  },
  onFontChange: (family, size, changed) => {
    statusbar.setFont(family, size);
    if (changed !== "size") inlinePreview.setFontFamily(family);
    if (!restoringEditorFont) {
      if (changed !== "size") setSetting("fontFamily", family);
      if (changed !== "family") setSetting("fontSize", size);
    }
  },
  registeredCommandPorts,
  openExternally: (path) => openInOtherApp(path),
  openInNewWindow: (path) => runBackground("新規ウィンドウで開けませんでした", () => launchNewWindow({ path })),
  revealInExplorer: (path, isDir) => revealInExplorer(path, isDir),
  onError: (message, error) => showError(message, error),
  openViewer: async (format, text, selection) => {
    const path = documentPathOf(doc.current);
    statusbar.setPreviewFormat(format);
    const label = await inlinePreview.open(format, text, selection);
    if (isCurrentPreviewDocument(previewDocument, tabs?.state.activeId ?? null, path)) {
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
});
function applySettingsToUi() {
  restoringEditorFont = true;
  editor.setFont(getSetting("fontFamily"), getSetting("fontSize"));
  restoringEditorFont = false;
  editor.setTabSize(statusbar.setIndent(getSetting("indentSize")));
  inlinePreview.setFontFamily(getSetting("fontFamily"));
  inlinePreview.setFontSize(getSetting("previewFontSize"));
  sidebar?.setSearchOptions(loadSearchOptions());
}

applySettingsToUi();

settingsPorts = {
  getTheme: () => normalizeTheme(document.documentElement.getAttribute("data-theme")),
  setTheme: (theme) => statusbar.restoreTheme(theme),
  getSetting,
  setSetting,
  applyFontFamily: (family) => editor.setFont(family, getSetting("fontSize"), "family"),
  applyFontSize: (size) => editor.setFont(getSetting("fontFamily"), size, "size"),
  applyIndent: (size) => {
    editor.setTabSize(size);
    statusbar.setIndent(size);
  },
  applyPreviewFontSize: (size) => inlinePreview.setFontSize(size),
  getSearchOptions: loadSearchOptions,
  updateSearchOptions: (options) => {
    saveSearchOptions(options);
    sidebar?.setSearchOptions(options);
  },
  confirmReset: () => confirmMessage(
    "設定を初期化",
    "アプリ設定を初期値へ戻します。再開タブは保持されます。",
    "初期化",
  ),
  resetSettings: () => {
    resetUserSettings();
    statusbar.restoreTheme("dark");
    applySettingsToUi();
  },
};

function openSettings() {
  if (settingsMenu) {
    settingsMenu.close();
    settingsMenu = null;
    return;
  }
  settingsMenu = openSettingsMenu($("addressbar-settings"), settingsPorts, () => {
    settingsMenu?.close();
    settingsMenu = null;
    openSettingsModal(settingsPorts);
  }, () => {
    settingsMenu = null;
  });
}

sidebar = new Sidebar(sidebarEl, {
  onSelect: async (relPath, newTab) => {
    if (newTab) return openInNewTab(relPath);
    return tabs.navigateEntry(relPath);
  },
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
  onCreateNote: () => folderActions.createNote(null),
  onTreeError: async (error) => {
    if (!isPasswordCancelled(error)) await showError("フォルダを展開できませんでした", error);
  },
  onSearch: (pat, options, searchId) => api.workspaceSearch(pat, options, searchId),
  onCancel: (searchId) => api.workspaceSearchCancel(searchId),
  onCancelError: (error) => showError("検索を中止できませんでした", error),
  onError: (error) => showError("フォルダを検索できませんでした", error),
  onOptionsChange: saveSearchOptions,
  onOpen: async (result, newTab, query) => {
    if (newTab) {
      if (!(await openInNewTab(result.rel_path, searchResultGoto(result)))) return false;
    } else if (!(await tabs.navigateEntry(result.rel_path))) {
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
    if (!(await tabs.navigateEntry(result.rel_path))) return false;
    const [, length] = result.highlights[0] ?? [0, 0];
    if (!length) return false;
    return editor.replaceRange(result.line, result.col, result.col + length, replacement);
  },
}, loadSearchOptions());

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
  return tabs.open(joinWindowsRoot(root, relPath), goto);
}

const windowChrome = new WindowChrome($("titlebar"), win, {
  onCloseRequest: () => canCloseWindow({
    saveForExit: (onProceed) => tabs.saveForExit(onProceed),
    flushSettings,
    onSettingsError: (error) => showError("設定を保存できませんでした", error),
  }),
  onGeometryChange: () => editor.syncWindowGeometry(),
  onError: showError,
}, $("save-notice"));

const doc: DocumentController = new DocumentController({
  editor,
  statusbar,
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
  api,
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
  statusbar.setByteSize(info.byte_len, info.is_huge);
  statusbar.setModifiedAt(info.modified_at);
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
  workspaceSearchListener.dispose();
  documentLoadListener.dispose();
  externalWindowListener.dispose();
  dragDropListener.dispose();
  windowChrome.dispose();
  externalWatch.dispose();
  favbar.dispose();
});

const favbar = new FavBar($("favbar"), {
  onOpen: (path, newTab) => runBackground("お気に入りを開けませんでした", () => openPathInTabs(tabs, path, newTab)),
  onOpenInNewWindow: (path) => launchNewWindow({ path }),
  onAddGroupToTabs: (items) => tabs.addLinks(items),
  revealInExplorer,
  currentFile: () => addressbar.path || null,
  onError: (error) => showError("お気に入りを移動できませんでした", error),
});

const folderActions = new FolderActions(doc, {
  sidebar,
  onOpenInNewTab: (relPath, goto) => runBackground("新規タブで開けませんでした", () => openInNewTab(relPath, goto)),
  onOpenInNewWindow: (path, goto) => launchNewWindow({ path, goto: goto ?? null }),
  onAddFavorite: (path) => runBackground("お気に入りに追加できませんでした", () => favbar.addExternal(path)),
  onSetStartupPath: (path) => setSetting("startupPath", path),
  onOpenPath: (path) => {
    runBackground("開けませんでした", () => openPathInTabs(tabs, path));
  },
}, {
  api,
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
  sidebarCollapsed = !sidebarCollapsed;
  updateSidebarVisibility();
});
previewToggle.addEventListener("click", () => {
  if (!previewAvailable) {
    const session = doc.current;
    const path = documentPathOf(session);
    const format = viewerFormatForPreviewToggle(path, session.isBinary);
    if (format) openPreviewFormat(session, path, format);
    return;
  }
  previewCollapsed = !previewCollapsed;
  if (previewCollapsed) {
    previewFullscreen = false;
    previewFullscreenTabId = null;
    previewEl.style.removeProperty("width");
  }
  updatePreviewVisibility();
  if (!previewCollapsed) inlinePreview.resend();
});
window.addEventListener("resize", updatePreviewVisibility);

document.addEventListener("contextmenu", (e) => e.preventDefault());

// サイドバー幅のドラッグ変更
splitter.addEventListener("mousedown", (e) => {
  e.preventDefault();
  const move = (ev: MouseEvent) => {
    sidebarEl.style.width = `${Math.max(120, ev.clientX)}px`;
    updateSidebarVisibility();
  };
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
});

// プレビュー幅のドラッグ変更
bindPreviewResize(previewSplitter, {
  mainLeft: () => editorHost.getBoundingClientRect().left,
  mainRight: () => mainEl.getBoundingClientRect().right,
  setWidth: (width) => {
    previewEl.style.width = `${width}px`;
    updatePreviewVisibility();
  },
  onStart: () => document.body.classList.add("preview-resizing"),
  onStop: () => document.body.classList.remove("preview-resizing"),
});

// グローバルショートカット (ファイル操作のみ。編集系はエディタが処理)
window.addEventListener("keydown", (e) => {
  const command = globalCommandForEvent(commands, e);
  if (!command) return;
  e.preventDefault();
  runBackground(`${command.label}を実行できませんでした`, () => command.run());
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
  statusbar.refreshModifiedAt();
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
  await windowChrome.syncMaxIcon();
} catch (error) {
  await reportBackgroundError("ウィンドウ状態を取得できませんでした", error);
}
// 以降はファイルエラーなどでユーザー操作待ちになるため、先に操作可能な画面を出す。
try {
  await win.show();
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
try {
  const unlisten = await api.onExternalWindowRequest(drainExternalWindowRequests);
  externalWindowListener.set(unlisten);
  drainExternalWindowRequests();
} catch (error) {
  await reportBackgroundError("外部からの起動要求を受信できませんでした", error);
}
doc.updateTitle();

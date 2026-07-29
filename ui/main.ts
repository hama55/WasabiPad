// アプリの組み立て場所。ここでは部品の生成と配線だけを行い、
// 文書の状態は DocumentController、画面の状態は各部品が持つ。
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import * as api from "./api";
import { VirtualEditor } from "./editor";
import {
  parseEditorViewState,
  serializeEditorViewState,
  type EditorViewState,
} from "./editor-view-state";
import { Sidebar } from "./sidebar";
import { FavBar } from "./favbar";
import { AddressBar } from "./addressbar";
import { StatusBar } from "./statusbar";
import { WindowChrome } from "./window-chrome";
import { ExternalWatch } from "./external-watch";
import { FolderActions, openInOtherApp } from "./folder-actions";
import { DocumentController, SAVE_EXTENSIONS } from "./document-controller";
import { showError } from "./dialogs";
import { confirmMessage } from "./prompt";
import { joinWindowsRoot } from "./path";
import { createCommandRegistry, globalCommandForEvent } from "./commands";
import { DEFAULT_EDITOR_CONFIG } from "./editor-config";
import { TabManager } from "./tabs";
import {
  getSetting,
  flushSettings,
  initSettings,
  loadSearchOptions,
  saveSearchOptions,
  setSetting,
} from "./settings";

const win = getCurrentWindow();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
window.addEventListener("error", () => { void win.show(); }, { once: true });
window.addEventListener("unhandledrejection", () => { void win.show(); }, { once: true });

// 以降のモジュール初期化は設定値を同期的に読むため、ここで一度だけ待つ
await initSettings();
const secondaryInstance = await api.isSecondaryInstance();

const editorHost = $("editorhost");
const sidebarEl = $("sidebar");
const splitter = $("splitter");
const loading = $("loading");
const loadingMessage = $("loading-message");

let sidebarAvailable = false;
let sidebarCollapsed = false;
let currentLine = 1;
let tabs: TabManager;

function setLoading(active: boolean, message = "読み込み中…") {
  loading.hidden = !active;
  loadingMessage.textContent = message;
  editorHost.setAttribute("aria-busy", String(active));
}

async function reportBackgroundError(title: string, error: unknown) {
  try {
    await showError(title, error);
  } catch (reportError) {
    console.error(`${title}のエラーを表示できませんでした`, reportError);
  }
}

async function launchNewWindow(
  path: string | null = null,
  goto?: api.Pos,
  selectedRelPath?: string,
  viewState?: EditorViewState,
): Promise<boolean> {
  try {
    await api.launchNewInstance(
      path,
      goto ?? null,
      selectedRelPath ?? null,
      viewState ? serializeEditorViewState(viewState) : null,
    );
    return true;
  } catch (error) {
    await reportBackgroundError("新規ウィンドウを開けませんでした", error);
    return false;
  }
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
  toggle.hidden = !sidebarAvailable;
  toggle.textContent = shown ? "<<" : ">>";
  toggle.title = shown ? "フォルダビューを閉じる" : "フォルダビューを開く";
  toggle.style.left = shown ? `${Math.max(4, sidebarEl.getBoundingClientRect().width - 32)}px` : "4px";
}

// ---- 部品 ----
const statusbar = new StatusBar($("statusbar"), {
  onGoTo: (line) => editor.goTo(line, 0),
  onFont: (family, size) => editor.setFont(family, size),
  onWrap: (on) => editor.setWrap(on),
  onIndent: (size) => {
    setSetting("indentSize", size);
    editor.setTabSize(size);
  },
  onReadEncoding: async (encoding) => {
    if (doc.current.dirty && !(await confirmReloadDiscardingEdits())) return false;
    return doc.reloadWithEncoding(encoding);
  },
});
statusbar.restoreTheme(localStorage.getItem("theme"));

const addressbar = new AddressBar($("topbar"), {
  onOpen: (path) => void doc.openPath(path),
  onSave: () => void doc.save(),
  onSaveAs: () => void doc.saveAs(),
  onNew: () => { void launchNewWindow(); },
  onFind: () => editor.openSearch(),
  onPick: () => void pickAndOpen(false),
  onFavorite: () => favbar.addCurrent(),
});

// 部品どうしが相互に参照するため、型注釈で推論の循環を切る
const editor: VirtualEditor = new VirtualEditor(editorHost, {
  onDocChange: (lineCount) => {
    doc.onEdit(lineCount);
    statusbar.setLineCount(lineCount);
  },
  onCursor: (line, col) => {
    currentLine = line;
    statusbar.setCursor(line, col);
  },
  onFontChange: (family, size) => statusbar.setFont(family, size),
  hasExternalFile: () => doc.current.savePath !== null,
  openExternally: () => { if (doc.current.savePath) void openInOtherApp(doc.current.savePath); },
  onError: (message, error) => showError(message, error),
  openViewer: async (format, text, selection) => {
    try {
      return await api.openViewer(format, text, selection, doc.current.savePath);
    } catch (error) {
      await showError("ビューを開けませんでした", error);
      return null;
    }
  },
  updateViewer: api.updateViewer,
});
editor.setFont(DEFAULT_EDITOR_CONFIG.fontFamily, DEFAULT_EDITOR_CONFIG.fontSize);
editor.setTabSize(statusbar.setIndent(getSetting("indentSize")));

const sidebar = new Sidebar(sidebarEl, {
  onSelect: async (relPath, newTab) => {
    if (newTab) {
      await openInNewTab(relPath);
      return;
    }
    if (!(await doc.confirmDiscard())) {
      sidebar.select(doc.current.selectedRelPath);
      return;
    }
    await doc.selectEntry(relPath);
  },
  onContextMenu: (x, y, target) => folderActions.showContextMenu(x, y, target),
  onExpandArchive: (relPath) => api.listArchiveEntries(relPath),
  onExpandFolder: (relDir) => api.listFolderEntries(relDir),
  onTreeError: (error) => showError("フォルダを展開できませんでした", error),
  onSearch: (pat, options, searchId) => api.workspaceSearch(pat, options, searchId),
  onCancel: () => api.workspaceSearchCancel(),
  onError: (error) => showError("フォルダを検索できませんでした", error),
  onOptionsChange: saveSearchOptions,
  onOpen: async (result, newTab) => {
    if (newTab) {
      // ファイル名一致の line/col は本文の位置ではない (どちらも 0) ので飛ばさない
      const goto = result.is_filename ? undefined : { line: result.line, col: result.col };
      await openInNewTab(result.rel_path, goto);
      return;
    }
    if (!(await doc.confirmDiscard())) return;
    await doc.selectEntry(result.rel_path);
    // 当たった長さは backend が返す範囲から取る。正規表現や大小の畳み込みでは
    // 入力したパターンの長さと一致しない。
    const [, length] = result.highlights[0] ?? [0, 0];
    if (result.is_filename) editor.goTo(result.line, result.col);
    else await editor.selectRange(result.line, result.col, result.col + length);
  },
}, loadSearchOptions());

// 検索の途中経過。確定を待たずに届いた分から並べる
void api.onWorkspaceSearchBatch((batch) => sidebar.acceptSearchBatch(batch.search_id, batch.results))
  .catch((error) => reportBackgroundError("検索結果の受信を開始できませんでした", error));

// フォルダビュー由来の relPath は、独立したファイルタブ用の絶対パスへ戻す
async function openInNewTab(relPath: string, goto?: api.Pos) {
  const root = doc.current.folderRoot;
  if (root) await tabs.open(joinWindowsRoot(root, relPath), goto);
}

const windowChrome = new WindowChrome($("titlebar"), win, {
  onCloseRequest: async () => {
    if (!await tabs.saveForExit()) return false;
    if (secondaryInstance) return true;
    try {
      await flushSettings();
      return true;
    } catch (error) {
      await showError("タブを保存できませんでした", error);
      return false;
    }
  },
  onGeometryChange: () => editor.syncWindowGeometry(),
  onError: showError,
});

const doc: DocumentController = new DocumentController({
  editor,
  statusbar,
  addressbar,
  sidebar,
  setSidebar,
  setLoading,
  setTitle: (title) => windowChrome.setTitle(title),
  notify: (text) => windowChrome.notify(text),
  onSessionChange: (session) => tabs?.syncActive(session),
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
});

const externalWatch = new ExternalWatch($("external-banner"), {
  canPoll: () => doc.current.savePath !== null && loading.hidden,
  isDirty: () => doc.current.dirty,
  onReload: (info) => {
    const line = currentLine;
    doc.applyDocInfo(info, true);
    editor.goTo(line - 1, 0);
  },
  onNotice: (text) => windowChrome.notify(text),
  onError: showError,
  onIgnore: () => editor.focus(),
});

const favbar = new FavBar($("favbar"), {
  onOpen: (path, newTab) => { void (newTab ? tabs.open(path) : doc.openPath(path)); },
  onAddGroupToTabs: (items) => tabs.addLinks(items),
  currentFile: () => addressbar.path || null,
  onSetDefault: (path) => setSetting("startupPath", path),
  onError: (error) => showError("お気に入りを移動できませんでした", error),
});

const folderActions = new FolderActions(doc, {
  sidebar,
  onOpenInNewTab: (relPath, goto) => { void openInNewTab(relPath, goto); },
  onOpenInNewWindow: (path, goto) => { void launchNewWindow(path, goto); },
  onAddFavorite: (path) => favbar.addExternal(path),
  onSetStartupPath: (path) => setSetting("startupPath", path),
  onOpenPath: (path) => {
    addressbar.render(path);
    void doc.openPath(path);
  },
});

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
    if (typeof path === "string") await doc.openPath(path);
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
  quit: () => { void win.close(); },
  find: () => editor.openSearch(),
});

$("toggle-bars").addEventListener("click", () => {
  $("navbars").hidden = !$("navbars").hidden;
});
$("sidebar-toggle").addEventListener("click", () => {
  sidebarCollapsed = !sidebarCollapsed;
  updateSidebarVisibility();
});

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

// グローバルショートカット (ファイル操作のみ。編集系はエディタが処理)
window.addEventListener("keydown", (e) => {
  const command = globalCommandForEvent(commands, e);
  if (!command) return;
  e.preventDefault();
  void command.run();
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
}).catch((error) => reportBackgroundError("ファイルのドロップを受信できませんでした", error));

// フォルダビューは他アプリによる増減を拾うため定期的に取り直す
let folderRefreshRunning = false;
window.setInterval(async () => {
  if (!doc.current.folderRoot || folderRefreshRunning) return;
  folderRefreshRunning = true;
  try {
    await sidebar.refreshFolderEntries();
  } catch {
    // 一時的に列挙できなくても、次の周期で再試行する。
  } finally {
    folderRefreshRunning = false;
  }
}, 3000);

// ---- 起動 ----
await windowChrome.syncMaxIcon();
// 以降はファイルエラーなどでユーザー操作待ちになるため、先に操作可能な画面を出す。
await win.show();
await favbar.init();
const cliPath = await api.initialPath();
const cliGoto = await api.initialGoto();
const cliSelectedRelPath = await api.initialSelectedRelPath();
const cliViewStateJson = await api.initialViewState();
const cliViewState = parseEditorViewState(cliViewStateJson);
const startupPath = getSetting("startupPath");
tabs = new TabManager($("tabs"), doc, {
  onChange: (state) => {
    if (!secondaryInstance) setSetting("openTabs", state);
  },
  onDetach: (path, goto, selectedRelPath, viewState) =>
    launchNewWindow(path, goto, selectedRelPath, viewState),
});
const storedTabs = secondaryInstance ? { tabs: [], activeId: null } : getSetting("openTabs");
await tabs.init(
  storedTabs,
  cliPath,
  secondaryInstance ? null : startupPath,
  cliGoto ?? undefined,
  cliSelectedRelPath ?? undefined,
  cliViewState,
);
doc.updateTitle();

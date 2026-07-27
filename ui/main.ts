// アプリの組み立て場所。ここでは部品の生成と配線だけを行い、
// 文書の状態は DocumentController、画面の状態は各部品が持つ。
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import * as api from "./api";
import { VirtualEditor } from "./editor";
import { Sidebar } from "./sidebar";
import { FavBar } from "./favbar";
import { AddressBar } from "./addressbar";
import { StatusBar } from "./statusbar";
import { WindowChrome } from "./window-chrome";
import { ExternalWatch } from "./external-watch";
import { FolderActions, openInOtherApp } from "./folder-actions";
import { DocumentController, SAVE_EXTENSIONS } from "./document-controller";
import { showMenu, MenuItem } from "./menu";
import { showError } from "./dialogs";
import { confirmMessage } from "./prompt";
import { joinWindowsRoot } from "./path";
import { createCommandRegistry, globalCommandForEvent, CommandId } from "./commands";
import { DEFAULT_EDITOR_CONFIG } from "./editor-config";
import { getSetting, initSettings, setSetting } from "./settings";

const win = getCurrentWindow();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// 以降のモジュール初期化は設定値を同期的に読むため、ここで一度だけ待つ
await initSettings();

const editorHost = $("editorhost");
const sidebarEl = $("sidebar");
const splitter = $("splitter");
const loading = $("loading");
const loadingMessage = $("loading-message");

let sidebarAvailable = false;
let sidebarVisible = true;
let currentLine = 1;

function setLoading(active: boolean, message = "読み込み中…") {
  loading.hidden = !active;
  loadingMessage.textContent = message;
  editorHost.setAttribute("aria-busy", String(active));
}

function setSidebar(on: boolean, label = "") {
  sidebarAvailable = on;
  const shown = on && sidebarVisible;
  sidebarEl.hidden = !shown;
  splitter.hidden = !shown;
  $<HTMLButtonElement>("toggle-sidebar").disabled = !on;
  statusbar.setMode(label);
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
  onNew: () => void doc.newFile(),
  onNewWindow: () => void api.launchNew(),
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
  onSelect: async (relPath, newWindow) => {
    if (newWindow) {
      await openInNewWindow(relPath);
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
  onWorkspaceSearch: (pat, options, searchId) => api.workspaceSearch(pat, options, searchId),
  onCancelSearch: () => { void api.workspaceSearchCancel(); },
  onSearchResult: async (result, newWindow) => {
    if (newWindow) {
      await openInNewWindow(result.rel_path, { line: result.line, col: result.col });
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
});

// 検索の途中経過。確定を待たずに届いた分から並べる
void api.onWorkspaceSearchBatch((batch) => sidebar.acceptSearchBatch(batch.search_id, batch.results));

// フォルダビュー由来の relPath は、別プロセスへ渡すため絶対パスへ戻す
async function openInNewWindow(relPath: string, goto?: api.Pos) {
  const root = doc.current.folderRoot;
  if (root) await api.launchNew(joinWindowsRoot(root, relPath), goto);
}

const windowChrome = new WindowChrome($("titlebar"), win, {
  onCloseRequest: () => doc.confirmDiscard(),
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
  onOpen: (path, newWindow) => { void (newWindow ? api.launchNew(path) : doc.openPath(path)); },
  currentFile: () => addressbar.path || null,
  onSetDefault: (path) => setSetting("startupPath", path),
});

const folderActions = new FolderActions(doc, {
  sidebar,
  onOpenInNewWindow: (relPath, goto) => { void openInNewWindow(relPath, goto); },
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
  const path = await openDialog({ directory });
  if (typeof path === "string") void doc.openPath(path);
}

const commands = createCommandRegistry({
  newFile: () => doc.newFile(),
  openFile: () => { void pickAndOpen(false); },
  openFolder: () => { void pickAndOpen(true); },
  save: () => doc.save(),
  saveAs: () => doc.saveAs(),
  quit: () => { void win.close(); },
  find: () => editor.openSearch(),
});

function commandMenuItem(id: CommandId, extra: Partial<MenuItem> = {}): MenuItem {
  const command = commands[id];
  return { label: command.label, key: command.shortcut, action: command.run, ...extra };
}

$("menu-file").addEventListener("click", (e) => {
  const r = (e.target as HTMLElement).getBoundingClientRect();
  showMenu(r.left, r.bottom, [
    commandMenuItem("new"),
    commandMenuItem("open"),
    commandMenuItem("openFolder"),
    commandMenuItem("save", { sep: true }),
    commandMenuItem("saveAs"),
    commandMenuItem("quit", { sep: true }),
  ]);
});
$("menu-view").addEventListener("click", (e) => {
  const r = (e.target as HTMLElement).getBoundingClientRect();
  showMenu(r.left, r.bottom, [
    commandMenuItem("find"),
    { label: "起動時のデフォルトを解除", action: () => setSetting("startupPath", null), sep: true },
  ]);
});

$("toggle-sidebar").addEventListener("click", () => {
  if (!sidebarAvailable) return;
  sidebarVisible = !sidebarVisible;
  setSidebar(sidebarAvailable, statusbar.mode);
});
$("toggle-favbar").addEventListener("click", () => {
  $("navbars").hidden = !$("navbars").hidden;
});

document.addEventListener("contextmenu", (e) => e.preventDefault());

// サイドバー幅のドラッグ変更
splitter.addEventListener("mousedown", (e) => {
  e.preventDefault();
  const move = (ev: MouseEvent) => {
    sidebarEl.style.width = `${Math.max(120, ev.clientX)}px`;
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
getCurrentWebview().onDragDropEvent((ev) => {
  if (ev.payload.type !== "drop" || ev.payload.paths.length === 0) return;
  const scale = window.devicePixelRatio || 1;
  const cssX = ev.payload.position.x / scale;
  const cssY = ev.payload.position.y / scale;
  if (document.elementFromPoint(cssX, cssY)?.closest("#favbar")) {
    void favbar.addDropped(ev.payload.paths, cssX, cssY);
  } else {
    void doc.openPath(ev.payload.paths[0]);
  }
});

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
await favbar.init();
const cliPath = await api.initialPath();
const startupPath = getSetting("startupPath");
const bootPath = cliPath || startupPath;
const opened = bootPath ? await doc.openPath(bootPath) : false;
if (opened) {
  // 検索結果を別ウィンドウで開いた場合、飛び先が起動引数に載っている
  const goto = await api.initialGoto();
  if (goto) editor.goTo(goto.line, goto.col);
} else {
  if (!cliPath && startupPath) setSetting("startupPath", null);
  editor.open(1, false);
  editor.focus();
}
doc.updateTitle();

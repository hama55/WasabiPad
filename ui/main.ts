import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog, save as saveDialog, ask } from "@tauri-apps/plugin-dialog";
import * as api from "./api";
import { VirtualEditor } from "./editor";
import { Sidebar, ContextTarget } from "./sidebar";
import { FavBar } from "./favbar";
import { showMenu, MenuItem } from "./menu";
import { promptFields } from "./prompt";
import { initialSession, sessionFromDocInfo } from "./session";
import { showError } from "./dialogs";
import {
  formatByteSize,
  formatCursor,
  formatFontFamily,
  formatLineCount,
  formatWindowTitle,
} from "./format";
import { basename, dirname, joinWindowsRoot, relativePathFromRoot } from "./path";
import { createCommandRegistry, globalCommandForEvent, CommandId } from "./commands";

const win = getCurrentWindow();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---- 配色モード ----
const THEMES = ["dark", "light"] as const;
type Theme = (typeof THEMES)[number];
const THEME_LABELS: Record<Theme, string> = { dark: "ダーク", light: "ライト" };

function applyTheme(t: Theme) {
  document.documentElement.setAttribute("data-theme", t);
  $("st-theme").textContent = THEME_LABELS[t];
  localStorage.setItem("theme", t);
}

const savedTheme = localStorage.getItem("theme");
applyTheme((THEMES as readonly string[]).includes(savedTheme ?? "") ? (savedTheme as Theme) : "dark");

$("st-theme").addEventListener("click", () => {
  const cur = (document.documentElement.getAttribute("data-theme") as Theme) ?? "dark";
  applyTheme(THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length]);
});

// ---- アプリ状態 ----
let session = initialSession();
let wrap = false;
let fontFamily = "Consolas, \"MS Gothic\", monospace";
let fontSize = 14;
let currentLine = 1;

const editorHost = $("editorhost");
const sidebarEl = $("sidebar");
const splitter = $("splitter");
const addressbar = $<HTMLInputElement>("addressbar");
const loading = $("loading");

function setLoading(active: boolean) {
  loading.hidden = !active;
  editorHost.setAttribute("aria-busy", String(active));
}

function updateFontStatus() {
  $("st-font").textContent = formatFontFamily(fontFamily);
  $("st-font-size").textContent = `${fontSize}px`;
}

function applyFont() {
  editor.setFont(fontFamily, fontSize);
}

const editor = new VirtualEditor(
  editorHost,
  (lineCount) => {
    if (!session.dirty) {
      session.dirty = true;
      updateTitle();
    }
    session.lineCount = lineCount;
    $("st-lines").textContent = formatLineCount(lineCount);
  },
  (line, col) => {
    currentLine = line;
    $("st-pos").textContent = formatCursor(line, col);
  },
  (family, size) => {
    fontFamily = family;
    fontSize = size;
    updateFontStatus();
  }
);
applyFont();
$("st-font").addEventListener("click", async () => {
  const result = await promptFields("フォント", [{ label: "フォント名", value: fontFamily }]);
  const family = result?.[0].trim();
  if (!family) return;
  fontFamily = family;
  applyFont();
});
$("st-font-size").addEventListener("click", async () => {
  const result = await promptFields("フォントサイズ", [{ label: "サイズ (8〜72px)", value: String(fontSize) }]);
  const size = Number(result?.[0]);
  if (!Number.isInteger(size) || size < 8 || size > 72) return;
  fontSize = size;
  applyFont();
});
$("st-wrap").addEventListener("click", () => {
  wrap = !wrap;
  $("st-wrap").textContent = `折り返し: ${wrap ? "オン" : "オフ"}`;
  editor.setWrap(wrap);
});
$("st-pos").addEventListener("click", async () => {
  const result = await promptFields("指定行へ移動", [
    { label: `行番号 (1〜${session.lineCount.toLocaleString("ja-JP")})`, value: String(currentLine) },
  ]);
  const line = Number(result?.[0]);
  if (Number.isInteger(line) && line >= 1 && line <= session.lineCount) editor.goTo(line - 1, 0);
});
$("st-lines").addEventListener("click", async () => {
  const ok = await ask("最後の行に移動しますか?", {
    title: "PetaPad",
    kind: "info",
    okLabel: "移動",
    cancelLabel: "キャンセル",
  });
  if (ok) editor.goTo(session.lineCount - 1, 0);
});
const sidebar = new Sidebar(
  sidebarEl,
  async (relPath, newWindow) => {
    if (newWindow) {
      if (session.folderRoot) await api.launchNew(relToAbs(relPath));
      return;
    }
    if (!(await confirmDiscard())) {
      sidebar.select(session.selectedRelPath);
      return;
    }
    session.selectedRelPath = relPath;
    const info = await api.selectEntry(relPath);
    applyDocInfo(info);
  },
  (x, y, target) => sidebarContextMenu(x, y, target),
  (relPath) => api.listArchiveEntries(relPath),
  (relDir) => api.listFolderEntries(relDir),
  (pat, matchCase) => api.workspaceSearch(pat, matchCase),
  async (result) => {
    if (!(await confirmDiscard())) return;
    session.selectedRelPath = result.rel_path;
    const info = await api.selectEntry(result.rel_path);
    applyDocInfo(info);
    editor.goTo(result.line, result.col);
  }
);
const favbar = new FavBar(
  $("favbar"),
  (p, newWindow) => newWindow ? api.launchNew(p) : openFile(p),
  () => session.displayPath || null
);

function updateTitle() {
  const t = formatWindowTitle(session);
  $("titletext").textContent = t;
  win.setTitle(t);
}

function setSidebar(on: boolean, label = "") {
  sidebarEl.hidden = !on;
  splitter.hidden = !on;
  $("st-mode").textContent = label;
}

// アーカイブ選択後/フォルダのエントリ切替後で共通の状態反映
function applyDocInfo(o: api.DocInfo) {
  session = sessionFromDocInfo(session, o);
  $<HTMLSelectElement>("st-enc").value = session.encoding;
  $<HTMLSelectElement>("st-eol").value = session.eol;
  addressbar.value = o.path;
  $("st-size").textContent = formatByteSize(o.byte_len);
  $("st-lines").textContent = formatLineCount(o.line_count);
  editor.open(o.line_count, session.readOnly);
  editor.focus();
  updateTitle();
}

// ---- ファイル操作 ----
async function openFile(path: string) {
  if (!(await confirmDiscard())) return;
  setLoading(true);
  try {
    const o = await api.openPath(path);
    session.selectedRelPath = "";
    if (o.kind === "archive") {
      setSidebar(true, "閲覧モード");
      sidebar.setWorkspaceSearch(false);
      if (o.entries) {
        sidebar.setArchiveEntries(o.entries);
      } else {
        // zip/xlsx/xls は展開前: 名前だけの1行を表示し、展開ボタンで初めて中身を取得する
        sidebar.setArchiveRoot(basename(o.path));
      }
    } else if (o.folder_entries) {
      setSidebar(true, "");
      sidebar.setWorkspaceSearch(true);
      sidebar.setEntries(o.folder_entries);
    } else {
      sidebar.setWorkspaceSearch(false);
      setSidebar(false);
    }
    applyDocInfo(o);
  } catch (e) {
    await showError("開けませんでした", e);
  } finally {
    setLoading(false);
  }
}

async function newFile() {
  if (!(await confirmDiscard())) return;
  await api.newDoc();
  session = initialSession();
  $<HTMLSelectElement>("st-enc").value = session.encoding;
  $<HTMLSelectElement>("st-eol").value = session.eol;
  addressbar.value = "";
  $("st-size").textContent = "";
  $("st-lines").textContent = "1 行";
  setSidebar(false);
  sidebar.setWorkspaceSearch(false);
  editor.open(1, false);
  editor.focus();
  updateTitle();
}

async function saveAs(): Promise<boolean> {
  const p = await saveDialog({
    filters: [{ name: "テキスト", extensions: ["txt"] }, { name: "すべて", extensions: ["*"] }],
    defaultPath: session.savePath ?? undefined,
  });
  if (!p) return false;
  session.savePath = p;
  session.displayPath = p;
  addressbar.value = p;
  return doSave();
}

async function doSave(): Promise<boolean> {
  if (session.readOnly) return false;
  if (!session.savePath) return saveAs();
  try {
    await api.saveFile(session.savePath, session.encoding, session.eol);
    session.dirty = false;
    updateTitle();
    return true;
  } catch (e) {
    await showError("保存できませんでした", e);
    return false;
  }
}

async function confirmDiscard(): Promise<boolean> {
  if (!session.dirty || session.readOnly) return true;
  return ask("変更が保存されていません。破棄しますか?", {
    title: "PetaPad",
    kind: "warning",
    okLabel: "破棄",
    cancelLabel: "キャンセル",
  });
}

async function pickAndOpen(directory: boolean) {
  const p = await openDialog({ directory });
  if (typeof p === "string") openFile(p);
}

// ---- フォルダビューの右クリックメニュー (新規メモ作成・名前を変更・エクスプローラで開く) ----
function relToAbs(relPath: string): string {
  return joinWindowsRoot(session.folderRoot!, relPath);
}

function sidebarContextMenu(x: number, y: number, target: ContextTarget | null) {
  if (!session.folderRoot) return; // アーカイブ閲覧中はファイル操作の対象がない
  const items: MenuItem[] = [];
  if (target) {
    items.push({ label: "名前を変更...", action: () => renameEntry(target.relPath) });
  }
  const createDir = target ? (target.isDir ? target.relPath : dirname(target.relPath)) : null;
  items.push({ label: "新規メモ作成...", action: () => createNote(createDir) });
  const revealPath = target ? relToAbs(target.relPath) : session.folderRoot;
  const revealIsDir = target ? target.isDir : true;
  items.push({ label: "エクスプローラで開く", action: () => revealInExplorer(revealPath, revealIsDir) });
  showMenu(x, y, items);
}

async function createNote(dir: string | null) {
  if (!(await confirmDiscard())) return;
  const result = await promptFields("新規メモ作成", [{ label: "ファイル名", value: "" }]);
  const name = result?.[0].trim();
  if (!name) return;
  try {
    const info = await api.createNote(dir, name);
    const rel = dir ? `${dir}/${name}` : name;
    session.selectedRelPath = rel;
    setSidebar(true, "");
    sidebar.setEntries(info.folder_entries ?? []);
    sidebar.selectByRelPath(rel);
    applyDocInfo(info);
  } catch (e) {
    await showError("作成できませんでした", e);
  }
}

async function renameEntry(relPath: string) {
  const cur = basename(relPath);
  const result = await promptFields("名前を変更", [{ label: "新しい名前", value: cur }]);
  const newName = result?.[0].trim();
  if (!newName || newName === cur) return;
  try {
    const info = await api.renameEntry(relPath, newName);
    sidebar.setEntries(info.folder_entries ?? []);
    if (info.path && session.folderRoot) {
      addressbar.value = info.path;
      session.displayPath = info.path;
      session.savePath = session.readOnly ? null : info.path;
      updateTitle();
      const rel = relativePathFromRoot(session.folderRoot, info.path);
      session.selectedRelPath = rel;
      sidebar.selectByRelPath(rel);
    }
  } catch (e) {
    await showError("名前を変更できませんでした", e);
  }
}

async function revealInExplorer(path: string, isDir: boolean) {
  try {
    await api.revealInExplorer(path, isDir);
  } catch (e) {
    await showError("開けませんでした", e);
  }
}

// ---- UI 配線 ----
const maxBtn = $("win-max");
async function syncMaxIcon() {
  const m = await win.isMaximized();
  maxBtn.textContent = String.fromCharCode(m ? 0xe923 : 0xe922); // Segoe MDL2: ChromeRestore / ChromeMaximize
  maxBtn.title = m ? "元に戻す" : "最大化";
}

$("win-min").addEventListener("click", () => win.minimize());
maxBtn.addEventListener("click", async () => {
  await win.toggleMaximize();
  await syncMaxIcon();
});
$("win-close").addEventListener("click", () => win.close());
$("titletext").addEventListener("dblclick", async () => {
  await win.toggleMaximize();
  await syncMaxIcon();
});
win.onResized(() => syncMaxIcon());

const commands = createCommandRegistry({
  newFile,
  openFile: () => { void pickAndOpen(false); },
  openFolder: () => { void pickAndOpen(true); },
  save: doSave,
  saveAs,
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
  ]);
});

$<HTMLSelectElement>("st-enc").addEventListener("change", (e) => {
  session.encoding = (e.target as HTMLSelectElement).value as api.Encoding;
  if (!session.readOnly) { session.dirty = true; updateTitle(); }
});
$<HTMLSelectElement>("st-eol").addEventListener("change", (e) => {
  session.eol = (e.target as HTMLSelectElement).value as api.Eol;
  if (!session.readOnly) { session.dirty = true; updateTitle(); }
});

addressbar.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && addressbar.value.trim()) openFile(addressbar.value.trim());
});
$("addressbar-fav").addEventListener("click", () => favbar.addCurrent());
$("addressbar-open").addEventListener("click", () => pickAndOpen(false));

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
  if (ev.payload.type === "drop" && ev.payload.paths.length > 0) {
    const { x, y } = ev.payload.position;
    const scale = window.devicePixelRatio || 1;
    const cssX = x / scale;
    const cssY = y / scale;
    if (document.elementFromPoint(cssX, cssY)?.closest("#favbar")) {
      void favbar.addDropped(ev.payload.paths, cssX, cssY);
    } else {
      openFile(ev.payload.paths[0]);
    }
  }
});

// 閉じる前の未保存確認
win.onCloseRequested(async (e) => {
  if (!(await confirmDiscard())) e.preventDefault();
});

// ---- 起動 ----
(async () => {
  await syncMaxIcon();
  await favbar.init();
  const p = await api.initialPath();
  if (p) await openFile(p);
  else {
    editor.open(1, false);
    editor.focus();
  }
  updateTitle();
})();

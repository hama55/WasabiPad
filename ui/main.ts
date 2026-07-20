import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog, save as saveDialog, ask } from "@tauri-apps/plugin-dialog";
import * as api from "./api";
import { VirtualEditor } from "./editor";
import { Sidebar, ContextTarget } from "./sidebar";
import { FavBar } from "./favbar";
import { showMenu, MenuItem } from "./menu";
import { promptFields } from "./prompt";

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
let filePath: string | null = null; // 保存先 (アーカイブ/フォルダ閲覧時は null)
let viewOnly = false; // アーカイブ/フォルダ = 編集不可
let dirty = false;
let enc = "utf8";
let eol = "crlf";
let wrap = false;
let folderRoot: string | null = null; // フォルダ閲覧中のルート絶対パス (アーカイブ閲覧時は null)
let fontFamily = "Consolas, \"MS Gothic\", monospace";
let fontSize = 14;
let currentLine = 1;
let currentLineCount = 1;

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
  $("st-font").textContent = fontFamily.split(",")[0].replaceAll("\"", "").trim();
  $("st-font-size").textContent = `${fontSize}px`;
}

function applyFont() {
  editor.setFont(fontFamily, fontSize);
}

const editor = new VirtualEditor(
  editorHost,
  (lineCount) => {
    if (!dirty) {
      dirty = true;
      updateTitle();
    }
    currentLineCount = lineCount;
    $("st-lines").textContent = `${lineCount.toLocaleString("ja-JP")} 行`;
  },
  (line, col) => {
    currentLine = line;
    $("st-pos").textContent = `${line}行 ${col}列`;
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
    { label: `行番号 (1〜${currentLineCount.toLocaleString("ja-JP")})`, value: String(currentLine) },
  ]);
  const line = Number(result?.[0]);
  if (Number.isInteger(line) && line >= 1 && line <= currentLineCount) editor.goTo(line - 1, 0);
});
$("st-lines").addEventListener("click", async () => {
  const ok = await ask("最後の行に移動しますか?", {
    title: "PetaPad",
    kind: "info",
    okLabel: "移動",
    cancelLabel: "キャンセル",
  });
  if (ok) editor.goTo(currentLineCount - 1, 0);
});
let sidebarSel = ""; // フォルダ選択中のキャンセル時に表示を戻すため
const sidebar = new Sidebar(
  sidebarEl,
  async (relPath, newWindow) => {
    if (newWindow) {
      if (folderRoot) await api.launchNew(relToAbs(relPath));
      return;
    }
    if (!(await confirmDiscard())) {
      sidebar.select(sidebarSel);
      return;
    }
    sidebarSel = relPath;
    const info = await api.selectEntry(relPath);
    applyDocInfo(info);
  },
  (x, y, target) => sidebarContextMenu(x, y, target),
  (relPath) => api.listArchiveEntries(relPath),
  (relDir) => api.listFolderEntries(relDir),
  (pat, matchCase) => api.workspaceSearch(pat, matchCase),
  async (result) => {
    if (!(await confirmDiscard())) return;
    sidebarSel = result.rel_path;
    const info = await api.selectEntry(result.rel_path);
    applyDocInfo(info);
    editor.goTo(result.line, result.col);
  }
);
const favbar = new FavBar(
  $("favbar"),
  (p, newWindow) => newWindow ? api.launchNew(p) : openFile(p),
  () => addressbar.value.trim() || null
);

function updateTitle() {
  const name = filePath
    ? filePath.replace(/\\/g, "/").split("/").pop()
    : viewOnly
      ? addressbar.value.replace(/\\/g, "/").split("/").pop()
      : "無題";
  const t = `${dirty ? "● " : ""}${name} — PetaPad`;
  $("titletext").textContent = t;
  win.setTitle(t);
}

function setSidebar(on: boolean, label = "") {
  sidebarEl.hidden = !on;
  splitter.hidden = !on;
  $("st-mode").textContent = label;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  for (const u of units) {
    if (v < 1024 || u === units[units.length - 1]) return `${v.toFixed(1)} ${u}`;
    v /= 1024;
  }
  return `${v.toFixed(1)} TB`;
}

// アーカイブ選択後/フォルダのエントリ切替後で共通の状態反映
function applyDocInfo(o: api.DocInfo) {
  enc = o.enc;
  eol = o.eol;
  $<HTMLSelectElement>("st-enc").value = enc;
  $<HTMLSelectElement>("st-eol").value = eol;
  addressbar.value = o.path;
  dirty = false;
  viewOnly = o.view_only;
  filePath = viewOnly ? null : o.path; // アーカイブは元ファイルを上書きで壊さないので null
  folderRoot = o.folder_root;
  $("st-size").textContent = formatSize(o.byte_len);
  $("st-lines").textContent = `${o.line_count.toLocaleString("ja-JP")} 行`;
  currentLineCount = o.line_count;
  editor.open(o.line_count, viewOnly);
  editor.focus();
  updateTitle();
}

function displayNameOf(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() || path;
}

// ---- ファイル操作 ----
async function openFile(path: string) {
  if (!(await confirmDiscard())) return;
  setLoading(true);
  try {
    const o = await api.openPath(path);
    sidebarSel = "";
    if (o.kind === "archive") {
      setSidebar(true, "閲覧モード");
      sidebar.setWorkspaceSearch(false);
      if (o.entries) {
        sidebar.setArchiveEntries(o.entries);
      } else {
        // zip/xlsx/xls は展開前: 名前だけの1行を表示し、展開ボタンで初めて中身を取得する
        sidebar.setArchiveRoot(displayNameOf(o.path));
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
    await ask(`開けませんでした:\n${e}`, { title: "PetaPad", kind: "error" });
  } finally {
    setLoading(false);
  }
}

async function newFile() {
  if (!(await confirmDiscard())) return;
  await api.newDoc();
  filePath = null;
  viewOnly = false;
  dirty = false;
  folderRoot = null;
  enc = "utf8";
  eol = "crlf";
  $<HTMLSelectElement>("st-enc").value = enc;
  $<HTMLSelectElement>("st-eol").value = eol;
  addressbar.value = "";
  $("st-size").textContent = "";
  $("st-lines").textContent = "1 行";
  currentLineCount = 1;
  setSidebar(false);
  sidebar.setWorkspaceSearch(false);
  editor.open(1, false);
  editor.focus();
  updateTitle();
}

async function saveAs(): Promise<boolean> {
  const p = await saveDialog({
    filters: [{ name: "テキスト", extensions: ["txt"] }, { name: "すべて", extensions: ["*"] }],
    defaultPath: filePath ?? undefined,
  });
  if (!p) return false;
  filePath = p;
  addressbar.value = p;
  return doSave();
}

async function doSave(): Promise<boolean> {
  if (viewOnly) return false;
  if (!filePath) return saveAs();
  try {
    await api.saveFile(filePath, enc, eol);
    dirty = false;
    updateTitle();
    return true;
  } catch (e) {
    await ask(`保存できませんでした:\n${e}`, { title: "PetaPad", kind: "error" });
    return false;
  }
}

async function confirmDiscard(): Promise<boolean> {
  if (!dirty || viewOnly) return true;
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
  return `${folderRoot}\\${relPath.replace(/\//g, "\\")}`;
}

function sidebarContextMenu(x: number, y: number, target: ContextTarget | null) {
  if (!folderRoot) return; // アーカイブ閲覧中はファイル操作の対象がない
  const items: MenuItem[] = [];
  if (target) {
    items.push({ label: "名前を変更...", action: () => renameEntry(target.relPath) });
  }
  const createDir = target ? (target.isDir ? target.relPath : dirNameOf(target.relPath)) : null;
  items.push({ label: "新規メモ作成...", action: () => createNote(createDir) });
  const revealPath = target ? relToAbs(target.relPath) : folderRoot;
  const revealIsDir = target ? target.isDir : true;
  items.push({ label: "エクスプローラで開く", action: () => revealInExplorer(revealPath, revealIsDir) });
  showMenu(x, y, items);
}

function dirNameOf(relPath: string): string | null {
  const i = relPath.lastIndexOf("/");
  return i < 0 ? null : relPath.slice(0, i);
}

async function createNote(dir: string | null) {
  if (!(await confirmDiscard())) return;
  const result = await promptFields("新規メモ作成", [{ label: "ファイル名", value: "" }]);
  const name = result?.[0].trim();
  if (!name) return;
  try {
    const info = await api.createNote(dir, name);
    const rel = dir ? `${dir}/${name}` : name;
    sidebarSel = rel;
    setSidebar(true, "");
    sidebar.setEntries(info.folder_entries ?? []);
    sidebar.selectByRelPath(rel);
    applyDocInfo(info);
  } catch (e) {
    await ask(`作成できませんでした:\n${e}`, { title: "PetaPad", kind: "error" });
  }
}

async function renameEntry(relPath: string) {
  const cur = relPath.split("/").pop() ?? relPath;
  const result = await promptFields("名前を変更", [{ label: "新しい名前", value: cur }]);
  const newName = result?.[0].trim();
  if (!newName || newName === cur) return;
  try {
    const info = await api.renameEntry(relPath, newName);
    sidebar.setEntries(info.folder_entries ?? []);
    if (info.path && folderRoot) {
      addressbar.value = info.path;
      filePath = viewOnly ? null : info.path;
      updateTitle();
      const rel = info.path.slice(folderRoot.length).replace(/^[\\/]/, "").replace(/\\/g, "/");
      sidebarSel = rel;
      sidebar.selectByRelPath(rel);
    }
  } catch (e) {
    await ask(`名前を変更できませんでした:\n${e}`, { title: "PetaPad", kind: "error" });
  }
}

async function revealInExplorer(path: string, isDir: boolean) {
  try {
    await api.revealInExplorer(path, isDir);
  } catch (e) {
    await ask(`開けませんでした:\n${e}`, { title: "PetaPad", kind: "error" });
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

$("menu-file").addEventListener("click", (e) => {
  const r = (e.target as HTMLElement).getBoundingClientRect();
  showMenu(r.left, r.bottom, [
    { label: "新規", key: "Ctrl+N", action: newFile },
    { label: "開く...", key: "Ctrl+O", action: () => pickAndOpen(false) },
    { label: "フォルダを開く...", action: () => pickAndOpen(true) },
    { label: "上書き保存", key: "Ctrl+S", action: doSave, sep: true },
    { label: "名前を付けて保存...", key: "Ctrl+Shift+S", action: saveAs },
    { label: "終了", action: () => win.close(), sep: true },
  ]);
});
$("menu-view").addEventListener("click", (e) => {
  const r = (e.target as HTMLElement).getBoundingClientRect();
  showMenu(r.left, r.bottom, [
    { label: "検索と置換", key: "Ctrl+F", action: () => editor.openSearch() },
  ]);
});

$<HTMLSelectElement>("st-enc").addEventListener("change", (e) => {
  enc = (e.target as HTMLSelectElement).value;
  if (!viewOnly) { dirty = true; updateTitle(); }
});
$<HTMLSelectElement>("st-eol").addEventListener("change", (e) => {
  eol = (e.target as HTMLSelectElement).value;
  if (!viewOnly) { dirty = true; updateTitle(); }
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
  if (!e.ctrlKey) return;
  switch (e.key.toLowerCase()) {
    case "n": e.preventDefault(); newFile(); break;
    case "o": e.preventDefault(); pickAndOpen(false); break;
    case "s":
      e.preventDefault();
      e.shiftKey ? saveAs() : doSave();
      break;
  }
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

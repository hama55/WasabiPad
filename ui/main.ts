import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import * as api from "./api";
import { VirtualEditor } from "./editor";
import { Sidebar, ContextTarget } from "./sidebar";
import { FavBar } from "./favbar";
import { showMenu, MenuItem } from "./menu";
import { confirmMessage, confirmSaveDiscard, promptFields } from "./prompt";
import { initialSession, sessionFromDocInfo } from "./session";
import { showError } from "./dialogs";
import {
  formatByteSize,
  formatCursor,
  formatFontFamily,
  formatLineCount,
  formatWindowTitle,
} from "./format";
import { basename, joinWindowsRoot, rebaseWindowsPath, relativePathFromRoot, relativePathWithinRoot } from "./path";
import { createCommandRegistry, globalCommandForEvent, CommandId } from "./commands";
import { DEFAULT_EDITOR_CONFIG } from "./editor-config";

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
let fontFamily = DEFAULT_EDITOR_CONFIG.fontFamily;
let fontSize = DEFAULT_EDITOR_CONFIG.fontSize;
let indentSize = Number(localStorage.getItem("indentSize")) || 8;
let currentLine = 1;
let sidebarAvailable = false;
let sidebarVisible = true;
let saveNoticeTimer: number | undefined;
const STARTUP_PATH_KEY = "startupPath";

const editorHost = $("editorhost");
const sidebarEl = $("sidebar");
const splitter = $("splitter");
const addressbar = $<HTMLInputElement>("addressbar");
const addressbarBreadcrumb = $("addressbar-breadcrumb");
const loading = $("loading");
const loadingMessage = $("loading-message");

function setLoading(active: boolean, message = "読み込み中…") {
  loading.hidden = !active;
  loadingMessage.textContent = message;
  editorHost.setAttribute("aria-busy", String(active));
}

function pathSegments(path: string): { label: string; path: string }[] {
  const normalized = path.replaceAll("/", "\\");
  const drive = normalized.match(/^[A-Za-z]:\\/);
  if (drive) {
    const root = drive[0];
    let current = root;
    return [{ label: root.slice(0, -1), path: root }, ...normalized.slice(root.length).split("\\").filter(Boolean).map((label) => {
      current += label;
      const segment = { label, path: current };
      current += "\\";
      return segment;
    })];
  }
  return [{ label: path, path }];
}

function renderAddressbar(path: string) {
  addressbar.value = path;
  addressbarBreadcrumb.replaceChildren(...pathSegments(path).flatMap((segment, index) => {
    const items: Node[] = [];
    if (index) {
      const separator = document.createElement("span");
      separator.className = "addressbar-sep";
      separator.textContent = ">";
      items.push(separator);
    }
    const button = document.createElement("button");
    button.className = "addressbar-crumb";
    button.textContent = segment.label;
    button.title = segment.path;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void openFile(segment.path);
    });
    items.push(button);
    return items;
  }));
  addressbar.hidden = true;
  addressbarBreadcrumb.hidden = false;
}

function editAddressbar() {
  addressbarBreadcrumb.hidden = true;
  addressbar.hidden = false;
  addressbar.focus();
  addressbar.select();
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
  {
  onDocChange: (lineCount) => {
    if (!session.dirty) {
      session.dirty = true;
      updateTitle();
    }
    session.lineCount = lineCount;
    $("st-lines").textContent = formatLineCount(lineCount);
  },
  onCursor: (line, col) => {
    currentLine = line;
    $("st-pos").textContent = formatCursor(line, col);
  },
  onFontChange: (family, size) => {
    fontFamily = family;
    fontSize = size;
    updateFontStatus();
  },
  hasExternalFile: () => session.savePath !== null,
  openExternally: () => { if (session.savePath) void openInOtherApp(session.savePath); },
  }
);
applyFont();
$("st-font").addEventListener("click", async () => {
  const fontOptions = [
    "Consolas, \"MS Gothic\", monospace",
    "Cascadia Mono, \"MS Gothic\", monospace",
    "\"MS Gothic\", monospace",
    "\"Yu Gothic UI\", sans-serif",
    "Meiryo, sans-serif",
    "\"BIZ UDPGothic\", sans-serif",
  ].map((value) => ({ label: value.replace(/,.*$/, "").replaceAll('"', ""), value }));
  if (!fontOptions.some((option) => option.value === fontFamily)) {
    fontOptions.unshift({ label: formatFontFamily(fontFamily), value: fontFamily });
  }
  const result = await promptFields("フォント", [{ label: "フォント", value: fontFamily, options: fontOptions }]);
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
const indentSelect = $<HTMLSelectElement>("st-indent");
indentSelect.value = String([2, 4, 8].includes(indentSize) ? indentSize : 8);
indentSize = Number(indentSelect.value);
editor.setTabSize(indentSize);
indentSelect.addEventListener("change", () => {
  indentSize = Number(indentSelect.value);
  localStorage.setItem("indentSize", String(indentSize));
  editor.setTabSize(indentSize);
});
$("st-pos").addEventListener("click", async () => {
  const result = await promptFields("指定行へ移動", [
    { label: `行番号 (1〜${session.lineCount.toLocaleString("ja-JP")})`, value: String(currentLine) },
  ]);
  const line = Number(result?.[0]);
  if (Number.isInteger(line) && line >= 1 && line <= session.lineCount) editor.goTo(line - 1, 0);
});
$("st-lines").addEventListener("click", async () => {
  const ok = await confirmMessage("最後の行へ移動", "最後の行に移動する", "移動");
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
  async (result, pattern) => {
    if (!(await confirmDiscard())) return;
    session.selectedRelPath = result.rel_path;
    const info = await api.selectEntry(result.rel_path);
    applyDocInfo(info);
    if (result.is_filename) editor.goTo(result.line, result.col);
    else editor.selectRange(result.line, result.col, result.col + [...pattern].length);
  }
);
let folderRefreshRunning = false;
window.setInterval(async () => {
  if (!session.folderRoot || folderRefreshRunning) return;
  folderRefreshRunning = true;
  try {
    await sidebar.refreshFolderEntries();
  } catch {
    // 一時的に列挙できなくても、次の周期で再試行する。
  } finally {
    folderRefreshRunning = false;
  }
}, 3000);

// ---- 外部変更の検知 ----
// 対象文書かどうか (小ファイル=ハンドル非保持) の判定は backend が持つ。
// 未編集なら backend が自動再読込し、dirty なら競合バナーで再読込/無視を選ばせる。
const externalBanner = $("external-banner");
let externalPollRunning = false;
window.setInterval(async () => {
  if (externalPollRunning || !externalBanner.hidden || !session.savePath || !loading.hidden) return;
  externalPollRunning = true;
  try {
    const check = await api.pollExternal(session.dirty);
    if (check.kind === "reloaded") {
      const line = currentLine;
      applyDocInfo(check.info);
      editor.goTo(line - 1, 0);
      showNotice("外部の変更を再読込しました");
    } else if (check.kind === "conflict") {
      externalBanner.hidden = false;
    }
  } catch {
    // 一時的に確認できなくても、次の周期で再試行する。
  } finally {
    externalPollRunning = false;
  }
}, 3000);
$("external-reload").addEventListener("click", async () => {
  externalBanner.hidden = true;
  const line = currentLine;
  try {
    const info = await api.reloadFromDisk();
    applyDocInfo(info);
    editor.goTo(line - 1, 0);
  } catch (e) {
    await showError("再読込できませんでした", e);
  }
});
$("external-ignore").addEventListener("click", async () => {
  externalBanner.hidden = true;
  await api.ackExternal();
  editor.focus();
});
const favbar = new FavBar(
  $("favbar"),
  (p, newWindow) => newWindow ? api.launchNew(p) : openFile(p),
  () => addressbar.value.trim() || null,
  setStartupPath
);

function updateTitle() {
  const t = formatWindowTitle(session);
  $("titletext").textContent = t;
  win.setTitle(t);
}

function setSidebar(on: boolean, label = "") {
  sidebarAvailable = on;
  const shown = on && sidebarVisible;
  sidebarEl.hidden = !shown;
  splitter.hidden = !shown;
  $<HTMLButtonElement>("toggle-sidebar").disabled = !on;
  $("st-mode").textContent = label;
}

function setStartupPath(path: string) {
  localStorage.setItem(STARTUP_PATH_KEY, path);
}

function showNotice(text: string) {
  $("save-notice").textContent = text;
  window.clearTimeout(saveNoticeTimer);
  saveNoticeTimer = window.setTimeout(() => { $("save-notice").textContent = ""; }, 2000);
}

const showSavedNotice = () => showNotice("保存しました");

// アーカイブ選択後/フォルダのエントリ切替後で共通の状態反映
function applyDocInfo(o: api.DocInfo) {
  $("external-banner").hidden = true; // 文書が切り替わったら競合バナーは無効
  session = sessionFromDocInfo(session, o);
  $<HTMLSelectElement>("st-enc").value = session.encoding;
  renderEncodingStatus();
  $<HTMLSelectElement>("st-eol").value = session.eol;
  renderAddressbar(o.path);
  $("st-size").textContent = formatByteSize(o.byte_len);
  $("st-lines").textContent = formatLineCount(o.line_count);
  editor.open(o.line_count, session.readOnly);
  editor.focus();
  updateTitle();
}

// ---- ファイル操作 ----
async function openFile(path: string): Promise<boolean> {
  if (!(await confirmDiscard())) return false;
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
    return true;
  } catch (e) {
    await showError("開けませんでした", e);
    return false;
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
  renderEncodingStatus();
  renderAddressbar("");
  $("st-size").textContent = "";
  $("st-lines").textContent = "1 行";
  setSidebar(false);
  sidebar.setWorkspaceSearch(false);
  editor.open(1, false);
  editor.focus();
  updateTitle();
}

async function saveAs(): Promise<boolean> {
  if (session.folderRoot && !session.savePath && !session.selectedRelPath) return saveFolderDraft();
  let defaultPath = session.savePath ?? undefined;
  if (!defaultPath) {
    const spec = await promptMemoSpec();
    if (!spec) return false;
    defaultPath = `${spec.stem}${spec.extension ? `.${spec.extension}` : ""}`;
  }
  const p = await saveDialog({
    filters: [
      { name: "テキスト", extensions: ["txt"] },
      { name: "Markdown", extensions: ["md"] },
      { name: "ログ", extensions: ["log"] },
      { name: "すべて", extensions: ["*"] },
    ],
    defaultPath,
  });
  if (!p) return false;
  return saveTo(p);
}

async function doSave(): Promise<boolean> {
  if (session.readOnly) return false;
  if (!session.savePath) return saveAs();
  return saveTo(session.savePath);
}

async function promptMemoSpec(): Promise<{ stem: string; extension: string } | null> {
  const result = await promptFields("新規メモ作成", [
    { label: "ファイル名", value: "memo" },
    { label: "拡張子", value: "txt", options: [
      { label: ".txt", value: "txt" },
      { label: ".md", value: "md" },
      { label: ".log", value: "log" },
      { label: "拡張子なし", value: "" },
    ] },
  ]);
  const stem = result?.[0].trim();
  return stem ? { stem, extension: result![1] } : null;
}

async function saveFolderDraft(): Promise<boolean> {
  const root = session.folderRoot;
  if (!root) return false;
  const spec = await promptMemoSpec();
  if (!spec) return false;
  try {
    const path = await api.nextMemoPath(root, spec.stem, spec.extension);
    return saveTo(path, root);
  } catch (e) {
    await showError("ファイル名を決められませんでした", e);
    return false;
  }
}

async function saveTo(path: string, folderDraftRoot: string | null = null): Promise<boolean> {
  setLoading(true, "書き込み中…");
  let outcome: api.SaveOutcome;
  try {
    outcome = await api.saveFile(path, session.encoding, session.eol);
  } catch (e) {
    setLoading(false);
    await showError("保存できませんでした", e);
    return false;
  }
  setLoading(false);
  if (outcome.kind === "conflict") {
    // 本体は上書きされていない。dirty のまま残し、バナーで再読込/無視を選ばせる
    await showError(
      "保存先が他のアプリで変更されています",
      `編集内容を退避保存しました:\n${outcome.saved_to}`
    );
    return false;
  }
  session.savePath = path;
  session.displayPath = path;
  session.sourceEncoding = session.encoding;
  session.dirty = false;
  renderAddressbar(path);
  renderEncodingStatus();
  updateTitle();
  showSavedNotice();
  if (folderDraftRoot) {
    const rel = relativePathWithinRoot(folderDraftRoot, path);
    if (rel !== null) {
      session.selectedRelPath = rel;
      try {
        sidebar.setEntries(await api.listFolderEntries(""));
        sidebar.selectByRelPath(rel);
      } catch {
        // 保存自体は成功しているため、一覧更新の失敗でdirtyへ戻さない。
      }
    }
  }
  return true;
}

async function confirmDiscard(): Promise<boolean> {
  if (!session.dirty || session.readOnly) return true;
  const choice = await confirmSaveDiscard();
  return choice === "discard" || (choice === "save" && await doSave());
}

async function pickAndOpen(directory: boolean) {
  const p = await openDialog({ directory });
  if (typeof p === "string") openFile(p);
}

// ---- フォルダビューの右クリックメニュー ----
function relToAbs(relPath: string): string {
  return joinWindowsRoot(session.folderRoot!, relPath);
}

function sidebarContextMenu(x: number, y: number, target: ContextTarget | null) {
  if (!session.folderRoot) return; // アーカイブ閲覧中はファイル操作の対象がない
  const items: MenuItem[] = [];
  if (target) {
    items.push({
      label: "アドレスバーに設定",
      action: () => {
        const path = relToAbs(target.relPath);
        renderAddressbar(path);
        void openFile(path);
      },
    });
  }
  items.push({ label: "新規メモ作成...", action: () => createNoteIn(target?.isDir ? target.relPath : null) });
  if (target) {
    items.push({ label: "名前を変更...", action: () => renameEntry(target.relPath) });
    if (!target.isDir) items.push({ label: "他のアプリで開く", action: () => openInOtherApp(relToAbs(target.relPath)) });
  }
  const revealPath = target ? relToAbs(target.relPath) : session.folderRoot;
  const revealIsDir = target ? target.isDir : true;
  items.push({ label: "お気に入りに追加", action: () => favbar.addExternal(revealPath) });
  items.push({ label: "エクスプローラで開く", action: () => revealInExplorer(revealPath, revealIsDir) });
  showMenu(x, y, items);
}

async function renameEntry(relPath: string) {
  const cur = basename(relPath);
  const result = await promptFields("名前を変更", [{ label: "新しい名前", value: cur }]);
  const newName = result?.[0].trim();
  if (!newName || newName === cur) return;
  const oldAbsolute = relToAbs(relPath);
  const newRelative = relPath.includes("/") ? `${relPath.slice(0, relPath.lastIndexOf("/") + 1)}${newName}` : newName;
  const newAbsolute = relToAbs(newRelative);
  try {
    const info = await api.renameEntry(relPath, newName);
    sidebar.setEntries(info.folder_entries ?? []);
    if (info.path && session.folderRoot) {
      renderAddressbar(info.path);
      session.displayPath = info.path;
      session.savePath = session.readOnly ? null : info.path;
      updateTitle();
      const rel = relativePathFromRoot(session.folderRoot, info.path);
      session.selectedRelPath = rel;
      sidebar.selectByRelPath(rel);
    }
    const startupPath = localStorage.getItem(STARTUP_PATH_KEY);
    const rebased = startupPath && rebaseWindowsPath(startupPath, oldAbsolute, newAbsolute);
    if (rebased) setStartupPath(rebased);
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

async function openInOtherApp(path: string) {
  try {
    await api.openInOtherApp(path);
  } catch (e) {
    await showError("他のアプリで開けませんでした", e);
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

async function createNoteIn(relDir: string | null) {
  const spec = await promptMemoSpec();
  if (!spec) return;
  const name = `${spec.stem}${spec.extension ? `.${spec.extension}` : ""}`;
  try {
    const info = await api.createNote(relDir, name);
    session.selectedRelPath = relDir ? `${relDir}/${name}` : name;
    applyDocInfo(info);
    await sidebar.refreshFolderEntries();
    sidebar.selectByRelPath(session.selectedRelPath);
  } catch (e) {
    await showError("新規メモを作成できませんでした", e);
  }
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
    { label: "起動時のデフォルトを解除", action: () => localStorage.removeItem(STARTUP_PATH_KEY), sep: true },
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
  if (e.key === "Enter" && addressbar.value.trim()) {
    void openFile(addressbar.value.trim());
  } else if (e.key === "Escape") {
    renderAddressbar(addressbar.value);
  }
});
addressbar.addEventListener("blur", () => renderAddressbar(addressbar.value));
addressbarBreadcrumb.addEventListener("click", () => editAddressbar());
$("addressbar-fav").addEventListener("click", () => favbar.addCurrent());
$("addressbar-save").addEventListener("click", () => { void doSave(); });
$("addressbar-new").addEventListener("click", () => { void newFile(); });
$("addressbar-new-window").addEventListener("click", () => { void api.launchNew(); });
$("addressbar-open").addEventListener("click", () => pickAndOpen(false));
$("toggle-sidebar").addEventListener("click", () => {
  if (!sidebarAvailable) return;
  sidebarVisible = !sidebarVisible;
  setSidebar(sidebarAvailable, $("st-mode").textContent ?? "");
});
$<HTMLSelectElement>("st-source-enc").addEventListener("change", async (e) => {
  const select = e.target as HTMLSelectElement;
  const requested = select.value as api.ReadEncoding;
  const current = session.sourceEncoding === "utf8bom" ? "utf8" : session.sourceEncoding;
  if (requested === current) return;
  if (session.dirty) {
    const confirmed = await confirmMessage(
      "文字コードを指定して再読込",
      "未保存の変更を破棄して、元ファイルを再読込する",
      "再読込"
    );
    if (!confirmed) { select.value = current; return; }
  }
  setLoading(true);
  try {
    const info = await api.reloadWithEncoding(requested);
    applyDocInfo(info);
  } catch (error) {
    select.value = current;
    await showError("再読込できませんでした", error);
  } finally {
    setLoading(false);
  }
});
$("toggle-favbar").addEventListener("click", () => {
  $("navbars").hidden = !$("navbars").hidden;
});

document.addEventListener("contextmenu", (e) => e.preventDefault());

function renderEncodingStatus() {
  const source = $<HTMLSelectElement>("st-source-enc");
  source.value = session.sourceEncoding === "utf8bom" ? "utf8" : session.sourceEncoding;
  source.disabled = session.readOnly || !session.savePath;
  source.title = session.sourceEncoding === "utf8bom" ? "読込文字コード: UTF-8 (BOMあり)" : "読込文字コード";
}

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
  const cliPath = await api.initialPath();
  const startupPath = localStorage.getItem(STARTUP_PATH_KEY);
  const p = cliPath || startupPath;
  const opened = p ? await openFile(p) : false;
  if (!opened) {
    if (!cliPath && startupPath) localStorage.removeItem(STARTUP_PATH_KEY);
    editor.open(1, false);
    editor.focus();
  }
  updateTitle();
})();

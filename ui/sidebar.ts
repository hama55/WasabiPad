import type { EditManyItem, FolderEntry, WorkspaceSearchOptions, WorkspaceSearchResult } from "./api";
import { WorkspaceSearchPanel, type WorkspaceSearchPorts } from "./workspace-search-panel";
import { archiveEntryPath } from "./archive-path";
import type { ContextTarget } from "./context-target";
import { isMiddleClick } from "./interaction-constants";
import { iconButton } from "./icon-button";
import { runAsyncBoundary } from "./async-boundary";
import { isDescendantPath } from "./path";
import type { FileTreeDropRequest, FileTreeDropResult } from "./file-tree-drop";
export type { ContextTarget } from "./context-target";
export type SidebarFileCommand = "copy" | "cut" | "paste" | "rename" | "delete" | "undo" | "redo";

// フォルダ/ZIP/Excelのエントリ名 ("sub/a.txt" 形式) からツリーを構築して表示。
// 実データは backend が保持し、選択時に relPath を親へ通知するだけ。
// 検索の窓と結果は WorkspaceSearchPanel が持ち、ここは置き場を貸すだけ。
//
// zip/xlsx/xls は "archive" 種別の葉として表示し、中身は展開ボタンを押すまで取得しない。
// 展開後に挿入される内部フォルダ行は "archiveDir"、葉は "archiveEntry"
// (相対パスは "アーカイブのrelPath::エントリ名")。
type RowKind = "dir" | "file" | "archive" | "archiveDir" | "archiveEntry";

interface Row {
  label: string;
  relPath: string; // フォルダルートからの相対パス ("sub" や "sub/a.txt")、archive内は "data.zip::Sheet1" 形式
  depth: number;
  kind: RowKind;
  expanded: boolean;
  childrenLoaded: boolean; // dir/archive の子一覧を取得済みか
}

interface PointerDrag {
  sourceRelPaths: string[];
  startX: number;
  startY: number;
  clientX: number;
  clientY: number;
  moved: boolean;
  targetRelDir: string | null;
  cleanup: () => void;
}

const DRAG_SCROLL_EDGE = 40;
const DRAG_SCROLL_STEP = 12;
const DRAG_SCROLL_INTERVAL = 16;

// 行頭の記号 [閉じているとき, 開いているとき]。種別を足したらここも足りなくなる
// (Record なので、足し忘れは型が落とす)。
const ROW_GLYPHS: Record<RowKind, [string, string]> = {
  dir: ["📁", "🗂️"],
  archive: ["›", "⌄"],
  archiveDir: ["📁", "🗂️"],
  file: ["📄", "📄"],
  archiveEntry: ["", ""],
};

// サイドバーが外界へ出す依頼。IPC も文書状態もここより先は知らない。
// 検索の依頼 (onSearch / onCancel / onOpen / onOptionsChange) は
// WorkspaceSearchPanel のもので、ここはそのまま素通しする。
export interface SidebarPorts extends Omit<WorkspaceSearchPorts, "onViewChange" | "onContextMenu"> {
  onSelect: (relPath: string, newTab: boolean) => void | Promise<boolean | void>;
  onContextMenu: (x: number, y: number, target: ContextTarget | null, selected?: ContextTarget[]) => void;
  onFileCommand?: (command: SidebarFileCommand, selected: ContextTarget[]) => void | Promise<void>;
  onRenameEntry?: (relPath: string, newName: string) => void | Promise<void>;
  isCut?: (relPath: string) => boolean;
  onExpandArchive: (relPath: string) => Promise<string[]>;
  onExpandFolder: (relDir: string) => Promise<FolderEntry[]>;
  onDropEntries: (request: FileTreeDropRequest) => Promise<FileTreeDropResult>;
  onUndoLastDrop: () => Promise<boolean>;
  onCreateFolder: (relDir: string) => void | Promise<void>;
  onCreateNote: () => void | Promise<void>;
  onTreeError: (error: unknown) => Promise<void>;
}

export class Sidebar {
  private host: HTMLElement;
  private tree: HTMLElement;
  private createActions: HTMLElement;
  private panel: WorkspaceSearchPanel;
  private rows: Row[] = [];
  private sel: string | null = null; // 選択中の relPath
  private selected = new Set<string>();
  private selectionAnchor: string | null = null;
  private selectionRequest = 0;
  private openRequest = 0;
  private keyboardFocusLock = false;
  private keyboardFocusRequests = new Set<number>();
  private onSelect: (relPath: string, newTab: boolean) => void | Promise<boolean | void>;
  private onContextMenu: (x: number, y: number, target: ContextTarget | null, selected?: ContextTarget[]) => void;
  private onFileCommand?: (command: SidebarFileCommand, selected: ContextTarget[]) => void | Promise<void>;
  private onRenameEntry?: (relPath: string, newName: string) => void | Promise<void>;
  private isCut?: (relPath: string) => boolean;
  private onExpandArchive: (relPath: string) => Promise<string[]>;
  private onExpandFolder: (relDir: string) => Promise<FolderEntry[]>;
  private onDropEntries: (request: FileTreeDropRequest) => Promise<FileTreeDropResult>;
  private onUndoLastDrop: () => Promise<boolean>;
  private onTreeError: (error: unknown) => Promise<void>;
  private dropTarget: HTMLElement | null = null;
  private pointerDrag: PointerDrag | null = null;
  private suppressRowClick = false;
  private managedDropUndo = false;
  private entryMoveInProgress = false;
  private workspaceRoot: string | null = null;
  private dragScrollTimer: number | null = null;
  private renamingRelPath: string | null = null;

  constructor(host: HTMLElement, ports: SidebarPorts, searchOptions: WorkspaceSearchOptions) {
    this.host = host;
    this.onSelect = ports.onSelect;
    this.onContextMenu = ports.onContextMenu;
    this.onFileCommand = ports.onFileCommand;
    this.onRenameEntry = ports.onRenameEntry;
    this.isCut = ports.isCut;
    this.onExpandArchive = ports.onExpandArchive;
    this.onExpandFolder = ports.onExpandFolder;
    this.onDropEntries = ports.onDropEntries;
    this.onUndoLastDrop = ports.onUndoLastDrop;
    this.onTreeError = ports.onTreeError;
    this.panel = new WorkspaceSearchPanel(searchOptions, {
      onSearch: ports.onSearch,
      onCancel: ports.onCancel,
      onCancelError: ports.onCancelError,
      onError: ports.onError,
      onOpen: ports.onOpen,
      onReplace: ports.onReplace,
      onOptionsChange: ports.onOptionsChange,
      onContextMenu: (x, y, target) => this.onContextMenu(x, y, target, [target]),
      onViewChange: () => this.render(),
    });
    this.tree = document.createElement("div");
    this.tree.className = "fv-tree";
    this.tree.tabIndex = 0;
    this.tree.addEventListener("keydown", (event) => this.onTreeKeyDown(event));
    this.host.addEventListener("mousedown", (event) => this.onBackButton(event), true);
    this.host.addEventListener("auxclick", (event) => this.onBackButton(event), true);
    document.addEventListener("pointerdown", (event) => {
      if (!this.keyboardFocusLock) return;
      const target = event.target;
      if (!(target instanceof Node) || !this.tree.contains(target)) this.keyboardFocusLock = false;
    }, true);
    const toolbar = document.createElement("div");
    toolbar.className = "fv-toolbar";
    const fold = iconButton("fv-fold", "⊟", "すべて折りたたむ");
    fold.addEventListener("click", () => runAsyncBoundary(
      () => this.collapseAll(),
      (error) => this.reportTreeError(error),
    ));
    toolbar.append(fold);
    this.createActions = document.createElement("div");
    this.createActions.className = "fv-create-actions";
    const createFolder = document.createElement("button");
    createFolder.type = "button";
    createFolder.className = "fv-create-folder";
    createFolder.textContent = "＋ フォルダ";
    createFolder.title = "新規フォルダ";
    createFolder.addEventListener("click", () => runAsyncBoundary(
      () => ports.onCreateFolder(this.selectedFolderRelDir()),
      (error) => this.reportTreeError(error),
    ));
    const createNote = document.createElement("button");
    createNote.type = "button";
    createNote.className = "fv-create-note";
    createNote.textContent = "＋ メモ";
    createNote.title = "新規メモ";
    createNote.addEventListener("click", () => runAsyncBoundary(
      ports.onCreateNote,
      (error) => this.reportTreeError(error),
    ));
    this.createActions.append(createFolder, createNote);
    this.host.append(toolbar, this.panel.bar, this.tree);
    this.host.addEventListener("contextmenu", (e) => {
      if (e.target !== this.host && e.target !== this.tree) return; // 個々の行上は行側のリスナーに任せる
      e.preventDefault();
      this.onContextMenu(e.clientX, e.clientY, null, []);
    });
  }

  setWorkspaceSearch(folderRoot: string | null) {
    this.selectionRequest++;
    this.invalidateOpenRequests();
    if (folderRoot !== this.workspaceRoot) {
      this.managedDropUndo = false;
    }
    this.workspaceRoot = folderRoot;
    this.panel.setFolderRoot(folderRoot);
  }

  refreshWorkspaceSearch(relPath: string, edits: EditManyItem[]) {
    this.panel.refreshAfterDocumentChange(relPath, edits);
  }

  setSearchOptions(options: WorkspaceSearchOptions) {
    this.panel.setSearchOptions(options);
  }

  refreshFileOperationState() {
    this.render();
  }

  clearFolderMoveUndo() {
    this.managedDropUndo = false;
  }

  acceptSearchBatch(searchId: number, results: WorkspaceSearchResult[]) {
    this.panel.acceptBatch(searchId, results);
  }

  // "sub/a.txt" 形式の名前一覧からディレクトリ見出し+葉の行を組み立てる。
  // relPrefix はアーカイブ内エントリの親パス。直接開いた書庫では空文字。
  private buildRows(names: string[], depth: number, relPrefix: string, leafKindOf: (name: string) => RowKind): Row[] {
    const rows: Row[] = [];
    const relPathOf = (name: string) => archiveEntryPath(relPrefix, name);
    let prevDirs: string[] = [];
    names.forEach((name) => {
      const parts = name.split("/");
      const dirs = parts.slice(0, -1);
      // 直前と共通の親ディレクトリはスキップし、新規分だけ見出し行を挿入
      let common = 0;
      while (common < dirs.length && common < prevDirs.length && dirs[common] === prevDirs[common]) common++;
      for (let d = common; d < dirs.length; d++) {
        rows.push({
          label: dirs[d],
          relPath: relPathOf(dirs.slice(0, d + 1).join("/")),
          depth: depth + d,
          kind: "archiveDir",
          expanded: false,
          childrenLoaded: true,
        });
      }
      rows.push({
        label: parts[parts.length - 1],
        relPath: relPathOf(name),
        depth: depth + dirs.length,
        kind: leafKindOf(name),
        expanded: false,
        childrenLoaded: false,
      });
      prevDirs = dirs;
    });
    return rows;
  }

  // フォルダの直下だけを表示する。ファイルは自動選択しない。
  setEntries(entries: FolderEntry[]) {
    this.renamingRelPath = null;
    this.selectionRequest++;
    this.invalidateOpenRequests();
    this.rows = this.folderRows(entries, 0, "");
    this.sel = null;
    this.selected.clear();
    this.selectionAnchor = null;
    this.render();
  }

  async refreshFolderEntries() {
    this.renamingRelPath = null;
    const request = ++this.selectionRequest;
    this.invalidateOpenRequests();
    const oldRows = this.rows;
    const oldByPath = new Map(oldRows.map((row) => [row.relPath, row]));
    const archiveChildren = new Map<string, Row[]>();
    for (let i = 0; i < oldRows.length; i++) {
      const row = oldRows[i];
      if (row.kind !== "archive" || !row.childrenLoaded) continue;
      const children: Row[] = [];
      for (let j = i + 1; j < oldRows.length && oldRows[j].depth > row.depth; j++) children.push(oldRows[j]);
      archiveChildren.set(row.relPath, children);
    }

    const rebuild = async (entries: FolderEntry[], depth: number, parent: string): Promise<Row[]> => {
      const rows = this.folderRows(entries, depth, parent);
      const groups = await Promise.all(rows.map(async (row) => {
        const old = oldByPath.get(row.relPath);
        if (!old || old.kind !== row.kind) return [row];
        row.expanded = old.expanded;
        row.childrenLoaded = old.childrenLoaded;
        if (row.kind === "dir" && row.childrenLoaded) {
          const children = await this.onExpandFolder(row.relPath);
          return [row, ...await rebuild(children, depth + 1, row.relPath)];
        }
        if (row.kind === "archive" && row.childrenLoaded) return [row, ...(archiveChildren.get(row.relPath) ?? [])];
        return [row];
      }));
      return groups.flat();
    };

    const rows = await rebuild(await this.onExpandFolder(""), 0, "");
    if (request !== this.selectionRequest) return;
    this.rows = rows;
    const available = new Set(this.rows.map((row) => row.relPath));
    this.selected = new Set([...this.selected].filter((path) => available.has(path)));
    if (this.sel && !available.has(this.sel)) this.sel = null;
    if (this.selectionAnchor && !available.has(this.selectionAnchor)) this.selectionAnchor = null;
    this.render();
  }

  setArchiveEntries(names: string[]) {
    this.renamingRelPath = null;
    this.selectionRequest++;
    this.invalidateOpenRequests();
    this.managedDropUndo = false;
    this.rows = this.buildRows(names, 0, "", () => "archiveEntry");
    this.sel = null;
    this.selected.clear();
    this.selectionAnchor = null;
    this.render();
  }

  private folderRows(entries: FolderEntry[], depth: number, parent: string): Row[] {
    return entries.map((entry) => ({
      label: entry.name,
      relPath: parent ? `${parent}/${entry.name}` : entry.name,
      depth,
      kind: entry.is_dir ? "dir" : entry.is_archive ? "archive" : "file",
      expanded: false,
      childrenLoaded: false,
    }));
  }

  // 直接開いた (フォルダ非経由の) zip/xlsx/xls 自身を、展開前の単一行として表示する。
  setArchiveRoot(displayName: string) {
    this.renamingRelPath = null;
    this.selectionRequest++;
    this.invalidateOpenRequests();
    this.managedDropUndo = false;
    this.rows = [{ label: displayName, relPath: "", depth: 0, kind: "archive", expanded: false, childrenLoaded: false }];
    this.sel = null;
    this.selected.clear();
    this.selectionAnchor = null;
    this.render();
  }

  select(relPath: string) {
    this.renamingRelPath = null;
    this.selectionRequest++;
    this.sel = relPath;
    this.selected = new Set([relPath]);
    this.selectionAnchor = relPath;
    this.render();
  }

  private selectedFolderRelDir(): string {
    if (!this.sel) return "";
    const selected = this.rows.find((row) => row.relPath === this.sel);
    if (selected?.kind === "dir") return selected.relPath;
    if (selected && (selected.kind === "file" || selected.kind === "archive")) return parentRelPath(selected.relPath);
    return "";
  }

  async expandAllFolder(relDir: string) {
    if (this.panel.showing) return;
    const row = relDir
      ? this.rows.find((candidate) => candidate.kind === "dir" && candidate.relPath === relDir)
      : undefined;
    if (relDir && !row) return;
    const request = ++this.selectionRequest;
    const start = row ? this.rows.indexOf(row) : 0;
    try {
      for (let i = start; i < this.rows.length; i++) {
        const current = this.rows[i];
        if (row && current !== row && current.depth <= row.depth) break;
        if (!isExpandable(current)) continue;
        if (!await this.ensureChildrenLoaded(current, request)) return;
        if (request !== this.selectionRequest) return;
        current.expanded = true;
      }
      if (request === this.selectionRequest) this.render();
    } catch (error) {
      if (request === this.selectionRequest) this.render();
      throw error;
    }
  }

  // 新規作成/リネーム後、相対パスからそのファイル行を再選択する (無ければ何もしない)。
  // タブ復帰時は深い階層がまだ展開されていないため、必要な親だけ非同期で開く。
  async selectByRelPath(relPath: string) {
    this.renamingRelPath = null;
    const request = ++this.selectionRequest;
    if (this.panel.showing) {
      this.sel = relPath;
      this.selected = new Set([relPath]);
      this.selectionAnchor = relPath;
      return;
    }
    const parts = relPath.split("/");
    for (let depth = 1; depth < parts.length; depth++) {
      if (request !== this.selectionRequest) return;
      const parent = parts.slice(0, depth).join("/");
      const row = this.rows.find((candidate) => candidate.kind === "dir" && candidate.relPath === parent);
      if (!row) return;
      if (!row.childrenLoaded) await this.expandFolderRow(row, request);
      else if (!row.expanded) {
        if (request !== this.selectionRequest) return;
        row.expanded = true;
        this.render();
      }
    }
    if (request !== this.selectionRequest) return;
    const row = this.rows.find((candidate) => candidate.kind !== "dir" && candidate.relPath === relPath);
    if (!row) return;
    this.sel = row.relPath;
    this.selected = new Set([row.relPath]);
    this.selectionAnchor = row.relPath;
    this.render();
  }

  private async expandArchiveRow(r: Row) {
    const request = this.selectionRequest;
    if (!await this.ensureChildrenLoaded(r, request)) return;
    r.expanded = !r.expanded;
    this.render();
  }

  private async expandFolderRow(r: Row, request = this.selectionRequest) {
    if (!await this.ensureChildrenLoaded(r, request)) return;
    r.expanded = !r.expanded;
    this.render();
  }

  private async ensureChildrenLoaded(r: Row, request: number): Promise<boolean> {
    if (r.childrenLoaded) return request === this.selectionRequest;
    const children = r.kind === "dir"
      ? this.folderRows(await this.onExpandFolder(r.relPath), r.depth + 1, r.relPath)
      : r.kind === "archive"
        ? this.buildRows(await this.onExpandArchive(r.relPath), r.depth + 1, r.relPath, () => "archiveEntry")
        : [];
    if (request !== this.selectionRequest) return false;
    const index = this.rows.indexOf(r);
    if (index < 0) return false;
    this.rows.splice(index + 1, 0, ...children);
    r.childrenLoaded = true;
    return true;
  }

  private collapseAll() {
    if (this.panel.showing) {
      this.panel.collapseAllGroups();
      return;
    }
    this.selectionRequest++;
    this.rows.forEach((row) => {
      if (isExpandable(row)) row.expanded = false;
    });
    this.render();
  }

  private visible(): number[] {
    const out: number[] = [];
    let hideDeeper = -1; // 折りたたみ中: この深さより深い行を隠す
    this.rows.forEach((r, i) => {
      if (hideDeeper >= 0) {
        if (r.depth > hideDeeper) return;
        hideDeeper = -1;
      }
      out.push(i);
      if (isExpandable(r) && !r.expanded) hideDeeper = r.depth;
    });
    return out;
  }

  // ツリーの置き場は1つ。検索中と検索後は結果を出し、それ以外はフォルダを出す
  private render() {
    this.createActions.hidden = this.panel.showing;
    this.tree.replaceChildren(
      this.panel.showing ? this.panel.renderTree() : this.folderTree(),
      this.createActions,
    );
  }

  private invalidateOpenRequests() {
    this.openRequest++;
  }

  private requestSelection(relPath: string, newTab: boolean) {
    try {
      return Promise.resolve(this.onSelect(relPath, newTab));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private focusTree() {
    try {
      this.tree.focus();
    } catch (error) {
      void this.reportTreeError(error);
    }
  }

  private restoreSelection(previous: string | null, current: string, request: number) {
    if (request !== this.openRequest || this.sel !== current) return;
    this.sel = previous;
    this.selected = previous ? new Set([previous]) : new Set();
    this.selectionAnchor = previous;
    try {
      this.render();
    } catch (error) {
      void this.reportTreeError(error);
    }
  }

  private openFileRow(r: Row, keepFocus = false) {
    const previous = this.sel;
    const request = ++this.openRequest;
    try {
      this.sel = r.relPath;
      this.selected = new Set([r.relPath]);
      this.selectionAnchor = r.relPath;
      this.render();
    } catch (error) {
      this.sel = previous;
      this.selected = previous ? new Set([previous]) : new Set();
      this.selectionAnchor = previous;
      void this.reportTreeError(error);
      this.focusTree();
      return;
    }
    const opening = this.requestSelection(r.relPath, false);
    if (keepFocus) {
      this.keyboardFocusRequests.add(request);
      this.keyboardFocusLock = true;
      this.focusTree();
    }
    void opening
      .then((opened) => {
        if (opened === false) this.restoreSelection(previous, r.relPath, request);
      })
      .catch((error) => {
        this.restoreSelection(previous, r.relPath, request);
        return this.reportTreeError(error);
      })
      .finally(() => {
        if (keepFocus) {
          if (this.keyboardFocusLock) this.focusTree();
          this.keyboardFocusRequests.delete(request);
          if (!this.keyboardFocusRequests.size) this.keyboardFocusLock = false;
        } else if (request === this.openRequest) {
          this.focusTree();
        }
      });
  }

  private onTreeKeyDown(event: KeyboardEvent) {
    if (isUndoShortcut(event) && (this.managedDropUndo || this.entryMoveInProgress)) {
      event.preventDefault();
      event.stopPropagation();
      void this.undoLastFolderMove();
      return;
    }
    const command = fileCommandForEvent(event);
    if (command === "rename" && this.beginRename()) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (command && this.onFileCommand) {
      event.preventDefault();
      event.stopPropagation();
      runAsyncBoundary(
        () => this.onFileCommand!(command, this.selectedTargets()),
        (error) => this.reportTreeError(error),
      );
      return;
    }
    if (isSelectAllShortcut(event)) {
      event.preventDefault();
      event.stopPropagation();
      this.selectAllVisible();
      return;
    }
    if (this.panel.showing || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    const visible = this.visible();
    if (!visible.length) return;
    event.preventDefault();
    const current = this.sel === null ? -1 : visible.findIndex((index) => this.rows[index].relPath === this.sel);
    const next = event.key === "ArrowUp"
      ? visible[Math.max(0, current < 0 ? visible.length - 1 : current - 1)]
      : visible[Math.min(visible.length - 1, current + 1)];
    const row = this.rows[next];
    if (row.relPath === this.sel) return;
    if (row.kind === "file" || row.kind === "archiveEntry") this.openFileRow(row, true);
    else {
      const previous = this.sel;
      try {
        this.sel = row.relPath;
        this.render();
      } catch (error) {
        this.sel = previous;
        void this.reportTreeError(error);
      }
    }
    this.tree.querySelector<HTMLElement>(".fv-row.sel")?.scrollIntoView?.({ block: "nearest" });
  }

  private selectAllVisible() {
    const rows = this.visible()
      .map((index) => this.rows[index])
      .filter((row) => !!row.relPath && row.kind !== "archiveEntry" && row.kind !== "archiveDir");
    this.selected = new Set(rows.map((row) => row.relPath));
    this.sel = rows.find((row) => row.relPath === this.sel)?.relPath ?? rows[0]?.relPath ?? null;
    this.selectionAnchor = this.sel;
    this.render();
  }

  private beginRename(): boolean {
    if (!this.workspaceRoot || !this.onRenameEntry || this.selected.size !== 1) return false;
    const relPath = [...this.selected][0];
    const row = this.rows.find((candidate) => candidate.relPath === relPath);
    if (!row || !row.relPath || row.kind === "archiveEntry" || row.kind === "archiveDir") return false;
    this.renamingRelPath = row.relPath;
    this.render();
    const input = this.tree.querySelector<HTMLInputElement>(".fv-rename-input");
    if (!input) return false;
    input.focus();
    const extension = row.label.lastIndexOf(".");
    const selectionEnd = extension > 0 ? extension : row.label.length;
    input.setSelectionRange(0, selectionEnd);
    return true;
  }

  private finishRename(relPath: string, value: string, cancel: boolean) {
    if (this.renamingRelPath !== relPath) return;
    const row = this.rows.find((candidate) => candidate.relPath === relPath);
    this.renamingRelPath = null;
    this.render();
    if (cancel || !row) return;
    const newName = value.trim();
    if (!newName || newName === row.label || !this.onRenameEntry) return;
    runAsyncBoundary(
      () => this.onRenameEntry!(relPath, newName),
      (error) => this.reportTreeError(error),
    );
  }

  private selectWithModifier(row: Row, range: boolean, additive: boolean) {
    if (!row.relPath) return;
    const visibleRows = this.visible()
      .map((index) => this.rows[index])
      .filter((candidate) => !!candidate.relPath);
    const rowIndex = visibleRows.findIndex((candidate) => candidate.relPath === row.relPath);
    if (rowIndex < 0) return;
    if (range && this.selectionAnchor) {
      const anchorIndex = visibleRows.findIndex((candidate) => candidate.relPath === this.selectionAnchor);
      if (anchorIndex >= 0) {
        const [start, end] = anchorIndex <= rowIndex
          ? [anchorIndex, rowIndex]
          : [rowIndex, anchorIndex];
        this.selected = new Set(visibleRows.slice(start, end + 1).map((candidate) => candidate.relPath));
      } else {
        this.selected = new Set([row.relPath]);
      }
    } else if (additive) {
      const next = new Set(this.selected);
      if (next.has(row.relPath)) next.delete(row.relPath);
      else next.add(row.relPath);
      this.selected = next;
    } else {
      this.selected = new Set([row.relPath]);
    }
    this.sel = this.selected.has(row.relPath) ? row.relPath : [...this.selected].at(-1) ?? null;
    this.selectionAnchor = row.relPath;
    this.render();
  }

  private selectedTargets(): ContextTarget[] {
    return this.rows
      .filter((row) => this.selected.has(row.relPath) && row.kind !== "archiveEntry" && row.kind !== "archiveDir")
      .map((row) => ({ relPath: row.relPath, isDir: row.kind === "dir" }));
  }

  private dragSources(row: Row): string[] {
    const candidates = this.selected.has(row.relPath)
      ? this.selectedTargets()
      : [{ relPath: row.relPath, isDir: row.kind === "dir" }];
    const result: ContextTarget[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const comparable = candidate.relPath.replace(/\\/g, "/").toLocaleLowerCase("en-US");
      if (!comparable || seen.has(comparable)) continue;
      seen.add(comparable);
      if (result.some((parent) => parent.isDir && isDescendantPath(candidate.relPath, parent.relPath))) continue;
      for (let i = result.length - 1; i >= 0; i--) {
        if (candidate.isDir && isDescendantPath(result[i].relPath, candidate.relPath)) result.splice(i, 1);
      }
      result.push(candidate);
    }
    return result.map((candidate) => candidate.relPath);
  }

  private canDrop(sourceRelPaths: string[] | null, targetRelDir: string): sourceRelPaths is string[] {
    if (!sourceRelPaths?.length) return false;
    const target = targetRelDir.replace(/\\/g, "/").replace(/\/$/, "");
    return sourceRelPaths.every((sourceRelPath) => {
      if (sourceRelPath.includes("::")) return false;
      const source = sourceRelPath.replace(/\\/g, "/").replace(/\/$/, "");
      return !target || (source !== target && !target.startsWith(`${source}/`));
    });
  }

  private setDropTarget(target: HTMLElement) {
    if (this.dropTarget === target) return;
    this.clearDropTarget();
    this.dropTarget = target;
    target.classList.add("fv-drop-target");
  }

  private clearDropTarget(target?: HTMLElement) {
    if (target && this.dropTarget !== target) return;
    this.dropTarget?.classList.remove("fv-drop-target");
    this.dropTarget = null;
  }

  private clearDragState() {
    this.pointerDrag?.cleanup();
    this.pointerDrag = null;
    this.clearDropTarget();
    this.host.classList.remove("fv-drop-root");
    this.host.classList.remove("fv-dragging");
    document.body.classList.remove("fv-dragging");
  }

  private beginPointerDrag(row: Row, event: PointerEvent) {
    if (!isMovable(row) || event.button !== 0 || event.isPrimary === false) return;
    const sourceRelPaths = this.dragSources(row);
    if (!sourceRelPaths.length) return;
    this.focusTree();
    this.clearDragState();
    const onMove = (move: PointerEvent) => this.updatePointerDrag(move);
    const onEnd = (end: PointerEvent) => {
      this.pointerDrag?.cleanup();
      this.finishPointerDrag(end);
    };
    const onCancel = () => this.clearDragState();
    const onBlur = () => this.clearDragState();
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", onBlur);
      this.stopDragAutoScroll();
    };
    this.pointerDrag = {
      sourceRelPaths,
      startX: event.clientX,
      startY: event.clientY,
      clientX: event.clientX,
      clientY: event.clientY,
      moved: false,
      targetRelDir: null,
      cleanup,
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("blur", onBlur);
  }

  private startDragAutoScroll() {
    if (this.dragScrollTimer !== null) return;
    this.dragScrollTimer = window.setInterval(
      () => this.autoScrollDuringDrag(),
      DRAG_SCROLL_INTERVAL,
    );
  }

  private stopDragAutoScroll() {
    if (this.dragScrollTimer === null) return;
    window.clearInterval(this.dragScrollTimer);
    this.dragScrollTimer = null;
  }

  private autoScrollDuringDrag() {
    const drag = this.pointerDrag;
    if (!drag?.moved) return;
    const rect = this.tree.getBoundingClientRect();
    const maxScrollTop = Math.max(0, this.tree.scrollHeight - this.tree.clientHeight);
    if (!maxScrollTop) return;
    const delta = drag.clientY < rect.top + DRAG_SCROLL_EDGE
      ? -DRAG_SCROLL_STEP
      : drag.clientY > rect.bottom - DRAG_SCROLL_EDGE
        ? DRAG_SCROLL_STEP
        : 0;
    if (!delta) return;
    const previous = this.tree.scrollTop;
    this.tree.scrollTop = Math.max(0, Math.min(maxScrollTop, previous + delta));
    if (this.tree.scrollTop !== previous) {
      this.updateDropTarget(drag.clientX, drag.clientY, drag.sourceRelPaths);
    }
  }

  private updatePointerDrag(event: PointerEvent) {
    const drag = this.pointerDrag;
    if (!drag) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return;
    drag.clientX = event.clientX;
    drag.clientY = event.clientY;
    drag.moved = true;
    event.preventDefault();
    document.body.classList.add("fv-dragging");
    this.host.classList.add("fv-dragging");
    if (this.dragScrollTimer === null) this.startDragAutoScroll();
    this.updateDropTarget(event.clientX, event.clientY, drag.sourceRelPaths);
  }

  private updateDropTarget(x: number, y: number, sourceRelPaths: string[]) {
    const drag = this.pointerDrag;
    if (!drag) return;
    const target = this.pointerDropTarget(x, y, sourceRelPaths);
    drag.targetRelDir = target?.relPath ?? null;
    if (!target) {
      this.clearDropTarget();
      this.host.classList.remove("fv-drop-root");
    } else if (target.element === this.tree) {
      this.clearDropTarget();
      this.host.classList.add("fv-drop-root");
    } else {
      this.host.classList.remove("fv-drop-root");
      this.setDropTarget(target.element);
    }
  }

  private pointerDropTarget(x: number, y: number, sourceRelPaths: string[]): { relPath: string; element: HTMLElement } | null {
    const element = document.elementFromPoint(x, y);
    if (!(element instanceof Element)) return null;
    const rowElement = element.closest<HTMLElement>(".fv-row");
    const row = rowElement && this.tree.contains(rowElement)
      ? this.rows.find((candidate) => candidate.kind === "dir" && candidate.relPath === rowElement.dataset.relPath)
      : undefined;
    if (row && rowElement && this.canDrop(sourceRelPaths, row.relPath)) return { relPath: row.relPath, element: rowElement };
    if (rowElement) return null;
    if (this.host.contains(element) && !element.closest(".fv-toolbar, .ws-search") && this.canDrop(sourceRelPaths, "")) {
      return { relPath: "", element: this.tree };
    }
    return null;
  }

  private finishPointerDrag(event: PointerEvent) {
    const drag = this.pointerDrag;
    if (!drag) return;
    if (drag.moved) this.updatePointerDrag(event);
    const targetRelDir = drag.targetRelDir;
    const shouldMove = drag.moved && targetRelDir !== null;
    this.clearDragState();
    if (!shouldMove) return;
    event.preventDefault();
    this.suppressRowClick = true;
    window.setTimeout(() => { this.suppressRowClick = false; }, 0);
    this.dropEntry({
      sourceRelPaths: drag.sourceRelPaths,
      targetRelDir,
      mode: event.ctrlKey ? "copy" : "move",
    });
  }

  private dropEntry(request: FileTreeDropRequest) {
    if (this.entryMoveInProgress) return;
    this.entryMoveInProgress = true;
    runAsyncBoundary(
      async () => {
        try {
          const result = await this.onDropEntries(request);
          this.managedDropUndo = result.undoable;
        } finally {
          this.entryMoveInProgress = false;
        }
      },
      (error) => this.reportTreeError(error),
    );
  }

  private onBackButton(event: MouseEvent) {
    if (event.button !== 3 || (!this.managedDropUndo && !this.entryMoveInProgress)) return;
    event.preventDefault();
    event.stopPropagation();
    void this.undoLastFolderMove();
  }

  private async undoLastFolderMove(): Promise<boolean> {
    if (!this.managedDropUndo || this.entryMoveInProgress) return false;
    this.entryMoveInProgress = true;
    try {
      const undone = await this.onUndoLastDrop();
      if (undone) this.managedDropUndo = false;
      return undone;
    } catch (error) {
      await this.reportTreeError(error);
      return false;
    } finally {
      this.entryMoveInProgress = false;
    }
  }

  // ---- フォルダ/アーカイブのツリー ----
  private folderTree(): DocumentFragment {
    const frag = document.createDocumentFragment();
    for (const i of this.visible()) {
      const r = this.rows[i];
      const div = document.createElement("div");
      div.className = "fv-row"
        + (this.selected.has(r.relPath) ? " sel" : "")
        + (this.isCut?.(r.relPath) ? " fv-cut" : "")
        + (isMovable(r) ? " fv-draggable" : "");
      div.dataset.relPath = r.relPath;
      div.style.paddingLeft = `${r.depth * 14 + 4}px`;
      if (isMovable(r)) {
        div.addEventListener("pointerdown", (event) => this.beginPointerDrag(r, event));
      }

      const arrow = document.createElement("span");
      arrow.className = "fv-arrow";
      arrow.textContent = ROW_GLYPHS[r.kind][r.expanded ? 1 : 0];
      div.appendChild(arrow);
      if (this.renamingRelPath === r.relPath) {
        const input = document.createElement("input");
        input.className = "fv-rename-input";
        input.dataset.relPath = r.relPath;
        input.value = r.label;
        input.spellcheck = false;
        input.addEventListener("click", (event) => event.stopPropagation());
        input.addEventListener("pointerdown", (event) => event.stopPropagation());
        input.addEventListener("keydown", (event) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            this.finishRename(r.relPath, input.value, false);
          } else if (event.key === "Escape") {
            event.preventDefault();
            this.finishRename(r.relPath, input.value, true);
          }
        });
        div.appendChild(input);
      } else {
        div.appendChild(document.createTextNode(r.label));
      }

      const activate = (newTab: boolean) => {
        if (newTab && r.kind !== "archiveEntry" && r.kind !== "archiveDir") {
          this.sel = r.relPath;
          this.selected = new Set([r.relPath]);
          this.selectionAnchor = r.relPath;
          this.render();
          void this.requestSelection(r.relPath, true).catch((error) => this.reportTreeError(error));
          return;
        }
        if (r.kind === "dir") {
          this.sel = r.relPath;
          this.selected = new Set([r.relPath]);
          this.selectionAnchor = r.relPath;
          void this.expandFolderRow(r).catch((error) => this.reportTreeError(error));
        } else if (r.kind === "archive") {
          void this.expandArchiveRow(r).catch((error) => this.reportTreeError(error));
        } else if (r.kind === "archiveDir") {
          r.expanded = !r.expanded;
          this.render();
        } else {
          this.openFileRow(r);
        }
      };
      div.addEventListener("click", (e) => {
        if (this.suppressRowClick) return;
        this.focusTree();
        if (e.ctrlKey || e.shiftKey) {
          this.selectWithModifier(r, e.shiftKey, e.ctrlKey);
          return;
        }
        runAsyncBoundary(
          () => activate(false),
          (error) => this.reportTreeError(error),
        );
      });
      div.addEventListener("auxclick", (e) => {
        if (isMiddleClick(e)) {
          runAsyncBoundary(
            () => activate(true),
            (error) => this.reportTreeError(error),
          );
        }
      });
      if (r.kind !== "archiveEntry" && r.kind !== "archiveDir") {
        // archiveEntry/archiveDir はアーカイブ内の仮想エントリなので、実ファイル向けの
        // 名前変更/エクスプローラ表示メニューの対象にしない
        div.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!this.selected.has(r.relPath)) {
            this.sel = r.relPath;
            this.selected = new Set([r.relPath]);
            this.selectionAnchor = r.relPath;
            this.render();
          }
          this.onContextMenu(
            e.clientX,
            e.clientY,
            { relPath: r.relPath, isDir: r.kind === "dir" },
            this.selectedTargets(),
          );
        });
      }
      frag.appendChild(div);
    }
    if (this.rows.some(isMovable)) {
      const rootDrop = document.createElement("div");
      rootDrop.className = "fv-root-drop";
      rootDrop.textContent = "↥ フォルダ直下へ移動";
      frag.appendChild(rootDrop);
    }
    return frag;
  }

  private async reportTreeError(error: unknown) {
    try {
      await this.onTreeError(error);
    } catch (reportError) {
      console.error("ツリー展開エラーを表示できませんでした", reportError);
    }
  }
}

function isExpandable(row: Row): boolean {
  return row.kind === "dir" || row.kind === "archive" || row.kind === "archiveDir";
}

function isMovable(row: Row): boolean {
  return !!row.relPath && (row.kind === "dir" || row.kind === "file" || row.kind === "archive");
}

function parentRelPath(relPath: string): string {
  const path = relPath.replace(/\\/g, "/").replace(/\/$/, "");
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

function fileCommandForEvent(event: KeyboardEvent): SidebarFileCommand | null {
  if (event.altKey || event.metaKey) return null;
  if (event.ctrlKey) {
    switch (event.key.toLowerCase()) {
      case "c": return "copy";
      case "x": return "cut";
      case "v": return "paste";
      case "z": return "undo";
      case "y": return "redo";
      default: return null;
    }
  }
  if (event.key === "F2") return "rename";
  if (event.key === "Delete") return "delete";
  return null;
}

function isSelectAllShortcut(event: KeyboardEvent): boolean {
  return event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey
    && event.key.toLowerCase() === "a";
}

function isUndoShortcut(event: KeyboardEvent): boolean {
  return event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && event.key.toLowerCase() === "z";
}

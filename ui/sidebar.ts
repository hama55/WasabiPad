import type { FolderEntry, WorkspaceSearchOptions, WorkspaceSearchResult } from "./api";
import { WorkspaceSearchPanel, type WorkspaceSearchPorts } from "./workspace-search-panel";
import { archiveEntryPath } from "./archive-path";
import type { ContextTarget } from "./context-target";
import { isMiddleClick } from "./interaction-constants";
export type { ContextTarget } from "./context-target";

// フォルダ/ZIP/Excelのエントリ名 ("sub/a.txt" 形式) からツリーを構築して表示。
// 実データは backend が保持し、選択時に relPath を親へ通知するだけ。
// 検索の窓と結果は WorkspaceSearchPanel が持ち、ここは置き場を貸すだけ。
//
// zip/xlsx/xls は "archive" 種別の葉として表示し、中身は展開ボタンを押すまで取得しない。
// 展開後に挿入される内部エントリ行は "archiveEntry" (相対パスは "アーカイブのrelPath::エントリ名")。
type RowKind = "dir" | "file" | "archive" | "archiveEntry";

interface Row {
  label: string;
  relPath: string; // フォルダルートからの相対パス ("sub" や "sub/a.txt")、archiveEntry は "data.zip::Sheet1" 形式
  depth: number;
  kind: RowKind;
  expanded: boolean;
  childrenLoaded: boolean; // dir/archive の子一覧を取得済みか
}

// 行頭の記号 [閉じているとき, 開いているとき]。種別を足したらここも足りなくなる
// (Record なので、足し忘れは型が落とす)。
const ROW_GLYPHS: Record<RowKind, [string, string]> = {
  dir: ["📁", "🗂️"],
  archive: ["›", "⌄"],
  file: ["📄", "📄"],
  archiveEntry: ["", ""],
};

// サイドバーが外界へ出す依頼。IPC も文書状態もここより先は知らない。
// 検索の依頼 (onSearch / onCancel / onOpen / onOptionsChange) は
// WorkspaceSearchPanel のもので、ここはそのまま素通しする。
export interface SidebarPorts extends Omit<WorkspaceSearchPorts, "onViewChange" | "onContextMenu"> {
  onSelect: (relPath: string, newTab: boolean) => void | Promise<boolean | void>;
  onContextMenu: (x: number, y: number, target: ContextTarget | null) => void;
  onExpandArchive: (relPath: string) => Promise<string[]>;
  onExpandFolder: (relDir: string) => Promise<FolderEntry[]>;
  onTreeError: (error: unknown) => Promise<void>;
}

export class Sidebar {
  private host: HTMLElement;
  private tree: HTMLElement;
  private panel: WorkspaceSearchPanel;
  private rows: Row[] = [];
  private sel: string | null = null; // 選択中の relPath
  private selectionRequest = 0;
  private onSelect: (relPath: string, newTab: boolean) => void | Promise<boolean | void>;
  private onContextMenu: (x: number, y: number, target: ContextTarget | null) => void;
  private onExpandArchive: (relPath: string) => Promise<string[]>;
  private onExpandFolder: (relDir: string) => Promise<FolderEntry[]>;
  private onTreeError: (error: unknown) => Promise<void>;

  constructor(host: HTMLElement, ports: SidebarPorts, searchOptions: WorkspaceSearchOptions) {
    this.host = host;
    this.onSelect = ports.onSelect;
    this.onContextMenu = ports.onContextMenu;
    this.onExpandArchive = ports.onExpandArchive;
    this.onExpandFolder = ports.onExpandFolder;
    this.onTreeError = ports.onTreeError;
    this.panel = new WorkspaceSearchPanel(searchOptions, {
      onSearch: ports.onSearch,
      onCancel: ports.onCancel,
      onCancelError: ports.onCancelError,
      onError: ports.onError,
      onOpen: ports.onOpen,
      onOptionsChange: ports.onOptionsChange,
      onContextMenu: (x, y, target) => this.onContextMenu(x, y, target),
      onViewChange: () => this.render(),
    });
    this.tree = document.createElement("div");
    this.tree.tabIndex = 0;
    this.tree.addEventListener("keydown", (event) => this.onTreeKeyDown(event));
    this.host.append(this.panel.bar, this.tree);
    this.host.addEventListener("contextmenu", (e) => {
      if (e.target !== this.host && e.target !== this.tree) return; // 個々の行上は行側のリスナーに任せる
      e.preventDefault();
      this.onContextMenu(e.clientX, e.clientY, null);
    });
  }

  setWorkspaceSearch(folderRoot: string | null) {
    this.selectionRequest++;
    this.panel.setFolderRoot(folderRoot);
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
          kind: "dir",
          expanded: false,
          childrenLoaded: false,
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
    this.selectionRequest++;
    this.rows = this.folderRows(entries, 0, "");
    this.sel = null;
    this.render();
  }

  async refreshFolderEntries() {
    const request = ++this.selectionRequest;
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
    if (this.sel && !this.rows.some((row) => row.kind !== "dir" && row.relPath === this.sel)) this.sel = null;
    this.render();
  }

  setArchiveEntries(names: string[]) {
    this.selectionRequest++;
    this.rows = this.buildRows(names, 0, "", () => "archiveEntry");
    this.sel = null;
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
    this.selectionRequest++;
    this.rows = [{ label: displayName, relPath: "", depth: 0, kind: "archive", expanded: false, childrenLoaded: false }];
    this.sel = null;
    this.render();
  }

  select(relPath: string) {
    this.selectionRequest++;
    this.sel = relPath;
    this.render();
  }

  // 新規作成/リネーム後、相対パスからそのファイル行を再選択する (無ければ何もしない)。
  // タブ復帰時は深い階層がまだ展開されていないため、必要な親だけ非同期で開く。
  async selectByRelPath(relPath: string) {
    const request = ++this.selectionRequest;
    if (this.panel.showing) {
      this.sel = relPath;
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
    this.render();
  }

  private async expandArchiveRow(r: Row) {
    if (!r.childrenLoaded) {
      const names = await this.onExpandArchive(r.relPath);
      const children = this.buildRows(names, r.depth + 1, r.relPath, () => "archiveEntry");
      const idx = this.rows.indexOf(r);
      this.rows.splice(idx + 1, 0, ...children);
      r.childrenLoaded = true;
    }
    r.expanded = !r.expanded;
    this.render();
  }

  private async expandFolderRow(r: Row, request?: number) {
    if (!r.childrenLoaded) {
      const children = this.folderRows(await this.onExpandFolder(r.relPath), r.depth + 1, r.relPath);
      if (request !== undefined && request !== this.selectionRequest) return;
      const index = this.rows.indexOf(r);
      if (index < 0) return;
      this.rows.splice(index + 1, 0, ...children);
      r.childrenLoaded = true;
    }
    if (request !== undefined && request !== this.selectionRequest) return;
    r.expanded = !r.expanded;
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
      if ((r.kind === "dir" || r.kind === "archive") && !r.expanded) hideDeeper = r.depth;
    });
    return out;
  }

  // ツリーの置き場は1つ。検索中と検索後は結果を出し、それ以外はフォルダを出す
  private render() {
    this.tree.replaceChildren(this.panel.showing ? this.panel.renderTree() : this.folderTree());
  }

  private onTreeKeyDown(event: KeyboardEvent) {
    if (this.panel.showing || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    const visible = this.visible();
    if (!visible.length) return;
    event.preventDefault();
    const current = this.sel === null ? -1 : visible.findIndex((index) => this.rows[index].relPath === this.sel);
    const next = event.key === "ArrowUp"
      ? visible[Math.max(0, current < 0 ? visible.length - 1 : current - 1)]
      : visible[Math.min(visible.length - 1, current + 1)];
    this.sel = this.rows[next].relPath;
    this.render();
    this.tree.querySelector<HTMLElement>(".fv-row.sel")?.scrollIntoView?.({ block: "nearest" });
  }

  // ---- フォルダ/アーカイブのツリー ----
  private folderTree(): DocumentFragment {
    const frag = document.createDocumentFragment();
    for (const i of this.visible()) {
      const r = this.rows[i];
      const div = document.createElement("div");
      div.className = "fv-row" + (r.relPath === this.sel ? " sel" : "");
      div.style.paddingLeft = `${r.depth * 14 + 4}px`;

      const arrow = document.createElement("span");
      arrow.className = "fv-arrow";
      arrow.textContent = ROW_GLYPHS[r.kind][r.expanded ? 1 : 0];
      div.appendChild(arrow);
      div.appendChild(document.createTextNode(r.label));

      const activate = (newTab: boolean) => {
        if (newTab && r.kind !== "archiveEntry") {
          void Promise.resolve(this.onSelect(r.relPath, true)).catch((error) => this.reportTreeError(error));
          return;
        }
        if (r.kind === "dir") {
          void this.expandFolderRow(r).catch((error) => this.reportTreeError(error));
        } else if (r.kind === "archive") {
          void this.expandArchiveRow(r).catch((error) => this.reportTreeError(error));
        } else {
          const previous = this.sel;
          this.sel = r.relPath;
          this.render();
          void Promise.resolve(this.onSelect(r.relPath, false))
            .then((opened) => {
              if (opened === false) {
                this.sel = previous;
                this.render();
              }
            })
            .catch((error) => this.reportTreeError(error));
        }
      };
      div.addEventListener("click", (e) => {
        this.tree.focus();
        activate(e.ctrlKey);
      });
      div.addEventListener("auxclick", (e) => {
        if (isMiddleClick(e)) activate(true);
      });
      if (r.kind !== "archiveEntry") {
        // archiveEntry はアーカイブ内の仮想エントリなので、実ファイル向けの
        // 名前変更/エクスプローラ表示メニューの対象にしない
        div.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.onContextMenu(e.clientX, e.clientY, { relPath: r.relPath, isDir: r.kind === "dir" });
        });
      }
      frag.appendChild(div);
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

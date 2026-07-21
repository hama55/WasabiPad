import type { FolderEntry, WorkspaceSearchResult } from "./api";

// フォルダ/ZIP/Excelのエントリ名 ("sub/a.txt" 形式) からツリーを構築して表示。
// 実データは backend が保持し、選択時に relPath を親へ通知するだけ。
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

export interface ContextTarget {
  relPath: string;
  isDir: boolean;
}

const ARCHIVE_EXT = /\.(zip|xlsx|xls)$/i;
function isArchiveName(name: string): boolean {
  return ARCHIVE_EXT.test(name);
}

export class Sidebar {
  private host: HTMLElement;
  private tree: HTMLElement;
  private search: HTMLElement;
  private searchInput: HTMLInputElement;
  private searchCase: HTMLInputElement;
  private searchClear: HTMLButtonElement;
  private results: WorkspaceSearchResult[] | null = null;
  private searchGen = 0;
  private searchTimer: number | undefined;
  private rows: Row[] = [];
  private sel: string | null = null; // 選択中の relPath
  private onSelect: (relPath: string, newWindow: boolean) => void;
  private onContextMenu: (x: number, y: number, target: ContextTarget | null) => void;
  private onExpandArchive: (relPath: string) => Promise<string[]>;
  private onExpandFolder: (relDir: string) => Promise<FolderEntry[]>;
  private onWorkspaceSearch: (pat: string, matchCase: boolean) => Promise<WorkspaceSearchResult[]>;
  private onSearchResult: (result: WorkspaceSearchResult) => void;

  constructor(
    host: HTMLElement,
    onSelect: (relPath: string, newWindow: boolean) => void,
    onContextMenu: (x: number, y: number, target: ContextTarget | null) => void,
    onExpandArchive: (relPath: string) => Promise<string[]>,
    onExpandFolder: (relDir: string) => Promise<FolderEntry[]>,
    onWorkspaceSearch: (pat: string, matchCase: boolean) => Promise<WorkspaceSearchResult[]>,
    onSearchResult: (result: WorkspaceSearchResult) => void
  ) {
    this.host = host;
    this.onSelect = onSelect;
    this.onContextMenu = onContextMenu;
    this.onExpandArchive = onExpandArchive;
    this.onExpandFolder = onExpandFolder;
    this.onWorkspaceSearch = onWorkspaceSearch;
    this.onSearchResult = onSearchResult;
    this.search = document.createElement("div");
    this.search.className = "ws-search";
    this.search.hidden = true;
    this.search.innerHTML = `<input placeholder="フォルダを検索" spellcheck="false" /><button type="button" title="検索をクリア">×</button><label><input type="checkbox" />Aa</label>`;
    this.searchInput = this.search.querySelector("input")!;
    this.searchClear = this.search.querySelector("button")!;
    this.searchCase = this.search.querySelector("label input")!;
    this.tree = document.createElement("div");
    this.host.append(this.search, this.tree);
    this.searchInput.addEventListener("input", () => this.queueWorkspaceSearch());
    this.searchClear.addEventListener("click", () => this.clearWorkspaceSearch());
    this.searchCase.addEventListener("change", () => this.queueWorkspaceSearch());
    this.host.addEventListener("contextmenu", (e) => {
      if (e.target !== this.host) return; // 個々の行上は行側のリスナーに任せる
      e.preventDefault();
      this.onContextMenu(e.clientX, e.clientY, null);
    });
  }

  setWorkspaceSearch(on: boolean) {
    this.search.hidden = !on;
    if (!on) {
      this.searchGen++;
      window.clearTimeout(this.searchTimer);
      this.searchInput.value = "";
      this.results = null;
      this.render();
    }
  }

  private queueWorkspaceSearch() {
    const pat = this.searchInput.value;
    const gen = ++this.searchGen;
    window.clearTimeout(this.searchTimer);
    if (!pat) {
      this.results = null;
      this.render();
      return;
    }
    this.searchTimer = window.setTimeout(() => this.searchWorkspace(gen, pat, this.searchCase.checked), 150);
  }

  private clearWorkspaceSearch() {
    this.searchGen++;
    window.clearTimeout(this.searchTimer);
    this.searchInput.value = "";
    this.results = null;
    this.render();
    this.searchInput.focus();
  }

  private async searchWorkspace(gen: number, pat: string, matchCase: boolean) {
    this.results = [];
    this.render();
    const results = await this.onWorkspaceSearch(pat, matchCase);
    if (gen !== this.searchGen) return;
    this.results = results;
    this.render();
  }

  // "sub/a.txt" 形式の名前一覧からディレクトリ見出し+葉の行を組み立てる。
  // relPrefix は葉の relPath に前置する文字列 (アーカイブ内エントリの "data.zip::" 用)。
  private buildRows(names: string[], depth: number, relPrefix: string, leafKindOf: (name: string) => RowKind): Row[] {
    const rows: Row[] = [];
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
          relPath: relPrefix + dirs.slice(0, d + 1).join("/"),
          depth: depth + d,
          kind: "dir",
          expanded: false,
          childrenLoaded: false,
        });
      }
      rows.push({
        label: parts[parts.length - 1],
        relPath: relPrefix + name,
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
    this.rows = this.folderRows(entries, 0, "");
    this.sel = null;
    this.render();
  }

  async refreshFolderEntries() {
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

    this.rows = await rebuild(await this.onExpandFolder(""), 0, "");
    if (this.sel && !this.rows.some((row) => row.kind !== "dir" && row.relPath === this.sel)) this.sel = null;
    this.render();
  }

  setArchiveEntries(names: string[]) {
    this.rows = this.buildRows(names, 0, "", () => "archiveEntry");
    this.sel = null;
    this.render();
  }

  private folderRows(entries: FolderEntry[], depth: number, parent: string): Row[] {
    return entries.map((entry) => ({
      label: entry.name,
      relPath: parent ? `${parent}/${entry.name}` : entry.name,
      depth,
      kind: entry.is_dir ? "dir" : isArchiveName(entry.name) ? "archive" : "file",
      expanded: false,
      childrenLoaded: false,
    }));
  }

  // 直接開いた (フォルダ非経由の) zip/xlsx/xls 自身を、展開前の単一行として表示する。
  setArchiveRoot(displayName: string) {
    this.rows = [{ label: displayName, relPath: "", depth: 0, kind: "archive", expanded: false, childrenLoaded: false }];
    this.sel = null;
    this.render();
  }

  select(relPath: string) {
    this.sel = relPath;
    this.render();
  }

  // 新規作成/リネーム後、相対パスからそのファイル行を再選択する (無ければ何もしない)。
  selectByRelPath(relPath: string) {
    const row = this.rows.find((r) => r.kind !== "dir" && r.relPath === relPath);
    if (!row) return;
    for (const r of this.rows) {
      if (r.kind === "dir" && relPath.startsWith(r.relPath + "/")) r.expanded = true;
    }
    this.sel = row.relPath;
    this.render();
  }

  private async expandArchiveRow(r: Row) {
    if (!r.childrenLoaded) {
      const names = await this.onExpandArchive(r.relPath);
      const prefix = r.relPath === "" ? "" : `${r.relPath}::`;
      const children = this.buildRows(names, r.depth + 1, prefix, () => "archiveEntry");
      const idx = this.rows.indexOf(r);
      this.rows.splice(idx + 1, 0, ...children);
      r.childrenLoaded = true;
    }
    r.expanded = !r.expanded;
    this.render();
  }

  private async expandFolderRow(r: Row) {
    if (!r.childrenLoaded) {
      const children = this.folderRows(await this.onExpandFolder(r.relPath), r.depth + 1, r.relPath);
      this.rows.splice(this.rows.indexOf(r) + 1, 0, ...children);
      r.childrenLoaded = true;
    }
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

  private render() {
    const frag = document.createDocumentFragment();
    if (this.results) {
      if (this.results.length === 0) {
        const empty = document.createElement("div");
        empty.className = "ws-empty";
        empty.textContent = "見つかりません";
        frag.appendChild(empty);
      }
      for (const result of this.results) {
        const div = document.createElement("div");
        div.className = "ws-result";
        div.textContent = `${result.rel_path}:${result.line + 1}  ${result.preview}`;
        div.title = div.textContent;
        div.addEventListener("click", () => this.onSearchResult(result));
        frag.appendChild(div);
      }
      this.tree.replaceChildren(frag);
      return;
    }
    for (const i of this.visible()) {
      const r = this.rows[i];
      const div = document.createElement("div");
      div.className = "fv-row" + (r.kind !== "dir" && r.relPath === this.sel ? " sel" : "");
      div.style.paddingLeft = `${r.depth * 14 + 4}px`;

      const arrow = document.createElement("span");
      arrow.className = "fv-arrow";
      arrow.textContent = r.kind === "dir" || r.kind === "archive" ? (r.expanded ? "⌄" : "›") : "";
      div.appendChild(arrow);
      div.appendChild(document.createTextNode(r.label));

      const activate = (newWindow: boolean) => {
        if (newWindow && r.kind !== "archiveEntry") {
          this.onSelect(r.relPath, true);
          return;
        }
        if (r.kind === "dir") {
          this.expandFolderRow(r);
        } else if (r.kind === "archive") {
          this.expandArchiveRow(r);
        } else {
          this.sel = r.relPath;
          this.render();
          this.onSelect(r.relPath, false);
        }
      };
      div.addEventListener("click", (e) => activate(e.ctrlKey));
      div.addEventListener("auxclick", (e) => {
        if (e.button === 1) activate(true);
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
    this.tree.replaceChildren(frag);
  }
}

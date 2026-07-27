import type {
  FolderEntry,
  Pos,
  WorkspaceSearchOptions,
  WorkspaceSearchOutcome,
  WorkspaceSearchResult,
} from "./api";
import { groupResults, highlightedPreview, sortResults, type ResultGroup } from "./search-results";
import { openSearchSettings } from "./search-settings-dialog";
import {
  clampSearchOptions,
  loadSearchOptions,
  sameSearchOptions,
  saveSearchOptions,
  searchScopeSummary,
} from "./workspace-search-options";

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
  goto?: Pos; // 検索結果から開く場合の飛び先
}

// サイドバーが外界へ出す依頼。IPC も文書状態もここより先は知らない。
export interface SidebarPorts {
  onSelect: (relPath: string, newWindow: boolean) => void;
  onContextMenu: (x: number, y: number, target: ContextTarget | null) => void;
  onExpandArchive: (relPath: string) => Promise<string[]>;
  onExpandFolder: (relDir: string) => Promise<FolderEntry[]>;
  onWorkspaceSearch: (
    pat: string,
    options: WorkspaceSearchOptions,
    searchId: number
  ) => Promise<WorkspaceSearchOutcome>;
  onCancelSearch: () => void;
  onSearchResult: (result: WorkspaceSearchResult, pattern: string, newWindow: boolean) => void;
}

// core の Doc::is_lazy_archive_ext と一致させる (check:ipc が両者の一致を検証する)
const ARCHIVE_EXT = /\.(zip|xlsx|xls)$/i;
function isArchiveName(name: string): boolean {
  return ARCHIVE_EXT.test(name);
}

// DOM の行数だけは有限にしないと画面が固まる。超えた分は隠さず「ここまで」と告げる
const MAX_RENDERED_ROWS = 3000;
// これを超える結果は畳んで出す (件数が多いときにファイル一覧を先に見せるため)
const AUTO_COLLAPSE_MATCHES = 500;
// 検索中の再描画の間引き。backend の送出間隔 (PROGRESS_INTERVAL) と同じ刻みで、
// これより細かく描いても届く中身が増えないため意味がない
const PARTIAL_RENDER_MS = 100;

type ToggleKey = "match_case" | "whole_word" | "use_regex" | "search_file_names" | "search_contents";

// 「どう当てるか」は入力欄の中へ (VSCode の Aa / ab / .* と同じ位置)。
// ab と .* はファイル名の当て方も変える (どちらかを入れるとファジーをやめる)。
const MATCH_TOGGLES: [string, string, ToggleKey][] = [
  ["Aa", "大文字小文字を区別", "match_case"],
  ["ab", "単語単位で一致 (ファイル名もファジーをやめる)", "whole_word"],
  [".*", "正規表現として扱う (ファイル名もファジーをやめる)", "use_regex"],
];
// 「どこを探すか」はヘッダへ。入力欄に5つ並べると打つ場所が無くなる
const SCOPE_TOGGLES: [string, string, ToggleKey][] = [
  ["名", "ファイル名を検索 (既定はファジー一致)", "search_file_names"],
  ["文", "本文を検索", "search_contents"],
];

export class Sidebar {
  private host: HTMLElement;
  private tree: HTMLElement;
  private search: HTMLElement;
  private searchInput: HTMLInputElement;
  private searchStop: HTMLButtonElement;
  private searchSummary: HTMLElement;
  private toggleButtons = new Map<ToggleKey, HTMLButtonElement>();
  private options: WorkspaceSearchOptions = loadSearchOptions();
  private outcome: WorkspaceSearchOutcome | "searching" | null = null;
  private partial: WorkspaceSearchResult[] = []; // 検索中に届いた分 (並べ替えは描画時)
  private partialTimer: number | undefined;
  private shownPattern = ""; // outcome が属するパターン (入力途中の値とは別)
  // 畳み方は「既定 + 例外」で持つ。全パスを集合に入れる持ち方だと、
  // 検索中に後から届いたファイルが既定から外れて開いたまま出てしまう。
  private collapseByDefault = false;
  private collapsed = new Set<string>(); // 既定と逆にするファイル
  private collapseTouched = false; // 畳み方を手で変えたか (自動の畳み込みより手を優先する)
  private searchGen = 0;
  private searchTimer: number | undefined;
  private searchRunning = false;
  private aborted = false; // 中止ボタンで止めた直後に自動で再開しないための印
  private rows: Row[] = [];
  private sel: string | null = null; // 選択中の relPath
  private onSelect: (relPath: string, newWindow: boolean) => void;
  private onContextMenu: (x: number, y: number, target: ContextTarget | null) => void;
  private onExpandArchive: (relPath: string) => Promise<string[]>;
  private onExpandFolder: (relDir: string) => Promise<FolderEntry[]>;
  private onWorkspaceSearch: SidebarPorts["onWorkspaceSearch"];
  private onCancelSearch: () => void;
  private onSearchResult: (result: WorkspaceSearchResult, pattern: string, newWindow: boolean) => void;

  constructor(host: HTMLElement, ports: SidebarPorts) {
    this.host = host;
    this.onSelect = ports.onSelect;
    this.onContextMenu = ports.onContextMenu;
    this.onExpandArchive = ports.onExpandArchive;
    this.onExpandFolder = ports.onExpandFolder;
    this.onWorkspaceSearch = ports.onWorkspaceSearch;
    this.onCancelSearch = ports.onCancelSearch;
    this.onSearchResult = ports.onSearchResult;
    this.search = document.createElement("div");
    this.search.className = "ws-search";
    this.search.hidden = true;
    const header = this.buildHeader();
    const row = this.buildInputRow();
    this.searchInput = row.querySelector("input")!;
    this.searchSummary = document.createElement("div");
    this.searchSummary.className = "ws-summary";
    this.searchSummary.hidden = true;
    this.searchStop = header.querySelector(".ws-stop")!;
    this.search.append(header, row, this.searchSummary);
    this.tree = document.createElement("div");
    this.host.append(this.search, this.tree);
    this.searchInput.addEventListener("input", () => this.queueWorkspaceSearch());
    this.host.addEventListener("contextmenu", (e) => {
      if (e.target !== this.host && e.target !== this.tree) return; // 個々の行上は行側のリスナーに任せる
      e.preventDefault();
      this.onContextMenu(e.clientX, e.clientY, null);
    });
  }

  // ---- 検索バー ----
  private buildHeader(): HTMLElement {
    const header = document.createElement("div");
    header.className = "ws-header";
    const title = document.createElement("span");
    title.className = "ws-title";
    title.textContent = "検索";
    const scope = document.createElement("span");
    scope.className = "ws-toggles";
    scope.append(...SCOPE_TOGGLES.map(([label, hint, key]) => this.targetToggle(label, hint, key)));
    const stop = iconButton("ws-stop", "⏹", "検索を中止");
    stop.hidden = true;
    stop.addEventListener("click", () => this.stopWorkspaceSearch());
    const refresh = iconButton("ws-refresh", "🔄", "同じ条件で検索し直す");
    refresh.addEventListener("click", () => this.queueWorkspaceSearch(0));
    const clear = iconButton("ws-clear", "✕", "検索をクリア");
    clear.addEventListener("click", () => this.clearWorkspaceSearch());
    const fold = iconButton("ws-fold", "⊟", "すべて折りたたむ / 展開");
    fold.addEventListener("click", () => this.toggleAllGroups());
    const settings = iconButton("ws-settings", "⚙", "検索の設定");
    settings.addEventListener("click", () => this.openSettings());
    header.append(title, scope, stop, refresh, clear, fold, settings);
    return header;
  }

  private buildInputRow(): HTMLElement {
    const row = document.createElement("div");
    row.className = "ws-search-row";
    const input = document.createElement("input");
    input.placeholder = "検索";
    input.spellcheck = false;
    const toggles = document.createElement("span");
    toggles.className = "ws-toggles";
    toggles.append(...MATCH_TOGGLES.map(([label, hint, key]) => this.targetToggle(label, hint, key)));
    row.append(input, toggles);
    return row;
  }

  private targetToggle(label: string, title: string, key: ToggleKey): HTMLButtonElement {
    const button = iconButton("ws-toggle", label, title);
    button.classList.toggle("on", this.options[key]);
    button.addEventListener("click", () => {
      const next = { ...this.options };
      next[key] = !next[key];
      this.options = clampSearchOptions(next);
      this.syncTargetToggles();
      this.commitOptions();
    });
    this.toggleButtons.set(key, button);
    return button;
  }

  private openSettings() {
    const opened = this.options;
    openSearchSettings(this.options, {
      onChange: (options) => {
        this.options = options;
        saveSearchOptions(options);
        this.syncTargetToggles();
      },
      // 何も変えずに閉じたなら検索し直さない。走査中なら結果がそこで捨てられる
      onClose: () => {
        if (!sameSearchOptions(opened, this.options)) this.commitOptions();
      },
    });
  }

  private syncTargetToggles() {
    for (const [key, button] of this.toggleButtons) button.classList.toggle("on", this.options[key]);
  }

  private commitOptions() {
    saveSearchOptions(this.options);
    if (this.searchInput.value) this.queueWorkspaceSearch(0);
    else this.render();
  }

  setWorkspaceSearch(on: boolean) {
    this.search.hidden = !on;
    if (!on) this.clearWorkspaceSearch(false);
  }

  private queueWorkspaceSearch(delay = 150) {
    const pat = this.searchInput.value;
    const gen = ++this.searchGen;
    this.aborted = false;
    window.clearTimeout(this.searchTimer);
    // 世代が変わった時点で、走っている検索の結果は捨てると決まっている。
    // 止めずに放っておくと最後まで走り切るまで次が始まらず (searchRunning)、
    // その間の途中経過も世代違いで捨てられるので、画面が空のまま待たされる。
    if (this.searchRunning) this.onCancelSearch();
    if (!pat) {
      this.setOutcome(null, "");
      return;
    }
    this.setOutcome("searching", pat);
    this.searchTimer = window.setTimeout(() => void this.searchWorkspace(gen, pat, this.options), delay);
  }

  // 走査量は無制限が既定なので、待たされたら止められる必要がある
  private stopWorkspaceSearch() {
    this.aborted = true;
    this.searchGen++;
    window.clearTimeout(this.searchTimer);
    if (this.outcome) this.onCancelSearch(); // 走っていないなら止めるものがない
    this.setOutcome(null, "");
  }

  private clearWorkspaceSearch(focus = true) {
    this.stopWorkspaceSearch();
    this.searchInput.value = "";
    if (focus) this.searchInput.focus();
  }

  // 検索中に backend から届いた途中経過。世代が変わっていれば捨てる
  // (打ち切った検索の取りこぼしが次の検索の結果に混ざらないようにする)。
  acceptSearchBatch(searchId: number, results: WorkspaceSearchResult[]) {
    if (searchId !== this.searchGen || this.outcome !== "searching") return;
    this.partial.push(...results);
    this.autoCollapse(this.partial);
    // 描画は間引く。届くたびに数千行を組み直すと走査より描画が重くなる
    if (this.partialTimer !== undefined) return;
    this.partialTimer = window.setTimeout(() => {
      this.partialTimer = undefined;
      if (this.outcome === "searching") this.render();
    }, PARTIAL_RENDER_MS);
  }

  // 件数が多いときはファイル一覧を先に見せる (中身は必要な分だけ開く)。
  // ただし利用者が畳み方を触ったあとは、途中経過が届くたびに上書きしない
  private autoCollapse(results: WorkspaceSearchResult[]) {
    if (this.collapseTouched) return;
    this.collapseByDefault = results.length > AUTO_COLLAPSE_MATCHES;
    this.collapsed.clear();
  }

  private setOutcome(outcome: WorkspaceSearchOutcome | "searching" | null, pattern: string) {
    this.outcome = outcome;
    this.shownPattern = pattern;
    this.searchStop.hidden = outcome !== "searching";
    window.clearTimeout(this.partialTimer);
    this.partialTimer = undefined;
    this.partial = [];
    if (outcome === "searching") this.collapseTouched = false; // 新しい検索の始まり
    if (outcome && outcome !== "searching") this.autoCollapse(outcome.results);
    this.render();
  }

  private toggleAllGroups() {
    if (!this.shownResults().length) return;
    this.collapseTouched = true;
    this.collapseByDefault = !this.collapseByDefault;
    this.collapsed.clear();
    this.render();
  }

  // いま画面に出ている結果。検索中は届いた分、確定後は確定結果
  private shownResults(): WorkspaceSearchResult[] {
    if (this.outcome === "searching") return this.partial;
    return this.outcome?.results ?? [];
  }

  private isCollapsed(relPath: string): boolean {
    return this.collapsed.has(relPath) !== this.collapseByDefault;
  }

  private async searchWorkspace(gen: number, pat: string, options: WorkspaceSearchOptions) {
    if (this.searchRunning) return;
    this.searchRunning = true;
    try {
      const outcome = await this.onWorkspaceSearch(pat, options, gen);
      if (gen === this.searchGen) this.setOutcome(outcome, pat);
    } finally {
      this.searchRunning = false;
      if (!this.aborted && gen !== this.searchGen && this.searchInput.value) this.queueWorkspaceSearch();
    }
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
    if (this.outcome === "searching") {
      this.tree.replaceChildren(this.searchingTree());
      return;
    }
    if (this.outcome) {
      this.tree.replaceChildren(this.resultTree());
      return;
    }
    this.searchSummary.hidden = true;
    this.tree.replaceChildren(this.folderTree());
  }

  // ---- 検索中の途中経過 (確定結果と同じ並びで、届いた分だけを見せる) ----
  private searchingTree(): DocumentFragment {
    const frag = document.createDocumentFragment();
    if (!this.partial.length) {
      this.searchSummary.hidden = true;
      frag.appendChild(searchingRow());
      return frag;
    }
    // 確定結果と同じ規則で並べ直す。走査順のまま出すと、検索が終わった瞬間に並びが飛ぶ
    const byScore = this.options.search_file_names && !this.options.search_contents;
    const groups = groupResults(sortResults(this.partial, byScore));
    this.searchSummary.hidden = false;
    this.searchSummary.replaceChildren(
      countRow(`${groups.length.toLocaleString()} 個のファイルに ${this.partial.length.toLocaleString()} 件 (検索中)`)
    );
    this.appendGroups(frag, groups);
    frag.appendChild(searchingRow());
    return frag;
  }

  // ---- 検索結果のツリー (ファイル見出し + その下に一致行) ----
  private resultTree(): DocumentFragment {
    const outcome = this.outcome as WorkspaceSearchOutcome;
    const groups = groupResults(outcome.results);
    this.renderSummary(outcome, groups.length);

    const frag = document.createDocumentFragment();
    if (outcome.pattern_error) {
      // 正規表現を打っている途中は必ず壊れる。エラーとして黙らせず、理由だけ出す
      frag.appendChild(warning(outcome.pattern_error));
      return frag;
    }
    if (!groups.length) {
      frag.appendChild(emptyNotice(searchScopeSummary(this.options)));
      return frag;
    }
    this.appendGroups(frag, groups);
    return frag;
  }

  private appendGroups(frag: DocumentFragment, groups: ResultGroup[]) {
    const wanted = groups.reduce(
      (rows, group) => rows + 1 + (this.isCollapsed(group.relPath) ? 0 : group.matches.length),
      0
    );
    let rendered = 0;
    for (const group of groups) {
      if (rendered >= MAX_RENDERED_ROWS) break;
      frag.appendChild(this.groupRow(group));
      rendered++;
      if (this.isCollapsed(group.relPath)) continue;
      for (const match of group.matches) {
        if (rendered >= MAX_RENDERED_ROWS) break;
        frag.appendChild(this.matchRow(match));
        rendered++;
      }
    }
    if (wanted > MAX_RENDERED_ROWS) {
      frag.appendChild(warning(
        `画面に出せるのはここまで (${rendered.toLocaleString()} 行)。折りたたむか条件を絞れば残りも見られる`
      ));
    }
  }

  private renderSummary(outcome: WorkspaceSearchOutcome, fileCount: number) {
    const summary = this.searchSummary;
    summary.hidden = false;
    summary.replaceChildren();
    if (outcome.pattern_error) return; // 件数を出す段階に達していない
    summary.appendChild(countRow(
      outcome.results.length
        ? `${fileCount.toLocaleString()} 個のファイルに ${outcome.results.length.toLocaleString()} 件の結果`
        : `${outcome.scanned_files.toLocaleString()} 個のファイルを調べて 0 件`
    ));
    // 上限で切ったなら必ず言う。黙って減らすのがいちばん困る
    if (outcome.hit_file_limit) summary.appendChild(warning("最大ファイル数で列挙を打ち切った"));
    if (outcome.hit_result_limit) summary.appendChild(warning("最大結果数で検索を打ち切った"));
  }

  private groupRow(group: ResultGroup): HTMLElement {
    const div = document.createElement("div");
    div.className = "ws-group";
    const collapsed = this.isCollapsed(group.relPath);
    const twisty = document.createElement("span");
    twisty.className = "ws-twisty";
    twisty.textContent = collapsed ? "›" : "⌄";
    const name = document.createElement("span");
    name.className = "ws-file";
    name.textContent = group.fileName;
    const dir = document.createElement("span");
    dir.className = "ws-dir";
    dir.textContent = group.dirPath;
    const count = document.createElement("span");
    count.className = "ws-count";
    count.textContent = String(group.matches.length);
    div.append(twisty, name, dir, count);
    div.title = group.relPath;
    div.addEventListener("click", () => {
      this.collapseTouched = true;
      // 集合が持つのは「既定と逆にするファイル」。既定へ戻すなら取り除く
      if (this.collapsed.has(group.relPath)) this.collapsed.delete(group.relPath);
      else this.collapsed.add(group.relPath);
      this.render();
    });
    this.bindOpen(div, group.matches[0]);
    return div;
  }

  private matchRow(match: WorkspaceSearchResult): HTMLElement {
    const div = document.createElement("div");
    div.className = "ws-match";
    const mark = document.createElement("span");
    mark.className = "ws-line";
    mark.textContent = match.is_filename ? "名" : String(match.line + 1);
    const preview = document.createElement("span");
    preview.className = "ws-preview";
    preview.appendChild(highlightedPreview(match.preview, match.highlights));
    div.append(mark, preview);
    div.title = match.preview;
    div.addEventListener("click", () => this.onSearchResult(match, this.shownPattern, false));
    this.bindOpen(div, match);
    return div;
  }

  // ホイールクリックと右クリックは、どちらの行でも「別 WasabiPad で開く」入口になる
  private bindOpen(row: HTMLElement, match: WorkspaceSearchResult) {
    row.addEventListener("auxclick", (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      this.onSearchResult(match, this.shownPattern, true);
    });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onContextMenu(e.clientX, e.clientY, {
        relPath: match.rel_path,
        isDir: false,
        goto: { line: match.line, col: match.col },
      });
    });
  }

  // ---- フォルダ/アーカイブのツリー ----
  private folderTree(): DocumentFragment {
    const frag = document.createDocumentFragment();
    for (const i of this.visible()) {
      const r = this.rows[i];
      const div = document.createElement("div");
      div.className = "fv-row" + (r.kind !== "dir" && r.relPath === this.sel ? " sel" : "");
      div.style.paddingLeft = `${r.depth * 14 + 4}px`;

      const arrow = document.createElement("span");
      arrow.className = "fv-arrow";
      arrow.textContent = r.kind === "dir" ? (r.expanded ? "🗂️" : "📁") : r.kind === "archive" ? (r.expanded ? "⌄" : "›") : r.kind === "file" ? "📄" : "";
      div.appendChild(arrow);
      div.appendChild(document.createTextNode(r.label));

      const activate = (newWindow: boolean) => {
        if (newWindow && r.kind !== "archiveEntry") {
          this.onSelect(r.relPath, true);
          return;
        }
        if (r.kind === "dir") {
          void this.expandFolderRow(r);
        } else if (r.kind === "archive") {
          void this.expandArchiveRow(r);
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
    return frag;
  }
}

function iconButton(className: string, label: string, title: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.title = title;
  return button;
}

function searchingRow(): HTMLElement {
  const div = document.createElement("div");
  div.className = "ws-empty";
  div.textContent = "検索中…";
  return div;
}

function countRow(text: string): HTMLElement {
  const div = document.createElement("div");
  div.textContent = text;
  return div;
}

function warning(text: string): HTMLElement {
  const div = document.createElement("div");
  div.className = "ws-warning";
  div.textContent = text;
  return div;
}

function emptyNotice(detail: string): HTMLElement {
  const empty = document.createElement("div");
  empty.className = "ws-empty";
  const title = document.createElement("div");
  title.textContent = "見つかりません";
  const excluded = document.createElement("div");
  excluded.className = "ws-empty-detail";
  excluded.textContent = detail;
  empty.append(title, excluded);
  return empty;
}

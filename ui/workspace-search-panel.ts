import type { WorkspaceSearchOptions, WorkspaceSearchOutcome, WorkspaceSearchResult } from "./api";
import type { ContextTarget } from "./sidebar";
import { groupResults, highlightedPreview, sortResults, type ResultGroup } from "./search-results";
import { openSearchSettings } from "./search-settings-dialog";
import {
  clampSearchOptions,
  optionTitle,
  sameSearchOptions,
  searchScopeSummary,
  type BoolOptionKey,
} from "./workspace-search-options";

// フォルダ検索の窓と結果ツリー。検索条件の保持・実行・打ち切り・途中経過の
// 取り込みまでを持ち、フォルダツリー (Sidebar) とは状態を共有しない。
// 器 (どこに描くか) は持たない: 結果ツリーは断片として返し、置き場は Sidebar が決める。

export interface WorkspaceSearchPorts {
  onSearch: (
    pat: string,
    options: WorkspaceSearchOptions,
    searchId: number
  ) => Promise<WorkspaceSearchOutcome>;
  onCancel: () => void | Promise<void>;
  onError: (error: unknown) => Promise<void>;
  // 一致の範囲は result.highlights が持つ。パターンを渡さないのは、
  // 正規表現や大小の畳み込みで「当たった長さ」がパターンの長さと一致しないため。
  onOpen: (result: WorkspaceSearchResult, newTab: boolean) => void;
  onContextMenu: (x: number, y: number, target: ContextTarget) => void;
  // 検索条件が変わった。保存先を知るのは呼び出し側 (ここは永続化を知らない)
  onOptionsChange: (options: WorkspaceSearchOptions) => void;
  // 出すべき中身が変わった → 器の描き替えを頼む
  onViewChange: () => void;
}

// DOM の行数だけは有限にしないと画面が固まる。超えた分は隠さず「ここまで」と告げる
const MAX_RENDERED_ROWS = 3000;
// これを超える結果は畳んで出す (件数が多いときにファイル一覧を先に見せるため)
const AUTO_COLLAPSE_MATCHES = 500;
// 検索中の再描画の間引き。backend の送出間隔 (PROGRESS_INTERVAL) と同じ刻みで、
// これより細かく描いても届く中身が増えないため意味がない
const PARTIAL_RENDER_MS = 100;

type ToggleKey = BoolOptionKey;
type SearchState = WorkspaceSearchOutcome | "searching" | "stopped" | null;
type SearchViewState = {
  pattern: string;
  outcome: SearchState;
  partial: WorkspaceSearchResult[];
  collapseByDefault: boolean;
  collapsed: Set<string>;
  collapseTouched: boolean;
};

// 「どう当てるか」は入力欄の中へ (VSCode の Aa / ab / .* と同じ位置)。
// 説明文は OPTION_TEXTS が持ち、ここが持つのは記号だけ。
const MATCH_TOGGLES: [string, ToggleKey][] = [
  ["Aa", "match_case"],
  ["ab", "whole_word"],
  [".*", "use_regex"],
];
// 「どこを探すか」はヘッダへ。入力欄に5つ並べると打つ場所が無くなる
const SCOPE_TOGGLES: [string, ToggleKey][] = [
  ["名", "search_file_names"],
  ["文", "search_contents"],
];

export class WorkspaceSearchPanel {
  readonly bar: HTMLElement; // 検索窓 (ヘッダ + 入力欄 + 件数)
  private searchInput: HTMLInputElement;
  private searchStop: HTMLButtonElement;
  private summary: HTMLElement;
  private toggleButtons = new Map<ToggleKey, HTMLButtonElement>();
  private options: WorkspaceSearchOptions;
  private folderRoot: string | null = null;
  private states = new Map<string, SearchViewState>();
  private partialTimer: number | undefined;
  private searchGen = 0;
  private searchTimer: number | undefined;
  private running: Promise<WorkspaceSearchOutcome> | null = null; // 走行中の検索
  private ports: WorkspaceSearchPorts;

  constructor(options: WorkspaceSearchOptions, ports: WorkspaceSearchPorts) {
    this.options = options;
    this.ports = ports;
    this.bar = document.createElement("div");
    this.bar.className = "ws-search";
    this.bar.hidden = true;
    const header = this.buildHeader();
    const row = this.buildInputRow();
    this.searchInput = row.querySelector("input")!;
    this.summary = document.createElement("div");
    this.summary.className = "ws-summary";
    this.summary.hidden = true;
    this.searchStop = header.querySelector(".ws-stop")!;
    this.bar.append(header, row, this.summary);
    this.searchInput.addEventListener("input", () => this.queueSearch());
  }

  // 結果ツリーを出すべきか (検索中か、結果が確定しているか)
  get showing(): boolean {
    return this.folderRoot !== null && this.state.outcome !== null;
  }

  setFolderRoot(folderRoot: string | null) {
    if (folderRoot === this.folderRoot) return;
    if (this.folderRoot && this.state.outcome === "searching") this.stop();
    else {
      this.searchGen++;
      window.clearTimeout(this.searchTimer);
    }
    this.folderRoot = folderRoot;
    this.bar.hidden = folderRoot === null;
    if (folderRoot) this.searchInput.value = this.state.pattern;
    this.ports.onViewChange();
  }

  private get state(): SearchViewState {
    const root = this.folderRoot;
    if (!root) throw new Error("フォルダ検索の対象がありません");
    let state = this.states.get(root);
    if (!state) {
      state = { pattern: "", outcome: null, partial: [], collapseByDefault: false, collapsed: new Set(), collapseTouched: false };
      this.states.set(root, state);
    }
    return state;
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
    scope.append(...SCOPE_TOGGLES.map(([icon, key]) => this.targetToggle(icon, key)));
    const stop = iconButton("ws-stop", "⏹", "検索を中止");
    stop.hidden = true;
    stop.addEventListener("click", () => this.stop());
    const refresh = iconButton("ws-refresh", "🔄", "同じ条件で検索し直す");
    refresh.addEventListener("click", () => this.queueSearch(0));
    const clear = iconButton("ws-clear", "✕", "検索をクリア");
    clear.addEventListener("click", () => this.clear());
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
    toggles.append(...MATCH_TOGGLES.map(([icon, key]) => this.targetToggle(icon, key)));
    row.append(input, toggles);
    return row;
  }

  private targetToggle(icon: string, key: ToggleKey): HTMLButtonElement {
    const button = iconButton("ws-toggle", icon, optionTitle(key));
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
        this.ports.onOptionsChange(options);
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
    this.ports.onOptionsChange(this.options);
    if (this.searchInput.value) this.queueSearch(0);
    else this.ports.onViewChange();
  }

  private queueSearch(delay = 150) {
    const pat = this.searchInput.value;
    this.state.pattern = pat;
    const gen = ++this.searchGen;
    window.clearTimeout(this.searchTimer);
    // 条件が1つでも変われば最初から引き直す (前回の結果は再利用しない)。
    // 世代が変わった時点で走行中の結果は捨てると決まっているので、その場で止める。
    // 放っておくと走り切るまで次が始まらず、その間の途中経過も世代違いで捨てられて
    // 画面が空のまま待たされる。
    if (this.running) this.cancelRunningSearch();
    if (!pat) {
      this.setOutcome(null);
      return;
    }
    this.setOutcome("searching");
    this.searchTimer = window.setTimeout(() => void this.run(gen, pat, this.options), delay);
  }

  // 走査量は無制限が既定なので、待たされたら止められる必要がある
  private stop() {
    this.searchGen++; // 世代を進めれば、走行中の結果も待機中の要求も捨てられる
    window.clearTimeout(this.searchTimer);
    if (this.running) this.cancelRunningSearch(); // 走っていないなら止めるものがない
    // すでに届いた結果は有用なので、停止しても表示したままにする。
    this.setOutcome("stopped");
  }

  private clear(focus = true) {
    this.stop();
    this.setOutcome(null);
    this.searchInput.value = "";
    this.state.pattern = "";
    if (focus) this.searchInput.focus();
  }

  private cancelRunningSearch() {
    try {
      void Promise.resolve(this.ports.onCancel()).catch((error) => {
        console.error("検索の中止に失敗しました", error);
      });
    } catch (error) {
      console.error("検索の中止に失敗しました", error);
    }
  }

  // 検索中に backend から届いた途中経過。世代が変わっていれば捨てる
  // (打ち切った検索の取りこぼしが次の検索の結果に混ざらないようにする)。
  acceptBatch(searchId: number, results: WorkspaceSearchResult[]) {
    if (searchId !== this.searchGen || this.folderRoot === null || this.state.outcome !== "searching") return;
    this.state.partial.push(...results);
    this.autoCollapse(this.state.partial);
    // 描画は間引く。届くたびに数千行を組み直すと走査より描画が重くなる
    if (this.partialTimer !== undefined) return;
    this.partialTimer = window.setTimeout(() => {
      this.partialTimer = undefined;
      if (this.folderRoot !== null && this.state.outcome === "searching") this.ports.onViewChange();
    }, PARTIAL_RENDER_MS);
  }

  // 件数が多いときはファイル一覧を先に見せる (中身は必要な分だけ開く)。
  // ただし利用者が畳み方を触ったあとは、途中経過が届くたびに上書きしない
  private autoCollapse(results: WorkspaceSearchResult[]) {
    if (this.state.collapseTouched) return;
    this.state.collapseByDefault = results.length > AUTO_COLLAPSE_MATCHES;
    this.state.collapsed.clear();
  }

  private setOutcome(outcome: SearchState) {
    this.state.outcome = outcome;
    this.searchStop.hidden = outcome !== "searching";
    window.clearTimeout(this.partialTimer);
    this.partialTimer = undefined;
    if (outcome !== "stopped") this.state.partial = [];
    if (outcome === null) this.summary.hidden = true;
    if (outcome === "searching") this.state.collapseTouched = false; // 新しい検索の始まり
    if (outcome && outcome !== "searching" && outcome !== "stopped") this.autoCollapse(outcome.results);
    this.ports.onViewChange();
  }

  private toggleAllGroups() {
    if (!this.shownResults().length) return;
    this.state.collapseTouched = true;
    this.state.collapseByDefault = !this.state.collapseByDefault;
    this.state.collapsed.clear();
    this.ports.onViewChange();
  }

  // いま画面に出ている結果。検索中は届いた分、確定後は確定結果
  private shownResults(): WorkspaceSearchResult[] {
    if (this.state.outcome === "searching" || this.state.outcome === "stopped") return this.state.partial;
    return this.state.outcome?.results ?? [];
  }

  private isCollapsed(relPath: string): boolean {
    return this.state.collapsed.has(relPath) !== this.state.collapseByDefault;
  }

  // 検索は同時に1本だけ。走っているものが畳まれるのを待ってから始める。
  // 要求を捨てて「終わったら再キュー」に頼ると、中止が間に合わなかったぶんだけ
  // 引き直しが遅れる (条件を変えたのに古い結果を見せられる時間ができる)。
  private async run(gen: number, pat: string, options: WorkspaceSearchOptions) {
    while (this.running) await this.running.catch(() => {});
    if (gen !== this.searchGen) return; // 待っている間にまた条件が変わった
    let run: Promise<WorkspaceSearchOutcome> | null = null;
    try {
      run = this.ports.onSearch(pat, options, gen);
      this.running = run;
      const outcome = await run;
      if (gen === this.searchGen) this.setOutcome(outcome);
    } catch (error) {
      if (gen !== this.searchGen) return;
      this.setOutcome(null);
      try {
        await this.ports.onError(error);
      } catch (reportError) {
        console.error("検索エラーを表示できませんでした", reportError);
      }
    } finally {
      if (this.running === run) this.running = null;
    }
  }

  // ---- 結果ツリー (ファイル見出し + その下に一致行) ----
  renderTree(): DocumentFragment {
    return this.state.outcome === "searching" || this.state.outcome === "stopped" ? this.searchingTree() : this.resultTree();
  }

  // 検索中の途中経過 (確定結果と同じ並びで、届いた分だけを見せる)
  private searchingTree(): DocumentFragment {
    const frag = document.createDocumentFragment();
    if (!this.state.partial.length) {
      this.summary.hidden = true;
      frag.appendChild(searchingRow(this.state.outcome === "stopped"));
      return frag;
    }
    const groups = groupResults(sortResults(this.state.partial, this.options));
    this.summary.hidden = false;
    this.summary.replaceChildren(
      countRow(`${groups.length.toLocaleString()} 個のファイルに ${this.state.partial.length.toLocaleString()} 件 (${this.state.outcome === "stopped" ? "検索を中止" : "検索中"})`)
    );
    this.appendGroups(frag, groups);
    frag.appendChild(searchingRow(this.state.outcome === "stopped"));
    return frag;
  }

  private resultTree(): DocumentFragment {
    const outcome = this.state.outcome as WorkspaceSearchOutcome;
    // 確定結果も途中経過と同じ関数に通す。backend の返す順は走査順で、並びは表示の都合
    const groups = groupResults(sortResults(outcome.results, this.options));
    this.renderSummary(outcome, groups.length);

    const frag = document.createDocumentFragment();
    if (outcome.pattern_error) {
      // 正規表現を打っている途中は必ず壊れる。エラーとして黙らせず、理由だけ出す
      frag.appendChild(warning(outcome.pattern_error));
      return frag;
    }
    if (!groups.length) {
      frag.appendChild(emptyNotice(searchScopeSummary(this.options, outcome.file_name_match_mode)));
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
    const summary = this.summary;
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
      this.state.collapseTouched = true;
      // 集合が持つのは「既定と逆にするファイル」。既定へ戻すなら取り除く
      if (this.state.collapsed.has(group.relPath)) this.state.collapsed.delete(group.relPath);
      else this.state.collapsed.add(group.relPath);
      this.ports.onViewChange();
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
    div.addEventListener("click", () => this.ports.onOpen(match, false));
    this.bindOpen(div, match);
    return div;
  }

  // ホイールクリックと右クリックは、どちらの行でも「新規タブで開く」入口になる
  private bindOpen(row: HTMLElement, match: WorkspaceSearchResult) {
    row.addEventListener("auxclick", (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      this.ports.onOpen(match, true);
    });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.ports.onContextMenu(e.clientX, e.clientY, {
        relPath: match.rel_path,
        isDir: false,
        // ファイル名一致の line/col は本文の位置ではない (どちらも 0)。飛び先を持たせない
        goto: match.is_filename ? undefined : { line: match.line, col: match.col },
      });
    });
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

function searchingRow(stopped: boolean): HTMLElement {
  const div = document.createElement("div");
  div.className = "ws-empty";
  div.textContent = stopped ? "検索を中止しました" : "検索中…";
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

import type { EditManyItem, WorkspaceSearchOptions, WorkspaceSearchOutcome, WorkspaceSearchResult } from "./api";
import type { ContextTarget } from "./context-target";
import { isMiddleClick } from "./interaction-constants";
import { CHEVRON_DOWN, CHEVRON_RIGHT, iconButton } from "./icon-button";
import { groupResults, highlightedPreview, searchResultGoto, sortResults, type ResultGroup } from "./search-results";
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
  onCancel: (searchId: number) => void | Promise<void>;
  onCancelError?: (error: unknown) => void | Promise<void>;
  onError: (error: unknown) => Promise<void>;
  // 選択範囲は result.highlights、画面内の全一致強調は query を使う。
  // 正規表現ではパターン長と一致長が異なるため、両者を混同しない。
  onOpen: (
    result: WorkspaceSearchResult,
    newTab: boolean,
    query: WorkspaceSearchHighlightQuery,
  ) => void | boolean | Promise<void | boolean>;
  // 本文一致を検索結果の位置で1件置換する。成功時は呼び出し側が
  // refreshAfterDocumentChange を通知する。ファイル名一致では呼ばない。
  onReplace: (result: WorkspaceSearchResult, replacement: string) => void | boolean | Promise<void | boolean>;
  onContextMenu: (x: number, y: number, target: ContextTarget) => void;
  // 検索条件が変わった。保存先を知るのは呼び出し側 (ここは永続化を知らない)
  onOptionsChange: (options: WorkspaceSearchOptions) => void;
  // 出すべき中身が変わった → 器の描き替えを頼む
  onViewChange: () => void;
}

export interface WorkspaceSearchHighlightQuery {
  pat: string;
  matchCase: boolean;
  useRegex: boolean;
  wholeWord: boolean;
}

// DOM の行数だけは有限にしないと画面が固まる。超えた分は隠さず「ここまで」と告げる
const MAX_RENDERED_ROWS = 3000;
// これを超える結果は畳んで出す (件数が多いときにファイル一覧を先に見せるため)
const AUTO_COLLAPSE_MATCHES = 500;
type ToggleKey = BoolOptionKey;
type SearchState = WorkspaceSearchOutcome | "searching" | "stopped" | null;
type SearchViewState = {
  pattern: string;
  outcome: SearchState;
  partial: WorkspaceSearchResult[];
  selected: string | null;
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
  private replaceInput: HTMLInputElement;
  private replaceRow: HTMLElement;
  private replaceToggle: HTMLButtonElement;
  private searchStop: HTMLButtonElement;
  private summary: HTMLElement;
  private toggleButtons = new Map<ToggleKey, HTMLButtonElement>();
  private options: WorkspaceSearchOptions;
  private searchOptionsChangedWhileHidden = false;
  private folderRoot: string | null = null;
  private states = new Map<string, SearchViewState>();
  private searchGen = 0;
  private searchTimer: number | undefined;
  private running: Promise<WorkspaceSearchOutcome> | null = null; // 走行中の検索
  private runningSearchId: number | null = null;
  private openRequest = 0;
  private replacementInProgress = false;
  private replaceVisible = false;
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
    this.replaceToggle = row.querySelector(".ws-replace-toggle")!;
    this.replaceRow = this.buildReplaceRow();
    this.replaceRow.hidden = true;
    this.replaceInput = this.replaceRow.querySelector("input")!;
    this.summary = document.createElement("div");
    this.summary.className = "ws-summary";
    this.summary.hidden = true;
    this.searchStop = header.querySelector(".ws-stop")!;
    this.bar.append(header, row, this.replaceRow, this.summary);
    this.searchInput.addEventListener("input", () => this.queueSearch());
  }

  // 結果ツリーを出すべきか (検索中か、結果が確定しているか)
  get showing(): boolean {
    return this.folderRoot !== null && this.state.outcome !== null;
  }

  setFolderRoot(folderRoot: string | null) {
    if (folderRoot === this.folderRoot) return;
    this.openRequest++;
    if (this.folderRoot && this.state.outcome === "searching") this.stop();
    else {
      this.searchGen++;
      window.clearTimeout(this.searchTimer);
    }
    this.folderRoot = folderRoot;
    this.bar.hidden = folderRoot === null;
    if (folderRoot) {
      this.searchInput.value = this.state.pattern;
      if (this.searchOptionsChangedWhileHidden) {
        this.searchOptionsChangedWhileHidden = false;
        if (this.searchInput.value) this.queueSearch(0);
      }
    }
    this.ports.onViewChange();
  }

  // 未保存の本文は backend のフォルダ検索から見えないため再走査しない。
  // 編集範囲だけを既存結果へ反映し、後続一致の位置を現バッファに合わせる。
  refreshAfterDocumentChange(relPath: string, edits: EditManyItem[]) {
    if (!this.folderRoot || !this.state.pattern || !relPath || !edits.length) return;
    this.openRequest++;
    if (this.state.outcome === "searching") this.stop();
    const normalizedRelPath = relPath.replace(/\\/g, "/");
    const update = (results: WorkspaceSearchResult[]) => results.flatMap((result) =>
      result.rel_path.replace(/\\/g, "/") !== normalizedRelPath || result.is_filename
        ? [result]
        : adjustResultAfterEdits(result, edits)
    );
    this.state.partial = update(this.state.partial);
    if (this.state.outcome && typeof this.state.outcome === "object") {
      this.state.outcome = { ...this.state.outcome, results: update(this.state.outcome.results) };
    }
    if (this.state.selected && !this.shownResults().some((result) => searchResultKey(result) === this.state.selected)) {
      this.state.selected = null;
    }
    this.ports.onViewChange();
  }

  private get state(): SearchViewState {
    const root = this.folderRoot;
    if (!root) throw new Error("フォルダ検索の対象がありません");
    let state = this.states.get(root);
    if (!state) {
      state = {
        pattern: "",
        outcome: null,
        partial: [],
        selected: null,
        collapseByDefault: false,
        collapsed: new Set(),
        collapseTouched: false,
      };
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
    const settings = iconButton("ws-settings", "⚙", "検索の設定");
    settings.addEventListener("click", () => this.openSettings());
    header.append(title, scope, stop, refresh, clear, settings);
    return header;
  }

  private buildInputRow(): HTMLElement {
    const row = document.createElement("div");
    row.className = "ws-search-row";
    const replaceToggle = iconButton("ws-replace-toggle", CHEVRON_RIGHT, "置換欄の表示切替");
    replaceToggle.setAttribute("aria-expanded", "false");
    replaceToggle.addEventListener("click", () => this.toggleReplace());
    const input = document.createElement("input");
    input.placeholder = "検索";
    input.spellcheck = false;
    const toggles = document.createElement("span");
    toggles.className = "ws-toggles";
    toggles.append(...MATCH_TOGGLES.map(([icon, key]) => this.targetToggle(icon, key)));
    row.append(replaceToggle, input, toggles);
    return row;
  }

  private toggleReplace() {
    this.replaceVisible = !this.replaceVisible;
    this.replaceRow.hidden = !this.replaceVisible;
    this.replaceToggle.textContent = this.replaceVisible ? CHEVRON_DOWN : CHEVRON_RIGHT;
    this.replaceToggle.setAttribute("aria-expanded", String(this.replaceVisible));
    if (this.replaceVisible) this.replaceInput.focus();
    this.ports.onViewChange();
  }

  private buildReplaceRow(): HTMLElement {
    const row = document.createElement("div");
    row.className = "ws-replace-row";
    const input = document.createElement("input");
    input.placeholder = "置換後";
    input.spellcheck = false;
    const hint = document.createElement("span");
    hint.className = "ws-replace-hint";
    hint.textContent = "一致行の置換";
    row.append(input, hint);
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

  setSearchOptions(options: WorkspaceSearchOptions) {
    this.options = clampSearchOptions(options);
    this.syncTargetToggles();
    if (!this.folderRoot) {
      this.searchOptionsChangedWhileHidden = true;
      return;
    }
    if (this.searchInput.value) this.queueSearch(0);
    else this.ports.onViewChange();
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
    this.state.selected = null;
    this.openRequest++;
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
    this.searchTimer = window.setTimeout(() => {
      void this.run(gen, pat, this.options).catch((error) => this.reportUiError(error));
    }, delay);
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
    this.openRequest++;
    this.setOutcome(null);
    this.searchInput.value = "";
    this.state.pattern = "";
    this.state.selected = null;
    if (focus) this.searchInput.focus();
  }

  private cancelRunningSearch() {
    const searchId = this.runningSearchId;
    if (searchId === null) return;
    try {
      void Promise.resolve(this.ports.onCancel(searchId)).catch((error) => {
        void this.reportCancelError(error);
      });
    } catch (error) {
      void this.reportCancelError(error);
    }
  }

  private async reportCancelError(error: unknown) {
    try {
      if (this.ports.onCancelError) await this.ports.onCancelError(error);
      else await this.ports.onError(error);
    } catch (reportError) {
      console.error("検索中止エラーを表示できませんでした", reportError);
    }
  }

  // 検索中に backend から届いた途中経過。世代が変わっていれば捨てる
  // (打ち切った検索の取りこぼしが次の検索の結果に混ざらないようにする)。
  acceptBatch(searchId: number, results: WorkspaceSearchResult[]) {
    if (searchId !== this.searchGen || this.folderRoot === null || this.state.outcome !== "searching") return;
    this.state.partial.push(...results);
    this.autoCollapse(this.state.partial);
    // backend が送出間隔を制限するため、ここで同じ待機を重ねない。
    this.ports.onViewChange();
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
    if (outcome !== "stopped") this.state.partial = [];
    if (outcome === null) this.summary.hidden = true;
    if (outcome === "searching") this.state.collapseTouched = false; // 新しい検索の始まり
    if (outcome && outcome !== "searching" && outcome !== "stopped") this.autoCollapse(outcome.results);
    this.ports.onViewChange();
  }

  collapseAllGroups() {
    if (!this.shownResults().length) return;
    this.state.collapseTouched = true;
    this.state.collapseByDefault = true;
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

  // 新しい検索を開始すると backend 側が前の走査をキャンセルする。
  // 古い Promise の完了を待つと、キャンセル失敗時に新しい条件まで永久に待たされる。
  private async run(gen: number, pat: string, options: WorkspaceSearchOptions) {
    if (gen !== this.searchGen) return; // 待っている間にまた条件が変わった
    let run: Promise<WorkspaceSearchOutcome> | null = null;
    try {
      run = this.ports.onSearch(pat, options, gen);
      this.running = run;
      this.runningSearchId = gen;
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
      if (this.running === run) {
        this.running = null;
        this.runningSearchId = null;
      }
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
    if (outcome.skipped_files) {
      summary.appendChild(warning(
        `${outcome.skipped_files.toLocaleString()} 件のファイルを読み取れず、完全には検索できなかった`
      ));
    }
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
    div.className = `ws-match${this.state.selected === searchResultKey(match) ? " sel" : ""}`;
    const mark = document.createElement("span");
    mark.className = "ws-line";
    mark.textContent = match.is_filename ? "名" : String(match.line + 1);
    const preview = document.createElement("span");
    preview.className = "ws-preview";
    preview.appendChild(highlightedPreview(match.preview, match.highlights));
    div.append(mark, preview);
    if (!match.is_filename) {
      const replace = document.createElement("button");
      replace.className = "ws-replace-button";
      replace.type = "button";
      replace.textContent = "置換";
      replace.title = "この一致だけ置換";
      replace.hidden = !this.replaceVisible;
      replace.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void this.invokeReplace(match);
      });
      div.appendChild(replace);
    }
    div.title = match.preview;
    div.addEventListener("click", () => this.invokeOpen(match, false));
    this.bindOpen(div, match);
    return div;
  }

  private async invokeReplace(match: WorkspaceSearchResult) {
    if (this.replacementInProgress) return;
    this.replacementInProgress = true;
    this.openRequest++; // 置換開始前の「開く」完了を無効化する
    try {
      const replaced = await this.ports.onReplace(match, this.replaceInput.value);
      if (replaced === false) return;
      // 未保存の本文はディスク検索で戻せない。onReplace 側の編集通知で
      // 既存結果を補正済みなので、ここで古いディスク内容を検索し直さない。
    } catch (error) {
      await this.reportUiError(error);
    } finally {
      this.replacementInProgress = false;
    }
  }

  private invokeOpen(match: WorkspaceSearchResult, newTab: boolean) {
    const request = ++this.openRequest;
    const key = searchResultKey(match);
    const query: WorkspaceSearchHighlightQuery = {
      pat: this.state.pattern,
      matchCase: this.options.match_case,
      useRegex: this.options.use_regex,
      wholeWord: this.options.whole_word,
    };
    try {
      void Promise.resolve(this.ports.onOpen(match, newTab, query))
        .then((opened) => {
          if (opened === false || request !== this.openRequest) return;
          this.state.selected = key;
          this.ports.onViewChange();
        })
        .catch((error) => this.reportUiError(error));
    } catch (error) {
      void this.reportUiError(error);
    }
  }

  private async reportUiError(error: unknown) {
    try {
      await this.ports.onError(error);
    } catch (reportError) {
      console.error("検索結果を開けませんでした", reportError);
    }
  }

  // ホイールクリックと右クリックは、どちらの行でも「新規タブで開く」入口になる
  private bindOpen(row: HTMLElement, match: WorkspaceSearchResult) {
    row.addEventListener("auxclick", (e) => {
      if (!isMiddleClick(e)) return;
      e.preventDefault();
      this.invokeOpen(match, true);
    });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.ports.onContextMenu(e.clientX, e.clientY, {
        relPath: match.rel_path,
        isDir: false,
        goto: searchResultGoto(match),
      });
    });
  }
}

function searchResultKey(result: Pick<WorkspaceSearchResult, "rel_path" | "line" | "col" | "is_filename">): string {
  return `${result.rel_path}\u0000${result.line}\u0000${result.col}\u0000${result.is_filename ? "name" : "text"}`;
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

function adjustResultAfterEdits(result: WorkspaceSearchResult, edits: EditManyItem[]): WorkspaceSearchResult[] {
  let current: WorkspaceSearchResult | null = result;
  const ordered = [...edits].sort((a, b) => comparePos(b.start, a.start));
  for (const edit of ordered) {
    if (!current) break;
    current = adjustResultAfterEdit(current, edit);
  }
  return current ? [current] : [];
}

function adjustResultAfterEdit(result: WorkspaceSearchResult, edit: EditManyItem): WorkspaceSearchResult | null {
  const length = result.highlights[0]?.[1] ?? 0;
  const start = { line: result.line, col: result.col };
  const end = { line: result.line, col: result.col + length };
  const insertion = comparePos(edit.start, edit.end) === 0;
  const overlaps = insertion
    ? comparePos(start, edit.start) < 0 && comparePos(edit.start, end) < 0
    : comparePos(start, edit.end) < 0 && comparePos(edit.start, end) < 0;
  if (overlaps || (!length && comparePos(start, edit.start) === 0 && !insertion)) return null;
  if (comparePos(start, edit.end) < 0) return result;
  const mapped = mapPositionAfterEdit(start, edit);
  return { ...result, line: mapped.line, col: mapped.col };
}

function mapPositionAfterEdit(pos: { line: number; col: number }, edit: EditManyItem) {
  if (comparePos(pos, edit.start) < 0) return pos;
  const replacementLines = edit.text.split("\n");
  const replacementEnd = replacementLines.length === 1
    ? { line: edit.start.line, col: edit.start.col + [...replacementLines[0]].length }
    : {
      line: edit.start.line + replacementLines.length - 1,
      col: [...replacementLines[replacementLines.length - 1]].length,
    };
  if (comparePos(pos, edit.end) >= 0) {
    if (pos.line === edit.end.line) {
      return { line: replacementEnd.line, col: replacementEnd.col + pos.col - edit.end.col };
    }
    return {
      line: pos.line + replacementEnd.line - edit.end.line,
      col: pos.col,
    };
  }
  return replacementEnd;
}

function comparePos(a: { line: number; col: number }, b: { line: number; col: number }): number {
  return a.line - b.line || a.col - b.col;
}

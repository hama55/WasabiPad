// エディタ上部を一行占有する検索/置換バー。実際の検索は backend(mmap 全体走査)へ委譲。
import { showMessage } from "./prompt";
import { addSearchInputActions } from "./search-input-actions";
import { optionTitle, type SearchHighlightQuery } from "./workspace-search-options";
import { unescapePattern } from "./editor-math";

export class FindBar {
  private root: HTMLElement;
  private findIn: HTMLInputElement;
  private repIn: HTMLInputElement;
  private caseChk: HTMLInputElement;
  private regexChk: HTMLInputElement;
  private wordChk: HTMLInputElement;
  private syncFindInput: () => void;
  private status: HTMLElement;
  private onFind: (pat: string, forward: boolean, matchCase: boolean, useRegex: boolean, wholeWord: boolean) => Promise<boolean>;
  private onReplaceAll: (pat: string, rep: string, matchCase: boolean, useRegex: boolean, wholeWord: boolean) => Promise<number>;
  private onReplaceNext: (pat: string, rep: string, matchCase: boolean, useRegex: boolean, wholeWord: boolean) => Promise<boolean>;
  private onReplaceVisible: (pat: string, rep: string, matchCase: boolean, useRegex: boolean, wholeWord: boolean) => Promise<number>;
  private onDone: () => void;
  private onError: (message: string, error: unknown) => void | Promise<void>;
  private onInitialQuery?: (pat: string, matchCase: boolean, useRegex: boolean, wholeWord: boolean) => void;
  private running: Promise<void> = Promise.resolve();
  private findRequest = 0;

  constructor(
    private host: HTMLElement,
    onFind: FindBar["onFind"],
    onReplaceAll: FindBar["onReplaceAll"],
    onReplaceVisible: FindBar["onReplaceVisible"],
    onReplaceNext: FindBar["onReplaceNext"],
    onDone: () => void,
    onError: (message: string, error: unknown) => void | Promise<void>,
    onInitialQuery?: FindBar["onInitialQuery"],
    private onFindAll?: (query: SearchHighlightQuery) => Promise<void>,
  ) {
    this.onFind = onFind;
    this.onReplaceAll = onReplaceAll;
    this.onReplaceNext = onReplaceNext;
    this.onDone = onDone;
    this.onError = onError;
    this.onInitialQuery = onInitialQuery;
    this.onReplaceVisible = onReplaceVisible;

    this.root = document.createElement("div");
    this.root.className = "ve-find";
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="ve-find-row">
        <input class="ve-find-in" placeholder="検索" aria-label="検索" spellcheck="false" />
        <span class="ve-find-options">
          <label class="ve-find-case"><input type="checkbox" /> Aa</label>
          <label class="ve-find-word"><input type="checkbox" /> ab</label>
          <label class="ve-find-regex"><input type="checkbox" /> .*</label>
        </span>
        <button class="ve-find-prev" title="前へ (Shift+Enter)">▲</button>
        <button class="ve-find-next" title="次へ (Enter)">▼</button>
        <button class="ve-find-all" type="button" title="全て検索">全て</button>
        <button class="ve-find-help" type="button" title="検索記法のヘルプ" aria-label="検索記法のヘルプ">?</button>
        <span class="ve-find-status"></span>
        <input class="ve-rep-in" placeholder="置換" aria-label="置換" spellcheck="false" />
        <div class="ve-rep-actions"><button class="ve-rep-next">置換</button><button class="ve-rep-visible">画面内</button><button class="ve-rep-all">全置換</button></div>
        <button class="ve-find-close" title="閉じる (Esc)">✕</button>
      </div>`;
    host.appendChild(this.root);

    this.findIn = this.root.querySelector(".ve-find-in")!;
    this.repIn = this.root.querySelector(".ve-rep-in")!;
    this.caseChk = this.root.querySelector(".ve-find-case input")!;
    this.regexChk = this.root.querySelector(".ve-find-regex input")!;
    this.wordChk = this.root.querySelector(".ve-find-word input")!;
    this.status = this.root.querySelector(".ve-find-status")!;
    for (const [selector, key] of [["case", "match_case"], ["word", "whole_word"], ["regex", "use_regex"]] as const) {
      const label = this.root.querySelector<HTMLElement>(`.ve-find-${selector}`)!;
      label.title = optionTitle(key);
      label.querySelector("input")!.setAttribute("aria-label", optionTitle(key));
    }
    this.syncFindInput = addSearchInputActions(this.findIn, error => this.reportError("入力を編集できませんでした", error));
    this.findIn.parentElement!.classList.add("ve-find-field");
    addSearchInputActions(this.repIn, error => this.reportError("入力を編集できませんでした", error));
    this.repIn.parentElement!.classList.add("ve-rep-field");

    this.findIn.addEventListener("input", () => this.runFind(true));
    this.root.querySelector(".ve-find-help")!.addEventListener("click", () => {
      void showMessage("エディタ検索記法", "通常検索・置換欄では次の記法を使えます。\n\\n: 改行\n\\t: タブ\n\\\\: バックスラッシュ\n正規表現検索は行内が対象です。置換欄の$1などは文字として挿入します。");
    });
    this.findIn.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.runFind(!e.shiftKey);
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      }
    });
    this.caseChk.addEventListener("change", () => this.runFind(true));
    this.regexChk.addEventListener("change", () => this.runFind(true));
    this.wordChk.addEventListener("change", () => this.runFind(true));
    this.repIn.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
    });
    this.root.querySelector(".ve-find-next")!.addEventListener("click", () => this.runFind(true));
    this.root.querySelector(".ve-find-prev")!.addEventListener("click", () => this.runFind(false));
    this.root.querySelector(".ve-find-all")!.addEventListener("click", () => this.run(async () => { await this.onFindAll?.(this.query); }));
    this.root.querySelector(".ve-find-close")!.addEventListener("click", () => this.close());
    this.root.querySelector(".ve-rep-all")!.addEventListener("click", () => this.run(() => this.replaceAll()));
    this.root.querySelector(".ve-rep-visible")!.addEventListener("click", () => this.run(() => this.replaceVisible()));
    this.root.querySelector(".ve-rep-next")!.addEventListener("click", () => this.run(() => this.replaceNext()));
  }

  open(initial: string) {
    this.host.classList.add("ve-search-open");
    this.root.hidden = false;
    if (initial) this.findIn.value = initial;
    this.syncFindInput();
    this.status.textContent = "";
    this.onInitialQuery?.(this.findIn.value, ...this.options);
    this.findIn.focus();
    this.findIn.select();
  }

  close() {
    this.findRequest++;
    this.host.classList.remove("ve-search-open");
    this.root.hidden = true;
    this.onDone();
  }

  setProgress(text: string) {
    this.status.textContent = text;
    this.status.title = text;
  }

  private get options(): [boolean, boolean, boolean] {
    return [this.caseChk.checked, this.regexChk.checked, this.wordChk.checked];
  }

  get query(): SearchHighlightQuery {
    const [matchCase, useRegex, wholeWord] = this.options;
    return { pat: useRegex ? this.findIn.value : unescapePattern(this.findIn.value), matchCase, useRegex, wholeWord };
  }

  private async next(forward: boolean) {
    const request = ++this.findRequest;
    const pat = this.findIn.value;
    if (!pat) {
      await this.onFind("", forward, ...this.options);
      if (request === this.findRequest) this.status.textContent = "";
      return;
    }
    // 後方検索やチャンク検索の最初のIPC往復中は無反応に見えるため、開始直後に表示する
    // (チャンク検索が進捗を報告し始めればこの文言は setProgress() で上書きされる)。
    this.status.textContent = "検索中…";
    let ok: boolean;
    try {
      ok = await this.onFind(pat, forward, ...this.options);
    } catch (error) {
      if (request !== this.findRequest) return;
      throw error;
    }
    if (request !== this.findRequest) return;
    this.status.textContent = ok ? "" : "見つかりません";
  }

  private runFind(forward: boolean) {
    void this.next(forward)
      .catch((error) => this.reportError("検索・置換を実行できませんでした", error));
  }

  private async replaceAll() {
    const pat = this.findIn.value;
    if (!pat) return;
    const n = await this.onReplaceAll(pat, this.repIn.value, ...this.options);
    this.status.textContent = `${n}件置換`;
  }

  private async replaceVisible() {
    const pat = this.findIn.value;
    if (!pat) return;
    const n = await this.onReplaceVisible(pat, this.repIn.value, ...this.options);
    this.status.textContent = `${n}件置換`;
  }

  private async replaceNext() {
    const pat = this.findIn.value;
    if (!pat) return;
    const ok = await this.onReplaceNext(pat, this.repIn.value, ...this.options);
    this.status.textContent = ok ? "" : "見つかりません";
  }

  private run(operation: () => Promise<void>) {
    this.running = this.running
      .catch(() => {})
      .then(operation)
      .catch((error) => this.reportError("検索・置換を実行できませんでした", error));
  }

  private async reportError(message: string, error: unknown) {
    if (String(error).includes("検索パターンが不正")) {
      this.setProgress(String(error));
      return;
    }
    this.status.textContent = "操作に失敗しました";
    try {
      await this.onError(message, error);
    } catch (reportError) {
      console.error("検索エラーを表示できませんでした", reportError);
    }
  }
}

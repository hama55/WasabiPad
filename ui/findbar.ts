// エディタ右上に重ねる検索/置換バー。実際の検索は backend(mmap 全体走査)へ委譲。
export class FindBar {
  private root: HTMLElement;
  private toggleBtn: HTMLButtonElement;
  private findIn: HTMLInputElement;
  private repIn: HTMLInputElement;
  private caseChk: HTMLInputElement;
  private status: HTMLElement;
  private onFind: (pat: string, forward: boolean, matchCase: boolean) => Promise<boolean>;
  private onReplaceAll: (pat: string, rep: string, matchCase: boolean) => Promise<number>;
  private onReplaceNext: (pat: string, rep: string, matchCase: boolean) => Promise<boolean>;
  private onDone: () => void;

  constructor(
    host: HTMLElement,
    onFind: (pat: string, forward: boolean, matchCase: boolean) => Promise<boolean>,
    onReplaceAll: (pat: string, rep: string, matchCase: boolean) => Promise<number>,
    onReplaceNext: (pat: string, rep: string, matchCase: boolean) => Promise<boolean>,
    onDone: () => void
  ) {
    this.onFind = onFind;
    this.onReplaceAll = onReplaceAll;
    this.onReplaceNext = onReplaceNext;
    this.onDone = onDone;

    this.root = document.createElement("div");
    this.root.className = "ve-find";
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="ve-find-row">
        <button class="ve-find-toggle" title="置換欄の表示切替">▶</button>
        <input class="ve-find-in" placeholder="検索" spellcheck="false" />
        <label class="ve-find-case"><input type="checkbox" /> Aa</label>
        <button class="ve-find-prev" title="前へ (Shift+Enter)">▲</button>
        <button class="ve-find-next" title="次へ (Enter)">▼</button>
        <span class="ve-find-status"></span>
        <button class="ve-find-close" title="閉じる (Esc)">✕</button>
      </div>
      <div class="ve-find-row ve-rep-row">
        <input class="ve-rep-in" placeholder="置換" spellcheck="false" />
        <div class="ve-rep-actions"><button class="ve-rep-next">連続置換</button><button class="ve-rep-all">すべて置換</button></div>
      </div>`;
    host.appendChild(this.root);

    this.toggleBtn = this.root.querySelector(".ve-find-toggle")!;
    this.findIn = this.root.querySelector(".ve-find-in")!;
    this.repIn = this.root.querySelector(".ve-rep-in")!;
    this.caseChk = this.root.querySelector(".ve-find-case input")!;
    this.status = this.root.querySelector(".ve-find-status")!;

    this.toggleBtn.addEventListener("click", () => this.toggleReplace());
    this.findIn.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.next(!e.shiftKey);
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      }
    });
    this.repIn.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
    });
    this.root.querySelector(".ve-find-next")!.addEventListener("click", () => this.next(true));
    this.root.querySelector(".ve-find-prev")!.addEventListener("click", () => this.next(false));
    this.root.querySelector(".ve-find-close")!.addEventListener("click", () => this.close());
    this.root.querySelector(".ve-rep-all")!.addEventListener("click", () => this.replaceAll());
    this.root.querySelector(".ve-rep-next")!.addEventListener("click", () => this.replaceNext());
  }

  open(initial: string) {
    this.root.hidden = false;
    if (initial) this.findIn.value = initial;
    this.status.textContent = "";
    this.findIn.focus();
    this.findIn.select();
  }

  private toggleReplace() {
    const on = this.root.classList.toggle("with-rep");
    this.toggleBtn.textContent = on ? "▼" : "▶";
    if (on) this.repIn.focus();
  }

  close() {
    this.root.hidden = true;
    this.onDone();
  }

  setProgress(text: string) {
    this.status.textContent = text;
  }

  private async next(forward: boolean) {
    const pat = this.findIn.value;
    if (!pat) return;
    // 後方検索やチャンク検索の最初のIPC往復中は無反応に見えるため、開始直後に表示する
    // (チャンク検索が進捗を報告し始めればこの文言は setProgress() で上書きされる)。
    this.status.textContent = "検索中…";
    const ok = await this.onFind(pat, forward, this.caseChk.checked);
    this.status.textContent = ok ? "" : "見つかりません";
  }

  private async replaceAll() {
    const pat = this.findIn.value;
    if (!pat) return;
    const n = await this.onReplaceAll(pat, this.repIn.value, this.caseChk.checked);
    this.status.textContent = `${n}件置換`;
  }

  private async replaceNext() {
    const pat = this.findIn.value;
    if (!pat) return;
    const ok = await this.onReplaceNext(pat, this.repIn.value, this.caseChk.checked);
    this.status.textContent = ok ? "" : "見つかりません";
  }
}

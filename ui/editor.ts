import * as api from "./api";
import type { Pos } from "./api";
import { FindBar } from "./findbar";
import { DEFAULT_EDITOR_CONFIG, EditorConfig } from "./editor-config";
import { showMenu, type MenuItem } from "./menu";

const CHUNK = 512; // 行取得のバックエンド往復単位
const CACHE_MAX = 64;
const OVERSCAN = 8;
// ブラウザ実装は要素の絶対サイズ/スクロール範囲に上限がある (~1670万px 前後、
// DPI拡大率によってはさらに小さい)。行数×行高がこれを超える巨大文書では
// コンテナの高さをこの値に丸め、スクロール位置と行番号を比例マッピングする
// (ve-scale モード)。
const MAX_SAFE_HEIGHT = 5_000_000;

// 折り返し数は可視域近傍だけ保持する。全行配列にすると巨大文書でWebViewの
// メモリを本文以上に消費するため、未測定行は1表示行として近似する。
class WrapRows {
  private rows = new Map<number, number>();
  private readonly maxEntries = 4096;

  clear() {
    this.rows.clear();
  }

  get(line: number): number {
    return this.rows.get(line) ?? 1;
  }

  set(line: number, rows: number, center: number): boolean {
    const previous = this.get(line);
    if (rows === previous) return false;
    if (rows === 1) this.rows.delete(line);
    else this.rows.set(line, rows);
    this.prune(center);
    return true;
  }

  sum(end: number): number {
    let total = end;
    for (const [line, rows] of this.rows) {
      if (line < end) total += rows - 1;
    }
    return total;
  }

  lowerBound(target: number, lineCount: number): number {
    let lo = 0;
    let hi = Math.max(0, lineCount - 1);
    while (lo < hi) {
      const mid = lo + Math.floor((hi - lo) / 2);
      if (this.sum(mid + 1) >= target) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  private prune(center: number) {
    if (this.rows.size <= this.maxEntries) return;
    let farthest: number | undefined;
    for (const line of this.rows.keys()) {
      if (farthest === undefined || Math.abs(line - center) > Math.abs(farthest - center)) farthest = line;
    }
    if (farthest !== undefined) this.rows.delete(farthest);
  }
}

// char index <-> UTF-16 offset (行文字列内)。backend は char 単位、DOM は UTF-16。
function charToU16(s: string, charIdx: number): number {
  let u = 0;
  let c = 0;
  for (const ch of s) {
    if (c === charIdx) return u;
    u += ch.length;
    c++;
  }
  return s.length;
}
function charLen(s: string): number {
  let c = 0;
  for (const _ of s) c++;
  return c;
}
function u16ToChar(s: string, offset: number): number {
  let u = 0;
  let c = 0;
  for (const ch of s) {
    if (u >= offset) break;
    u += ch.length;
    c++;
  }
  return c;
}
// 検索/置換欄の \n \t \\ を実際の改行・タブ・バックスラッシュへ解釈する (他のバックスラッシュ列はそのまま)
function unescapePattern(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && i + 1 < s.length) {
      const next = s[i + 1];
      if (next === "n") { out += "\n"; i++; continue; }
      if (next === "t") { out += "\t"; i++; continue; }
      if (next === "\\") { out += "\\"; i++; continue; }
    }
    out += s[i];
  }
  return out;
}

// チャンク分割検索の進捗率。開始行(from)から末尾まで進み、そこで折り返して
// from行手前まで進む1周分(総行数)を分母とする概算値。
function findProgressPercent(cursor: api.FindCursor, fromLine: number, totalLines: number): number {
  if (totalLines <= 0) return 100;
  const scanned = cursor.wrapped ? totalLines - fromLine + cursor.line : cursor.line - fromLine;
  return Math.min(99, Math.max(0, Math.round((scanned / totalLines) * 100)));
}

function cmp(a: Pos, b: Pos): number {
  return a.line !== b.line ? a.line - b.line : a.col - b.col;
}
// 単語移動用の文字クラス: 0=空白 / 1=語(英数・非ASCII) / 2=記号
function charClass(ch: string): number {
  if (ch === " " || ch === "\t") return 0;
  const code = ch.codePointAt(0)!;
  const isWord =
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95 ||
    code > 127;
  return isWord ? 1 : 2;
}

// 全ファイル共通の仮想スクロールエディタ。文書は backend(mmap/overlay)が所有し、
// ここは可視スライスの描画と入力の中継のみを行う (全文を持たない)。
export class VirtualEditor {
  private gutter: HTMLElement;
  private scroll: HTMLElement;
  private inner: HTMLElement;
  private linesLayer: HTMLElement; // 行/選択ハイライトの描画専用コンテナ
  private caretEl: HTMLElement;
  private input: HTMLTextAreaElement;
  private findBar: FindBar;

  private lineCount = 1;
  private readOnly = false;
  private cache = new Map<number, string[]>(); // chunk -> lines
  private pending = new Set<number>();
  private raf = 0;
  private maxWidth = 0;
  private fontFamily: string;
  private fontSize: number;
  private lineHeight: number;
  private readonly lineHeightExtra: number;
  private readonly paddingLeft: number;
  private readonly gutterWidth: number;
  private wrap = false;
  private wrapRows = new WrapRows();
  private scaleMode = false; // 行数×行高が MAX_SAFE_HEIGHT を超える巨大文書
  private scrollHeight = 0; // ve-inner に実際に設定する高さ (scaleMode 時は丸め)
  private viewTop = 0; // 直近 render() 時点の scroll.scrollTop
  private viewTopLine = 0; // 直近 render() 時点で viewTop に対応する行番号
  // scaleMode 専用: 現在の仮想的な先頭行 (小数)。scrollTop からの逆算に頼らない権威値。
  // 巨大文書 (例: 2億4千万行) では1行あたりの圧縮px幅が1デバイスpx未満になり、
  // ホイールの小さい delta を scrollTop へ書き込んでもブラウザ側で丸められて
  // 変化が消えてしまう。scrollTop を読み戻して現在地を求めると、その丸めで
  // 毎回ゼロに戻ってしまい延々スクロールできなくなるため、ここで独自に保持する。
  private topLineF = 0;
  private scrollbarDragging = false; // ネイティブscrollTopを入力として扱う間だけtrue

  private caret: Pos = { line: 0, col: 0 };
  private anchor: Pos = { line: 0, col: 0 };
  private goalX: number | null = null;
  private composing = false;
  private chain: Promise<unknown> = Promise.resolve();
  private findGen = 0; // 検索ループの世代。closeやEnter連打で古いループを打ち切るため
  private lastFindMatch: { start: Pos; end: Pos; pat: string; matchCase: boolean } | null = null; // 連続置換が対象にしてよい直前の一致
  private busy = false; // 全置換チャンク実行中は入力を無効化 (レジューム状態の破損防止)

  private onDocChange: (lineCount: number) => void;
  private onCursor: (line: number, col: number) => void;
  private onFontChange: (fontFamily: string, fontSize: number) => void;

  constructor(
    host: HTMLElement,
    onDocChange: (lineCount: number) => void,
    onCursor: (line: number, col: number) => void,
    onFontChange: (fontFamily: string, fontSize: number) => void,
    config: EditorConfig = DEFAULT_EDITOR_CONFIG
  ) {
    this.onDocChange = onDocChange;
    this.onCursor = onCursor;
    this.onFontChange = onFontChange;
    this.fontFamily = config.fontFamily;
    this.fontSize = config.fontSize;
    this.lineHeightExtra = config.lineHeightExtra;
    this.lineHeight = config.fontSize + config.lineHeightExtra;
    this.paddingLeft = config.paddingLeft;
    this.gutterWidth = config.gutterWidth;
    host.classList.add("ve");
    host.style.setProperty("--ve-font-family", this.fontFamily);
    host.style.setProperty("--ve-font", `${this.fontSize}px`);
    host.style.setProperty("--line-h", `${this.lineHeight}px`);
    host.style.setProperty("--ve-pad-left", `${this.paddingLeft}px`);
    host.style.setProperty("--gutter-w", `${this.gutterWidth}px`);

    this.gutter = el("div", "ve-gutter");
    this.scroll = el("div", "ve-scroll");
    this.inner = el("div", "ve-inner");
    this.linesLayer = el("div", "ve-lines");
    this.caretEl = el("div", "ve-caret");
    this.input = document.createElement("textarea");
    this.input.className = "ve-input";
    this.input.spellcheck = false;
    this.input.autocapitalize = "off";
    (this.input as unknown as { autocorrect: string }).autocorrect = "off";

    // caretEl/input は一度だけ挿入し、以後 render() では linesLayer の中身だけ差し替える。
    // (inner.replaceChildren に caretEl/input を含めて呼ぶと、フォーカス中の input が
    //  毎フレーム DOM から外れて再挿入され blur してしまい、クリック直後に一切入力できなくなる)
    this.inner.appendChild(this.linesLayer);
    this.inner.appendChild(this.caretEl);
    this.inner.appendChild(this.input);
    this.scroll.appendChild(this.inner);
    host.appendChild(this.gutter);
    host.appendChild(this.scroll);

    this.findBar = new FindBar(
      host,
      (pat, forward, mc) => this.doFind(pat, forward, mc),
      (pat, rep, mc) => this.doReplaceAll(pat, rep, mc),
      (pat, rep, mc) => this.doReplaceNext(pat, rep, mc),
      () => { this.findGen++; this.lastFindMatch = null; this.focus(); }
    );

    this.scroll.addEventListener("scroll", () => this.onScroll());
    this.scroll.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    this.scroll.addEventListener("mousedown", (e) => this.onMouseDown(e));
    this.scroll.addEventListener("contextmenu", (e) => this.onContextMenu(e));
    this.gutter.addEventListener("mousedown", (e) => this.onGutterMouseDown(e));
    this.input.addEventListener("keydown", (e) => this.onKeyDown(e));
    this.input.addEventListener("input", (e) => this.onInput(e as InputEvent));
    this.input.addEventListener("compositionstart", () => {
      this.composing = true;
      this.input.classList.add("ime"); // 変換中は textarea を可視化
      this.resizeImeInput();
      this.caretEl.classList.remove("on");
    });
    this.input.addEventListener("compositionend", () => this.onCompositionEnd());
    this.input.addEventListener("blur", () => this.caretEl.classList.remove("on"));
    this.input.addEventListener("focus", () => this.caretEl.classList.add("on"));
    window.addEventListener("mouseup", () => {
      if (!this.scrollbarDragging) return;
      this.topLineF = this.pxToLine(this.scroll.scrollTop);
      this.scrollbarDragging = false;
      this.schedule();
    });

    new ResizeObserver(() => {
      const topLine = this.scaleMode ? this.topLineF : this.pxToLine(this.scroll.scrollTop);
      const wasAtBottom = topLine >= this.maxTopLine();
      // 幅が変わるとCSSの折り返し数も変わる。古い実測値を使うと行位置がずれる。
      if (this.wrap) this.wrapRows.clear();
      this.updateMetrics();
      this.setTopLine(wasAtBottom ? this.maxTopLine() : topLine);
      this.schedule();
    }).observe(this.scroll);
  }

  // ---- 文書ロード ----
  open(lineCount: number, readOnly: boolean) {
    this.lineCount = Math.max(1, lineCount);
    this.wrapRows.clear();
    this.readOnly = readOnly;
    this.cache.clear();
    this.pending.clear();
    this.maxWidth = 0;
    this.caret = { line: 0, col: 0 };
    this.anchor = { line: 0, col: 0 };
    this.goalX = null;
    this.scroll.scrollLeft = 0;
    this.topLineF = 0;
    this.updateMetrics();
    this.setTopLine(0);
    this.render();
    this.notifyCursor();
  }

  setReadOnly(on: boolean) {
    this.readOnly = on;
  }

  focus() {
    this.input.focus({ preventScroll: true });
  }

  openSearch() {
    const sel = this.selectionText();
    this.findBar.open(sel);
  }

  goTo(line: number, col: number) {
    const pos = { line: Math.max(0, Math.min(this.lineCount - 1, line)), col: Math.max(0, col) };
    this.moveTo(pos, false);
    this.focus();
  }

  setWrap(on: boolean) {
    if (this.wrap === on) return;
    const topLine = this.scaleMode ? this.topLineF : this.pxToLine(this.scroll.scrollTop);
    const wasAtBottom = topLine >= this.maxTopLine();
    this.wrap = on;
    this.wrapRows.clear();
    this.scroll.classList.toggle("wrap", on);
    this.scroll.scrollLeft = 0;
    this.maxWidth = 0;
    this.updateMetrics();
    this.setTopLine(wasAtBottom ? this.maxTopLine() : topLine);
    this.render();
  }

  setFont(fontFamily: string, fontSize: number) {
    const topLine = this.scaleMode ? this.topLineF : this.pxToLine(this.scroll.scrollTop);
    const wasAtBottom = topLine >= this.maxTopLine();
    this.fontFamily = fontFamily;
    this.fontSize = Math.max(8, Math.min(72, fontSize));
    this.lineHeight = this.fontSize + this.lineHeightExtra;
    this.scroll.parentElement!.style.setProperty("--ve-font-family", this.fontFamily);
    this.scroll.parentElement!.style.setProperty("--ve-font", `${this.fontSize}px`);
    this.scroll.parentElement!.style.setProperty("--line-h", `${this.lineHeight}px`);
    if (this.wrap) {
      this.wrapRows.clear();
    }
    this.maxWidth = 0;
    this.updateMetrics();
    this.setTopLine(wasAtBottom ? this.maxTopLine() : topLine);
    this.render();
    this.onFontChange(this.fontFamily, this.fontSize);
  }

  // ---- 座標マッピング (scaleMode: 巨大文書では行位置とスクロール位置を比例配分) ----
  private updateMetrics() {
    const ideal = (this.wrap ? this.wrapRows.sum(this.lineCount) : this.lineCount) * this.lineHeight;
    this.scaleMode = ideal > MAX_SAFE_HEIGHT;
    this.scrollHeight = this.scaleMode ? MAX_SAFE_HEIGHT : ideal;
    this.inner.style.height = `${Math.max(this.scrollHeight, 1)}px`;
  }

  private maxScroll(): number {
    // WebView は巨大な CSS 高さを内部上限へ丸めることがある。指定値ではなく
    // 実際に確保された範囲を使わないと、つまみ位置と行位置の比率がずれる。
    return Math.max(0, this.scroll.scrollHeight - this.scroll.clientHeight);
  }

  private visibleRows(): number {
    return Math.max(1, Math.floor(this.scroll.clientHeight / this.lineHeight));
  }

  private maxTopLine(): number {
    if (!this.wrap) return Math.max(0, this.lineCount - this.visibleRows());
    const maxTopRow = Math.max(0, this.wrapRows.sum(this.lineCount) - this.visibleRows());
    return this.wrapRows.lowerBound(maxTopRow + 1, this.lineCount);
  }

  // 行番号 -> その行を可視域の先頭に置くための scrollTop (ensureVisible/goto 用)
  private lineToPx(line: number): number {
    if (this.wrap) {
      const row = this.wrapRows.sum(line);
      if (!this.scaleMode) return row * this.lineHeight;
      const maxTopRow = Math.max(0, this.wrapRows.sum(this.lineCount) - this.visibleRows());
      return maxTopRow ? (Math.min(row, maxTopRow) / maxTopRow) * this.maxScroll() : 0;
    }
    if (!this.scaleMode) return line * this.lineHeight;
    const maxTopLine = this.maxTopLine();
    return maxTopLine ? (Math.min(line, maxTopLine) / maxTopLine) * this.maxScroll() : 0;
  }

  // scrollTop -> その位置に対応する行番号 (render の基準行)
  private pxToLine(px: number): number {
    if (this.wrap) {
      if (!this.scaleMode) return this.wrapRows.lowerBound(px / this.lineHeight + 1, this.lineCount);
      const maxTopRow = Math.max(0, this.wrapRows.sum(this.lineCount) - this.visibleRows());
      const row = this.maxScroll() ? (px / this.maxScroll()) * maxTopRow : 0;
      return this.wrapRows.lowerBound(row + 1, this.lineCount);
    }
    if (!this.scaleMode) return Math.floor(px / this.lineHeight);
    const ms = this.maxScroll();
    if (ms <= 0) return 0;
    const ratio = Math.min(1, Math.max(0, px / ms));
    return Math.round(ratio * this.maxTopLine());
  }

  // topLineF (権威値) を line に設定し、scrollTop へも反映する。
  // scrollTop 側は1億行超級の文書では1行 <1デバイスpx になり、ブラウザが
  // 書き込み値を丸めてしまうことがあるが、実際に何行目を描画するかは
  // render() が topLineF を直接見るため、scrollTop が丸められても表示は壊れない
  // (scrollTop はネイティブスクロールバーのつまみ位置を近似するためだけに使う)。
  private setTopLine(line: number) {
    this.topLineF = Math.max(0, Math.min(this.maxTopLine(), line));
    this.scroll.scrollTop = this.lineToPx(this.topLineF);
  }

  // 行 i の描画用 top (px)。scaleMode では viewTopLine を viewTop に固定し、
  // 可視域内は常に行高の間隔で並べる (行密度が px 密度を上回っても崩れない)。
  private rowTop(i: number): number {
    if (this.wrap) {
      const y = this.wrapRows.sum(i) * this.lineHeight;
      if (!this.scaleMode) return y;
      return this.viewTop + y - this.wrapRows.sum(this.viewTopLine) * this.lineHeight;
    }
    return this.scaleMode ? this.viewTop + (i - this.viewTopLine) * this.lineHeight : i * this.lineHeight;
  }

  // ---- 行キャッシュ ----
  private lineText(i: number): string | undefined {
    const c = Math.floor(i / CHUNK);
    return this.cache.get(c)?.[i - c * CHUNK];
  }

  private async ensureLine(i: number): Promise<string> {
    const cached = this.lineText(i);
    if (cached !== undefined) return cached;
    await this.fetchChunk(Math.floor(i / CHUNK));
    return this.lineText(i) ?? "";
  }

  private async fetchChunk(c: number): Promise<void> {
    if (this.cache.has(c) || this.pending.has(c)) return;
    this.pending.add(c);
    try {
      const ls = await api.lines(c * CHUNK, CHUNK);
      this.cache.set(c, ls);
      while (this.cache.size > CACHE_MAX) {
        const oldest = this.cache.keys().next().value!;
        if (oldest === c) break;
        this.cache.delete(oldest);
      }
    } finally {
      this.pending.delete(c);
    }
  }

  // ---- 描画 ----
  private schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  private onScroll() {
    if (!this.scaleMode || this.scrollbarDragging) {
      this.topLineF = this.pxToLine(this.scroll.scrollTop);
    }
    this.schedule();
  }

  private render() {
    const top = this.scroll.scrollTop;
    const h = this.scroll.clientHeight;
    const topLine = Math.round(this.topLineF);
    this.viewTop = top;
    this.viewTopLine = topLine;
    const visibleRows = Math.ceil(h / this.lineHeight) + 1;
    const first = Math.max(0, topLine - OVERSCAN);
    const last = this.wrap
      ? Math.min(this.lineCount, this.wrapRows.lowerBound(this.wrapRows.sum(topLine) + visibleRows + OVERSCAN, this.lineCount) + 1)
      : Math.min(this.lineCount, topLine + visibleRows + OVERSCAN);

    // 未取得チャンクを要求
    let needFetch = false;
    for (let c = Math.floor(first / CHUNK); c <= Math.floor((last - 1) / CHUNK); c++) {
      if (!this.cache.has(c)) {
        needFetch = true;
        this.fetchChunk(c).then(() => this.schedule());
      }
    }

    // 行 + ガター
    // selectLines() でガター上の行をクリックすると、改行込みで選択するため
    // caret は選択末尾の「次の行の先頭」に置かれる (行1をクリック→caretは行2)。
    // それをそのまま「現在行」として使うと、クリックした行の1つ下が光って見える
    // ため、この形の行選択中は1つ前の行(実際に選択されている行)を現在行として扱う。
    const wholeLineSelectEnd =
      this.anchor.col === 0 && this.caret.col === 0 && this.caret.line > this.anchor.line;
    const curLine = wholeLineSelectEnd ? this.caret.line - 1 : this.caret.line;
    const frag = document.createDocumentFragment();
    const gfrag = document.createDocumentFragment();
    for (let i = first; i < last; i++) {
      const rowTop = this.rowTop(i);
      const text = this.lineText(i);
      const line = el("div", "ve-line");
      line.style.top = `${rowTop}px`;
      line.dataset.line = String(i);
      line.textContent = text ?? "…";
      frag.appendChild(line);

      const g = el("div", "ve-gnum");
      g.style.top = `${rowTop - top}px`;
      g.textContent = this.formatLineNumber(i + 1);
      if (i === curLine) g.classList.add("cur");
      gfrag.appendChild(g);
    }

    // 選択ハイライト
    this.appendSelection(frag, first, last);

    this.linesLayer.replaceChildren(frag);
    this.gutter.replaceChildren(gfrag);

    if (this.wrap) this.measureWrappedRows(first, last);

    // 横スクロール用に inner 幅を可視行の最大幅へ更新
    this.updateWidth();
    this.placeCaret();
    if (!needFetch) this.updateGutterWidth();
  }

  private measureWrappedRows(first: number, last: number) {
    let changed = false;
    for (let i = first; i < last; i++) {
      const line = this.lineElem(i);
      if (!line) continue;
      // CSSの line-height は整数px指定だが、DPI倍率で実測値には微小な誤差が入る。
      // ceil だと 3.0001 行を4行と誤認して、折り返し間に空行を作ってしまう。
      const rows = Math.max(1, Math.round(line.getBoundingClientRect().height / this.lineHeight));
      changed = this.wrapRows.set(i, rows, this.viewTopLine) || changed;
    }
    // フォント変更直後は、古い行高で置いたDOMを次フレームまで残すと空行に見える。
    // 実測値が変わったら同じ描画サイクル内で位置を置き直す。
    if (changed) {
      const topLine = this.topLineF;
      const wasAtBottom = topLine >= this.maxTopLine();
      this.updateMetrics();
      this.setTopLine(wasAtBottom ? this.maxTopLine() : topLine);
      this.render();
    }
  }

  private updateWidth() {
    if (this.wrap) {
      this.inner.style.width = "100%";
      return;
    }
    let w = 0;
    for (const l of this.inner.querySelectorAll<HTMLElement>(".ve-line")) {
      w = Math.max(w, l.scrollWidth);
    }
    this.maxWidth = Math.max(this.maxWidth, w + 40);
    this.inner.style.width = `${this.maxWidth}px`;
  }

  private updateGutterWidth() {
    const sample = this.gutter.querySelector<HTMLElement>(".ve-gnum");
    const style = getComputedStyle(sample ?? this.gutter);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) return;
    context.font = style.font;
    const numberWidth = context.measureText(this.formatLineNumber(this.lineCount)).width;
    const w = Math.max(this.gutterWidth, Math.ceil(numberWidth + 24));
    this.scroll.parentElement!.style.setProperty("--gutter-w", `${w}px`);
  }

  private formatLineNumber(line: number) {
    return String(line).replace(/\B(?=(\d{3})+(?!\d))/g, "\u200a");
  }

  // 指定行内の col(char) の x ピクセル (行左端padding基準)
  private colToX(lineEl: HTMLElement, s: string, col: number): number {
    const node = lineEl.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) return this.paddingLeft;
    const u = charToU16(s, col);
    const r = document.createRange();
    r.setStart(node, 0);
    r.setEnd(node, Math.min(u, (node.textContent ?? "").length));
    return this.paddingLeft + r.getBoundingClientRect().width;
  }

  private lineElem(i: number): HTMLElement | null {
    return this.inner.querySelector<HTMLElement>(`.ve-line[data-line="${i}"]`);
  }

  private placeCaret() {
    const s = this.lineText(this.caret.line) ?? "";
    const lineEl = this.lineElem(this.caret.line);
    if (!lineEl) {
      // 画面外の論理行座標へ focused textarea を置くと、巨大文書ではCSS座標上限を
      // 超えてスクロール範囲自体が変わる。入力フォーカスだけ表示領域内で維持する。
      this.caretEl.classList.remove("on");
      this.input.style.top = `${this.viewTop}px`;
      this.input.style.left = `${this.scroll.scrollLeft + this.paddingLeft}px`;
      return;
    }
    this.caretEl.classList.toggle("on", document.activeElement === this.input);
    const point = lineEl && this.wrap ? this.wrapPoint(lineEl, s, this.caret.col) : null;
    const x = point?.x ?? (lineEl ? this.colToX(lineEl, s, this.caret.col) : this.paddingLeft);
    const y = point?.y ?? this.rowTop(this.caret.line);
    this.caretEl.style.top = `${y}px`;
    this.caretEl.style.left = `${x}px`;
    // IME 変換窓を追従させるため textarea も同座標へ
    this.input.style.top = `${y}px`;
    this.input.style.left = `${x}px`;
  }

  private wrapPoint(lineEl: HTMLElement, s: string, col: number): { x: number; y: number } | null {
    const node = lineEl.firstChild;
    if (!node) return null;
    const range = document.createRange();
    range.setStart(node, Math.min(charToU16(s, col), node.textContent?.length ?? 0));
    range.collapse(true);
    const rect = range.getClientRects()[0] ?? lineEl.getBoundingClientRect();
    const inner = this.inner.getBoundingClientRect();
    return { x: rect.left - inner.left + this.scroll.scrollLeft, y: rect.top - inner.top + this.scroll.scrollTop };
  }

  private appendSelection(frag: DocumentFragment, first: number, last: number) {
    if (cmp(this.anchor, this.caret) === 0) return;
    const [s, e] = cmp(this.anchor, this.caret) < 0 ? [this.anchor, this.caret] : [this.caret, this.anchor];
    if (this.wrap) {
      const inner = this.inner.getBoundingClientRect();
      for (let i = Math.max(first, s.line); i < Math.min(last, e.line + 1); i++) {
        const str = this.lineText(i) ?? "";
        const line = this.lineElem(i);
        const node = line?.firstChild;
        if (!node) continue;
        const c0 = i === s.line ? s.col : 0;
        const c1 = i === e.line ? e.col : charLen(str);
        const range = document.createRange();
        range.setStart(node, charToU16(str, c0));
        range.setEnd(node, charToU16(str, c1));
        for (const rect of range.getClientRects()) {
          const box = el("div", "ve-sel");
          box.style.top = `${rect.top - inner.top + this.scroll.scrollTop}px`;
          box.style.left = `${rect.left - inner.left + this.scroll.scrollLeft}px`;
          box.style.width = `${Math.max(2, rect.width)}px`;
          box.style.height = `${rect.height}px`;
          frag.insertBefore(box, frag.firstChild);
        }
      }
      return;
    }
    for (let i = Math.max(first, s.line); i < Math.min(last, e.line + 1); i++) {
      const str = this.lineText(i) ?? "";
      const lineEl = this.lineElem(i);
      const c0 = i === s.line ? s.col : 0;
      const c1 = i === e.line ? e.col : charLen(str);
      const x0 = lineEl ? this.colToX(lineEl, str, c0) : this.paddingLeft;
      let x1 = lineEl ? this.colToX(lineEl, str, c1) : this.paddingLeft;
      if (i < e.line) x1 += 6; // 行末(改行)まで選択している見た目
      const box = el("div", "ve-sel");
      box.style.top = `${this.rowTop(i)}px`;
      box.style.left = `${x0}px`;
      box.style.width = `${Math.max(2, x1 - x0)}px`;
      frag.insertBefore(box, frag.firstChild);
    }
  }

  // ---- カーソル移動 ----
  private notifyCursor() {
    this.onCursor(this.caret.line + 1, this.caret.col + 1);
  }

  private moveTo(pos: Pos, extend: boolean, keepGoal = false) {
    this.caret = pos;
    if (!extend) this.anchor = pos;
    if (!keepGoal) this.goalX = null;
    this.ensureVisible();
    this.render();
    this.notifyCursor();
  }

  private ensureVisible() {
    if (this.wrap) {
      const y = this.lineToPx(this.caret.line);
      const height = this.wrapRows.get(this.caret.line) * this.lineHeight;
      const top = this.scroll.scrollTop;
      if (!this.scaleMode) {
        if (y < top) this.setTopLine(this.caret.line);
        else if (y + height > top + this.scroll.clientHeight) {
          this.setTopLine(this.pxToLine(y + height - this.scroll.clientHeight));
        }
      } else {
        const visibleRows = Math.max(1, Math.floor(this.scroll.clientHeight / this.lineHeight));
        let topLine = this.topLineF;
        if (this.caret.line < topLine) topLine = this.caret.line;
        else if (this.caret.line >= topLine + visibleRows) topLine = this.caret.line - visibleRows + 1;
        if (topLine !== this.topLineF) this.setTopLine(topLine);
      }
      return;
    }
    if (this.scaleMode) {
      // scaleMode では scrollTop が行数に対して線形圧縮されており、caret.line を
      // lineToPx() の実数値で直接 top/bottom 判定すると、行高・clientHeight という
      // 「非圧縮px」の量を圧縮空間に混在させてしまい、1行の移動が数千行分の
      // スクロールに化けてしまう。そのため行番号(整数)だけで可視判定し、
      // 最後に lineToPx() で一度だけ scrollTop へ変換する。
      const visibleRows = Math.max(1, Math.floor(this.scroll.clientHeight / this.lineHeight));
      let topLine = this.topLineF;
      if (this.caret.line < topLine) topLine = this.caret.line;
      else if (this.caret.line >= topLine + visibleRows) topLine = this.caret.line - visibleRows + 1;
      if (topLine !== this.topLineF) this.setTopLine(topLine);
    } else {
      const y = this.lineToPx(this.caret.line);
      const top = this.scroll.scrollTop;
      const h = this.scroll.clientHeight;
      if (y < top) this.setTopLine(this.caret.line);
      else if (y + this.lineHeight > top + h) {
        this.setTopLine(this.pxToLine(y + this.lineHeight - h));
      }
    }
    // 横方向: caret が見えるように
    const s = this.lineText(this.caret.line) ?? "";
    const lineEl = this.lineElem(this.caret.line);
    if (lineEl) {
      const x = this.colToX(lineEl, s, this.caret.col);
      const sl = this.scroll.scrollLeft;
      const w = this.scroll.clientWidth;
      if (x < sl + this.paddingLeft) this.scroll.scrollLeft = Math.max(0, x - this.paddingLeft);
      else if (x > sl + w - 20) this.scroll.scrollLeft = x - w + 20;
    }
  }

  private async lineLen(i: number): Promise<number> {
    const t = this.lineText(i);
    if (t !== undefined) return charLen(t);
    return api.lineCharLen(i);
  }

  private async horiz(dir: -1 | 1, extend: boolean) {
    const c = this.caret;
    if (!extend && cmp(this.anchor, c) !== 0) {
      // 選択解除は端へ
      const [s, e] = cmp(this.anchor, c) < 0 ? [this.anchor, c] : [c, this.anchor];
      this.moveTo(dir < 0 ? s : e, false);
      return;
    }
    if (dir < 0) {
      if (c.col > 0) this.moveTo({ line: c.line, col: c.col - 1 }, extend);
      else if (c.line > 0) {
        const len = await this.lineLen(c.line - 1);
        this.moveTo({ line: c.line - 1, col: len }, extend);
      }
    } else {
      const len = await this.lineLen(c.line);
      if (c.col < len) this.moveTo({ line: c.line, col: c.col + 1 }, extend);
      else if (c.line + 1 < this.lineCount) this.moveTo({ line: c.line + 1, col: 0 }, extend);
    }
  }

  private async wordMove(dir: -1 | 1, extend: boolean) {
    const c = this.caret;
    const s = await this.ensureLine(c.line);
    const chars = [...s];
    if (dir < 0) {
      if (c.col === 0) {
        if (c.line > 0) {
          const len = await this.lineLen(c.line - 1);
          this.moveTo({ line: c.line - 1, col: len }, extend);
        }
        return;
      }
      let i = c.col - 1;
      while (i > 0 && charClass(chars[i]) === 0) i--; // 空白スキップ
      const cls = charClass(chars[i]);
      while (i > 0 && charClass(chars[i - 1]) === cls) i--;
      this.moveTo({ line: c.line, col: i }, extend);
    } else {
      if (c.col >= chars.length) {
        if (c.line + 1 < this.lineCount) this.moveTo({ line: c.line + 1, col: 0 }, extend);
        return;
      }
      let i = c.col;
      const cls = charClass(chars[i]);
      while (i < chars.length && charClass(chars[i]) === cls) i++;
      while (i < chars.length && charClass(chars[i]) === 0) i++; // 続く空白
      this.moveTo({ line: c.line, col: i }, extend);
    }
  }

  private async vert(delta: number, extend: boolean) {
    const c = this.caret;
    const targetLine = Math.max(0, Math.min(this.lineCount - 1, c.line + delta));
    if (targetLine === c.line) return;
    if (this.goalX === null) {
      const s = this.lineText(c.line) ?? "";
      const lineEl = this.lineElem(c.line);
      this.goalX = lineEl ? this.colToX(lineEl, s, c.col) - this.paddingLeft : 0;
    }
    // 目標 x に最も近い列へ (行が描画済みでなければ列を長さで近似)
    await this.ensureLine(targetLine);
    this.render();
    const s = this.lineText(targetLine) ?? "";
    const lineEl = this.lineElem(targetLine);
    let col = charLen(s);
    if (lineEl) col = this.xToCol(lineEl, s, this.paddingLeft + this.goalX);
    this.moveTo({ line: targetLine, col }, extend, true);
  }

  // xピクセル -> col(char)。caretRangeFromPoint はpadding付近の境界で行の
  // テキストノードでなく親要素にヒットすることがあり、その場合 col が行末に
  // 化けて誤ったジャンプを起こす(長い行の先頭付近をドラッグすると全選択に
  // 化けて画面が末尾まで飛ぶ不具合の原因だった)。colToX(単調増加)の逆写像を
  // 2分探索で求めることで、ヒットテストに頼らず正確な col を得る。
  private xToCol(lineEl: HTMLElement, s: string, x: number): number {
    const len = charLen(s);
    if (len === 0 || x <= this.paddingLeft) return 0;
    let lo = 0;
    let hi = len;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.colToX(lineEl, s, mid) <= x) lo = mid;
      else hi = mid - 1;
    }
    if (lo >= len) return len;
    const x0 = this.colToX(lineEl, s, lo);
    const x1 = this.colToX(lineEl, s, lo + 1);
    return x - x0 <= x1 - x ? lo : lo + 1;
  }

  private pageRows(): number {
    return Math.max(1, Math.floor(this.scroll.clientHeight / this.lineHeight) - 1);
  }

  private async home(extend: boolean) {
    this.moveTo({ line: this.caret.line, col: 0 }, extend);
  }
  private async end(extend: boolean) {
    const len = await this.lineLen(this.caret.line);
    this.moveTo({ line: this.caret.line, col: len }, extend);
  }

  // ---- 選択 ----
  private hasSel(): boolean {
    return cmp(this.anchor, this.caret) !== 0;
  }
  private selNorm(): [Pos, Pos] {
    return cmp(this.anchor, this.caret) <= 0 ? [this.anchor, this.caret] : [this.caret, this.anchor];
  }
  private posInSelection(p: Pos): boolean {
    if (!this.hasSel()) return false;
    const [s, e] = this.selNorm();
    return cmp(p, s) >= 0 && cmp(p, e) <= 0;
  }
  private selectionText(): string {
    if (!this.hasSel()) return "";
    const [s, e] = this.selNorm();
    if (s.line === e.line) {
      const str = this.lineText(s.line) ?? "";
      return [...str].slice(s.col, e.col).join("");
    }
    return ""; // 複数行はプレースホルダ用途のみ (検索欄初期値)
  }

  private async selectAll() {
    const last = this.lineCount - 1;
    const len = await this.lineLen(last);
    this.anchor = { line: 0, col: 0 };
    this.moveTo({ line: last, col: len }, true);
  }

  // ---- 編集 (backend へ委譲・順序保証) ----
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn);
    this.chain = p.catch(() => {});
    return p;
  }

  private applyResult(r: api.EditResult, fromLine: number) {
    const oldTopLine = this.scaleMode ? this.topLineF : this.pxToLine(this.scroll.scrollTop);
    const wasAtBottom = oldTopLine >= this.maxTopLine();
    this.lineCount = Math.max(1, r.line_count);
    this.wrapRows.clear();
    this.updateMetrics();
    // 行数変更前後の座標系を混在させない。末尾表示中は新しい末尾へ追従し、
    // それ以外は同じ先頭行を維持する。
    this.setTopLine(wasAtBottom ? this.maxTopLine() : oldTopLine);
    // 編集で fromLine 以降の行番号がずれるためキャッシュを破棄
    for (const c of [...this.cache.keys()]) {
      if (c * CHUNK + CHUNK > fromLine) this.cache.delete(c);
    }
    this.caret = r.caret;
    this.anchor = r.caret;
    this.goalX = null;
    this.onDocChange(this.lineCount);
  }

  private async renderAfterEdit() {
    this.ensureVisible();
    const visibleRows = Math.ceil(this.scroll.clientHeight / this.lineHeight) + OVERSCAN;
    const topLine = this.scaleMode ? Math.round(this.topLineF) : this.pxToLine(this.scroll.scrollTop);
    const first = Math.max(0, topLine - OVERSCAN);
    const last = Math.min(this.lineCount - 1, topLine + visibleRows);
    for (let c = Math.floor(first / CHUNK); c <= Math.floor(last / CHUNK); c++) {
      await this.fetchChunk(c);
    }
    this.render();
    this.notifyCursor();
  }

  private insertText(text: string) {
    if (this.readOnly) return;
    this.run(async () => {
      const [s, e] = this.selNorm();
      const coalesce = !this.hasSel() && text.length === 1 && text !== "\n";
      const r = await api.edit(s, e, this.caret, text, coalesce);
      this.applyResult(r, s.line);
      await this.renderAfterEdit();
    });
  }

  private deleteSel() {
    this.run(async () => {
      const [s, e] = this.selNorm();
      const r = await api.edit(s, e, this.caret, "", false);
      this.applyResult(r, s.line);
      await this.renderAfterEdit();
    });
  }

  private backspace() {
    if (this.readOnly) return;
    if (this.hasSel()) {
      this.deleteSel();
      return;
    }
    this.run(async () => {
      const c = this.caret;
      let s: Pos;
      if (c.col > 0) s = { line: c.line, col: c.col - 1 };
      else if (c.line > 0) s = { line: c.line - 1, col: await this.lineLen(c.line - 1) };
      else return;
      const r = await api.edit(s, c, c, "", false);
      this.applyResult(r, s.line);
      await this.renderAfterEdit();
    });
  }

  private deleteForward() {
    if (this.readOnly) return;
    if (this.hasSel()) {
      this.deleteSel();
      return;
    }
    this.run(async () => {
      const c = this.caret;
      const len = await this.lineLen(c.line);
      let e: Pos;
      if (c.col < len) e = { line: c.line, col: c.col + 1 };
      else if (c.line + 1 < this.lineCount) e = { line: c.line + 1, col: 0 };
      else return;
      const r = await api.edit(c, e, c, "", false);
      this.applyResult(r, c.line);
      await this.renderAfterEdit();
    });
  }

  private doUndo(redo: boolean) {
    if (this.readOnly) return;
    this.run(async () => {
      const r = redo ? await api.redo() : await api.undo();
      if (!r) return;
      this.applyResult(r, 0);
      this.ensureVisible();
      this.render();
      this.notifyCursor();
    });
  }

  private async copy(cut: boolean) {
    if (!this.hasSel()) return;
    const [s, e] = this.selNorm();
    let text: string;
    if (s.line === e.line) {
      text = [...(await this.ensureLine(s.line))].slice(s.col, e.col).join("");
    } else {
      const parts: string[] = [];
      for (let i = s.line; i <= e.line; i++) {
        const str = await this.ensureLine(i);
        if (i === s.line) parts.push([...str].slice(s.col).join(""));
        else if (i === e.line) parts.push([...str].slice(0, e.col).join(""));
        else parts.push(str);
      }
      text = parts.join("\n");
    }
    await navigator.clipboard.writeText(text);
    if (cut && !this.readOnly) this.deleteSel();
  }

  private async paste() {
    if (this.readOnly) return;
    const text = (await navigator.clipboard.readText()).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (text) this.insertText(text);
  }

  // ---- キー入力 ----
  private onKeyDown(e: KeyboardEvent) {
    if (this.composing || this.busy) return;
    const ext = e.shiftKey;
    if (e.ctrlKey && !e.altKey) {
      switch (e.key.toLowerCase()) {
        case "z": e.preventDefault(); this.doUndo(e.shiftKey); return;
        case "y": e.preventDefault(); this.doUndo(true); return;
        case "a": e.preventDefault(); this.selectAll(); return;
        case "c": e.preventDefault(); this.copy(false); return;
        case "x": e.preventDefault(); this.copy(true); return;
        case "v": e.preventDefault(); this.paste(); return;
        case "f": e.preventDefault(); this.openSearch(); return;
        case "arrowleft": e.preventDefault(); this.wordMove(-1, ext); return;
        case "arrowright": e.preventDefault(); this.wordMove(1, ext); return;
        case "home": e.preventDefault(); this.moveTo({ line: 0, col: 0 }, ext); return;
        case "end": e.preventDefault(); this.gotoEnd(ext); return;
      }
      return;
    }
    switch (e.key) {
      case "ArrowLeft": e.preventDefault(); this.horiz(-1, ext); break;
      case "ArrowRight": e.preventDefault(); this.horiz(1, ext); break;
      case "ArrowUp": e.preventDefault(); this.vert(-1, ext); break;
      case "ArrowDown": e.preventDefault(); this.vert(1, ext); break;
      case "PageUp": e.preventDefault(); this.vert(-this.pageRows(), ext); break;
      case "PageDown": e.preventDefault(); this.vert(this.pageRows(), ext); break;
      case "Home": e.preventDefault(); this.home(ext); break;
      case "End": e.preventDefault(); this.end(ext); break;
      case "Backspace": e.preventDefault(); this.backspace(); break;
      case "Delete": e.preventDefault(); this.deleteForward(); break;
      case "Enter": e.preventDefault(); this.insertText("\n"); break;
      case "Tab": e.preventDefault(); this.insertText("\t"); break;
      case "Escape": this.findBar.close(); break;
    }
  }

  private async gotoEnd(extend: boolean) {
    const last = this.lineCount - 1;
    const len = await this.lineLen(last);
    this.moveTo({ line: last, col: len }, extend);
  }

  // ---- 入力 / IME ----
  // textarea の内容を文書へ流し込む。clear 済みなら二重挿入しない (IME終了時の重複対策)。
  private flushInput() {
    const v = this.input.value;
    this.input.value = "";
    if (v) this.insertText(v);
  }

  private onInput(e: InputEvent) {
    if (this.composing || e.isComposing) {
      this.resizeImeInput();
      return;
    }
    this.flushInput();
  }

  private onCompositionEnd() {
    this.composing = false;
    this.input.classList.remove("ime");
    this.input.style.removeProperty("width");
    if (document.activeElement === this.input) this.caretEl.classList.add("on");
    this.flushInput();
  }

  private resizeImeInput() {
    this.input.style.width = "1px";
    this.input.style.width = `${this.input.scrollWidth + 2}px`;
  }

  // ---- ホイール ----
  // scaleMode ではブラウザ標準のホイールスクロール(scrollTopをdeltaYそのまま加算)に任せると、
  // 圧縮された scrollTop 空間では1notchが数千行分の移動になってしまう。非scaleMode時と
  // 同じ「見た目の行数」だけ動くよう、行番号ベースで自前計算して scrollTop を設定する。
  private onWheel(e: WheelEvent) {
    if (e.ctrlKey) {
      e.preventDefault();
      if (e.deltaY) this.setFont(this.fontFamily, this.fontSize + (e.deltaY < 0 ? 1 : -1));
      return;
    }
    if (!this.scaleMode) return;
    e.preventDefault();
    if (e.deltaX) this.scroll.scrollLeft += e.deltaX;
    let deltaLines: number;
    if (e.deltaMode === 1) deltaLines = e.deltaY; // DOM_DELTA_LINE
    else if (e.deltaMode === 2) deltaLines = e.deltaY * this.pageRows(); // DOM_DELTA_PAGE
    else deltaLines = e.deltaY / this.lineHeight; // DOM_DELTA_PIXEL
    if (!deltaLines) return;
    // topLineF (権威値) に直接加算する。scrollTop を読み戻して積算すると、
    // 超巨大文書 (1行あたり1デバイスpx未満に圧縮される文書) では書き込んだ
    // 端数がブラウザ側で丸められて消え、延々スクロールできなくなる。
    this.setTopLine(this.topLineF + deltaLines);
    // scrollTop が丸めで実質変化しない場合でも topLineF は進んでいるため、
    // 'scroll' イベントに頼らず明示的に再描画する。
    this.schedule();
  }

  // ---- マウス ----
  private onMouseDown(e: MouseEvent) {
    if (e.button !== 0 || this.busy) return;
    // ネイティブスクロールバー(トラック/つまみ)は .ve-scroll のヒット領域に含まれるため、
    // clientWidth/clientHeight (スクロールバー分を除いた実コンテンツ領域) の外側でのクリックは
    // キャレット配置として扱わずブラウザに任せる。でないとスクロールバー操作の瞬間に
    // 意図しない位置へジャンプし、ネイティブドラッグも preventDefault で壊れる。
    const rect = this.scroll.getBoundingClientRect();
    if (e.clientX - rect.left >= this.scroll.clientWidth) {
      this.scrollbarDragging = true;
      return;
    }
    if (e.clientY - rect.top >= this.scroll.clientHeight) return;
    const pos = this.posFromPoint(e.clientX, e.clientY);
    if (!pos) return;
    e.preventDefault();
    this.focus();
    this.moveTo(pos, e.shiftKey);
    const move = (ev: MouseEvent) => {
      const p = this.posFromPoint(ev.clientX, ev.clientY);
      if (p) this.moveTo(p, true);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  private posFromPoint(cx: number, cy: number): Pos | null {
    if (this.wrap) {
      const target = document.elementFromPoint(cx, cy)?.closest<HTMLElement>(".ve-line");
      if (!target?.dataset.line) return null;
      const line = Number(target.dataset.line);
      const point = document.caretPositionFromPoint?.(cx, cy);
      const text = this.lineText(line) ?? "";
      if (point?.offsetNode === target.firstChild) {
        return { line, col: u16ToChar(text, point.offset) };
      }
      return { line, col: this.posFromLineAndX(line, cx, text).col };
    }
    const rect = this.scroll.getBoundingClientRect();
    // scaleMode では画面上の行は常に viewTopLine を基準に行高の間隔で並ぶため、
    // 画面相対オフセットのみで行番号を求める (絶対 px 密度には依存しない)。
    const rel = cy - rect.top;
    const line = this.scaleMode
      ? this.viewTopLine + Math.floor(rel / this.lineHeight)
      : Math.floor((rel + this.scroll.scrollTop) / this.lineHeight);
    const clamped = Math.max(0, Math.min(this.lineCount - 1, line));
    const s = this.lineText(clamped);
    return this.posFromLineAndX(clamped, cx, s);
  }

  private posFromLineAndX(line: number, cx: number, s: string | undefined): Pos {
    if (s === undefined) return { line, col: 0 };
    const lineEl = this.lineElem(line);
    if (!lineEl) return { line, col: 0 };
    const lr = lineEl.getBoundingClientRect();
    const col = this.xToCol(lineEl, s, cx - lr.left);
    return { line, col: Math.max(0, Math.min(charLen(s), col)) };
  }

  // ---- 右クリックメニュー ----
  private onContextMenu(e: MouseEvent) {
    e.preventDefault();
    const pos = this.posFromPoint(e.clientX, e.clientY);
    if (pos && !this.posInSelection(pos)) this.moveTo(pos, false);
    this.focus();
    const items: MenuItem[] = [];
    if (!this.readOnly) {
      items.push({ label: "元に戻す", key: "Ctrl+Z", action: () => this.doUndo(false) });
      items.push({ label: "やり直し", key: "Ctrl+Y", action: () => this.doUndo(true) });
      items.push({ label: "切り取り", key: "Ctrl+X", action: () => this.copy(true), sep: true });
    }
    items.push({ label: "コピー", key: "Ctrl+C", action: () => this.copy(false), sep: this.readOnly });
    if (!this.readOnly) {
      items.push({ label: "貼り付け", key: "Ctrl+V", action: () => this.paste() });
      items.push({ label: "削除", action: () => { if (this.hasSel()) this.deleteSel(); } });
    }
    items.push({ label: "すべて選択", key: "Ctrl+A", action: () => this.selectAll(), sep: true });
    showMenu(e.clientX, e.clientY, items);
  }

  // ---- ガター(行番号) ----
  private lineFromGutterY(cy: number): number {
    if (this.wrap) {
      for (const line of this.inner.querySelectorAll<HTMLElement>(".ve-line")) {
        const rect = line.getBoundingClientRect();
        if (cy >= rect.top && cy < rect.bottom) return Number(line.dataset.line);
      }
    }
    const rect = this.gutter.getBoundingClientRect();
    const rel = cy - rect.top;
    const line = this.scaleMode
      ? this.viewTopLine + Math.floor(rel / this.lineHeight)
      : Math.floor((rel + this.scroll.scrollTop) / this.lineHeight);
    return Math.max(0, Math.min(this.lineCount - 1, line));
  }

  private async selectLines(a: number, b: number) {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    this.anchor = { line: lo, col: 0 };
    const caret =
      hi + 1 < this.lineCount ? { line: hi + 1, col: 0 } : { line: hi, col: await this.lineLen(hi) };
    this.moveTo(caret, true);
  }

  private onGutterMouseDown(e: MouseEvent) {
    if (e.button !== 0 || this.busy) return;
    e.preventDefault();
    this.focus();
    const clicked = this.lineFromGutterY(e.clientY);
    const startLine = e.shiftKey ? this.anchor.line : clicked;
    this.selectLines(startLine, clicked);
    const move = (ev: MouseEvent) => {
      this.selectLines(startLine, this.lineFromGutterY(ev.clientY));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  // ---- 検索 ----
  // 1回のIPC呼び出しで最大この行数だけ走査する。巨大ファイルで一致が見つからない場合でも
  // 呼び出し毎にbackendのMutexを解放するため、その間にスクロール/入力が割り込める。
  private static readonly FIND_BUDGET = 20_000;
  private static readonly REPLACE_BUDGET = 2_000;
  private static readonly REPLACE_WARN_THRESHOLD = 5_000;

  private async doFind(pat: string, forward: boolean, matchCase: boolean): Promise<boolean> {
    const p = unescapePattern(pat);
    if (!p) return false;
    const myGen = ++this.findGen;
    const from = forward ? this.selNorm()[1] : this.selNorm()[0];
    if (!forward) {
      const r = await api.find(p, from, false, matchCase);
      if (myGen !== this.findGen || !r) { this.lastFindMatch = null; return false; }
      this.anchor = r.start;
      this.moveTo(r.end, true);
      this.lastFindMatch = { start: r.start, end: r.end, pat: p, matchCase };
      return true;
    }
    let cursor: api.FindCursor | undefined;
    for (;;) {
      const outcome = await api.findStep(p, from, matchCase, cursor, VirtualEditor.FIND_BUDGET);
      if (myGen !== this.findGen) return false; // 検索バーが閉じられた/新しい検索が始まった
      if (outcome.kind === "Found") {
        this.findBar.setProgress("");
        this.anchor = outcome.start;
        this.moveTo(outcome.end, true);
        this.lastFindMatch = { start: outcome.start, end: outcome.end, pat: p, matchCase };
        return true;
      }
      if (outcome.kind === "NotFound") { this.lastFindMatch = null; return false; }
      cursor = outcome.cursor;
      this.findBar.setProgress(`検索中… ${findProgressPercent(cursor, from.line, this.lineCount)}%`);
    }
  }

  // 現在の選択が直前の検索結果そのものであれば置換してから次を検索する (連続置換)。
  // そうでなければ (まだ何も検索していない等) 次の一致を探すだけに留める。
  private async doReplaceNext(pat: string, rep: string, matchCase: boolean): Promise<boolean> {
    if (this.readOnly) return this.doFind(pat, true, matchCase);
    const p = unescapePattern(pat);
    if (!p) return false;
    const m = this.lastFindMatch;
    if (
      m && m.pat === p && m.matchCase === matchCase &&
      cmp(this.anchor, m.start) === 0 && cmp(this.caret, m.end) === 0
    ) {
      const r = unescapePattern(rep);
      const res = await api.edit(m.start, m.end, this.caret, r, false);
      this.lastFindMatch = null;
      this.applyResult(res, m.start.line);
      this.ensureVisible();
      this.render();
      this.notifyCursor();
    }
    return this.doFind(pat, true, matchCase);
  }

  private async doReplaceAll(pat: string, rep: string, matchCase: boolean): Promise<number> {
    if (this.readOnly) return 0;
    const p = unescapePattern(pat);
    if (!p) return 0;
    const r = unescapePattern(rep);
    this.busy = true;
    try {
      let warned = false;
      for (;;) {
        const res = await api.replaceAllChunk(p, r, matchCase, VirtualEditor.REPLACE_BUDGET);
        if (!warned && !res.done && res.count >= VirtualEditor.REPLACE_WARN_THRESHOLD) {
          warned = true;
          const cont = window.confirm(`既に${res.count}件置換しています。続行しますか?`);
          if (!cont) {
            const fin = await api.replaceAllCancel();
            this.applyResult(fin, 0);
            this.ensureVisible();
            this.render();
            this.notifyCursor();
            return res.count;
          }
        }
        if (res.done) {
          if (res.count > 0) {
            this.applyResult({ caret: res.caret, line_count: res.line_count }, 0);
            this.ensureVisible();
            this.render();
            this.notifyCursor();
          }
          return res.count;
        }
      }
    } finally {
      this.busy = false;
    }
  }
}

function el(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}

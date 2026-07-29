import * as api from "./api";
import type { Pos } from "./api";
import { FindBar } from "./findbar";
import { DEFAULT_EDITOR_CONFIG, EditorConfig } from "./editor-config";
import { showMenu, type MenuItem } from "./menu";
import { VIEWER_FORMAT_LABELS } from "./format";
import { LineCache } from "./line-cache";
import { LiveViewers } from "./live-viewers";
import { lineNumberGroups } from "./line-number";
import { Selection } from "./selection";
import { MAX_SAFE_HEIGHT, ViewportMetrics } from "./viewport-metrics";
import {
  addRegisteredString,
  loadRegisteredStrings,
  registeredStringLabel,
  removeRegisteredString,
} from "./registered-strings";
import {
  charClass,
  charLen,
  charToU16,
  clampImeAnchor,
  comparePos as cmp,
  findProgressPercent,
  positionAfterDeletion,
  u16ToChar,
  unescapePattern,
  WrapHeightMap,
  wordBounds,
} from "./editor-math";
import type { EditorViewState } from "./editor-view-state";
import {
  newlineWithLeadingTabs,
  planLineIndent,
  selectedLineRange,
} from "./editor-edit-plan";

const OVERSCAN = 8;
export type { EditorViewState } from "./editor-view-state";

export interface EditorPorts {
  onDocChange: (lineCount: number) => void;
  onCursor: (line: number, col: number) => void;
  onFontChange: (fontFamily: string, fontSize: number) => void;
  hasExternalFile: () => boolean;
  openExternally: () => void;
  onError: (message: string, error: unknown) => Promise<void>;
  openViewer: (format: api.ViewerFormat, text: string, selection: api.ViewerSelection | null) => Promise<string | null>;
  updateViewer: (label: string, text: string, selection: api.ViewerSelection | null) => Promise<boolean>;
}

// 全ファイル共通の仮想スクロールエディタ。文書は backend(mmap/overlay)が所有し、
// ここは可視スライスの描画と入力の中継のみを行う (全文を持たない)。
export class VirtualEditor {
  private gutter: HTMLElement;
  private scroll: HTMLElement;
  private hScroll: HTMLElement;
  private hScrollSpacer: HTMLElement;
  private inner: HTMLElement;
  private linesLayer: HTMLElement; // 行/選択ハイライトの描画専用コンテナ
  private caretEl: HTMLElement;
  private secondaryCaretEls: HTMLElement[] = [];
  private input: HTMLTextAreaElement;
  private findBar: FindBar;

  private lineCount = 1;
  private readOnly = false;
  private metrics: ViewportMetrics;
  private lineCache: LineCache;
  private raf = 0;
  private inputPositionRaf = 0;
  private imeBlurTimer: number | undefined;
  private imeBlurPending = false;
  private maxWidth = 0;
  private fontFamily: string;
  private fontSize: number;
  private readonly lineHeightExtra: number;
  private readonly paddingLeft: number;
  private readonly gutterWidth: number;
  private wrap = false;
  private wrapIntraLinePx = 0;
  private wrapHeights = new WrapHeightMap(1, 1);
  private wrapMeasureWidth = -1;
  private localRowTops = new Map<number, number>();
  private viewTop = 0; // 直近 render() 時点の scroll.scrollTop
  private viewTopLine = 0; // 直近 render() 時点で viewTop に対応する行番号
  // scaleMode 専用: 現在の仮想的な先頭行 (小数)。scrollTop からの逆算に頼らない権威値。
  // 巨大文書 (例: 2億4千万行) では1行あたりの圧縮px幅が1デバイスpx未満になり、
  // ホイールの小さい delta を scrollTop へ書き込んでもブラウザ側で丸められて
  // 変化が消えてしまう。scrollTop を読み戻して現在地を求めると、その丸めで
  // 毎回ゼロに戻ってしまい延々スクロールできなくなるため、ここで独自に保持する。
  private topLineF = 0;
  private scrollbarDragging = false; // ネイティブscrollTopを入力として扱う間だけtrue

  private sel = new Selection();
  private composing = false;
  private chain: Promise<unknown> = Promise.resolve();
  private findGen = 0; // 検索ループの世代。closeやEnter連打で古いループを打ち切るため
  private lastFindMatch: { start: Pos; end: Pos; pat: string; matchCase: boolean } | null = null; // 連続置換が対象にしてよい直前の一致
  private busy = false; // 全置換チャンク実行中は入力を無効化 (レジューム状態の破損防止)

  private onDocChange: (lineCount: number) => void;
  private onCursor: (line: number, col: number) => void;
  private onFontChange: (fontFamily: string, fontSize: number) => void;
  private hasExternalFile: () => boolean;
  private openExternally: () => void;
  private onError: (message: string, error: unknown) => Promise<void>;
  private liveViewers: LiveViewers;

  constructor(
    private host: HTMLElement,
    ports: EditorPorts,
    config: EditorConfig = DEFAULT_EDITOR_CONFIG,
    private doc: api.DocumentClient = api.documentClient
  ) {
    this.metrics = new ViewportMetrics(
      () => ({
        clientHeight: this.scroll.clientHeight,
        maxScroll: Math.max(0, this.scroll.scrollHeight - this.scroll.clientHeight),
      }),
      config.fontSize + config.lineHeightExtra
    );
    this.lineCache = new LineCache(doc);
    this.liveViewers = new LiveViewers({
      openViewer: ports.openViewer,
      updateViewer: ports.updateViewer,
      wholeRange: async () => {
        const last = this.lineCount - 1;
        return { start: { line: 0, col: 0 }, end: { line: last, col: await this.lineCache.lineLength(last) } };
      },
      textInRange: (start, end) => this.lineCache.textInRange(start, end),
    });
    this.onDocChange = ports.onDocChange;
    this.onCursor = ports.onCursor;
    this.onFontChange = ports.onFontChange;
    this.hasExternalFile = ports.hasExternalFile;
    this.openExternally = ports.openExternally;
    this.onError = ports.onError;
    this.fontFamily = config.fontFamily;
    this.fontSize = config.fontSize;
    this.lineHeightExtra = config.lineHeightExtra;
    this.metrics.lineHeight = config.fontSize + config.lineHeightExtra;
    this.paddingLeft = config.paddingLeft;
    this.gutterWidth = config.gutterWidth;
    this.host.classList.add("ve");
    this.host.style.setProperty("--ve-font-family", this.fontFamily);
    this.host.style.setProperty("--ve-font", `${this.fontSize}px`);
    this.host.style.setProperty("--line-h", `${this.metrics.lineHeight}px`);
    this.host.style.setProperty("--ve-pad-left", `${this.paddingLeft}px`);
    this.host.style.setProperty("--gutter-w", `${this.gutterWidth}px`);

    this.gutter = el("div", "ve-gutter");
    this.scroll = el("div", "ve-scroll");
    this.hScroll = el("div", "ve-hscroll");
    this.hScrollSpacer = el("div", "ve-hscroll-spacer");
    this.inner = el("div", "ve-inner");
    this.linesLayer = el("div", "ve-lines");
    this.caretEl = el("div", "ve-caret");
    this.input = document.createElement("textarea");
    this.input.className = "ve-input";
    this.input.spellcheck = false;
    this.input.autocapitalize = "off";
    (this.input as unknown as { autocorrect: string }).autocorrect = "off";

    // caretEl は一度だけ挿入し、以後 render() では linesLayer の中身だけ差し替える。
    this.inner.appendChild(this.linesLayer);
    this.inner.appendChild(this.caretEl);
    this.scroll.appendChild(this.inner);
    this.hScroll.appendChild(this.hScrollSpacer);
    this.host.appendChild(this.gutter);
    this.host.appendChild(this.scroll);
    this.host.appendChild(this.hScroll);
    // native IME用textareaは仮想本文のclip領域外に置く。WebView2へ空のcaret矩形を渡さないため。
    this.host.appendChild(this.input);

    this.findBar = new FindBar(
      this.host,
      (pat, forward, mc) => this.doFind(pat, forward, mc),
      (pat, rep, mc) => this.doReplaceAll(pat, rep, mc),
      (pat, rep, mc) => this.doReplaceNext(pat, rep, mc),
      () => { this.findGen++; this.lastFindMatch = null; this.focus(); }
    );

    this.scroll.addEventListener("scroll", () => {
      this.hScroll.scrollLeft = this.scroll.scrollLeft;
      this.onScroll();
    });
    this.hScroll.addEventListener("scroll", () => {
      this.scroll.scrollLeft = this.hScroll.scrollLeft;
    });
    this.scroll.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    this.scroll.addEventListener("mousedown", (e) => this.onMouseDown(e));
    this.scroll.addEventListener("contextmenu", (e) => this.onContextMenu(e));
    this.gutter.addEventListener("mousedown", (e) => this.onGutterMouseDown(e));
    this.input.addEventListener("keydown", (e) => this.onKeyDown(e));
    this.input.addEventListener("input", (e) => this.onInput(e as InputEvent));
    this.input.addEventListener("compositionstart", () => {
      this.composing = true;
      this.input.classList.add("ime"); // 変換中は textarea を可視化
      this.syncImeAnchor();
      this.caretEl.classList.remove("on");
    });
    this.input.addEventListener("compositionend", () => {
      this.finishComposition();
      if (this.imeBlurPending && this.imeBlurTimer === undefined) {
        this.imeBlurTimer = window.setTimeout(() => this.blurImeAfterGeometry(), 0);
      }
    });
    this.input.addEventListener("blur", () => {
      window.clearTimeout(this.imeBlurTimer);
      this.imeBlurTimer = undefined;
      this.imeBlurPending = false;
      if (this.composing || this.input.value) this.finishComposition();
      this.caretEl.classList.remove("on");
      this.secondaryCaretEls.forEach((caret) => caret.classList.remove("on"));
    });
    this.input.addEventListener("focus", () => this.render());
    window.addEventListener("mouseup", () => {
      if (!this.scrollbarDragging) return;
      if (this.wrap) {
        const anchor = this.wrapAnchorFromPx(this.scroll.scrollTop);
        this.topLineF = anchor.line;
        this.wrapIntraLinePx = anchor.intraLinePx;
      } else {
        this.topLineF = this.pxToLine(this.scroll.scrollTop);
      }
      this.scrollbarDragging = false;
      this.schedule();
    });
    window.addEventListener("focus", () => this.syncImeAnchorAfterLayout());
    window.addEventListener("resize", () => this.syncWindowGeometry());
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) this.syncImeAnchorAfterLayout();
    });
    window.visualViewport?.addEventListener("resize", () => this.syncImeAnchorAfterLayout());
    window.visualViewport?.addEventListener("scroll", () => this.syncImeAnchorAfterLayout());

    new ResizeObserver(() => {
      const topLine = this.wrap || this.metrics.scaleMode ? this.topLineF : this.pxToLine(this.scroll.scrollTop);
      const intraLinePx = this.wrapIntraLinePx;
      const wasAtBottom = topLine >= this.maxTopLine();
      if (this.wrap && this.wrapMeasureWidth !== this.scroll.getBoundingClientRect().width) {
        this.resetWrapHeights();
      }
      this.updateMetrics();
      const nextTopLine = wasAtBottom ? this.maxTopLine() : topLine;
      if (this.wrap) this.setWrapAnchor(nextTopLine, nextTopLine === topLine ? intraLinePx : 0);
      else this.setTopLine(nextTopLine);
      this.syncImeAnchorAfterLayout();
      this.schedule();
    }).observe(this.scroll);
  }

  // ---- 文書ロード ----
  // keepViewers: 同じファイルを読み直しただけの場合。開いているビューを閉じずに新内容へ差し替える
  open(lineCount: number, readOnly: boolean, keepViewers = false) {
    if (keepViewers) this.liveViewers.scheduleRefresh();
    else this.liveViewers.clear();
    this.lineCount = Math.max(1, lineCount);
    this.wrapIntraLinePx = 0;
    this.resetWrapHeights();
    this.readOnly = readOnly;
    this.lineCache.clear();
    
    this.maxWidth = 0;
    this.sel.reset();
    this.secondaryCaretEls.forEach((caret) => caret.remove());
    this.secondaryCaretEls = [];
    this.scroll.scrollLeft = 0;
    this.hScroll.scrollLeft = 0;
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
    this.syncImeAnchor();
    this.input.focus({ preventScroll: true });
    this.syncImeAnchor();
  }

  captureViewState(): EditorViewState {
    const topLine = this.wrap || this.metrics.scaleMode
      ? this.topLineF
      : this.pxToLine(this.scroll.scrollTop);
    return {
      anchor: { ...this.sel.anchor },
      caret: { ...this.sel.caret },
      topLine,
      wrapIntraLinePx: this.wrapIntraLinePx,
      scrollLeft: this.scroll.scrollLeft,
    };
  }

  async restoreViewState(state: EditorViewState) {
    const anchorLine = Math.max(0, Math.min(this.lineCount - 1, state.anchor.line));
    const caretLine = Math.max(0, Math.min(this.lineCount - 1, state.caret.line));
    const [anchorText, caretText] = await Promise.all([
      this.lineCache.line(anchorLine),
      this.lineCache.line(caretLine),
    ]);
    this.sel.anchor = {
      line: anchorLine,
      col: Math.max(0, Math.min(charLen(anchorText), state.anchor.col)),
    };
    this.sel.caret = {
      line: caretLine,
      col: Math.max(0, Math.min(charLen(caretText), state.caret.col)),
    };
    this.sel.secondary = [];
    this.sel.goalX = null;
    const topLine = Math.max(0, Math.min(this.maxTopLine(), state.topLine));
    if (this.wrap) this.setWrapAnchor(topLine, Math.max(0, state.wrapIntraLinePx));
    else this.setTopLine(topLine);
    await this.lineCache.line(Math.floor(topLine));
    this.render();
    this.setHorizontalScroll(Math.max(0, state.scrollLeft));
    this.notifyCursor();
  }

  syncWindowGeometry() {
    this.syncImeAnchorAfterLayout();
    window.clearTimeout(this.imeBlurTimer);
    this.imeBlurTimer = undefined;
    if (document.activeElement !== this.input) {
      this.imeBlurPending = false;
      return;
    }
    this.imeBlurPending = true;
    this.imeBlurTimer = window.setTimeout(() => this.blurImeAfterGeometry(), 50);
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

  async selectRange(line: number, startCol: number, endCol: number) {
    const targetLine = Math.max(0, Math.min(this.lineCount - 1, line));
    await this.lineCache.line(targetLine);
    this.sel.anchor = { line: targetLine, col: Math.max(0, startCol) };
    this.moveTo({ line: targetLine, col: Math.max(startCol, endCol) }, true);
    // 文書切替直後は初回moveTo時に対象行DOMがまだ無い。実本文の描画後に
    // 再配置し、フォルダ検索結果も縦横とも表示領域内へ入れる。
    this.ensureVisible();
    this.render();
    this.focus();
  }

  setWrap(on: boolean) {
    if (this.wrap === on) return;
    const topLine = this.wrap || this.metrics.scaleMode ? this.topLineF : this.pxToLine(this.scroll.scrollTop);
    const wasAtBottom = topLine >= this.maxTopLine();
    this.wrap = on;
    this.wrapIntraLinePx = 0;
    this.resetWrapHeights();
    this.scroll.classList.toggle("wrap", on);
    this.scroll.parentElement!.classList.toggle("hscroll-hidden", on);
    this.host.classList.toggle("wrap", on);
    this.hScroll.hidden = on;
    this.scroll.scrollLeft = 0;
    this.hScroll.scrollLeft = 0;
    this.maxWidth = 0;
    this.updateMetrics();
    this.setTopLine(wasAtBottom ? this.maxTopLine() : topLine);
    this.render();
  }

  setFont(fontFamily: string, fontSize: number) {
    const topLine = this.wrap || this.metrics.scaleMode ? this.topLineF : this.pxToLine(this.scroll.scrollTop);
    const wasAtBottom = topLine >= this.maxTopLine();
    this.fontFamily = fontFamily;
    this.fontSize = Math.max(8, Math.min(72, fontSize));
    this.metrics.lineHeight = this.fontSize + this.lineHeightExtra;
    this.scroll.parentElement!.style.setProperty("--ve-font-family", this.fontFamily);
    this.scroll.parentElement!.style.setProperty("--ve-font", `${this.fontSize}px`);
    this.scroll.parentElement!.style.setProperty("--line-h", `${this.metrics.lineHeight}px`);
    if (this.wrap) this.wrapIntraLinePx = 0;
    this.resetWrapHeights();
    this.maxWidth = 0;
    this.updateMetrics();
    this.setTopLine(wasAtBottom ? this.maxTopLine() : topLine);
    this.render();
    this.onFontChange(this.fontFamily, this.fontSize);
  }

  setTabSize(size: number) {
    this.scroll.parentElement!.style.setProperty("--ve-tab-size", String(Math.max(1, Math.min(16, size))));
    this.maxWidth = 0;
    this.resetWrapHeights();
    this.updateMetrics();
    this.render();
  }

  // 行数/行高の変更を metrics へ反映し、スクロール範囲をDOMへ書き戻す。
  private updateMetrics() {
    this.metrics.lineCount = this.lineCount;
    this.metrics.wrap = this.wrap;
    const height = this.wrap
      ? Math.min(this.wrapHeights.totalHeight(), MAX_SAFE_HEIGHT)
      : this.metrics.scrollHeight;
    this.inner.style.height = `${Math.max(height, 1)}px`;
  }

  private resetWrapHeights() {
    this.wrapHeights.reset(this.lineCount, this.metrics.lineHeight);
    this.wrapMeasureWidth = this.scroll?.getBoundingClientRect().width ?? -1;
  }

  private maxTopLine(): number {
    return this.metrics.maxTopLine();
  }

  private lineToPx(line: number): number {
    return this.metrics.lineToPx(line);
  }

  private pxToLine(px: number): number {
    return this.metrics.pxToLine(px);
  }

  // topLineF (権威値) を line に設定し、scrollTop へも反映する。
  // scrollTop 側は1億行超級の文書では1行 <1デバイスpx になり、ブラウザが
  // 書き込み値を丸めてしまうことがあるが、実際に何行目を描画するかは
  // render() が topLineF を直接見るため、scrollTop が丸められても表示は壊れない
  // (scrollTop はネイティブスクロールバーのつまみ位置を近似するためだけに使う)。
  private setTopLine(line: number) {
    this.topLineF = Math.max(0, Math.min(this.maxTopLine(), line));
    if (this.wrap) this.wrapIntraLinePx = 0;
    this.scroll.scrollTop = this.wrap
      ? this.wrapAnchorToPx(this.topLineF, 0)
      : this.lineToPx(this.topLineF);
  }

  private setWrapAnchor(line: number, intraLinePx: number) {
    this.topLineF = Math.max(0, Math.min(this.maxTopLine(), Math.floor(line)));
    this.wrapIntraLinePx = Math.max(
      0,
      Math.min(
        intraLinePx,
        Math.max(this.wrapHeights.heightAt(this.topLineF), this.wrappedLineHeight(this.topLineF)),
      ),
    );
    this.scroll.scrollTop = this.wrapAnchorToPx(this.topLineF, this.wrapIntraLinePx);
  }

  private wrapAnchorToPx(line: number, intraLinePx: number): number {
    const virtualMax = Math.max(0, this.wrapHeights.totalHeight() - this.scroll.clientHeight);
    const nativeMax = Math.max(0, this.scroll.scrollHeight - this.scroll.clientHeight);
    if (!virtualMax || !nativeMax) return 0;
    return Math.min(1, this.wrapHeights.offsetOf(line, intraLinePx) / virtualMax) * nativeMax;
  }

  private wrapAnchorFromPx(px: number): { line: number; intraLinePx: number } {
    const virtualMax = Math.max(0, this.wrapHeights.totalHeight() - this.scroll.clientHeight);
    const nativeMax = Math.max(0, this.scroll.scrollHeight - this.scroll.clientHeight);
    const offset = nativeMax ? Math.min(1, Math.max(0, px / nativeMax)) * virtualMax : 0;
    return this.wrapHeights.anchorAt(offset);
  }

  private wrappedLineHeight(line: number): number {
    const elem = this.lineElem(line);
    return elem ? Math.max(this.metrics.lineHeight, elem.getBoundingClientRect().height) : this.metrics.lineHeight;
  }

  private scrollWrapBy(deltaPx: number) {
    let line = Math.round(this.topLineF);
    let intra = this.wrapIntraLinePx + deltaPx;
    while (intra >= this.wrappedLineHeight(line) && line < this.lineCount - 1) {
      intra -= this.wrappedLineHeight(line);
      line++;
    }
    while (intra < 0 && line > 0) {
      line--;
      intra += this.wrappedLineHeight(line);
    }
    if (line === 0) intra = Math.max(0, intra);
    if (line === this.lineCount - 1) {
      intra = Math.min(intra, Math.max(0, this.wrappedLineHeight(line) - this.scroll.clientHeight));
    }
    this.setWrapAnchor(line, intra);
  }

  // 行 i の描画用 top (px)。scaleMode では viewTopLine を viewTop に固定し、
  // 可視域内は常に行高の間隔で並べる (行密度が px 密度を上回っても崩れない)。
  private rowTop(i: number): number {
    if (this.wrap) return this.localRowTops.get(i) ?? this.viewTop;
    return this.metrics.scaleMode ? this.viewTop + (i - this.viewTopLine) * this.metrics.lineHeight : i * this.metrics.lineHeight;
  }

  // ---- 行キャッシュ ----
  // ---- 描画 ----
  private schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  private onScroll() {
    if (this.wrap && this.scrollbarDragging) {
      const anchor = this.wrapAnchorFromPx(this.scroll.scrollTop);
      this.topLineF = anchor.line;
      this.wrapIntraLinePx = anchor.intraLinePx;
    } else if (!this.wrap && (!this.metrics.scaleMode || this.scrollbarDragging)) {
      this.topLineF = this.pxToLine(this.scroll.scrollTop);
    }
    if (document.activeElement === this.input) this.placeCaret();
    this.schedule();
  }

  private render() {
    const top = this.scroll.scrollTop;
    const h = this.scroll.clientHeight;
    const topLine = Math.round(this.topLineF);
    this.viewTop = top;
    this.viewTopLine = topLine;
    const visibleRows = Math.ceil(h / this.metrics.lineHeight) + 1;
    const first = Math.max(0, topLine - (this.wrap ? visibleRows : 0) - OVERSCAN);
    // 1論理行の最小高はlineHeight→この件数なら折り返し量に関係なく
    // viewportとoverscanを必ず埋められる。
    const last = Math.min(this.lineCount, topLine + visibleRows + OVERSCAN);

    // 未取得チャンクを要求
    let needFetch = false;
    for (let c = LineCache.chunkOf(first); c <= LineCache.chunkOf(last - 1); c++) {
      if (!this.lineCache.has(c)) {
        needFetch = true;
        this.lineCache.fetch(c).then(() => this.schedule());
      }
    }

    // 行 + ガター
    // selectLines() でガター上の行をクリックすると、改行込みで選択するため
    // caret は選択末尾の「次の行の先頭」に置かれる (行1をクリック→caretは行2)。
    // それをそのまま「現在行」として使うと、クリックした行の1つ下が光って見える
    // ため、この形の行選択中は1つ前の行(実際に選択されている行)を現在行として扱う。
    const wholeLineSelectEnd =
      this.sel.anchor.col === 0 && this.sel.caret.col === 0 && this.sel.caret.line > this.sel.anchor.line;
    const curLine = wholeLineSelectEnd ? this.sel.caret.line - 1 : this.sel.caret.line;
    const caretLines = new Set([curLine, ...this.sel.secondary.map((caret) => caret.line)]);
    const selectedLines = selectedLineRange(this.sel.anchor, this.sel.caret);
    this.renderVisibleLines(first, last);
    this.layoutVisibleLines(first, last, topLine, top);

    this.renderGutter(first, last, top, selectedLines, caretLines);

    // 新しい可視行DOMを基準にRangeを測定する。旧DOMを測るとスクロール後に欠落する。
    const selectionFrag = document.createDocumentFragment();
    this.appendSelection(selectionFrag, first, last);
    this.linesLayer.prepend(selectionFrag);

    // 横スクロール用に inner 幅を可視行の最大幅へ更新
    this.updateWidth();
    if (!needFetch) this.updateGutterWidth();
    this.syncImeAnchor();
  }

  private renderVisibleLines(first: number, last: number) {
    const current = [...this.linesLayer.querySelectorAll<HTMLElement>(":scope > .ve-line")];
    const canReuse = current.length === last - first
      && current.every((line, index) => line.dataset.line === String(first + index));
    if (canReuse) {
      this.linesLayer.querySelectorAll(":scope > .ve-sel").forEach((selection) => selection.remove());
      current.forEach((line, index) => {
        const text = this.lineCache.peek(first + index) ?? "…";
        if (line.textContent !== text) line.textContent = text;
      });
      return;
    }

    const frag = document.createDocumentFragment();
    for (let i = first; i < last; i++) {
      const line = el("div", "ve-line");
      line.dataset.line = String(i);
      line.textContent = this.lineCache.peek(i) ?? "…";
      frag.appendChild(line);
    }
    this.linesLayer.replaceChildren(frag);
  }

  private renderGutter(
    first: number,
    last: number,
    top: number,
    selectedLines: { first: number; last: number } | null,
    caretLines: Set<number>,
  ) {
    let rows = [...this.gutter.querySelectorAll<HTMLElement>(":scope > .ve-gnum")];
    const canReuse = rows.length === last - first
      && rows.every((row, index) => row.dataset.line === String(first + index));
    if (!canReuse) {
      const frag = document.createDocumentFragment();
      for (let i = first; i < last; i++) {
        const row = el("div", "ve-gnum");
        row.dataset.line = String(i);
        const groups = lineNumberGroups(i + 1);
        row.append(document.createTextNode(groups[0]));
        for (const group of groups.slice(1)) {
          const separator = el("span", "ve-gnum-separator");
          separator.textContent = group;
          row.appendChild(separator);
        }
        frag.appendChild(row);
      }
      this.gutter.replaceChildren(frag);
      rows = [...this.gutter.querySelectorAll<HTMLElement>(":scope > .ve-gnum")];
    }
    rows.forEach((row, index) => {
      const line = first + index;
      row.style.top = `${this.rowTop(line) - top}px`;
      row.classList.toggle(
        "selected-line",
        selectedLines !== null && line >= selectedLines.first && line <= selectedLines.last,
      );
      row.classList.toggle("caret-line", caretLines.has(line));
    });
  }

  private layoutVisibleLines(first: number, last: number, topLine: number, viewTop: number) {
    this.localRowTops.clear();
    if (!this.wrap) {
      for (let i = first; i < last; i++) {
        const line = this.lineElem(i);
        if (line) line.style.top = `${this.rowTop(i)}px`;
      }
      return;
    }

    // topLineだけをviewportへ固定し、前後は今回生成したDOMの実測高だけで並べる。
    // 可視外の折り返し数や文書先頭からの累積値は保持しない。
    let heightsChanged = false;
    let y = viewTop - this.wrapIntraLinePx;
    for (let i = topLine; i < last; i++) {
      const line = this.lineElem(i);
      if (!line) continue;
      this.localRowTops.set(i, y);
      line.style.top = `${y}px`;
      const height = Math.max(this.metrics.lineHeight, line.getBoundingClientRect().height);
      if (!this.scrollbarDragging) {
        heightsChanged = this.wrapHeights.set(i, height) || heightsChanged;
      }
      y += height;
    }
    y = viewTop - this.wrapIntraLinePx;
    for (let i = topLine - 1; i >= first; i--) {
      const line = this.lineElem(i);
      if (!line) continue;
      const height = Math.max(this.metrics.lineHeight, line.getBoundingClientRect().height);
      if (!this.scrollbarDragging) {
        heightsChanged = this.wrapHeights.set(i, height) || heightsChanged;
      }
      y -= height;
      this.localRowTops.set(i, y);
      line.style.top = `${y}px`;
    }
    if (heightsChanged) {
      this.updateMetrics();
      this.scroll.scrollTop = this.wrapAnchorToPx(this.topLineF, this.wrapIntraLinePx);
      this.schedule();
    }
  }

  private updateWidth() {
    if (this.wrap) {
      this.inner.style.width = "100%";
      this.hScrollSpacer.style.width = "100%";
      return;
    }
    let w = 0;
    for (const l of this.inner.querySelectorAll<HTMLElement>(".ve-line")) {
      w = Math.max(w, l.scrollWidth);
    }
    this.maxWidth = Math.max(this.maxWidth, w + 40);
    this.inner.style.width = `${this.maxWidth}px`;
    const viewportDifference = this.hScroll.clientWidth - this.scroll.clientWidth;
    this.hScrollSpacer.style.width = `${Math.max(0, this.maxWidth + viewportDifference)}px`;
  }

  private updateGutterWidth() {
    const sample = this.gutter.querySelector<HTMLElement>(".ve-gnum");
    const style = getComputedStyle(sample ?? this.gutter);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) return;
    context.font = style.font;
    const groups = lineNumberGroups(this.lineCount);
    const numberWidth = context.measureText(groups.join("")).width + (groups.length - 1) * 2;
    const w = Math.max(this.gutterWidth, Math.ceil(numberWidth + 24));
    this.scroll.parentElement!.style.setProperty("--gutter-w", `${w}px`);
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
    const s = this.lineCache.peek(this.sel.caret.line) ?? "";
    const lineEl = this.lineElem(this.sel.caret.line);
    const y = lineEl ? this.rowTop(this.sel.caret.line) : this.scroll.scrollTop;
    const point = lineEl && this.wrap ? this.wrapPoint(lineEl, s, this.sel.caret.col) : null;
    const caretY = point?.y ?? y;
    const outsideViewport = caretY < this.scroll.scrollTop
      || caretY + this.metrics.lineHeight > this.scroll.scrollTop + this.scroll.clientHeight;
    if (!lineEl || outsideViewport) {
      // 画面外の論理行座標へ focused textarea を置くと、巨大文書ではCSS座標上限を
      // 超えてスクロール範囲自体が変わる。入力フォーカスだけ表示領域内で維持する。
      this.caretEl.classList.remove("on");
      this.placeInputAt(this.scroll.scrollLeft + this.paddingLeft, this.scroll.scrollTop);
      this.placeSecondaryCarets();
      return;
    }
    this.caretEl.classList.toggle("on", document.activeElement === this.input);
    const x = point?.x ?? (lineEl ? this.colToX(lineEl, s, this.sel.caret.col) : this.paddingLeft);
    this.caretEl.style.top = `${caretY}px`;
    this.caretEl.style.left = `${x}px`;
    this.placeSecondaryCarets();
    // IME 変換窓を追従させるため textarea も同座標へ
    if (this.composing && this.wrap) {
      this.placeInputAt(this.paddingLeft, caretY);
      const indent = Math.max(0, x - this.paddingLeft);
      this.input.style.textIndent = `${indent}px`;
      this.input.style.setProperty("--ime-indent", `${indent}px`);
    } else {
      this.placeInputAt(x, caretY);
      this.input.style.removeProperty("text-indent");
      this.input.style.removeProperty("--ime-indent");
    }
  }

  private placeInputAt(contentX: number, contentY: number) {
    const viewportX = contentX - this.scroll.scrollLeft;
    const viewportY = contentY - this.scroll.scrollTop;
    const { x, y } = clampImeAnchor(
      viewportX,
      viewportY,
      this.scroll.clientWidth,
      this.scroll.clientHeight,
      this.paddingLeft,
      this.metrics.lineHeight,
    );
    this.input.style.left = `${this.scroll.offsetLeft + x}px`;
    this.input.style.top = `${this.scroll.offsetTop + y}px`;
  }

  private syncImeAnchor() {
    this.placeCaret();
    if (this.composing) this.resizeImeInput();
    this.keepImeAnchorInsideViewport();
    // WebView2がnative IMEへ渡すcaret矩形を、現在のlayoutで確定させる。
    void this.input.getBoundingClientRect();
  }

  private syncImeAnchorAfterLayout() {
    this.syncImeAnchor();
    if (this.inputPositionRaf) return;
    this.inputPositionRaf = requestAnimationFrame(() => {
      this.inputPositionRaf = 0;
      this.syncImeAnchor();
    });
  }

  private blurImeAfterGeometry() {
    this.imeBlurTimer = undefined;
    if (!this.imeBlurPending || this.composing || document.activeElement !== this.input) return;

    this.imeBlurPending = false;
    this.input.blur();
  }

  private keepImeAnchorInsideViewport() {
    const viewport = this.scroll.getBoundingClientRect();
    const input = this.input.getBoundingClientRect();
    if (viewport.width <= 0 || viewport.height <= 0 || input.width <= 0 || input.height <= 0) return;
    const inside = input.left >= viewport.left
      && input.top >= viewport.top
      && input.right <= viewport.right
      && input.bottom <= viewport.bottom;
    if (inside) return;
    const host = this.host.getBoundingClientRect();
    this.input.style.left = `${viewport.left - host.left + this.paddingLeft}px`;
    this.input.style.top = `${viewport.top - host.top}px`;
  }

  private wrapPoint(lineEl: HTMLElement, s: string, col: number): { x: number; y: number } | null {
    const node = lineEl.firstChild;
    if (!node) return null;
    const range = document.createRange();
    range.setStart(node, Math.min(charToU16(s, col), node.textContent?.length ?? 0));
    range.collapse(true);
    const rect = range.getClientRects()[0] ?? lineEl.getBoundingClientRect();
    const inner = this.inner.getBoundingClientRect();
    return { x: rect.left - inner.left, y: rect.top - inner.top };
  }

  private appendSelection(frag: DocumentFragment, first: number, last: number) {
    if (cmp(this.sel.anchor, this.sel.caret) === 0) return;
    const [s, e] = cmp(this.sel.anchor, this.sel.caret) < 0 ? [this.sel.anchor, this.sel.caret] : [this.sel.caret, this.sel.anchor];
    if (this.wrap) {
      const inner = this.inner.getBoundingClientRect();
      for (let i = Math.max(first, s.line); i < Math.min(last, e.line + 1); i++) {
        const str = this.lineCache.peek(i) ?? "";
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
          box.style.top = `${rect.top - inner.top}px`;
          box.style.left = `${rect.left - inner.left}px`;
          box.style.width = `${Math.max(2, rect.width)}px`;
          box.style.height = `${rect.height}px`;
          frag.insertBefore(box, frag.firstChild);
        }
      }
      return;
    }
    for (let i = Math.max(first, s.line); i < Math.min(last, e.line + 1); i++) {
      const str = this.lineCache.peek(i) ?? "";
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
    const [start, end] = this.sel.norm();
    this.liveViewers.setSelection({ start, end });
    this.onCursor(this.sel.caret.line + 1, this.sel.caret.col + 1);
  }

  private moveTo(pos: Pos, extend: boolean, keepGoal = false, keepSecondary = false) {
    if (!keepSecondary) {
      this.sel.secondary = [];
      this.sel.multiCaretX = null;
    }
    this.sel.caret = pos;
    if (!extend) this.sel.anchor = pos;
    if (!keepGoal) this.sel.goalX = null;
    this.ensureVisible();
    this.render();
    this.notifyCursor();
  }

  private syncCaretBlink() {
    const carets = [this.caretEl, ...this.secondaryCaretEls.slice(0, this.sel.secondary.length)];
    carets.forEach((caret) => caret.classList.remove("on"));
    void this.caretEl.offsetWidth;
    if (document.activeElement === this.input) carets.forEach((caret) => caret.classList.add("on"));
  }

  private async addCaretVert(delta: -1 | 1) {
    if (this.sel.hasSel()) return;
    const from = this.sel.caret;
    const line = Math.max(0, Math.min(this.lineCount - 1, from.line + delta));
    if (line === from.line) return;
    const fromText = await this.lineCache.line(from.line);
    const fromLine = this.lineElem(from.line);
    if (this.sel.multiCaretX === null && fromLine) {
      this.sel.multiCaretX = this.colToX(fromLine, fromText, from.col);
    }
    const x = this.sel.multiCaretX;
    await this.lineCache.line(line);
    this.render();
    const targetText = this.lineCache.peek(line) ?? "";
    const targetLine = this.lineElem(line);
    const target = {
      line,
      col: x !== null && targetLine ? this.xToCol(targetLine, targetText, x) : Math.min(from.col, charLen(targetText)),
    };
    if (this.sel.all().some((p) => cmp(p, target) === 0)) return;
    this.sel.secondary.push(from);
    this.sel.caret = target;
    this.sel.anchor = target;
    this.sel.goalX = null;
    this.ensureVisible();
    this.render();
    this.syncCaretBlink();
    this.notifyCursor();
  }

  private ensureVisible() {
    if (this.wrap) {
      const lineEl = this.lineElem(this.sel.caret.line);
      if (!lineEl) {
        this.setTopLine(this.sel.caret.line);
        return;
      }
      const s = this.lineCache.peek(this.sel.caret.line) ?? "";
      const point = this.wrapPoint(lineEl, s, this.sel.caret.col);
      if (!point) return;
      const top = this.viewTop;
      const bottom = top + this.scroll.clientHeight - this.metrics.lineHeight;
      if (point.y < top) this.scrollWrapBy(point.y - top);
      else if (point.y > bottom) this.scrollWrapBy(point.y - bottom);
      return;
    }
    if (this.metrics.scaleMode) {
      // scaleMode では scrollTop が行数に対して線形圧縮されており、caret.line を
      // lineToPx() の実数値で直接 top/bottom 判定すると、行高・clientHeight という
      // 「非圧縮px」の量を圧縮空間に混在させてしまい、1行の移動が数千行分の
      // スクロールに化けてしまう。そのため行番号(整数)だけで可視判定し、
      // 最後に lineToPx() で一度だけ scrollTop へ変換する。
      const visibleRows = Math.max(1, Math.floor(this.scroll.clientHeight / this.metrics.lineHeight));
      let topLine = this.topLineF;
      if (this.sel.caret.line < topLine) topLine = this.sel.caret.line;
      else if (this.sel.caret.line >= topLine + visibleRows) topLine = this.sel.caret.line - visibleRows + 1;
      if (topLine !== this.topLineF) this.setTopLine(topLine);
    } else {
      const y = this.lineToPx(this.sel.caret.line);
      const top = this.scroll.scrollTop;
      const h = this.scroll.clientHeight;
      if (y < top) this.setTopLine(this.sel.caret.line);
      else if (y + this.metrics.lineHeight > top + h) {
        this.setTopLine(this.pxToLine(y + this.metrics.lineHeight - h));
      }
    }
    // 横方向: caret が見えるように
    const s = this.lineCache.peek(this.sel.caret.line) ?? "";
    const lineEl = this.lineElem(this.sel.caret.line);
    if (lineEl) {
      const x = this.colToX(lineEl, s, this.sel.caret.col);
      const sl = this.scroll.scrollLeft;
      const w = this.scroll.clientWidth;
      if (x < sl + this.paddingLeft) this.setHorizontalScroll(Math.max(0, x - this.paddingLeft));
      else if (x > sl + w - 20) this.setHorizontalScroll(x - w + 20);
    }
  }

  private setHorizontalScroll(left: number) {
    this.scroll.scrollLeft = left;
    this.hScroll.scrollLeft = this.scroll.scrollLeft;
  }


  private async horiz(dir: -1 | 1, extend: boolean) {
    const c = this.sel.caret;
    if (!extend && cmp(this.sel.anchor, c) !== 0) {
      // 選択解除は端へ
      const [s, e] = cmp(this.sel.anchor, c) < 0 ? [this.sel.anchor, c] : [c, this.sel.anchor];
      this.moveTo(dir < 0 ? s : e, false);
      return;
    }
    if (dir < 0) {
      if (c.col > 0) this.moveTo({ line: c.line, col: c.col - 1 }, extend);
      else if (c.line > 0) {
        const len = await this.lineCache.lineLength(c.line - 1);
        this.moveTo({ line: c.line - 1, col: len }, extend);
      }
    } else {
      const len = await this.lineCache.lineLength(c.line);
      if (c.col < len) this.moveTo({ line: c.line, col: c.col + 1 }, extend);
      else if (c.line + 1 < this.lineCount) this.moveTo({ line: c.line + 1, col: 0 }, extend);
    }
  }

  private async wordMove(dir: -1 | 1, extend: boolean) {
    const c = this.sel.caret;
    const s = await this.lineCache.line(c.line);
    const chars = [...s];
    if (dir < 0) {
      if (c.col === 0) {
        if (c.line > 0) {
          const len = await this.lineCache.lineLength(c.line - 1);
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
    const c = this.sel.caret;
    const targetLine = Math.max(0, Math.min(this.lineCount - 1, c.line + delta));
    if (targetLine === c.line) return;
    if (this.sel.goalX === null) {
      const s = this.lineCache.peek(c.line) ?? "";
      const lineEl = this.lineElem(c.line);
      this.sel.goalX = lineEl ? this.colToX(lineEl, s, c.col) - this.paddingLeft : 0;
    }
    // 目標 x に最も近い列へ (行が描画済みでなければ列を長さで近似)
    await this.lineCache.line(targetLine);
    this.render();
    const s = this.lineCache.peek(targetLine) ?? "";
    const lineEl = this.lineElem(targetLine);
    let col = charLen(s);
    if (lineEl) col = this.xToCol(lineEl, s, this.paddingLeft + this.sel.goalX);
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
    return Math.max(1, Math.floor(this.scroll.clientHeight / this.metrics.lineHeight) - 1);
  }

  private async home(extend: boolean) {
    this.moveTo({ line: this.sel.caret.line, col: 0 }, extend);
  }
  private async end(extend: boolean) {
    const len = await this.lineCache.lineLength(this.sel.caret.line);
    this.moveTo({ line: this.sel.caret.line, col: len }, extend);
  }

  // ---- 選択 ----
  private selectionText(): string {
    if (!this.sel.hasSel()) return "";
    const [s, e] = this.sel.norm();
    if (s.line === e.line) {
      const str = this.lineCache.peek(s.line) ?? "";
      return [...str].slice(s.col, e.col).join("");
    }
    return ""; // 複数行はプレースホルダ用途のみ (検索欄初期値)
  }

  private async selectAll() {
    const last = this.lineCount - 1;
    const len = await this.lineCache.lineLength(last);
    this.sel.anchor = { line: 0, col: 0 };
    this.moveTo({ line: last, col: len }, true);
  }

  // ---- 編集 (backend へ委譲・順序保証) ----
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn);
    this.chain = p.catch(() => {});
    return p;
  }

  private applyResult(r: api.EditResult, fromLine: number, edits: api.EditManyItem[] = []) {
    const oldTopLine = this.wrap || this.metrics.scaleMode ? this.topLineF : this.pxToLine(this.scroll.scrollTop);
    const oldIntraLinePx = this.wrapIntraLinePx;
    const wasAtBottom = oldTopLine >= this.maxTopLine();
    const oldLineCount = this.lineCount;
    this.lineCount = Math.max(1, r.line_count);
    this.resetWrapHeights();
    this.updateMetrics();
    // 行数変更前後の座標系を混在させない。末尾表示中は新しい末尾へ追従し、
    // それ以外は同じ先頭行を維持する。
    const nextTopLine = wasAtBottom ? this.maxTopLine() : oldTopLine;
    if (this.wrap) this.setWrapAnchor(nextTopLine, nextTopLine === oldTopLine ? oldIntraLinePx : 0);
    else this.setTopLine(nextTopLine);
    const cached = oldLineCount === this.lineCount
      && edits.length === 1
      && this.lineCache.applySingleLineEdit(edits[0].start, edits[0].end, edits[0].text);
    if (!cached) this.lineCache.invalidateFrom(fromLine);
    this.liveViewers.applyEdits(edits);
    this.sel.caret = r.caret;
    this.sel.anchor = r.caret;
    this.sel.goalX = null;
    this.onDocChange(this.lineCount);
    this.liveViewers.scheduleRefresh();
  }

  private async renderAfterEdit() {
    const previousScrollLeft = this.scroll.scrollLeft;
    const visibleRows = Math.ceil(this.scroll.clientHeight / this.metrics.lineHeight) + OVERSCAN;
    const topLine = this.metrics.scaleMode ? Math.round(this.topLineF) : this.pxToLine(this.scroll.scrollTop);
    const first = Math.max(0, topLine - OVERSCAN);
    const last = Math.min(this.lineCount - 1, topLine + visibleRows);
    for (let c = LineCache.chunkOf(first); c <= LineCache.chunkOf(last); c++) {
      await this.lineCache.fetch(c);
    }
    if (!this.wrap) this.ensureVisible();
    this.render();
    if (!this.wrap) this.scroll.scrollLeft = previousScrollLeft;
    this.ensureVisible();
    this.syncImeAnchor();
    this.notifyCursor();
  }

  private insertText(text: string): Promise<void> {
    if (this.readOnly) return Promise.resolve();
    if (this.sel.secondary.length) {
      return this.run(async () => {
        this.sel.multiCaretX = null;
        const carets = this.sel.all();
        const edits = carets.map((pos) => ({ start: pos, end: pos, text }));
        const fromLine = Math.min(...carets.map((pos) => pos.line));
        const r = await this.doc.editMany(edits, this.sel.caret, 0);
        this.applyResult({ caret: r.carets[0], line_count: r.line_count }, fromLine, edits);
        this.sel.caret = r.carets[0];
        this.sel.anchor = this.sel.caret;
        this.sel.secondary = r.carets.slice(1);
        await this.renderAfterEdit();
      });
    }
    return this.run(async () => {
      const [s, e] = this.sel.norm();
      const coalesce = !this.sel.hasSel() && text.length === 1 && text !== "\n";
      const r = await this.doc.edit(s, e, this.sel.caret, text, coalesce);
      this.applyResult(r, s.line, [{ start: s, end: e, text }]);
      await this.renderAfterEdit();
    });
  }

  private insertNewlineWithIndent(): Promise<void> {
    if (this.readOnly) return Promise.resolve();
    if (this.sel.secondary.length) return this.insertText("\n");
    return this.run(async () => {
      const [s, e] = this.sel.norm();
      const line = await this.lineCache.line(s.line);
      const text = newlineWithLeadingTabs(line);
      const r = await this.doc.edit(s, e, this.sel.caret, text, false);
      this.applyResult(r, s.line, [{ start: s, end: e, text }]);
      await this.renderAfterEdit();
    });
  }

  private indentSelection(): Promise<void> {
    const plan = planLineIndent(this.sel.anchor, this.sel.caret);
    if (!plan) return this.insertText("\t");
    if (this.readOnly) return Promise.resolve();
    return this.run(async () => {
      const caret = { ...this.sel.caret };
      const r = await this.doc.editMany(
        plan.edits,
        caret,
        plan.primaryIndex,
      );
      this.applyResult({ caret: plan.nextCaret, line_count: r.line_count }, plan.fromLine, plan.edits);
      this.sel.anchor = plan.nextAnchor;
      this.sel.caret = plan.nextCaret;
      await this.renderAfterEdit();
    });
  }

  private deleteSel(): Promise<void> {
    return this.run(async () => {
      const [s, e] = this.sel.norm();
      const r = await this.doc.edit(s, e, this.sel.caret, "", false);
      this.applyResult(r, s.line, [{ start: s, end: e, text: "" }]);
      await this.renderAfterEdit();
    });
  }

  private backspace(): Promise<void> {
    if (this.readOnly) return Promise.resolve();
    if (this.sel.hasSel()) {
      return this.deleteSel();
    }
    return this.run(async () => {
      const c = this.sel.caret;
      let s: Pos;
      if (c.col > 0) s = { line: c.line, col: c.col - 1 };
      else if (c.line > 0) s = { line: c.line - 1, col: await this.lineCache.lineLength(c.line - 1) };
      else return;
      const r = await this.doc.edit(s, c, c, "", false);
      this.applyResult(r, s.line, [{ start: s, end: c, text: "" }]);
      await this.renderAfterEdit();
    });
  }

  private deleteForward(): Promise<void> {
    if (this.readOnly) return Promise.resolve();
    if (this.sel.hasSel()) {
      return this.deleteSel();
    }
    return this.run(async () => {
      const c = this.sel.caret;
      const len = await this.lineCache.lineLength(c.line);
      let e: Pos;
      if (c.col < len) e = { line: c.line, col: c.col + 1 };
      else if (c.line + 1 < this.lineCount) e = { line: c.line + 1, col: 0 };
      else return;
      const r = await this.doc.edit(c, e, c, "", false);
      this.applyResult(r, c.line, [{ start: c, end: e, text: "" }]);
      await this.renderAfterEdit();
    });
  }

  private doUndo(redo: boolean): Promise<void> {
    if (this.readOnly) return Promise.resolve();
    return this.run(async () => {
      const r = redo ? await this.doc.redo() : await this.doc.undo();
      if (!r) return;
      this.applyResult(r, 0);
      this.sel.secondary = [];
      this.sel.multiCaretX = null;
      this.ensureVisible();
      this.render();
      this.notifyCursor();
    });
  }

  private async copy(cut: boolean) {
    if (!this.sel.hasSel()) return;
    const [s, e] = this.sel.norm();
    const text = await this.lineCache.textInRange(s, e);
    await navigator.clipboard.writeText(text);
    if (cut && !this.readOnly) await this.deleteSel();
  }

  private placeSecondaryCarets() {
    while (this.secondaryCaretEls.length < this.sel.secondary.length) {
      const caret = el("div", "ve-caret on");
      this.inner.appendChild(caret);
      this.secondaryCaretEls.push(caret);
    }
    for (let i = 0; i < this.secondaryCaretEls.length; i++) {
      const caret = this.secondaryCaretEls[i];
      const pos = this.sel.secondary[i];
      if (!pos) { caret.classList.remove("on"); continue; }
      const text = this.lineCache.peek(pos.line) ?? "";
      const line = this.lineElem(pos.line);
      if (!line) { caret.classList.remove("on"); continue; }
      const point = this.wrap ? this.wrapPoint(line, text, pos.col) : null;
      caret.style.top = `${point?.y ?? this.rowTop(pos.line)}px`;
      caret.style.left = `${point?.x ?? this.colToX(line, text, pos.col)}px`;
      caret.classList.toggle("on", document.activeElement === this.input);
    }
  }


  private async openTextViewer(format: api.ViewerFormat) {
    const [selectionStart, selectionEnd] = this.sel.norm();
    const selection = { start: selectionStart, end: selectionEnd };
    if (!this.sel.hasSel()) return this.liveViewers.open(format, null, selection);
    const { start, end } = selection;
    return this.liveViewers.open(format, { start: { ...start }, end: { ...end } }, selection);
  }

  private moveSelection(target: Pos) {
    if (this.readOnly) return;
    const [s, e] = this.sel.norm();
    if (cmp(target, s) >= 0 && cmp(target, e) <= 0) return;
    this.run(async () => {
      const text = await this.lineCache.textInRange(s, e);
      const drop = cmp(target, e) > 0 ? positionAfterDeletion(s, e, target) : target;
      const deleted = await this.doc.edit(s, e, e, "", false);
      this.applyResult(deleted, s.line, [{ start: s, end: e, text: "" }]);
      const inserted = await this.doc.edit(drop, drop, drop, text, false);
      this.applyResult(inserted, drop.line, [{ start: drop, end: drop, text }]);
      await this.renderAfterEdit();
    });
  }

  private async paste() {
    if (this.readOnly) return;
    const text = (await navigator.clipboard.readText()).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (text) await this.insertText(text);
  }

  // ---- キー入力 ----
  private onKeyDown(e: KeyboardEvent) {
    if (this.composing || this.busy) return;
    const ext = e.shiftKey;
    if (e.ctrlKey && !e.altKey) {
      switch (e.key.toLowerCase()) {
        case "z": e.preventDefault(); this.dispatch("編集を反映できませんでした", () => this.doUndo(e.shiftKey)); return;
        case "y": e.preventDefault(); this.dispatch("編集を反映できませんでした", () => this.doUndo(true)); return;
        case "a": e.preventDefault(); this.selectAll(); return;
        case "c": e.preventDefault(); this.dispatch("クリップボードへコピーできませんでした", () => this.copy(false)); return;
        case "x": e.preventDefault(); this.dispatch("切り取りできませんでした", () => this.copy(true)); return;
        case "v": e.preventDefault(); this.dispatch("クリップボードから貼り付けできませんでした", () => this.paste()); return;
        case "f": e.preventDefault(); this.openSearch(); return;
        case "arrowleft": e.preventDefault(); this.wordMove(-1, ext); return;
        case "arrowright": e.preventDefault(); this.wordMove(1, ext); return;
        case "home": e.preventDefault(); this.moveTo({ line: 0, col: 0 }, ext); return;
        case "end": e.preventDefault(); this.gotoEnd(ext); return;
      }
      return;
    }
    if (e.altKey && !e.shiftKey) {
      if (e.key === "ArrowUp") { e.preventDefault(); this.addCaretVert(-1); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); this.addCaretVert(1); return; }
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
      case "Backspace": e.preventDefault(); this.dispatch("編集を反映できませんでした", () => this.backspace()); break;
      case "Delete": e.preventDefault(); this.dispatch("編集を反映できませんでした", () => this.deleteForward()); break;
      case "Enter": e.preventDefault(); this.dispatch("編集を反映できませんでした", () => this.insertNewlineWithIndent()); break;
      case "Tab": e.preventDefault(); this.dispatch("編集を反映できませんでした", () => this.indentSelection()); break;
      case "Escape": this.findBar.close(); break;
    }
  }

  private async gotoEnd(extend: boolean) {
    const last = this.lineCount - 1;
    const len = await this.lineCache.lineLength(last);
    this.moveTo({ line: last, col: len }, extend);
  }

  // ---- 入力 / IME ----
  // textarea の内容を文書へ流し込む。clear 済みなら二重挿入しない (IME終了時の重複対策)。
  private async flushInput() {
    const v = this.input.value;
    this.input.value = "";
    if (!v) return;
    try {
      await this.insertText(v);
    } catch (error) {
      // IPC失敗でtextareaを空にしたままにすると、未保存の入力だけが失われる。
      this.input.value = v + this.input.value;
      throw error;
    }
  }

  private dispatch(message: string, operation: () => void | Promise<unknown>) {
    void Promise.resolve()
      .then(operation)
      .catch((error) => this.reportActionError(message, error));
  }

  private async reportActionError(message: string, error: unknown) {
    try {
      await this.onError(message, error);
    } catch (reportError) {
      console.error("操作エラーを表示できませんでした", reportError);
    }
  }

  private onInput(e: InputEvent) {
    if (this.composing || e.isComposing) {
      this.ensureCompositionVisible();
      this.syncImeAnchor();
      return;
    }
    this.dispatch("入力を反映できませんでした", () => this.flushInput());
  }

  private finishComposition() {
    const committed = this.input.value;
    const overlay = committed ? this.showImeCommit(committed) : null;
    this.composing = false;
    this.input.classList.remove("ime");
    this.input.style.removeProperty("width");
    this.input.style.removeProperty("height");
    this.input.style.removeProperty("text-indent");
    this.input.style.removeProperty("--ime-indent");
    if (!committed) this.updateWidth();
    this.syncCaretBlink();
    void this.flushInput()
      .catch((error) => this.reportActionError("入力を反映できませんでした", error))
      .finally(() => overlay?.remove());
  }

  private showImeCommit(text: string): HTMLElement {
    const overlay = el("div", "ve-ime-commit");
    overlay.textContent = text;
    overlay.style.top = this.input.style.top;
    overlay.style.left = this.input.style.left;
    overlay.style.width = this.input.style.width;
    overlay.style.height = this.input.style.height;
    overlay.style.textIndent = this.input.style.textIndent;
    overlay.style.setProperty("--ime-indent", this.input.style.getPropertyValue("--ime-indent"));
    if (this.wrap) overlay.classList.add("wrap");
    this.host.appendChild(overlay);
    return overlay;
  }

  private resizeImeInput() {
    const left = Number.parseFloat(this.input.style.left) || this.scroll.offsetLeft + this.paddingLeft;
    const viewportRight = this.scroll.offsetLeft + this.scroll.clientWidth;
    const available = Math.max(4, viewportRight - left - 4);
    if (this.wrap) {
      const indent = Number.parseFloat(this.input.style.textIndent) || 0;
      // 入力欄の不透明背景は変換中文字列の範囲だけに置き、右側の既存文を隠さない。
      const contentWidth = Math.max(4, this.measureInputText() + 2);
      this.input.style.width = `${Math.min(available, indent + contentWidth)}px`;
      this.input.style.height = "1px";
      const height = Math.max(this.metrics.lineHeight, this.input.scrollHeight);
      this.input.style.height = `${Math.min(Math.max(this.metrics.lineHeight, this.scroll.clientHeight), height)}px`;
      return;
    }
    this.input.style.width = "4px";
    this.input.style.width = `${Math.min(available, Math.max(4, this.input.scrollWidth + 2))}px`;
  }

  private ensureCompositionVisible() {
    if (this.wrap) return;
    const line = this.lineCache.peek(this.sel.caret.line) ?? "";
    const lineEl = this.lineElem(this.sel.caret.line);
    if (!lineEl) return;
    const caretX = this.colToX(lineEl, line, this.sel.caret.col);
    const inputWidth = Math.max(this.measureInputText(), this.input.scrollWidth) + 2;
    const right = caretX + inputWidth;
    const width = Math.max(this.maxWidth, right + 20);
    this.inner.style.width = `${width}px`;
    const viewportDifference = this.hScroll.clientWidth - this.scroll.clientWidth;
    this.hScrollSpacer.style.width = `${Math.max(0, width + viewportDifference)}px`;
    if (right > this.scroll.scrollLeft + this.scroll.clientWidth - 20) {
      this.setHorizontalScroll(right - this.scroll.clientWidth + 20);
    }
  }

  private measureInputText(): number {
    const context = document.createElement("canvas").getContext("2d");
    if (!context) return charLen(this.input.value) * this.fontSize;
    context.font = `${this.fontSize}px ${this.fontFamily}`;
    return Math.max(...this.input.value.split("\n").map((line) => context.measureText(line).width), 0);
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
    if (this.wrap) {
      e.preventDefault();
      if (e.deltaX) this.scroll.scrollLeft += e.deltaX;
      const pages = Math.max(1, this.scroll.clientHeight - this.metrics.lineHeight);
      const deltaPx = e.deltaMode === 1 ? e.deltaY * this.metrics.lineHeight
        : e.deltaMode === 2 ? e.deltaY * pages
        : e.deltaY;
      if (deltaPx) {
        // 未測定行を仮の1行高で何画面も通過しない。1イベントの移動量を
        // 現在生成済みのDOMで必ず測定できる範囲へ制限する。
        const limited = Math.max(-this.scroll.clientHeight, Math.min(this.scroll.clientHeight, deltaPx));
        this.scrollWrapBy(limited);
        this.schedule();
      }
      return;
    }
    if (!this.metrics.scaleMode) return;
    e.preventDefault();
    if (e.deltaX) this.scroll.scrollLeft += e.deltaX;
    let deltaLines: number;
    if (e.deltaMode === 1) deltaLines = e.deltaY; // DOM_DELTA_LINE
    else if (e.deltaMode === 2) deltaLines = e.deltaY * this.pageRows(); // DOM_DELTA_PAGE
    else deltaLines = e.deltaY / this.metrics.lineHeight; // DOM_DELTA_PIXEL
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
    if (e.altKey) {
      const base = this.sel.all();
      const startLine = pos.line;
      const update = (ev: MouseEvent) => {
        const end = this.posFromPoint(ev.clientX, ev.clientY);
        if (!end) return;
        const lo = Math.min(startLine, end.line);
        const hi = Math.max(startLine, end.line);
        const added: Pos[] = [];
        for (let line = lo; line <= hi; line++) {
          const text = this.lineCache.peek(line);
          if (text !== undefined) added.push(this.posFromLineAndX(line, ev.clientX, text));
        }
        const primary = added.find((item) => item.line === end.line) ?? pos;
        const unique = [...base, ...added].filter(
          (item, index, items) => items.findIndex((candidate) => cmp(candidate, item) === 0) === index
        );
        this.sel.caret = primary;
        this.sel.anchor = primary;
        this.sel.secondary = unique.filter((item) => cmp(item, primary) !== 0);
        this.sel.multiCaretX = null;
        this.sel.goalX = null;
        this.render();
        this.syncCaretBlink();
        this.notifyCursor();
      };
      update(e);
      const move = (ev: MouseEvent) => update(ev);
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        this.syncCaretBlink();
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
      return;
    }
    if (!this.readOnly && this.sel.hasSel()) {
      const [s, end] = this.sel.norm();
      if (cmp(pos, s) >= 0 && cmp(pos, end) < 0) {
        const startX = e.clientX;
        const startY = e.clientY;
        let dragging = false;
        const moveSelection = (ev: MouseEvent) => {
          if (Math.abs(ev.clientX - startX) > 3 || Math.abs(ev.clientY - startY) > 3) dragging = true;
        };
        const upSelection = (ev: MouseEvent) => {
          window.removeEventListener("mousemove", moveSelection);
          window.removeEventListener("mouseup", upSelection);
          if (dragging) {
            const drop = this.posFromPoint(ev.clientX, ev.clientY);
            if (drop) this.moveSelection(drop);
          } else {
            this.moveTo(pos, false);
          }
        };
        window.addEventListener("mousemove", moveSelection);
        window.addEventListener("mouseup", upSelection);
        return;
      }
    }
    if (e.detail === 2) {
      const text = this.lineCache.peek(pos.line) ?? "";
      const bounds = wordBounds(text, pos.col);
      if (bounds) {
        this.moveTo({ line: pos.line, col: bounds.start }, false);
        this.moveTo({ line: pos.line, col: bounds.end }, true);
      }
      return;
    }
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
      const text = this.lineCache.peek(line) ?? "";
      if (point?.offsetNode === target.firstChild) {
        return { line, col: u16ToChar(text, point.offset) };
      }
      const legacy = (document as Document & {
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
      }).caretRangeFromPoint?.(cx, cy);
      if (legacy?.startContainer === target.firstChild) {
        return { line, col: u16ToChar(text, legacy.startOffset) };
      }
      return { line, col: this.posFromLineAndX(line, cx, text).col };
    }
    const rect = this.scroll.getBoundingClientRect();
    // scaleMode では画面上の行は常に viewTopLine を基準に行高の間隔で並ぶため、
    // 画面相対オフセットのみで行番号を求める (絶対 px 密度には依存しない)。
    const rel = cy - rect.top;
    const line = this.metrics.scaleMode
      ? this.viewTopLine + Math.floor(rel / this.metrics.lineHeight)
      : Math.floor((rel + this.scroll.scrollTop) / this.metrics.lineHeight);
    const clamped = Math.max(0, Math.min(this.lineCount - 1, line));
    const s = this.lineCache.peek(clamped);
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
    if (pos && !this.sel.contains(pos)) this.moveTo(pos, false);
    this.focus();
    const items: MenuItem[] = [];
    if (!this.readOnly) {
      items.push({ label: "元に戻す", key: "Ctrl+Z", action: () =>
        this.dispatch("編集を反映できませんでした", () => this.doUndo(false)) });
      items.push({ label: "やり直し", key: "Ctrl+Y", action: () =>
        this.dispatch("編集を反映できませんでした", () => this.doUndo(true)) });
      items.push({ label: "切り取り", key: "Ctrl+X", action: () =>
        this.dispatch("切り取りできませんでした", () => this.copy(true)), sep: true });
    }
    items.push({ label: "コピー", key: "Ctrl+C", action: () =>
      this.dispatch("クリップボードへコピーできませんでした", () => this.copy(false)), sep: this.readOnly });
    if (!this.readOnly) {
      items.push({ label: "貼り付け", key: "Ctrl+V", action: () =>
        this.dispatch("クリップボードから貼り付けできませんでした", () => this.paste()) });
      items.push({ label: "削除", action: () => {
        if (this.sel.hasSel()) this.dispatch("編集を反映できませんでした", () => this.deleteSel());
      } });
      if (this.sel.hasSel()) items.push({ label: "選択範囲を登録文字列に追加", action: () => { void this.addSelectionAsRegisteredString(); } });
      const registered = loadRegisteredStrings();
      if (registered.length) {
        items.push({
          label: "登録文字列",
          action: () => {},
          sub: registered.map((text) => ({
            label: registeredStringLabel(text),
            action: () => this.insertText(text),
            trailing: { label: "×", title: "登録文字列を削除", action: () => removeRegisteredString(text) },
          })),
        });
      }
    }
    items.push({ label: "すべて選択", key: "Ctrl+A", action: () => this.selectAll(), sep: true });
    const viewerFormats = Object.entries(VIEWER_FORMAT_LABELS) as [api.ViewerFormat, string][];
    items.push(
      ...viewerFormats.map(([format, label], index) => ({
        label,
        action: () => { void this.openTextViewer(format); },
        sep: index === 0,
      })),
    );
    if (this.hasExternalFile()) items.push({ label: "アプリで開く", action: this.openExternally, sep: true });
    showMenu(e.clientX, e.clientY, items);
  }

  private async addSelectionAsRegisteredString() {
    const [start, end] = this.sel.norm();
    addRegisteredString(await this.lineCache.textInRange(start, end));
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
    const line = this.metrics.scaleMode
      ? this.viewTopLine + Math.floor(rel / this.metrics.lineHeight)
      : Math.floor((rel + this.scroll.scrollTop) / this.metrics.lineHeight);
    return Math.max(0, Math.min(this.lineCount - 1, line));
  }

  private async selectLines(a: number, b: number) {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    this.sel.anchor = { line: lo, col: 0 };
    const caret =
      hi + 1 < this.lineCount ? { line: hi + 1, col: 0 } : { line: hi, col: await this.lineCache.lineLength(hi) };
    this.moveTo(caret, true);
  }

  private onGutterMouseDown(e: MouseEvent) {
    if (e.button !== 0 || this.busy) return;
    e.preventDefault();
    this.focus();
    const clicked = this.lineFromGutterY(e.clientY);
    const startLine = e.shiftKey ? this.sel.anchor.line : clicked;
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
    const from = forward ? this.sel.norm()[1] : this.sel.norm()[0];
    if (!forward) {
      const r = await this.doc.find(p, from, false, matchCase);
      if (myGen !== this.findGen || !r) { this.lastFindMatch = null; return false; }
      this.sel.anchor = r.start;
      this.moveTo(r.end, true);
      this.lastFindMatch = { start: r.start, end: r.end, pat: p, matchCase };
      return true;
    }
    let cursor: api.FindCursor | undefined;
    for (;;) {
      const outcome = await this.doc.findStep(p, from, matchCase, cursor, VirtualEditor.FIND_BUDGET);
      if (myGen !== this.findGen) return false; // 検索バーが閉じられた/新しい検索が始まった
      if (outcome.kind === "Found") {
        this.findBar.setProgress("");
        this.sel.anchor = outcome.start;
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
      cmp(this.sel.anchor, m.start) === 0 && cmp(this.sel.caret, m.end) === 0
    ) {
      const r = unescapePattern(rep);
      const res = await this.doc.edit(m.start, m.end, this.sel.caret, r, false);
      this.lastFindMatch = null;
      this.applyResult(res, m.start.line, [{ start: m.start, end: m.end, text: r }]);
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
        const res = await this.doc.replaceAllChunk(p, r, matchCase, VirtualEditor.REPLACE_BUDGET);
        if (!warned && !res.done && res.count >= VirtualEditor.REPLACE_WARN_THRESHOLD) {
          warned = true;
          const cont = window.confirm(`既に${res.count}件置換しています。続行しますか?`);
          if (!cont) {
            const fin = await this.doc.replaceAllCancel();
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

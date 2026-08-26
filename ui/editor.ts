import * as api from "./api";
import type { Pos } from "./api";
import { readText as readClipboardText, writeText as writeClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import { RectangularClipboard } from "./editor-clipboard";
import { findForward } from "./editor-find-loop";
import { FindBar } from "./findbar";
import { clampFontSize } from "./font-controls";
import { DEFAULT_EDITOR_CONFIG, EditorConfig } from "./editor-config";
import { showMenu, type MenuItem } from "./menu";
import {
  createRegisteredCommandMenu,
  type RegisteredCommandMenuPorts,
} from "./registered-command-menu";
import { MENU_ICON } from "./menu-icons";
import { MENU_LABELS } from "./menu-labels";
import { viewerFormatIcon, VIEWER_FORMAT_LABELS } from "./format";
import { viewerFormatForPath } from "./viewer-formats";
import { LineCache } from "./line-cache";
import { EditorMutationController } from "./editor-mutation";
import { LiveViewers } from "./live-viewers";
import { lineNumberGroups } from "./line-number";
import { blockRangeForLine, Selection } from "./selection";
import { MAX_SAFE_HEIGHT, ViewportMetrics } from "./viewport-metrics";
import {
  addRegisteredString,
  loadRegisteredStrings,
  registeredStringLabel,
  removeRegisteredString,
} from "./registered-strings";
import { flushSettings } from "./settings";
import {
  charClass,
  charLen,
  charToU16,
  clampImeAnchor,
  comparePos as cmp,
  findProgressPercent,
  u16ToChar,
  unescapePattern,
  WrapHeightMap,
  wordBounds,
} from "./editor-math";
import type { EditorViewState } from "./editor-view-state";
import { selectedLineRange } from "./editor-edit-plan";
import type { SearchHighlightQuery } from "./workspace-search-options";

const OVERSCAN = 8;

function normalizeClipboardText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export type { EditorViewState } from "./editor-view-state";

function isPreviewLine(line: number, range: { start: Pos; end: Pos } | null): boolean {
  const selected = range ? selectedLineRange(range.start, range.end) : null;
  return !!selected && line >= selected.first && line <= selected.last;
}

export interface EditorPorts {
  onDocChange: (lineCount: number, edits?: api.EditManyItem[]) => void;
  onCursor: (line: number, col: number) => void;
  onFontChange: (fontFamily: string, fontSize: number, changed: "family" | "size" | "both") => void;
  openExternally: (path: string) => void | Promise<unknown>;
  openInNewWindow?: (path: string) => void | Promise<unknown>;
  registeredCommandPorts: RegisteredCommandMenuPorts;
  revealInExplorer?: (path: string, isDir: boolean) => void | Promise<unknown>;
  onError: (message: string, error: unknown) => Promise<void>;
  openViewer: (format: api.ViewerFormat, text: string, selection: api.ViewerSelection | null) => Promise<string | null>;
  updateViewer: (label: string, text: string, selection: api.ViewerSelection | null) => Promise<boolean>;
  closeViewer: (label: string) => Promise<void>;
  saveImage?: (bytes: number[], mimeType: string) => Promise<string>;
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
  private dragCaretEl: HTMLElement;
  private secondaryCaretEls: HTMLElement[] = [];
  private input: HTMLTextAreaElement;
  private findBar: FindBar;

  private lineCount = 1;
  private documentGeneration = 0;
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
  private pendingCenterLine: number | null = null;
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
  private dragCaret: Pos | null = null;
  private dragCleanup: (() => void) | null = null;
  private ctrlDown = false;
  private composing = false;
  private mutation: EditorMutationController;
  private findGen = 0; // 検索ループの世代。closeやEnter連打で古いループを打ち切るため
  private lastFindMatch: { start: Pos; end: Pos; pat: string; matchCase: boolean } | null = null; // 連続置換が対象にしてよい直前の一致
  private activeFind: SearchHighlightQuery | null = null;
  private findHighlights: api.FindResult[] = [];
  private findHighlightRequestKey = "";
  private findHighlightGeneration = 0;
  private busy = false; // 全置換チャンク実行中は入力を無効化 (レジューム状態の破損防止)

  private onDocChange: (lineCount: number, edits?: api.EditManyItem[]) => void;
  private onCursor: (line: number, col: number) => void;
  private onFontChange: (fontFamily: string, fontSize: number, changed: "family" | "size" | "both") => void;
  private externalFilePath: string | null = null;
  private markdown = false;
  private openExternally: (path: string) => void | Promise<unknown>;
  private openInNewWindow?: (path: string) => void | Promise<unknown>;
  private registeredCommandPorts: RegisteredCommandMenuPorts;
  private revealInExplorer?: (path: string, isDir: boolean) => void | Promise<unknown>;
  private onError: (message: string, error: unknown) => Promise<void>;
  private onPasteImage?: (bytes: number[], mimeType: string) => Promise<string>;
  private rectangularClipboard = new RectangularClipboard();
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
      closeViewer: ports.closeViewer,
      wholeRange: async () => {
        const last = this.lineCount - 1;
        return { start: { line: 0, col: 0 }, end: { line: last, col: await this.lineCache.lineLength(last) } };
      },
      textInRange: (start, end) => this.lineCache.textInRange(start, end),
      onError: (error) => this.reportActionError("プレビューを更新できませんでした", error),
    });
    this.mutation = new EditorMutationController({
      doc: this.doc,
      selection: this.sel,
      lineCache: this.lineCache,
      lineCount: () => this.lineCount,
      isReadOnly: () => this.readOnly,
      isMarkdown: () => this.markdown,
      applyResult: (result, fromLine, edits) => this.applyResult(result, fromLine, edits),
      renderAfterEdit: () => this.renderAfterEdit(),
    });
    this.onDocChange = ports.onDocChange;
    this.onCursor = ports.onCursor;
    this.onFontChange = ports.onFontChange;
    this.openExternally = ports.openExternally;
    this.openInNewWindow = ports.openInNewWindow;
    this.registeredCommandPorts = ports.registeredCommandPorts;
    this.revealInExplorer = ports.revealInExplorer;
    this.onError = ports.onError;
    this.onPasteImage = ports.saveImage;
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
    this.dragCaretEl = el("div", "ve-caret ve-drag-caret");
    this.input = document.createElement("textarea");
    this.input.className = "ve-input";
    this.input.spellcheck = false;
    this.input.autocapitalize = "off";
    (this.input as unknown as { autocorrect: string }).autocorrect = "off";

    // caretEl は一度だけ挿入し、以後 render() では linesLayer の中身だけ差し替える。
    this.inner.appendChild(this.linesLayer);
    this.inner.appendChild(this.caretEl);
    this.inner.appendChild(this.dragCaretEl);
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
      () => {
        this.findGen++;
        this.lastFindMatch = null;
        this.setFindHighlightQuery("", false);
        this.focus();
      },
      (message, error) => this.reportActionError(message, error),
      (pat, matchCase) => this.setFindHighlightQuery(unescapePattern(pat), matchCase),
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
    this.gutter.addEventListener("contextmenu", (e) => this.onGutterContextMenu(e));
    this.input.addEventListener("keydown", (e) => this.onKeyDown(e));
    this.input.addEventListener("paste", (e) => this.onPaste(e));
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
    window.addEventListener("keydown", (e) => {
      if (e.key === "Control") this.ctrlDown = true;
    });
    window.addEventListener("keyup", (e) => {
      if (e.key === "Control") this.ctrlDown = false;
    });
    window.addEventListener("blur", () => {
      this.ctrlDown = false;
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
      if (this.pendingCenterLine !== null) this.centerLine(this.pendingCenterLine);
      this.syncImeAnchorAfterLayout();
      this.schedule();
    }).observe(this.scroll);
  }

  // ---- 文書ロード ----
  // keepViewers: 同じファイルを読み直しただけの場合。開いているビューを閉じずに新内容へ差し替える
  open(
    lineCount: number,
    readOnly: boolean,
    keepViewers = false,
    externalFilePath: string | null = null,
    markdown = viewerFormatForPath(externalFilePath ?? "") === "markdown",
  ) {
    this.dragCleanup?.();
    this.clearDragCaret();
    this.externalFilePath = externalFilePath;
    this.markdown = markdown;
    this.rectangularClipboard.clear();
    this.documentGeneration++;
    this.findGen++;
    this.lastFindMatch = null;
    this.invalidateFindHighlights();
    if (keepViewers) this.liveViewers.scheduleRefresh();
    else this.liveViewers.clear();
    this.lineCount = Math.max(1, lineCount);
    this.wrapIntraLinePx = 0;
    this.resetWrapHeights();
    this.readOnly = readOnly;
    this.lineCache.clear();
    
    this.maxWidth = 0;
    this.pendingCenterLine = null;
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

  setExternalFilePath(
    path: string | null,
    markdown = viewerFormatForPath(path ?? "") === "markdown",
  ) {
    this.externalFilePath = path;
    this.markdown = markdown;
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
    const generation = this.documentGeneration;
    const anchorLine = Math.max(0, Math.min(this.lineCount - 1, state.anchor.line));
    const caretLine = Math.max(0, Math.min(this.lineCount - 1, state.caret.line));
    const [anchorText, caretText] = await Promise.all([
      this.lineCache.line(anchorLine),
      this.lineCache.line(caretLine),
    ]);
    if (generation !== this.documentGeneration) return;
    this.sel.anchor = {
      line: anchorLine,
      col: Math.max(0, Math.min(charLen(anchorText), state.anchor.col)),
    };
    this.sel.caret = {
      line: caretLine,
      col: Math.max(0, Math.min(charLen(caretText), state.caret.col)),
    };
    this.sel.secondary = [];
    this.sel.block = null;
    this.sel.goalX = null;
    const topLine = Math.max(0, Math.min(this.maxTopLine(), state.topLine));
    if (this.wrap) this.setWrapAnchor(topLine, Math.max(0, state.wrapIntraLinePx));
    else this.setTopLine(topLine);
    await this.lineCache.line(Math.floor(topLine));
    if (generation !== this.documentGeneration) return;
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
    this.centerLine(pos.line);
    this.render();
    this.focus();
  }

  async goToPreview(selection: api.ViewerSelection) {
    const generation = this.documentGeneration;
    const target = this.liveViewers.positionInDocument(selection.end);
    const line = Math.max(0, Math.min(this.lineCount - 1, target.line));
    const text = await this.lineCache.line(line);
    if (generation !== this.documentGeneration) return;
    const pos = { line, col: Math.max(0, Math.min(charLen(text), target.col)) };
    this.sel.reset(pos);
    this.centerLine(line);
    this.render();
    if (!this.wrap) {
      const lineEl = this.lineElem(line);
      if (lineEl) {
        const x = this.colToX(lineEl, text, pos.col);
        this.setHorizontalScroll(x - this.scroll.clientWidth / 2);
      }
    }
    this.render();
    this.notifyCursor();
    this.focus();
  }

  async selectRange(line: number, startCol: number, endCol: number) {
    const targetLine = Math.max(0, Math.min(this.lineCount - 1, line));
    const generation = this.documentGeneration;
    await this.lineCache.line(targetLine);
    if (generation !== this.documentGeneration) return;
    this.selectAndCenter(
      { line: targetLine, col: Math.max(0, startCol) },
      { line: targetLine, col: Math.max(startCol, endCol) },
    );
    this.focus();
  }

  // フォルダ検索の「この一致だけ置換」。編集後は onDocChange が検索を引き直すため、
  // 古い結果を次の置換へ持ち越さない。
  async replaceRange(line: number, startCol: number, endCol: number, text: string): Promise<boolean> {
    if (this.readOnly || this.busy) return false;
    const targetLine = Math.max(0, Math.min(this.lineCount - 1, line));
    const generation = this.documentGeneration;
    const lineText = await this.lineCache.line(targetLine);
    if (generation !== this.documentGeneration) return false;
    const start = Math.max(0, Math.min(charLen(lineText), startCol));
    const end = Math.max(start, Math.min(charLen(lineText), endCol));
    if (start === end) return false;
    const startPos = { line: targetLine, col: start };
    const endPos = { line: targetLine, col: end };
    const result = await this.doc.edit(startPos, endPos, startPos, text, false);
    if (generation !== this.documentGeneration) return false;
    this.applyResult(result, targetLine, [{ start: startPos, end: endPos, text }]);
    await this.renderAfterEdit();
    this.focus();
    return true;
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

  setFont(fontFamily: string, fontSize: number, changed: "family" | "size" | "both" = "both") {
    const topLine = this.wrap || this.metrics.scaleMode ? this.topLineF : this.pxToLine(this.scroll.scrollTop);
    const wasAtBottom = topLine >= this.maxTopLine();
    this.fontFamily = fontFamily;
    this.fontSize = clampFontSize(fontSize);
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
    this.onFontChange(this.fontFamily, this.fontSize, changed);
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

  private centerLine(line: number) {
    const viewportHeight = this.scroll.clientHeight;
    if (viewportHeight <= 0) {
      this.pendingCenterLine = line;
      return;
    }
    this.pendingCenterLine = null;
    if (this.wrap) {
      const targetHeight = this.wrappedLineHeight(line);
      const maxOffset = Math.max(0, this.wrapHeights.totalHeight() - viewportHeight);
      const targetOffset = this.wrapHeights.offsetOf(line) - (viewportHeight - targetHeight) / 2;
      const offset = Math.max(0, Math.min(maxOffset, targetOffset));
      const anchor = this.wrapHeights.anchorAt(offset);
      this.setWrapAnchor(anchor.line, anchor.intraLinePx);
      return;
    }
    const visibleRows = Math.max(1, viewportHeight / this.metrics.lineHeight);
    this.setTopLine(line - (visibleRows - 1) / 2);
  }

  private centerSelection(line: number) {
    if (!this.wrap) {
      this.centerLine(line);
      return;
    }
    const viewportHeight = this.scroll.clientHeight;
    if (viewportHeight <= 0) {
      this.pendingCenterLine = line;
      return;
    }
    this.pendingCenterLine = null;
    const boxes = [...this.linesLayer.querySelectorAll<HTMLElement>(".ve-sel")];
    let top = Infinity;
    let bottom = -Infinity;
    for (const box of boxes) {
      const boxTop = Number.parseFloat(box.style.top);
      const height = Number.parseFloat(box.style.height);
      if (!Number.isFinite(boxTop) || !Number.isFinite(height)) continue;
      top = Math.min(top, boxTop);
      bottom = Math.max(bottom, boxTop + height);
    }
    if (!Number.isFinite(top) || !Number.isFinite(bottom)) {
      this.centerLine(line);
      return;
    }
    const selectionCenter = (top + bottom) / 2;
    this.scrollWrapBy(selectionCenter - (this.viewTop + viewportHeight / 2));
  }

  private selectAndCenter(start: Pos, end: Pos) {
    this.sel.anchor = start;
    this.moveTo(end, true);
    // moveTo() の描画後に横方向の可視性を確定し、行高を反映した中央配置を
    // 最後に行う。フォルダ検索と本文検索の結果を同じ規則へ通す。
    this.ensureVisible();
    if (this.wrap) this.render();
    this.centerSelection(start.line);
    this.render();
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
    this.requestFindHighlights(first, last);

    // 未取得チャンクを要求
    let needFetch = false;
    for (let c = LineCache.chunkOf(first); c <= LineCache.chunkOf(last - 1); c++) {
      if (!this.lineCache.has(c)) {
        needFetch = true;
        void this.lineCache.fetch(c)
          .then(() => this.schedule())
          .catch((error) => this.reportActionError("表示用の行を読み込めませんでした", error));
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
    const selectedLines = this.sel.blockBounds() ?? selectedLineRange(this.sel.anchor, this.sel.caret);
    this.renderVisibleLines(first, last);
    this.layoutVisibleLines(first, last, topLine, top);

    this.renderGutter(first, last, top, selectedLines, caretLines, this.liveViewers.previewRange());

    // 新しい可視行DOMを基準にRangeを測定する。旧DOMを測るとスクロール後に欠落する。
    const decorationFrag = document.createDocumentFragment();
    this.appendSelection(decorationFrag, first, last);
    this.appendFindHighlights(decorationFrag, first, last);
    this.linesLayer.prepend(decorationFrag);

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
      this.linesLayer.querySelectorAll(":scope > .ve-sel, :scope > .ve-find-hit")
        .forEach((decoration) => decoration.remove());
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
    previewRange: { start: Pos; end: Pos } | null,
  ) {
    let rows = [...this.gutter.querySelectorAll<HTMLElement>(":scope > .ve-gnum")];
    const canReuse = rows.length === last - first
      && rows.every((row, index) => row.dataset.line === String(first + index));
    if (!canReuse) {
      const frag = document.createDocumentFragment();
      for (let i = first; i < last; i++) {
        const row = el("div", "ve-gnum");
        row.dataset.line = String(i);
        const previewMark = el("span", "ve-preview-mark");
        previewMark.textContent = "P";
        previewMark.setAttribute("aria-hidden", "true");
        row.appendChild(previewMark);
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
      const previewMark = row.querySelector<HTMLElement>(".ve-preview-mark");
      if (previewMark) previewMark.hidden = !isPreviewLine(line, previewRange);
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
    const previewExtra = this.liveViewers.previewRange() ? 14 : 0;
    const w = Math.max(this.gutterWidth, Math.ceil(numberWidth + 24 + previewExtra));
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
    this.caretEl.classList.toggle("on", document.activeElement === this.input && this.dragCaret === null);
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

  private placeDragCaret() {
    if (!this.dragCaret) {
      this.dragCaretEl.classList.remove("on");
      return;
    }
    const line = this.lineElem(this.dragCaret.line);
    if (!line) {
      this.dragCaretEl.classList.remove("on");
      return;
    }
    const text = this.lineCache.peek(this.dragCaret.line) ?? "";
    const point = this.wrap ? this.wrapPoint(line, text, this.dragCaret.col) : null;
    this.dragCaretEl.style.top = `${point?.y ?? this.rowTop(this.dragCaret.line)}px`;
    this.dragCaretEl.style.left = `${point?.x ?? this.colToX(line, text, this.dragCaret.col)}px`;
    this.dragCaretEl.classList.add("on");
  }

  private showDragCaret(pos: Pos) {
    this.dragCaret = { ...pos };
    this.placeCaret();
    this.placeDragCaret();
  }

  private clearDragCaret() {
    this.dragCaret = null;
    this.dragCaretEl.classList.remove("on");
    this.syncCaretVisibility();
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
    this.placeDragCaret();
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
    const block = this.sel.blockBounds();
    if (block) {
      for (let i = Math.max(first, block.first); i < Math.min(last, block.last + 1); i++) {
        const str = this.lineCache.peek(i) ?? "";
        const lineEl = this.lineElem(i);
        const { start: c0, end: c1 } = blockRangeForLine(str, block);
        if (this.wrap) {
          const node = lineEl?.firstChild;
          if (!node) continue;
          const inner = this.inner.getBoundingClientRect();
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
        } else {
          const x0 = lineEl ? this.colToX(lineEl, str, c0) : this.paddingLeft;
          const x1 = lineEl ? this.colToX(lineEl, str, c1) : this.paddingLeft;
          const box = el("div", "ve-sel");
          box.style.top = `${this.rowTop(i)}px`;
          box.style.left = `${x0}px`;
          box.style.width = `${Math.max(2, x1 - x0)}px`;
          frag.insertBefore(box, frag.firstChild);
        }
      }
      return;
    }
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

  private appendFindHighlights(frag: DocumentFragment, first: number, last: number) {
    for (const match of this.findHighlights) {
      if (match.start.line < first || match.start.line >= last) continue;
      const str = this.lineCache.peek(match.start.line) ?? "";
      const lineEl = this.lineElem(match.start.line);
      if (!lineEl) continue;
      if (this.wrap) {
        const node = lineEl.firstChild;
        if (!node) continue;
        const inner = this.inner.getBoundingClientRect();
        const range = document.createRange();
        range.setStart(node, charToU16(str, match.start.col));
        range.setEnd(node, charToU16(str, match.end.col));
        for (const rect of range.getClientRects()) {
          const box = el("div", "ve-find-hit");
          box.style.top = `${rect.top - inner.top}px`;
          box.style.left = `${rect.left - inner.left}px`;
          box.style.width = `${Math.max(2, rect.width)}px`;
          box.style.height = `${rect.height}px`;
          frag.insertBefore(box, frag.firstChild);
        }
        continue;
      }
      const x0 = this.colToX(lineEl, str, match.start.col);
      const x1 = this.colToX(lineEl, str, match.end.col);
      const box = el("div", "ve-find-hit");
      box.style.top = `${this.rowTop(match.start.line)}px`;
      box.style.left = `${x0}px`;
      box.style.width = `${Math.max(2, x1 - x0)}px`;
      frag.insertBefore(box, frag.firstChild);
    }
  }

  setFindHighlightQuery(pat: string, matchCase: boolean, useRegex = false, wholeWord = false) {
    const next = pat ? { pat, matchCase, useRegex, wholeWord } : null;
    if (this.activeFind?.pat === next?.pat
      && this.activeFind?.matchCase === next?.matchCase
      && this.activeFind?.useRegex === next?.useRegex
      && this.activeFind?.wholeWord === next?.wholeWord) return;
    this.activeFind = next;
    this.invalidateFindHighlights();
    this.schedule();
  }

  captureFindHighlightQuery(): SearchHighlightQuery | null {
    return this.activeFind ? { ...this.activeFind } : null;
  }

  restoreFindHighlightQuery(query: SearchHighlightQuery | null) {
    this.setFindHighlightQuery(
      query?.pat ?? "",
      query?.matchCase ?? false,
      query?.useRegex ?? false,
      query?.wholeWord ?? false,
    );
  }

  private invalidateFindHighlights() {
    this.findHighlights = [];
    this.findHighlightRequestKey = "";
    this.findHighlightGeneration++;
  }

  private requestFindHighlights(first: number, last: number) {
    const query = this.activeFind;
    if (!query) return;
    const key = `${this.documentGeneration}:${first}:${last}:${query.matchCase}:${query.useRegex}:${query.wholeWord}:${query.pat}`;
    if (key === this.findHighlightRequestKey) return;
    this.findHighlightRequestKey = key;
    const generation = ++this.findHighlightGeneration;
    void this.doc.findAllInRange(
      query.pat,
      first,
      last,
      query.matchCase,
      query.useRegex,
      query.wholeWord,
    )
      .then((matches) => {
        if (generation !== this.findHighlightGeneration || key !== this.findHighlightRequestKey) return;
        this.findHighlights = matches;
        this.schedule();
      })
      .catch((error) => {
        if (generation !== this.findHighlightGeneration || key !== this.findHighlightRequestKey) return;
        this.findHighlights = [];
        this.findHighlightRequestKey = "";
        void this.reportActionError("検索結果を強調表示できませんでした", error);
      });
  }

  // ---- カーソル移動 ----
  private notifyCursor() {
    const [start, end] = this.sel.norm();
    this.liveViewers.setSelection({ start, end }, this.sel.caret);
    this.onCursor(this.sel.caret.line + 1, this.sel.caret.col + 1);
  }

  private moveTo(pos: Pos, extend: boolean, keepGoal = false, keepSecondary = false) {
    if (!keepSecondary) {
      this.sel.secondary = [];
      this.sel.block = null;
      this.sel.multiCaretX = null;
    }
    this.sel.caret = pos;
    if (!extend) this.sel.anchor = pos;
    if (!keepGoal) this.sel.goalX = null;
    this.ensureVisible();
    this.render();
    this.notifyCursor();
  }

  private syncCaretVisibility() {
    const carets = [this.caretEl, ...this.secondaryCaretEls.slice(0, this.sel.secondary.length)];
    carets.forEach((caret) => caret.classList.remove("on"));
    if (document.activeElement === this.input && this.dragCaret === null) {
      carets.forEach((caret) => caret.classList.add("on"));
    }
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
    this.syncCaretVisibility();
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
    // scrollTop はブラウザや巨大文書の比例配分で丸められるため、行番号で
    // 可視判定する。改行直後のキャレット行を座標の誤差で取りこぼさない。
    const visibleRows = Math.max(1, Math.floor(this.scroll.clientHeight / this.metrics.lineHeight));
    const topLine = this.metrics.scaleMode ? this.topLineF : this.pxToLine(this.scroll.scrollTop);
    if (this.sel.caret.line < topLine) {
      this.setTopLine(this.sel.caret.line);
    } else if (this.sel.caret.line >= topLine + visibleRows) {
      this.setTopLine(this.sel.caret.line - visibleRows + 1);
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
  private async blockText(): Promise<string> {
    const block = this.sel.blockBounds();
    if (!block) return "";
    const parts: string[] = [];
    for (let line = block.first; line <= block.last; line += 1) {
      const value = await this.lineCache.line(line);
      const range = blockRangeForLine(value, block);
      parts.push([...value].slice(range.start, range.end).join(""));
    }
    return parts.join("\n");
  }

  private selectionText(): string {
    if (!this.sel.hasSel() || this.sel.blockBounds()) return "";
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
  private applyResult(r: api.EditResult, fromLine: number, edits: api.EditManyItem[] = []) {
    const oldScrollTop = this.scroll.scrollTop;
    const oldTopLine = this.wrap || this.metrics.scaleMode ? this.topLineF : this.pxToLine(oldScrollTop);
    const oldIntraLinePx = this.wrapIntraLinePx;
    const oldMaxScroll = Math.max(0, this.metrics.scrollHeight - this.scroll.clientHeight);
    const wasAtBottom = this.wrap || this.metrics.scaleMode
      ? oldTopLine >= this.maxTopLine()
      : oldScrollTop >= oldMaxScroll;
    const oldLineCount = this.lineCount;
    this.lineCount = Math.max(1, r.line_count);
    this.resetWrapHeights();
    this.updateMetrics();
    // 行数変更前後の座標系を混在させない。末尾表示中は新しい末尾へ追従し、
    // それ以外は同じ先頭行を維持する。
    const nextTopLine = wasAtBottom ? this.maxTopLine() : oldTopLine;
    if (this.wrap) this.setWrapAnchor(nextTopLine, nextTopLine === oldTopLine ? oldIntraLinePx : 0);
    else if (this.metrics.scaleMode || wasAtBottom) this.setTopLine(nextTopLine);
    else {
      // 通常モードでは行途中のスクロール位置を編集前のまま保持する。
      this.scroll.scrollTop = Math.min(oldScrollTop, Math.max(0, this.metrics.scrollHeight - this.scroll.clientHeight));
      this.topLineF = this.pxToLine(this.scroll.scrollTop);
    }
    const cached = oldLineCount === this.lineCount
      && edits.length === 1
      && this.lineCache.applySingleLineEdit(edits[0].start, edits[0].end, edits[0].text);
    if (!cached) this.lineCache.invalidateFrom(fromLine);
    this.invalidateFindHighlights();
    this.liveViewers.applyEdits(edits);
    this.sel.caret = r.caret;
    this.sel.anchor = r.caret;
    this.sel.secondary = [];
    this.sel.block = null;
    this.sel.goalX = null;
    this.onDocChange(this.lineCount, edits);
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

  private insertText(text: string): Promise<void> { return this.mutation.insertText(text); }
  private insertNewlineWithIndent(): Promise<void> { return this.mutation.insertNewlineWithIndent(); }
  private indentSelection(): Promise<void> { return this.mutation.indentSelection(); }
  private unindentSelection(): Promise<void> { return this.mutation.unindentSelection(); }
  private deleteSel(): Promise<void> { return this.mutation.deleteSel(); }
  private backspace(): Promise<void> { return this.mutation.backspace(); }
  private deleteForward(): Promise<void> { return this.mutation.deleteForward(); }
  private doUndo(redo: boolean): Promise<void> { return this.mutation.undo(redo); }

  private async copy(cut: boolean) {
    if (!this.sel.hasSel()) return;
    const block = this.sel.blockBounds();
    const text = block
      ? await this.blockText()
      : await this.lineCache.textInRange(...this.sel.norm());
    this.rectangularClipboard.clear();
    await writeClipboardText(text);
    if (block) this.rectangularClipboard.set(text);
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


  async openTextViewer(format: api.ViewerFormat, keepPreviewRange = false) {
    const [selectionStart, selectionEnd] = this.sel.norm();
    const selection = { start: selectionStart, end: selectionEnd };
    const previewRange = keepPreviewRange ? this.liveViewers.previewRange() : null;
    const range = format === "image" ? null : previewRange ?? (this.sel.hasSel()
      ? { start: { ...selectionStart }, end: { ...selectionEnd } }
      : null);
    this.liveViewers.clear();
    const opened = await this.liveViewers.open(format, range, selection, this.sel.caret);
    this.render();
    return opened;
  }

  private moveSelection(start: Pos, end: Pos, target: Pos, copy: boolean) {
    return this.mutation.moveSelection(start, end, target, copy);
  }

  private async paste() {
    if (this.readOnly) return;
    const image = await this.readClipboardImage();
    if (image && this.onPasteImage) {
      await this.insertImage(image.bytes, image.mimeType);
      return;
    }
    const text = normalizeClipboardText(await readClipboardText());
    const rows = this.rectangularClipboard.rowsFor(text);
    if (rows) {
      await this.mutation.pasteBlock(rows);
      return;
    }
    if (text) await this.insertText(text);
  }

  private onPaste(event: ClipboardEvent) {
    if (this.readOnly) return;
    const item = [...(event.clipboardData?.items ?? [])]
      .find((candidate) => candidate.type.toLowerCase().startsWith("image/"));
    const file = item?.getAsFile();
    if (file) {
      event.preventDefault();
      this.dispatch("クリップボードから画像を貼り付けできませんでした", () => this.insertImageBlob(file));
      return;
    }
    const text = normalizeClipboardText(event.clipboardData?.getData("text/plain") ?? "");
    const rows = this.rectangularClipboard.rowsFor(text);
    if (!rows) return;
    event.preventDefault();
    this.dispatch(
      "矩形を貼り付けできませんでした",
      () => this.mutation.pasteBlock(rows),
    );
  }

  private async readClipboardImage(): Promise<{ bytes: number[]; mimeType: string } | null> {
    if (!navigator.clipboard?.read) return null;
    try {
      for (const item of await navigator.clipboard.read()) {
        const mimeType = item.types.find((type) => type.toLowerCase().startsWith("image/"));
        if (!mimeType) continue;
        const blob = await item.getType(mimeType);
        return { bytes: Array.from(new Uint8Array(await blob.arrayBuffer())), mimeType };
      }
    } catch {
      // 画像の読込権限が無い環境では、通常の文字貼り付けへフォールバックする。
    }
    return null;
  }

  private async insertImageBlob(blob: Blob) {
    await this.insertImage(
      Array.from(new Uint8Array(await blob.arrayBuffer())),
      blob.type,
    );
  }

  private async insertImage(bytes: number[], mimeType: string) {
    if (!this.onPasteImage) return;
    const src = await this.onPasteImage(bytes, mimeType);
    await this.insertText(`<img src="${src}" alt="貼り付け画像" width="900">\n`);
    if (!this.liveViewers.has("markdown")) await this.openTextViewer("markdown");
  }

  // ---- キー入力 ----
  private onKeyDown(e: KeyboardEvent) {
    if (this.composing || this.busy) return;
    const ext = e.shiftKey;
    if (e.ctrlKey && !e.altKey) {
      switch (e.key.toLowerCase()) {
        case "z": e.preventDefault(); this.dispatch("編集を反映できませんでした", () => this.doUndo(e.shiftKey)); return;
        case "y": e.preventDefault(); this.dispatch("編集を反映できませんでした", () => this.doUndo(true)); return;
        case "a": e.preventDefault(); this.dispatch("全選択できませんでした", () => this.selectAll()); return;
        case "c": e.preventDefault(); this.dispatch("クリップボードへコピーできませんでした", () => this.copy(false)); return;
        case "x": e.preventDefault(); this.dispatch("切り取りできませんでした", () => this.copy(true)); return;
        case "v":
          // 画像対応時は native paste イベントから画像を受け取り、文字列は textarea の input で処理する。
          if (this.onPasteImage) return;
          e.preventDefault();
          this.dispatch("クリップボードから貼り付けできませんでした", () => this.paste());
          return;
        case "f": e.preventDefault(); this.openSearch(); return;
        case "arrowleft": e.preventDefault(); this.dispatch("カーソルを移動できませんでした", () => this.wordMove(-1, ext)); return;
        case "arrowright": e.preventDefault(); this.dispatch("カーソルを移動できませんでした", () => this.wordMove(1, ext)); return;
        case "home": e.preventDefault(); this.moveTo({ line: 0, col: 0 }, ext); return;
        case "end": e.preventDefault(); this.dispatch("カーソルを移動できませんでした", () => this.gotoEnd(ext)); return;
      }
      return;
    }
    if (e.altKey && !e.shiftKey) {
      if (e.key === "ArrowUp") { e.preventDefault(); this.dispatch("カーソルを移動できませんでした", () => this.addCaretVert(-1)); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); this.dispatch("カーソルを移動できませんでした", () => this.addCaretVert(1)); return; }
    }
    switch (e.key) {
      case "ArrowLeft": e.preventDefault(); this.dispatch("カーソルを移動できませんでした", () => this.horiz(-1, ext)); break;
      case "ArrowRight": e.preventDefault(); this.dispatch("カーソルを移動できませんでした", () => this.horiz(1, ext)); break;
      case "ArrowUp": e.preventDefault(); this.dispatch("カーソルを移動できませんでした", () => this.vert(-1, ext)); break;
      case "ArrowDown": e.preventDefault(); this.dispatch("カーソルを移動できませんでした", () => this.vert(1, ext)); break;
      case "PageUp": e.preventDefault(); this.dispatch("カーソルを移動できませんでした", () => this.vert(-this.pageRows(), ext)); break;
      case "PageDown": e.preventDefault(); this.dispatch("カーソルを移動できませんでした", () => this.vert(this.pageRows(), ext)); break;
      case "Home": e.preventDefault(); this.dispatch("カーソルを移動できませんでした", () => this.home(ext)); break;
      case "End": e.preventDefault(); this.dispatch("カーソルを移動できませんでした", () => this.end(ext)); break;
      case "Backspace": e.preventDefault(); this.dispatch("編集を反映できませんでした", () => this.backspace()); break;
      case "Delete": e.preventDefault(); this.dispatch("編集を反映できませんでした", () => this.deleteForward()); break;
      case "Enter": e.preventDefault(); this.dispatch("編集を反映できませんでした", () => this.insertNewlineWithIndent()); break;
      case "Tab": e.preventDefault(); this.dispatch("編集を反映できませんでした", () =>
        e.shiftKey ? this.unindentSelection() : this.indentSelection()); break;
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
    this.syncCaretVisibility();
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
      if (e.deltaY) this.setFont(this.fontFamily, this.fontSize + (e.deltaY < 0 ? 1 : -1), "size");
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
      const base = this.sel.all().map((item) => ({ ...item }));
      const origin = { ...pos };
      const baseLines = [...new Set(base.map((item) => item.line))];
      const existingColumn = baseLines.length > 1
        && base.every((item) => item.col === base[0].col);
      const baseColumn = existingColumn ? base[0].col : origin.col;
      const update = (ev: MouseEvent) => {
        const end = this.posFromPoint(ev.clientX, ev.clientY);
        if (!end) return;
        const blockLines = existingColumn
          ? [...baseLines, origin.line, end.line]
          : [origin.line, end.line];
        const first = Math.min(...blockLines);
        const last = Math.max(...blockLines);
        if (baseColumn !== end.col) {
          this.sel.setBlock(
            { line: first, col: baseColumn },
            { line: last, col: end.col },
          );
        } else {
          const lo = Math.min(origin.line, end.line);
          const hi = Math.max(origin.line, end.line);
          const added: Pos[] = [];
          for (let line = lo; line <= hi; line++) {
            const text = this.lineCache.peek(line);
            if (text !== undefined) added.push(this.posFromLineAndX(line, ev.clientX, text));
          }
          const primary = added.find((item) => item.line === end.line) ?? origin;
          const unique = [...base, ...added].filter(
            (item, index, items) => items.findIndex((candidate) => cmp(candidate, item) === 0) === index
          );
          this.sel.block = null;
          this.sel.caret = primary;
          this.sel.anchor = primary;
          this.sel.secondary = unique.filter((item) => cmp(item, primary) !== 0);
        }
        this.sel.multiCaretX = null;
        this.sel.goalX = null;
        this.render();
        this.syncCaretVisibility();
        this.notifyCursor();
      };
      update(e);
      const move = (ev: MouseEvent) => update(ev);
      const cleanup = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        window.removeEventListener("blur", cancel);
      };
      const cancel = () => {
        cleanup();
        this.syncCaretVisibility();
      };
      const up = () => {
        cleanup();
        this.syncCaretVisibility();
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
      window.addEventListener("blur", cancel);
      return;
    }
    if (!this.readOnly && this.sel.hasSel()) {
      const [s, end] = this.sel.norm();
      if (cmp(pos, s) >= 0 && cmp(pos, end) < 0) {
        const startX = e.clientX;
        const startY = e.clientY;
        const originalAnchor = { ...this.sel.anchor };
        const originalCaret = { ...this.sel.caret };
        let copy = this.isCtrlPressed(e);
        let dragging = false;
        let drop: Pos | null = null;
        const updateSelectionDrag = (ev: MouseEvent) => {
          if (!dragging && (Math.abs(ev.clientX - startX) > 3 || Math.abs(ev.clientY - startY) > 3)) {
            dragging = true;
          }
          if (!dragging) return;
          const next = this.posFromPoint(ev.clientX, ev.clientY);
          if (!next) return;
          drop = next;
          copy = this.isCtrlPressed(ev);
          this.showDragCaret(next);
        };
        const cleanupSelectionDrag = () => {
          window.removeEventListener("mousemove", updateSelectionDrag);
          window.removeEventListener("mouseup", upSelection);
          window.removeEventListener("blur", cancelSelectionDrag);
          if (this.dragCleanup === cleanupSelectionDrag) this.dragCleanup = null;
          this.clearDragCaret();
        };
        const cancelSelectionDrag = () => {
          cleanupSelectionDrag();
        };
        const upSelection = (ev: MouseEvent) => {
          try {
            updateSelectionDrag(ev);
            if (dragging && drop) {
              if (cmp(drop, s) >= 0 && cmp(drop, end) <= 0) {
                this.sel.anchor = originalAnchor;
                this.sel.caret = originalCaret;
                this.render();
                this.notifyCursor();
                return;
              }
              void this.moveSelection(s, end, drop, copy)
                .catch((error) => this.reportActionError("選択範囲を移動またはコピーできませんでした", error));
            } else {
              this.moveTo(pos, false);
            }
          } catch (error) {
            void this.reportActionError("選択範囲を移動またはコピーできませんでした", error);
          } finally {
            cleanupSelectionDrag();
          }
        };
        this.dragCleanup = cleanupSelectionDrag;
        window.addEventListener("mousemove", updateSelectionDrag);
        window.addEventListener("mouseup", upSelection);
        window.addEventListener("blur", cancelSelectionDrag);
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
    const cleanup = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("blur", cancel);
    };
    const up = () => cleanup();
    const cancel = () => cleanup();
    window.addEventListener("blur", cancel);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  private isCtrlPressed(e: MouseEvent): boolean {
    return e.ctrlKey || e.getModifierState("Control") || this.ctrlDown;
  }

  private posFromPoint(cx: number, cy: number): Pos | null {
    if (this.wrap) {
      const target = document.elementFromPoint?.(cx, cy)?.closest<HTMLElement>(".ve-line");
      if (!target?.dataset.line) {
        // 行のない空白 (新規メモの本文下など) でもクリックを捨てず、文書末尾へ置く。
        const line = this.lineCount - 1;
        const text = this.lineCache.peek(line) ?? "";
        return { line, col: charLen(text) };
      }
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
  private onContextMenu(e: MouseEvent, pos = this.posFromPoint(e.clientX, e.clientY)) {
    e.preventDefault();
    if (pos && !this.sel.contains(pos)) this.moveTo(pos, false);
    this.focus();
    const items: MenuItem[] = [];
    const commandPath = this.externalFilePath;
    const hasOpenItems = Boolean(commandPath && (this.revealInExplorer || this.openInNewWindow));
    if (commandPath && this.revealInExplorer) {
      items.push({
        label: MENU_LABELS.explorer,
        iconClass: MENU_ICON.explorer,
        action: () => this.dispatch("エクスプローラで開けませんでした", () => this.revealInExplorer?.(commandPath, false)),
      });
    }
    if (commandPath && this.openInNewWindow) {
      items.push({
        label: MENU_LABELS.newWindow,
        iconClass: MENU_ICON.newWindow,
        action: () => this.dispatch("新規ウィンドウで開けませんでした", () => this.openInNewWindow?.(commandPath)),
      });
    }
    if (!this.readOnly) {
      items.push({ label: "元に戻す", iconClass: MENU_ICON.undo, key: "Ctrl+Z", action: () =>
        this.dispatch("編集を反映できませんでした", () => this.doUndo(false)), sep: hasOpenItems });
      items.push({ label: "やり直し", iconClass: MENU_ICON.redo, key: "Ctrl+Y", action: () =>
        this.dispatch("編集を反映できませんでした", () => this.doUndo(true)) });
      items.push({ label: "切り取り", iconClass: MENU_ICON.cut, key: "Ctrl+X", action: () =>
        this.dispatch("切り取りできませんでした", () => this.copy(true)), sep: true });
    }
    items.push({ label: "コピー", iconClass: MENU_ICON.copy, key: "Ctrl+C", action: () =>
      this.dispatch("クリップボードへコピーできませんでした", () => this.copy(false)), sep: this.readOnly });
    if (!this.readOnly) {
      items.push({ label: "貼り付け", iconClass: MENU_ICON.paste, key: "Ctrl+V", action: () =>
        this.dispatch("クリップボードから貼り付けできませんでした", () => this.paste()) });
      items.push({ label: MENU_LABELS.delete, iconClass: MENU_ICON.delete, action: () => {
        if (this.sel.hasSel()) this.dispatch("編集を反映できませんでした", () => this.deleteSel());
      } });
    }
    items.push({
      label: "すべて選択",
      iconClass: MENU_ICON.selectAll,
      key: "Ctrl+A",
      action: () => this.dispatch("全選択できませんでした", () => this.selectAll()),
    });
    let customStarted = false;
    const addCustomItem = (item: MenuItem) => {
      items.push(customStarted ? item : { ...item, sep: true });
      customStarted = true;
    };
    if (!this.readOnly) {
      if (this.sel.hasSel()) addCustomItem({
        label: "選択範囲を登録文字列に追加",
        iconClass: MENU_ICON.registeredString,
        action: () => this.dispatch("登録文字列に追加できませんでした", () => this.addSelectionAsRegisteredString()),
      });
      const registered = loadRegisteredStrings();
      if (registered.length) {
        addCustomItem({
          label: "登録文字列",
          iconClass: MENU_ICON.registeredString,
          sub: registered.map((text) => ({
            label: registeredStringLabel(text),
            iconClass: MENU_ICON.registeredString,
            action: () => this.dispatch("登録文字列を挿入できませんでした", () => this.insertText(text)),
            trailing: {
              label: "×",
              title: "登録文字列を削除",
              action: () => this.dispatch("登録文字列を削除できませんでした", async () => {
                removeRegisteredString(text);
                await flushSettings();
              }),
            },
          })),
        });
      }
    }
    if (this.sel.hasSel() && commandPath) {
      const [start, end] = this.sel.norm();
      addCustomItem({
        ...createRegisteredCommandMenu({
          path: commandPath,
          value: () => this.sel.blockBounds() ? this.blockText() : this.lineCache.textInRange(start, end),
          valueKind: "string",
        }, {
          ...this.registeredCommandPorts,
          run: (title, operation) => this.dispatch(title, operation),
        }),
      });
    }
    const viewerFormats = Object.entries(VIEWER_FORMAT_LABELS) as [api.ViewerFormat, string][];
    items.push(
      ...viewerFormats.map(([format, label], index) => ({
        label,
        iconClass: viewerFormatIcon(format),
        action: () => this.dispatch("ビューを開けませんでした", () => this.openTextViewer(format)),
        sep: index === 0,
      })),
    );
    if (commandPath) {
      items.push({
        label: MENU_LABELS.external,
        iconClass: MENU_ICON.external,
        action: () => this.dispatch("アプリで開けませんでした", () => this.openExternally(commandPath)),
        sep: true,
      });
    }
    showMenu(e.clientX, e.clientY, items);
  }

  private onGutterContextMenu(e: MouseEvent) {
    this.onContextMenu(e, { line: this.lineFromGutterY(e.clientY), col: 0 });
  }

  private async addSelectionAsRegisteredString() {
    const [start, end] = this.sel.norm();
    addRegisteredString(await this.lineCache.textInRange(start, end));
    await flushSettings();
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
    const update = (line: number) => {
      this.dispatch("行選択を更新できませんでした", () => this.selectLines(startLine, line));
    };
    update(clicked);
    const move = (ev: MouseEvent) => {
      update(this.lineFromGutterY(ev.clientY));
    };
    const cleanup = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("blur", cancel);
    };
    const cancel = () => cleanup();
    const up = () => cleanup();
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    window.addEventListener("blur", cancel);
  }

  // ---- 検索 ----
  // 1回のIPC呼び出しで最大この行数だけ走査する。巨大ファイルで一致が見つからない場合でも
  // 呼び出し毎にbackendのMutexを解放するため、その間にスクロール/入力が割り込める。
  private static readonly FIND_BUDGET = 20_000;
  private static readonly REPLACE_BUDGET = 2_000;
  private static readonly REPLACE_WARN_THRESHOLD = 5_000;

  private async doFind(pat: string, forward: boolean, matchCase: boolean): Promise<boolean> {
    const myGen = ++this.findGen;
    const previousMatch = this.lastFindMatch;
    const p = unescapePattern(pat);
    this.setFindHighlightQuery(p, matchCase);
    this.lastFindMatch = null;
    if (!p) return false;
    const selectionIsPrevious = previousMatch
      && cmp(this.sel.anchor, previousMatch.start) === 0
      && cmp(this.sel.caret, previousMatch.end) === 0;
    const refiningCurrent = forward && selectionIsPrevious
      && (previousMatch.pat !== p || previousMatch.matchCase !== matchCase);
    const from = forward ? (refiningCurrent ? previousMatch.start : this.sel.norm()[1]) : this.sel.norm()[0];
    if (!forward) {
      const r = await this.doc.find(p, from, false, matchCase);
      if (myGen !== this.findGen) return false;
      if (!r) { this.lastFindMatch = null; return false; }
      this.selectAndCenter(r.start, r.end);
      this.lastFindMatch = { start: r.start, end: r.end, pat: p, matchCase };
      return true;
    }
    const outcome = await findForward(
      this.doc,
      p,
      from,
      matchCase,
      VirtualEditor.FIND_BUDGET,
      () => myGen === this.findGen,
      (cursor) => this.findBar.setProgress(
        `検索中… ${findProgressPercent(cursor, from.line, this.lineCount)}%`,
      ),
    );
    if (!outcome || outcome.kind !== "Found") {
      this.lastFindMatch = null;
      return false;
    }
    this.findBar.setProgress("");
    this.selectAndCenter(outcome.start, outcome.end);
    this.lastFindMatch = { start: outcome.start, end: outcome.end, pat: p, matchCase };
    return true;
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

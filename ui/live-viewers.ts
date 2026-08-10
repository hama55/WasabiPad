// 開いているビューウィンドウへの追随。どの範囲を映しているかを覚え、
// 編集で範囲を追従させ、少し待ってからまとめて送り直す。
// テキストの取り出し方 (どの範囲が全文か) は呼び出し側から受け取る。
import type { EditManyItem, ViewerFormat, ViewerSelection } from "./api";
import type { Pos } from "./api";
import { comparePos } from "./editor-math";
import { transformTrackedRange, type TrackedRange } from "./viewer-range";
import { type ViewerSelectionWithCaret } from "./viewer-selection";

const DEBOUNCE_MS = 120;

export interface LiveViewerPorts {
  openViewer: (format: ViewerFormat, text: string, selection: ViewerSelection | null) => Promise<string | null>;
  // false は backend がビューの消滅を確認した場合だけ返す。
  updateViewer: (label: string, text: string, selection: ViewerSelection | null) => Promise<boolean>;
  closeViewer?: (label: string) => Promise<void>;
  // range が null のときに映すべき全文の範囲
  wholeRange: () => Promise<{ start: Pos; end: Pos }>;
  textInRange: (start: Pos, end: Pos) => Promise<string>;
  onError?: (error: unknown) => void | Promise<void>;
}

export class LiveViewers {
  private viewers = new Map<string, { format: ViewerFormat; range: TrackedRange | null; selection: ViewerSelectionWithCaret | null }>();
  private timer: number | undefined;
  private generation = 0;
  private refreshVersion = 0;
  private refreshPromise: Promise<void> | undefined;
  private refreshRequested = false;
  private errorReported = false;

  constructor(private ports: LiveViewerPorts) {}

  clear() {
    const labels = [...this.viewers.keys()];
    this.generation++;
    this.refreshVersion++;
    this.refreshRequested = false;
    this.refreshPromise = undefined;
    this.viewers.clear();
    for (const label of labels) this.closeViewer(label);
    window.clearTimeout(this.timer);
    this.timer = undefined;
    this.errorReported = false;
  }

  private closeViewer(label: string) {
    if (!this.ports.closeViewer) return;
    void Promise.resolve()
      .then(() => this.ports.closeViewer!(label))
      .catch((error) => this.reportUnexpectedRefreshError(error));
  }

  has(format: ViewerFormat) {
    return [...this.viewers.values()].some((viewer) => viewer.format === format);
  }

  previewRange(): TrackedRange | null {
    const ranges = [...this.viewers.values()]
      .map((viewer) => viewer.range)
      .filter((range): range is TrackedRange => !!range);
    const range = ranges[0];
    if (!range || ranges.some((candidate) =>
      comparePos(candidate.start, range.start) !== 0 || comparePos(candidate.end, range.end) !== 0
    )) return null;
    return { start: { ...range.start }, end: { ...range.end } };
  }

  positionInDocument(position: Pos): Pos {
    const range = this.previewRange();
    if (!range) return { ...position };
    const target = {
      line: range.start.line + position.line,
      col: position.line === 0 ? range.start.col + position.col : position.col,
    };
    return comparePos(target, range.end) > 0 ? { ...range.end } : target;
  }

  // range=null は「全文を映す」= 以後の編集で常に最新の全文へ追随する
  async open(format: ViewerFormat, range: TrackedRange | null, selection: TrackedRange, caret = selection.end) {
    const generation = this.generation;
    const { start, end } = range ?? (await this.ports.wholeRange());
    if (generation !== this.generation) return;
    const viewerSelection = relativeSelection(range, selection, caret);
    const text = await this.ports.textInRange(start, end);
    if (generation !== this.generation) return;
    const label = await this.ports.openViewer(format, text, viewerSelection);
    if (!label) return;
    if (generation === this.generation) {
      this.viewers.set(label, { format, range, selection: viewerSelection });
      return;
    }
    try {
      await this.ports.closeViewer?.(label);
    } catch (error) {
      this.reportUnexpectedRefreshError(error);
    }
  }

  // 編集を各ビューの追跡範囲へ反映する (範囲外の編集なら位置だけずれる)
  applyEdits(edits: EditManyItem[]) {
    if (!edits.length) return;
    this.refreshVersion++;
    for (const viewer of this.viewers.values()) {
      if (viewer.range) viewer.range = transformTrackedRange(viewer.range, edits);
    }
  }

  setSelection(selection: TrackedRange, caret = selection.end) {
    this.refreshVersion++;
    for (const viewer of this.viewers.values()) {
      viewer.selection = relativeSelection(viewer.range, selection, caret);
    }
    this.scheduleRefresh();
  }

  scheduleRefresh() {
    if (!this.viewers.size) return;
    window.clearTimeout(this.timer);
    if (this.refreshPromise) {
      this.refreshRequested = true;
      return;
    }
    const generation = this.generation;
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      const refreshPromise = this.refresh(generation, this.refreshVersion);
      this.refreshPromise = refreshPromise;
      void refreshPromise.catch((error) => {
        // 個別ビューの更新失敗は refresh 内で隔離する。ここは予期しない
        // コレクション/実装エラーが未処理Promiseになるのを防ぐ境界。
        this.reportUnexpectedRefreshError(error);
      }).finally(() => {
        if (this.refreshPromise !== refreshPromise) return;
        this.refreshPromise = undefined;
        if (this.refreshRequested) {
          this.refreshRequested = false;
          if (generation === this.generation && this.viewers.size) this.scheduleRefresh();
        }
      });
    }, DEBOUNCE_MS);
  }

  private reportUnexpectedRefreshError(error: unknown) {
    if (!this.ports.onError) {
      console.error("プレビュー更新で予期しないエラーが発生しました", error);
      return;
    }
    void Promise.resolve()
      .then(() => this.ports.onError!(error))
      .catch((reportError) => console.error("プレビュー更新エラーを表示できませんでした", reportError));
  }

  private async refresh(generation: number, version: number) {
    for (const [label, viewer] of [...this.viewers]) {
      if (generation !== this.generation || version !== this.refreshVersion) return;
      try {
        const { start, end } = viewer.range ?? (await this.ports.wholeRange());
        const text = await this.ports.textInRange(start, end);
        if (generation !== this.generation || version !== this.refreshVersion) return;
        const exists = await this.ports.updateViewer(label, text, viewer.selection);
        if (generation !== this.generation || version !== this.refreshVersion) return;
        this.errorReported = false;
        if (!exists) this.viewers.delete(label);
      } catch (error) {
        if (generation !== this.generation || version !== this.refreshVersion) return;
        // 一時的なIPC/文書読込み失敗で追随を永久停止しない。次の編集で再試行する。
        if (this.errorReported) continue;
        this.errorReported = true;
        try {
          await this.ports.onError?.(error);
        } catch (reportError) {
          console.error("プレビュー更新エラーを表示できませんでした", reportError);
        }
      }
    }
  }
}

function relativeSelection(
  range: TrackedRange | null,
  selection: TrackedRange,
  caret: Pos,
): ViewerSelectionWithCaret | null {
  const collapsed = comparePos(selection.start, selection.end) === 0;
  if (!range) {
    const result = { start: { ...selection.start }, end: { ...selection.end } };
    return collapsed ? result : { ...result, caret: { ...caret } };
  }
  if (comparePos(selection.end, range.start) < 0 || comparePos(selection.start, range.end) > 0) return null;
  const start = comparePos(selection.start, range.start) < 0 ? range.start : selection.start;
  const end = comparePos(selection.end, range.end) > 0 ? range.end : selection.end;
  const result = { start: relativePos(start, range.start), end: relativePos(end, range.start) };
  return collapsed ? result : { ...result, caret: relativePos(caret, range.start) };
}

function relativePos(pos: Pos, origin: Pos): Pos {
  return { line: pos.line - origin.line, col: pos.line === origin.line ? pos.col - origin.col : pos.col };
}

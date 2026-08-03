// 開いているビューウィンドウへの追随。どの範囲を映しているかを覚え、
// 編集で範囲を追従させ、少し待ってからまとめて送り直す。
// テキストの取り出し方 (どの範囲が全文か) は呼び出し側から受け取る。
import type { EditManyItem, ViewerFormat, ViewerSelection } from "./api";
import type { Pos } from "./api";
import { transformTrackedRange, type TrackedRange } from "./viewer-range";

const DEBOUNCE_MS = 120;

const compare = (a: Pos, b: Pos) => a.line - b.line || a.col - b.col;

export interface LiveViewerPorts {
  openViewer: (format: ViewerFormat, text: string, selection: ViewerSelection | null) => Promise<string | null>;
  // false は backend がビューの消滅を確認した場合だけ返す。
  updateViewer: (label: string, text: string, selection: ViewerSelection | null) => Promise<boolean>;
  // range が null のときに映すべき全文の範囲
  wholeRange: () => Promise<{ start: Pos; end: Pos }>;
  textInRange: (start: Pos, end: Pos) => Promise<string>;
  onError?: (error: unknown) => void | Promise<void>;
}

export class LiveViewers {
  private viewers = new Map<string, { format: ViewerFormat; range: TrackedRange | null; selection: ViewerSelection | null }>();
  private timer: number | undefined;
  private generation = 0;
  private errorReported = false;

  constructor(private ports: LiveViewerPorts) {}

  clear() {
    this.generation++;
    this.viewers.clear();
    window.clearTimeout(this.timer);
    this.timer = undefined;
    this.errorReported = false;
  }

  has(format: ViewerFormat) {
    return [...this.viewers.values()].some((viewer) => viewer.format === format);
  }

  // range=null は「全文を映す」= 以後の編集で常に最新の全文へ追随する
  async open(format: ViewerFormat, range: TrackedRange | null, selection: TrackedRange) {
    const generation = this.generation;
    const { start, end } = range ?? (await this.ports.wholeRange());
    const viewerSelection = relativeSelection(range, selection);
    const label = await this.ports.openViewer(format, await this.ports.textInRange(start, end), viewerSelection);
    if (label && generation === this.generation) this.viewers.set(label, { format, range, selection: viewerSelection });
  }

  // 編集を各ビューの追跡範囲へ反映する (範囲外の編集なら位置だけずれる)
  applyEdits(edits: EditManyItem[]) {
    if (!edits.length) return;
    for (const viewer of this.viewers.values()) {
      if (viewer.range) viewer.range = transformTrackedRange(viewer.range, edits);
    }
  }

  setSelection(selection: TrackedRange) {
    for (const viewer of this.viewers.values()) {
      viewer.selection = relativeSelection(viewer.range, selection);
    }
    this.scheduleRefresh();
  }

  scheduleRefresh() {
    if (!this.viewers.size) return;
    window.clearTimeout(this.timer);
    const generation = this.generation;
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      void this.refresh(generation).catch((error) => {
        // 個別ビューの更新失敗は refresh 内で隔離する。ここは予期しない
        // コレクション/実装エラーが未処理Promiseになるのを防ぐ境界。
        this.reportUnexpectedRefreshError(error);
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

  private async refresh(generation: number) {
    for (const [label, viewer] of [...this.viewers]) {
      if (generation !== this.generation) return;
      try {
        const { start, end } = viewer.range ?? (await this.ports.wholeRange());
        const text = await this.ports.textInRange(start, end);
        if (generation !== this.generation) return;
        const exists = await this.ports.updateViewer(label, text, viewer.selection);
        if (generation !== this.generation) return;
        this.errorReported = false;
        if (!exists) this.viewers.delete(label);
      } catch (error) {
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

function relativeSelection(range: TrackedRange | null, selection: TrackedRange): ViewerSelection | null {
  if (!range) return { start: { ...selection.start }, end: { ...selection.end } };
  if (compare(selection.end, range.start) < 0 || compare(selection.start, range.end) > 0) return null;
  const start = compare(selection.start, range.start) < 0 ? range.start : selection.start;
  const end = compare(selection.end, range.end) > 0 ? range.end : selection.end;
  return { start: relativePos(start, range.start), end: relativePos(end, range.start) };
}

function relativePos(pos: Pos, origin: Pos): Pos {
  return { line: pos.line - origin.line, col: pos.line === origin.line ? pos.col - origin.col : pos.col };
}

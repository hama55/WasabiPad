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
  updateViewer: (label: string, text: string, selection: ViewerSelection | null) => Promise<void>;
  // range が null のときに映すべき全文の範囲
  wholeRange: () => Promise<{ start: Pos; end: Pos }>;
  textInRange: (start: Pos, end: Pos) => Promise<string>;
}

export class LiveViewers {
  private viewers = new Map<string, { range: TrackedRange | null; selection: ViewerSelection | null }>();
  private timer: number | undefined;

  constructor(private ports: LiveViewerPorts) {}

  clear() {
    this.viewers.clear();
    window.clearTimeout(this.timer);
  }

  // range=null は「全文を映す」= 以後の編集で常に最新の全文へ追随する
  async open(format: ViewerFormat, range: TrackedRange | null, selection: TrackedRange) {
    const { start, end } = range ?? (await this.ports.wholeRange());
    const viewerSelection = relativeSelection(range, selection);
    const label = await this.ports.openViewer(format, await this.ports.textInRange(start, end), viewerSelection);
    if (label) this.viewers.set(label, { range, selection: viewerSelection });
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
    this.timer = window.setTimeout(() => { void this.refresh(); }, DEBOUNCE_MS);
  }

  private async refresh() {
    for (const [label, viewer] of [...this.viewers]) {
      try {
        const { start, end } = viewer.range ?? (await this.ports.wholeRange());
        await this.ports.updateViewer(label, await this.ports.textInRange(start, end), viewer.selection);
      } catch {
        this.viewers.delete(label); // 閉じられたビューは追随対象から外す
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

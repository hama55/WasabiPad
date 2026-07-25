// 開いているビューウィンドウへの追随。どの範囲を映しているかを覚え、
// 編集で範囲を追従させ、少し待ってからまとめて送り直す。
// テキストの取り出し方 (どの範囲が全文か) は呼び出し側から受け取る。
import type { EditManyItem, ViewerFormat } from "./api";
import type { Pos } from "./api";
import { transformTrackedRange, type TrackedRange } from "./viewer-range";

const DEBOUNCE_MS = 120;

export interface LiveViewerPorts {
  openViewer: (format: ViewerFormat, text: string) => Promise<string | null>;
  updateViewer: (label: string, text: string) => Promise<void>;
  // range が null のときに映すべき全文の範囲
  wholeRange: () => Promise<{ start: Pos; end: Pos }>;
  textInRange: (start: Pos, end: Pos) => Promise<string>;
}

export class LiveViewers {
  private viewers = new Map<string, { range: TrackedRange | null }>();
  private timer: number | undefined;

  constructor(private ports: LiveViewerPorts) {}

  clear() {
    this.viewers.clear();
    window.clearTimeout(this.timer);
  }

  // range=null は「全文を映す」= 以後の編集で常に最新の全文へ追随する
  async open(format: ViewerFormat, range: TrackedRange | null) {
    const { start, end } = range ?? (await this.ports.wholeRange());
    const label = await this.ports.openViewer(format, await this.ports.textInRange(start, end));
    if (label) this.viewers.set(label, { range });
  }

  // 編集を各ビューの追跡範囲へ反映する (範囲外の編集なら位置だけずれる)
  applyEdits(edits: EditManyItem[]) {
    if (!edits.length) return;
    for (const viewer of this.viewers.values()) {
      if (viewer.range) viewer.range = transformTrackedRange(viewer.range, edits);
    }
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
        await this.ports.updateViewer(label, await this.ports.textInRange(start, end));
      } catch {
        this.viewers.delete(label); // 閉じられたビューは追随対象から外す
      }
    }
  }
}

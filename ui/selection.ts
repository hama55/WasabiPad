// キャレットと選択範囲の状態。座標の比較だけを扱い、DOM も backend も知らない。
import type { Pos } from "./api";
import { comparePos as cmp } from "./editor-math";

export class Selection {
  caret: Pos = { line: 0, col: 0 };
  anchor: Pos = { line: 0, col: 0 };
  secondary: Pos[] = [];
  // 上下移動で維持したい x 座標 (px)。行末より短い行を通過しても列が戻る
  goalX: number | null = null;
  // 複数キャレットを縦に追加するときの基準 x (px)
  multiCaretX: number | null = null;

  reset(pos: Pos = { line: 0, col: 0 }) {
    this.caret = pos;
    this.anchor = pos;
    this.secondary = [];
    this.goalX = null;
    this.multiCaretX = null;
  }

  hasSel(): boolean {
    return cmp(this.anchor, this.caret) !== 0;
  }

  // 常に [先, 後] の順で返す
  norm(): [Pos, Pos] {
    return cmp(this.anchor, this.caret) <= 0 ? [this.anchor, this.caret] : [this.caret, this.anchor];
  }

  contains(pos: Pos): boolean {
    if (!this.hasSel()) return false;
    const [start, end] = this.norm();
    return cmp(pos, start) >= 0 && cmp(pos, end) <= 0;
  }

  all(): Pos[] {
    return [this.caret, ...this.secondary];
  }
}

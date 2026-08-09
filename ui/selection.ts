// キャレットと選択範囲の状態。座標の比較だけを扱い、DOM も backend も知らない。
import type { Pos } from "./api";
import { charLen, comparePos as cmp } from "./editor-math";

export interface BlockSelection {
  anchor: Pos;
  caret: Pos;
}

export interface BlockBounds {
  first: number;
  last: number;
  left: number;
  right: number;
}

export function blockRangeForLine(text: string, bounds: Pick<BlockBounds, "left" | "right">) {
  const length = charLen(text);
  return {
    start: Math.min(bounds.left, length),
    end: Math.min(bounds.right, length),
  };
}

export class Selection {
  caret: Pos = { line: 0, col: 0 };
  anchor: Pos = { line: 0, col: 0 };
  secondary: Pos[] = [];
  block: BlockSelection | null = null;
  // 上下移動で維持したい x 座標 (px)。行末より短い行を通過しても列が戻る
  goalX: number | null = null;
  // 複数キャレットを縦に追加するときの基準 x (px)
  multiCaretX: number | null = null;

  reset(pos: Pos = { line: 0, col: 0 }) {
    this.caret = pos;
    this.anchor = pos;
    this.secondary = [];
    this.block = null;
    this.goalX = null;
    this.multiCaretX = null;
  }

  hasSel(): boolean {
    return this.blockBounds() !== null || cmp(this.anchor, this.caret) !== 0;
  }

  setBlock(anchor: Pos, caret: Pos) {
    this.block = { anchor: { ...anchor }, caret: { ...caret } };
    this.anchor = this.block.anchor;
    this.caret = this.block.caret;
    this.secondary = [];
    this.goalX = null;
    this.multiCaretX = null;
  }

  // 常に [先, 後] の順で返す
  norm(): [Pos, Pos] {
    const block = this.blockBounds();
    if (block) {
      return [
        { line: block.first, col: block.left },
        { line: block.last, col: block.right },
      ];
    }
    return cmp(this.anchor, this.caret) <= 0 ? [this.anchor, this.caret] : [this.caret, this.anchor];
  }

  blockBounds(): BlockBounds | null {
    if (!this.block || this.block.anchor.col === this.block.caret.col) return null;
    return {
      first: Math.min(this.block.anchor.line, this.block.caret.line),
      last: Math.max(this.block.anchor.line, this.block.caret.line),
      left: Math.min(this.block.anchor.col, this.block.caret.col),
      right: Math.max(this.block.anchor.col, this.block.caret.col),
    };
  }

  contains(pos: Pos): boolean {
    if (!this.hasSel()) return false;
    const block = this.blockBounds();
    if (block) {
      return pos.line >= block.first && pos.line <= block.last
        && pos.col >= block.left && pos.col <= block.right;
    }
    const [start, end] = this.norm();
    return cmp(pos, start) >= 0 && cmp(pos, end) <= 0;
  }

  all(): Pos[] {
    return [this.caret, ...this.secondary];
  }
}

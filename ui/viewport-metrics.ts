// 行番号 ⇔ スクロール位置の対応だけを持つ値オブジェクト。DOM の書き込みはしない
// (実測値は measure() で受け取る)。巨大文書の比例配分 (scaleMode) の判断もここ。
//
// ブラウザ実装は要素の絶対サイズ/スクロール範囲に上限がある (~1670万px 前後、
// DPI拡大率によってはさらに小さい)。行数×行高がこれを超える巨大文書では
// 1:1 の対応を諦め、スクロール範囲全体へ比例配分する。
export const MAX_SAFE_HEIGHT = 5_000_000;

export interface ViewportSize {
  clientHeight: number;
  // WebView は巨大な CSS 高さを内部上限へ丸めることがある。指定値ではなく
  // 実際に確保された範囲を使わないと、つまみ位置と行位置の比率がずれる。
  maxScroll: number;
}

export class ViewportMetrics {
  lineCount = 1;
  wrap = false;

  constructor(private measure: () => ViewportSize, private height: number) {}

  get lineHeight(): number {
    return this.height;
  }

  set lineHeight(value: number) {
    this.height = value;
  }

  // 行数×行高がブラウザ上限を超えるか (超える場合は比例配分に切り替える)
  get scaleMode(): boolean {
    return this.lineCount * this.height > MAX_SAFE_HEIGHT;
  }

  // ve-inner に設定すべき高さ
  get scrollHeight(): number {
    return Math.min(this.lineCount * this.height, MAX_SAFE_HEIGHT);
  }

  visibleRows(): number {
    return Math.max(1, Math.floor(this.measure().clientHeight / this.height));
  }

  // 折り返し時は末尾行自身が viewport より高い可能性があるため、末尾行まで
  // anchor にできる必要がある。可視行数からの逆算は行わない。
  maxTopLine(): number {
    if (this.wrap) return Math.max(0, this.lineCount - 1);
    return Math.max(0, this.lineCount - this.visibleRows());
  }

  // 行番号 -> その行を可視域の先頭に置くための scrollTop
  lineToPx(line: number): number {
    if (!this.wrap && !this.scaleMode) return line * this.height;
    const maxTopLine = this.maxTopLine();
    return maxTopLine ? (Math.min(line, maxTopLine) / maxTopLine) * this.measure().maxScroll : 0;
  }

  // scrollTop -> その位置に対応する行番号 (描画の基準行)
  pxToLine(px: number): number {
    if (!this.wrap && !this.scaleMode) return Math.floor(px / this.height);
    const maxScroll = this.measure().maxScroll;
    if (maxScroll <= 0) return 0;
    return Math.round(Math.min(1, Math.max(0, px / maxScroll)) * this.maxTopLine());
  }

  clampTopLine(line: number): number {
    return Math.max(0, Math.min(this.maxTopLine(), line));
  }
}

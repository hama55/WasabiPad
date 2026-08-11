import { describe, expect, it } from "vitest";
import { MAX_SAFE_HEIGHT, ViewportMetrics } from "./viewport-metrics";

const metrics = (lineCount: number, clientHeight = 400, maxScroll = 1000) => {
  const m = new ViewportMetrics(() => ({ clientHeight, maxScroll }), 20);
  m.lineCount = lineCount;
  return m;
};

describe("Feature: ViewportMetrics", () => {
  // Given: 行数1000、行高20、表示高400、最大スクロール1000
  // When: 各変換値を取得
  // Then: 非縮尺、scrollHeight20000、10行→200px、205px→10行、表示行20、最大先頭980
  it("Scenario: 通常サイズでは行と px が1:1で対応する", () => {
    const m = metrics(1000);
    expect(m.scaleMode).toBe(false);
    expect(m.scrollHeight).toBe(20_000);
    expect(m.lineToPx(10)).toBe(200);
    expect(m.pxToLine(205)).toBe(10);
    expect(m.visibleRows()).toBe(20);
    expect(m.maxTopLine()).toBe(980);
  });

  // Given: 行数240,000,000でブラウザ上限を超える
  // When: 行/px変換を取得
  // Then: 縮尺モード、scrollHeightは`MAX_SAFE_HEIGHT`、先頭0px、末尾1000px、500pxは中央行、範囲外10000pxは末尾
  it("Scenario: ブラウザ上限を超える行数では比例配分へ切り替わる", () => {
    const m = metrics(240_000_000);
    expect(m.scaleMode).toBe(true);
    expect(m.scrollHeight).toBe(MAX_SAFE_HEIGHT);
    // 1行あたり1px未満でも先頭/中間/末尾が区別できる
    expect(m.lineToPx(0)).toBe(0);
    expect(m.lineToPx(m.maxTopLine())).toBe(1000);
    expect(m.pxToLine(500)).toBe(Math.round(m.maxTopLine() / 2));
    expect(m.pxToLine(10_000), "範囲外の px は末尾へ丸める").toBe(m.maxTopLine());
  });

  // Given: 行数1000でwrapを有効化
  // When: 最大先頭行と末尾行のpxを取得
  // Then: 最大先頭999、999行目は1000px
  it("Scenario: 折り返し時は末尾行まで先頭にできる", () => {
    const m = metrics(1000);
    m.wrap = true;
    expect(m.maxTopLine()).toBe(999);
    expect(m.lineToPx(999)).toBe(1000);
  });

  // Given: 行数240,000,000だが最大スクロール0
  // When: 999px→行、500行→pxを変換
  // Then: どちらも0
  it("Scenario: スクロール範囲がない場合は常に先頭", () => {
    const m = new ViewportMetrics(() => ({ clientHeight: 400, maxScroll: 0 }), 20);
    m.lineCount = 240_000_000;
    expect(m.pxToLine(999)).toBe(0);
    expect(m.lineToPx(500)).toBe(0);
  });

  // Given: 行数200,000、行高20から40へ変更
  // When: 縮尺判定と範囲外行を取得
  // Then: 20では非縮尺、40では縮尺、`1e9`は末尾、`-5`は0
  it("Scenario: 行高を変えると閾値判定も追随する", () => {
    const m = metrics(200_000);
    expect(m.scaleMode).toBe(false);
    m.lineHeight = 40;
    expect(m.scaleMode).toBe(true);
    expect(m.clampTopLine(1e9)).toBe(m.maxTopLine());
    expect(m.clampTopLine(-5)).toBe(0);
  });
});

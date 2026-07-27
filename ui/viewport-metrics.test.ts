import { describe, expect, it } from "vitest";
import { MAX_SAFE_HEIGHT, ViewportMetrics } from "./viewport-metrics";

const metrics = (lineCount: number, clientHeight = 400, maxScroll = 1000) => {
  const m = new ViewportMetrics(() => ({ clientHeight, maxScroll }), 20);
  m.lineCount = lineCount;
  return m;
};

describe("ViewportMetrics", () => {
  it("通常サイズでは行と px が1:1で対応する", () => {
    const m = metrics(1000);
    expect(m.scaleMode).toBe(false);
    expect(m.scrollHeight).toBe(20_000);
    expect(m.lineToPx(10)).toBe(200);
    expect(m.pxToLine(205)).toBe(10);
    expect(m.visibleRows()).toBe(20);
    expect(m.maxTopLine()).toBe(980);
  });

  it("ブラウザ上限を超える行数では比例配分へ切り替わる", () => {
    const m = metrics(240_000_000);
    expect(m.scaleMode).toBe(true);
    expect(m.scrollHeight).toBe(MAX_SAFE_HEIGHT);
    // 1行あたり1px未満でも先頭/中間/末尾が区別できる
    expect(m.lineToPx(0)).toBe(0);
    expect(m.lineToPx(m.maxTopLine())).toBe(1000);
    expect(m.pxToLine(500)).toBe(Math.round(m.maxTopLine() / 2));
    expect(m.pxToLine(10_000), "範囲外の px は末尾へ丸める").toBe(m.maxTopLine());
  });

  it("折り返し時は末尾行まで先頭にできる", () => {
    const m = metrics(1000);
    m.wrap = true;
    expect(m.maxTopLine()).toBe(999);
    expect(m.lineToPx(999)).toBe(1000);
  });

  it("スクロール範囲がない場合は常に先頭", () => {
    const m = new ViewportMetrics(() => ({ clientHeight: 400, maxScroll: 0 }), 20);
    m.lineCount = 240_000_000;
    expect(m.pxToLine(999)).toBe(0);
    expect(m.lineToPx(500)).toBe(0);
  });

  it("行高を変えると閾値判定も追随する", () => {
    const m = metrics(200_000);
    expect(m.scaleMode).toBe(false);
    m.lineHeight = 40;
    expect(m.scaleMode).toBe(true);
    expect(m.clampTopLine(1e9)).toBe(m.maxTopLine());
    expect(m.clampTopLine(-5)).toBe(0);
  });
});

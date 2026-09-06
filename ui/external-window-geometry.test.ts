import { describe, expect, it } from "vitest";
import { externalWindowRectFor } from "./external-window-geometry";

describe("Feature: 連携先ウィンドウの画面矩形変換", () => {
  // Scenario: DPI倍率を反映する
  // Given: CSS矩形と物理画面上のWebView位置、150%のDPI倍率がある
  // When: 連携先ウィンドウの矩形へ変換する
  // Then: 位置とサイズを物理ピクセルへ変換する
  it("Scenario: scales the pane rectangle to physical pixels", () => {
    expect(externalWindowRectFor(
      { left: 10, top: 20, width: 400, height: 300 },
      { x: 100, y: 200 },
      1.5,
    )).toEqual({ x: 115, y: 230, width: 600, height: 450 });
  });

  // Scenario: マルチモニターの負座標を維持する
  // Given: WebViewの画面位置が負の座標にある
  // When: 連携先ウィンドウの矩形へ変換する
  // Then: 負の画面座標をそのまま返す
  it("Scenario: preserves negative multi-monitor coordinates", () => {
    expect(externalWindowRectFor(
      { left: 8, top: 4.25, width: 100, height: 80 },
      { x: -1920, y: -40 },
      1,
    )).toEqual({ x: -1912, y: -36, width: 100, height: 80 });
  });

  // Scenario: 不正な矩形をフォールバック対象にする
  // Given: ペインが非表示で幅または高さが0である
  // When: 連携先ウィンドウの矩形へ変換する
  // Then: 配置せずnullを返す
  it("Scenario: returns null for an unusable pane rectangle", () => {
    expect(externalWindowRectFor(
      { left: 0, top: 0, width: 0, height: 100 },
      { x: 0, y: 0 },
      1,
    )).toBeNull();
  });

  // Scenario: IPC型の範囲を超える矩形をフォールバック対象にする
  // Given: DPI倍率が極端に大きく、物理サイズが安全な整数範囲を超える
  // When: 連携先ウィンドウの矩形へ変換する
  // Then: 不正なIPC引数を作らずnullを返す
  it("Scenario: returns null when the physical rectangle exceeds IPC ranges", () => {
    expect(externalWindowRectFor(
      { left: 0, top: 0, width: 1, height: 1 },
      { x: 0, y: 0 },
      Number.MAX_VALUE,
    )).toBeNull();
  });
});

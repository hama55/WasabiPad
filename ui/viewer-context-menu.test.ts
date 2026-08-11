// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { MENU_ICON } from "./menu-icons";
import { createViewerBrowserMenuItem, createViewerChartMenuItem } from "./viewer-context-menu";

describe("Feature: viewer context menu", () => {
  // Given: グラフ作成アクションを渡したビューアのメニュー項目
  // When: グラフメニュー項目を生成してクリックする
  // Then: ラベル・装飾用アイコン・aria-hiddenが設定され、アクションが1回呼ばれる
  it("Scenario: グラフ作成項目に共通アイコンを付けて実行する", () => {
    const onClick = vi.fn();
    const item = createViewerChartMenuItem(onClick);

    expect(item.textContent).toBe("グラフを作成...");
    const icon = item.firstElementChild as HTMLElement;
    expect(icon.classList.contains("menu-icon")).toBe(true);
    expect(icon.classList.contains(MENU_ICON.chart)).toBe(true);
    expect(icon.getAttribute("aria-hidden")).toBe("true");

    item.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  // Given: ブラウザで開くアクション
  // When: ブラウザメニュー項目を生成してクリックする
  // Then: 指定ラベルを表示し、アクションを実行する
  it("Scenario: 既定のブラウザ項目を作成する", () => {
    const onClick = vi.fn();
    const item = createViewerBrowserMenuItem(onClick);

    expect(item.textContent).toBe("\u898f\u5b9a\u306e\u30d6\u30e9\u30a6\u30b6\u3067\u8868\u793a");
    expect(item.querySelector(`.${MENU_ICON.external}`)).not.toBeNull();
    item.click();
    expect(onClick).toHaveBeenCalledOnce();
  });
});

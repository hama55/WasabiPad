import { describe, expect, it, vi } from "vitest";
import { createOpenAsMenu } from "./open-as-menu";
import { MENU_ICON } from "./menu-icons";

describe("Feature: 形式を指定して開くメニュー", () => {
  // Scenario: 共有カタログから代表形式を表示する
  // Given: ビューアー・画像・アーカイブの共有形式カタログ
  // When: 形式指定メニューを作る
  // Then: 代表拡張子を既存順で表示し、HTMLのiconもビューアー定義と一致する
  it("Scenario: 共有カタログから代表形式を表示する", () => {
    const menu = createOpenAsMenu(vi.fn());
    if (!menu.sub) throw new Error("形式指定メニューがありません");

    expect(menu.sub.map((item) => item.label)).toEqual([
      ".txt", ".md", ".csv", ".html", ".pdf", "画像", ".zip", ".7z", ".xlsx", ".xls",
    ]);
    expect(menu.sub[3].iconClass).toBe(MENU_ICON.html);
    const images = menu.sub[5];
    if (!images.sub) throw new Error("画像形式メニューがありません");
    expect(images.sub.map((item) => item.label)).toEqual([
      "自動判別", ".svg", ".png", ".jpg", ".gif", ".webp", ".bmp", ".ico", ".avif", ".apng",
    ]);
  });
});

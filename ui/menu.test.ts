// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { showMenu } from "./menu";
import { MENU_ICON } from "./menu-icons";

describe("Feature: menu", () => {
  beforeEach(() => {
    const dropdown = document.createElement("div");
    dropdown.id = "dropdown";
    document.body.replaceChildren(dropdown);
  });

  // Given: dropdownが空、親「その他」と子「削除」がある
  // When: 親→子の順にクリック
  // Then: 子表示中は親を保持し、確定後にaction1回・dropdown非表示・子要素0
  it("Scenario: 親メニューを残したままサブメニューを表示し、確定時に閉じる", () => {
    const action = vi.fn();
    const dropdown = document.getElementById("dropdown")!;

    showMenu(0, 0, [{
      label: "その他",
      sub: [{ label: "削除", action }],
    }]);

    dropdown.querySelector<HTMLElement>(".dd-item")!.click();

    expect(dropdown.hidden).toBe(false);
    expect(dropdown.querySelector<HTMLElement>(":scope > .dd-item")?.textContent).toBe("その他 ▸");
    expect(dropdown.querySelector<HTMLElement>(".dd-submenu .dd-item")?.textContent).toBe("削除");

    dropdown.querySelector<HTMLElement>(".dd-submenu .dd-item")!.click();

    expect(action).toHaveBeenCalledOnce();
    expect(dropdown.hidden).toBe(true);
    expect(dropdown.childElementCount).toBe(0);
  });

  // Given: Explorerアイコンを指定したメニュー項目がある
  // When: 共有メニューを表示する
  // Then: アイコン要素がラベルの先頭に装飾用として生成される
  it("Scenario: MenuItemのアイコンを装飾要素として描画する", () => {
    showMenu(0, 0, [{ label: "エクスプローラで開く", iconClass: MENU_ICON.explorer, action: vi.fn() }]);

    const label = document.querySelector<HTMLElement>(".dd-label")!;
    const icon = label.firstElementChild as HTMLElement;
    expect(icon.classList.contains("menu-icon")).toBe(true);
    expect(icon.classList.contains(MENU_ICON.explorer)).toBe(true);
    expect(icon.getAttribute("aria-hidden")).toBe("true");
    expect(label.textContent).toBe("エクスプローラで開く");
  });

  // Given: A→A-1、B→B-1の深いsubmenuがある
  // When: A表示後にBへ切替
  // Then: B-1を表示し、A-1を破棄
  it("Scenario: 深いサブメニューを別項目へ切り替えると古い子孫を破棄する", () => {
    showMenu(0, 0, [{
      label: "親",
      sub: [
        { label: "A", sub: [{ label: "A-1", action: vi.fn() }] },
        { label: "B", sub: [{ label: "B-1", action: vi.fn() }] },
      ],
    }]);
    const dropdown = document.getElementById("dropdown")!;

    dropdown.querySelector<HTMLElement>(":scope > .dd-item")!.click();
    const firstSubmenu = dropdown.querySelector<HTMLElement>(".dd-submenu")!;
    firstSubmenu.querySelector<HTMLElement>(".dd-item")!.click();
    expect(dropdown.querySelectorAll<HTMLElement>(".dd-submenu")[1].querySelector<HTMLElement>(".dd-item")?.textContent).toBe("A-1");

    firstSubmenu.querySelectorAll<HTMLElement>(".dd-item")[1].click();

    expect(dropdown.querySelectorAll<HTMLElement>(".dd-submenu")[1].querySelector<HTMLElement>(".dd-item")?.textContent).toBe("B-1");
    expect(dropdown.textContent).not.toContain("A-1");
  });

  // Given: contextmenu handlerが`context menu failed`をthrowする
  // When: contextmenuイベントをdispatch
  // Then: dispatchはthrowせず、console.errorにメッセージとError
  it("Scenario: コンテキストメニューの同期例外をイベントの外へ漏らさない", () => {
    const error = new Error("context menu failed");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      showMenu(0, 0, [{
        label: "項目",
        action: vi.fn(),
        onContextMenu: () => { throw error; },
      }]);
      const item = document.querySelector<HTMLElement>(".dd-item")!;

      expect(() => item.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))).not.toThrow();
      expect(log).toHaveBeenCalledWith("メニュー操作に失敗しました", error);
    } finally {
      log.mockRestore();
    }
  });
});

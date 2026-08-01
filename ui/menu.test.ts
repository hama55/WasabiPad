// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { showMenu } from "./menu";

describe("menu", () => {
  beforeEach(() => {
    const dropdown = document.createElement("div");
    dropdown.id = "dropdown";
    document.body.replaceChildren(dropdown);
  });

  it("親メニューを残したままサブメニューを表示し、確定時に閉じる", () => {
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

  it("深いサブメニューを別項目へ切り替えると古い子孫を破棄する", () => {
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

  it("コンテキストメニューの同期例外をイベントの外へ漏らさない", () => {
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

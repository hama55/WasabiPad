// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { AddressBar, pathSegments } from "./addressbar";

function addressBarFixture() {
  const host = document.createElement("div");
  host.innerHTML = [
    "addressbar", "addressbar-breadcrumb", "addressbar-back", "addressbar-forward",
    "addressbar-fav", "addressbar-save", "addressbar-save-as", "addressbar-new",
    "addressbar-find", "addressbar-open",
  ].map((id) => id === "addressbar" ? `<input id="${id}">` : `<button id="${id}"></button>`).join("");
  const ports = {
    onOpen: vi.fn(),
    onBack: vi.fn(),
    onForward: vi.fn(),
    onSave: vi.fn(),
    onSaveAs: vi.fn(),
    onNew: vi.fn(),
    onFind: vi.fn(),
    onPick: vi.fn(),
    onFavorite: vi.fn(),
  };
  return { host, ports };
}

describe("pathSegments", () => {
  it("makes every crumb an openable absolute path", () => {
    expect(pathSegments("C:\\work\\notes\\memo.txt")).toEqual([
      { label: "C:", path: "C:\\" },
      { label: "work", path: "C:\\work" },
      { label: "notes", path: "C:\\work\\notes" },
      { label: "memo.txt", path: "C:\\work\\notes\\memo.txt" },
    ]);
  });

  it("accepts forward slashes as separators", () => {
    expect(pathSegments("C:/work/memo.txt").map((s) => s.path)).toEqual([
      "C:\\", "C:\\work", "C:\\work\\memo.txt",
    ]);
  });

  it("leaves non-drive paths as a single crumb", () => {
    expect(pathSegments("")).toEqual([{ label: "", path: "" }]);
    expect(pathSegments("memo.txt")).toEqual([{ label: "memo.txt", path: "memo.txt" }]);
  });
});

describe("AddressBar navigation buttons", () => {
  it("clickを通知し、履歴の有無で無効状態を切り替える", () => {
    const { host, ports } = addressBarFixture();
    const addressbar = new AddressBar(host, ports);

    addressbar.setNavigationState({ canGoBack: true, canGoForward: false });
    host.querySelector<HTMLButtonElement>("#addressbar-back")!.click();
    host.querySelector<HTMLButtonElement>("#addressbar-forward")!.click();

    expect(ports.onBack).toHaveBeenCalledTimes(1);
    expect(ports.onForward).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLButtonElement>("#addressbar-back")!.disabled).toBe(false);
    expect(host.querySelector<HTMLButtonElement>("#addressbar-forward")!.disabled).toBe(true);
  });

  it("マウス側面ボタンのX1/X2を戻る/進むへ割り当てる", () => {
    const { host, ports } = addressBarFixture();
    new AddressBar(host, ports).setNavigationState({ canGoBack: true, canGoForward: true });

    const backEvent = new MouseEvent("auxclick", { button: 3, bubbles: true, cancelable: true });
    const forwardEvent = new MouseEvent("auxclick", { button: 4, bubbles: true, cancelable: true });
    window.dispatchEvent(backEvent);
    window.dispatchEvent(forwardEvent);

    expect(ports.onBack).toHaveBeenCalledTimes(1);
    expect(ports.onForward).toHaveBeenCalledTimes(1);
    expect(backEvent.defaultPrevented).toBe(true);
    expect(forwardEvent.defaultPrevented).toBe(true);
  });
});

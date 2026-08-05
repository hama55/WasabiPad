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

describe("Feature: pathSegments", () => {
  // Given: 入力が `C:\work\notes\memo.txt`
  // When: `pathSegments` を呼ぶ
  // Then: `C:`→`C:\`、`work`→`C:\work`、`notes`→`C:\work\notes`、`memo.txt`→`C:\work\notes\memo.txt` の4 crumb
  it("Scenario: makes every crumb an openable absolute path", () => {
    expect(pathSegments("C:\\work\\notes\\memo.txt")).toEqual([
      { label: "C:", path: "C:\\" },
      { label: "work", path: "C:\\work" },
      { label: "notes", path: "C:\\work\\notes" },
      { label: "memo.txt", path: "C:\\work\\notes\\memo.txt" },
    ]);
  });

  // Given: 入力が `C:/work/memo.txt`
  // When: `pathSegments` の各 `path` を取得
  // Then: [`C:\\`, `C:\\work`, `C:\\work\\memo.txt`]
  it("Scenario: accepts forward slashes as separators", () => {
    expect(pathSegments("C:/work/memo.txt").map((s) => s.path)).toEqual([
      "C:\\", "C:\\work", "C:\\work\\memo.txt",
    ]);
  });

  // Given: 入力が空文字と `memo.txt`
  // When: `pathSegments` を呼ぶ
  // Then: それぞれ `[{label:"",path:""}]`、`[{label:"memo.txt",path:"memo.txt"}]`
  it("Scenario: leaves non-drive paths as a single crumb", () => {
    expect(pathSegments("")).toEqual([{ label: "", path: "" }]);
    expect(pathSegments("memo.txt")).toEqual([{ label: "memo.txt", path: "memo.txt" }]);
  });
});

describe("Feature: AddressBar navigation buttons", () => {
  // Given: jsdom上のAddressBar fixtureと、戻る可・進む不可の状態
  // When: 戻る/進むボタンをクリック
  // Then: `onBack`は1回、`onForward`は未呼出し、disabledは戻る=false・進む=true
  it("Scenario: clickを通知し、履歴の有無で無効状態を切り替える", () => {
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

  // Given: 戻る/進む両方可のAddressBar
  // When: `auxclick` button=3とbutton=4をwindowへdispatch
  // Then: `onBack`と`onForward`が各1回呼ばれ、両イベントの`defaultPrevented`がtrue
  it("Scenario: マウス側面ボタンのX1/X2を戻る/進むへ割り当てる", () => {
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

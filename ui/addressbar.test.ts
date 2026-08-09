// @vitest-environment jsdom
import { readFileSync } from "node:fs";
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
    addressbar.setNavigationState({ canGoBack: false, canGoForward: false });
  });

  // Given: 戻る/進む両方可のAddressBar
  // When: `auxclick` button=3とbutton=4をwindowへdispatch
  // Then: `onBack`と`onForward`が各1回呼ばれ、両イベントの`defaultPrevented`がtrue
  it("Scenario: マウス側面ボタンのX1/X2を戻る/進むへ割り当てる", () => {
    const { host, ports } = addressBarFixture();
    const addressbar = new AddressBar(host, ports);
    addressbar.setNavigationState({ canGoBack: true, canGoForward: true });

    const backEvent = new MouseEvent("auxclick", { button: 3, bubbles: true, cancelable: true });
    const forwardEvent = new MouseEvent("auxclick", { button: 4, bubbles: true, cancelable: true });
    window.dispatchEvent(backEvent);
    window.dispatchEvent(forwardEvent);

    expect(ports.onBack).toHaveBeenCalledTimes(1);
    expect(ports.onForward).toHaveBeenCalledTimes(1);
    expect(backEvent.defaultPrevented).toBe(true);
    expect(forwardEvent.defaultPrevented).toBe(true);
    addressbar.setNavigationState({ canGoBack: false, canGoForward: false });
  });

  // Given: 履歴が空で戻る/進むの両方が無効なAddressBar
  // When: X1/X2のauxclickをwindowへdispatchする
  // Then: どちらの操作も奪わず、onBack/onForwardは呼ばれない
  it("Scenario: 履歴がないマウス側面ボタンはブラウザへの既定操作を妨げない", () => {
    const { host, ports } = addressBarFixture();
    new AddressBar(host, ports).setNavigationState({ canGoBack: false, canGoForward: false });

    const backEvent = new MouseEvent("auxclick", { button: 3, bubbles: true, cancelable: true });
    const forwardEvent = new MouseEvent("auxclick", { button: 4, bubbles: true, cancelable: true });
    window.dispatchEvent(backEvent);
    window.dispatchEvent(forwardEvent);

    expect(ports.onBack).not.toHaveBeenCalled();
    expect(ports.onForward).not.toHaveBeenCalled();
    expect(backEvent.defaultPrevented).toBe(false);
    expect(forwardEvent.defaultPrevented).toBe(false);
  });
});

describe("Feature: AddressBar breadcrumbs", () => {
  // Given: `C:\\work\\memo.txt`を入力欄に入力したAddressBar
  // When: Enterを押す
  // Then: 入力欄のパスは現在タブ用の開く通知だけを送る
  it("Scenario: 入力欄のEnterは現在タブで開く", () => {
    const { host, ports } = addressBarFixture();
    const addressbar = new AddressBar(host, ports);
    const input = host.querySelector<HTMLInputElement>("#addressbar")!;
    input.value = "C:\\work\\memo.txt";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(ports.onOpen.mock.calls).toEqual([["C:\\work\\memo.txt"]]);
    addressbar.dispose();
  });

  // Given: `C:\\work\\memo.txt` を表示中のAddressBar
  // When: `work` のパンくずをホイールボタンでクリックする
  // Then: 対象パスと新規タブ指定を `onOpen` に通知し、既定動作を抑止する
  it("Scenario: ホイールクリックしたパンくずを新規タブで開く", () => {
    const { host, ports } = addressBarFixture();
    const addressbar = new AddressBar(host, ports);
    addressbar.render("C:\\work\\memo.txt");

    const crumb = host.querySelectorAll<HTMLButtonElement>(".addressbar-crumb")[1];
    const event = new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true });
    crumb.dispatchEvent(event);

    expect(ports.onOpen).toHaveBeenCalledTimes(1);
    expect(ports.onOpen).toHaveBeenCalledWith("C:\\work", true);
    expect(event.defaultPrevented).toBe(true);
  });

  // Given: `C:\\work\\memo.txt` を表示中のAddressBar
  // When: `work` のパンくずを通常クリックする
  // Then: 新規タブ用の開く通知だけを1回送り、既定動作は維持する
  it("Scenario: 通常クリックしたパンくずを新規タブで開く", () => {
    const { host, ports } = addressBarFixture();
    const addressbar = new AddressBar(host, ports);
    addressbar.render("C:\\work\\memo.txt");

    const crumb = host.querySelectorAll<HTMLButtonElement>(".addressbar-crumb")[1];
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    crumb.dispatchEvent(event);

    expect(ports.onOpen).toHaveBeenCalledTimes(1);
    expect(ports.onOpen.mock.calls).toEqual([["C:\\work", true]]);
    expect(event.defaultPrevented).toBe(false);
  });

  // Given: ドライブ直下/末尾/非ドライブ形式のパンくず
  // When: 指定位置を通常クリックする
  // Then: どのパスでも新規タブ指定で対象パスを通知する
  it.each([
    ["C:\\work\\memo.txt", 0, "C:\\"],
    ["C:\\work\\memo.txt", 2, "C:\\work\\memo.txt"],
    ["memo.txt", 0, "memo.txt"],
  ] as const)("Scenario: path=%s のcrumbを新規タブで開く", (path, index, expected) => {
    const { host, ports } = addressBarFixture();
    const addressbar = new AddressBar(host, ports);
    addressbar.render(path);

    host.querySelectorAll<HTMLButtonElement>(".addressbar-crumb")[index].click();

    expect(ports.onOpen.mock.calls).toEqual([[expected, true]]);
    addressbar.dispose();
  });

  // Given: `C:\\work\\memo.txt` を表示中のAddressBar
  // When: パンくずへホイールボタン以外のauxclickを送る
  // Then: 新規タブ通知も既定動作の抑止も行わない
  // Examples: button = 0, 2, 3, 4
  it.each([0, 2, 3, 4])("Scenario: button=%s はホイールクリックとして扱わない", (button) => {
    const { host, ports } = addressBarFixture();
    const addressbar = new AddressBar(host, ports);
    addressbar.render("C:\\work\\memo.txt");

    const crumb = host.querySelectorAll<HTMLButtonElement>(".addressbar-crumb")[1];
    const event = new MouseEvent("auxclick", { button, bubbles: true, cancelable: true });
    crumb.dispatchEvent(event);

    expect(ports.onOpen).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  // Given: 戻る操作を受け付けるAddressBar
  // When: disposeしてからwindowへ側面ボタンを送る
  // Then: 解除後はAddressBarが操作を奪わない
  it("Scenario: disposeでwindowのナビゲーション監視を解除する", () => {
    const { host, ports } = addressBarFixture();
    const addressbar = new AddressBar(host, ports);
    addressbar.setNavigationState({ canGoBack: true, canGoForward: false });
    addressbar.dispose();

    const event = new MouseEvent("auxclick", { button: 3, bubbles: true, cancelable: true });
    window.dispatchEvent(event);

    expect(ports.onBack).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("Feature: AddressBar navigation button presentation", () => {
  // Given: アプリ本体のtopbarをDOMとして読み込む
  // When: フォルダ選択ボタンとの並び順と戻る/進むボタンの文字を確認する
  // Then: 戻る→進むがフォルダ選択の左隣に連続して配置され、矢印文字ではなくSegoe MDL2のアイコンコードを使う
  it("Scenario: 戻る/進むをアイコンとしてフォルダ選択の左側に表示する", () => {
    const html = readFileSync("index.html", "utf8");
    const page = new DOMParser().parseFromString(html, "text/html");
    const topbar = page.querySelector("#topbar")!;
    const buttons = [...topbar.querySelectorAll<HTMLButtonElement>("button")];
    const ids = buttons.map((button) => button.id);
    const backIndex = ids.indexOf("addressbar-back");
    const forwardIndex = ids.indexOf("addressbar-forward");
    const openIndex = ids.indexOf("addressbar-open");

    expect(forwardIndex).toBe(backIndex + 1);
    expect(forwardIndex).toBe(openIndex - 1);
    expect(buttons[backIndex].textContent).toBe("\uE72B");
    expect(buttons[forwardIndex].textContent).toBe("\uE72A");
    expect(buttons[backIndex].textContent).not.toBe("←");
    expect(buttons[forwardIndex].textContent).not.toBe("→");
  });
});

// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { AddressBar, pathSegments } from "./addressbar";

function addressBarFixture() {
  const host = document.createElement("div");
  host.innerHTML = [
    "addressbar", "addressbar-breadcrumb",
    "addressbar-fav", "addressbar-save", "addressbar-save-as", "addressbar-new",
    "addressbar-find", "addressbar-open",
  ].map((id) => id === "addressbar" ? `<input id="${id}">` : `<button id="${id}"></button>`).join("");
  const ports = {
    onOpen: vi.fn(),
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

describe("Feature: AddressBar breadcrumbs", () => {
  // Given: `C:\\work\\memo.txt`を入力欄に入力したAddressBar
  // When: Enterを押す
  // Then: 入力欄のパスは現在タブ用の開く通知だけを送る
  it("Scenario: 入力欄のEnterは現在タブで開く", () => {
    const { host, ports } = addressBarFixture();
    new AddressBar(host, ports);
    const input = host.querySelector<HTMLInputElement>("#addressbar")!;
    input.value = "C:\\work\\memo.txt";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(ports.onOpen.mock.calls).toEqual([["C:\\work\\memo.txt"]]);
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

});

describe("Feature: AddressBar layout", () => {
  // Given: the application's topbar markup
  // When: the address bar child order is inspected
  // Then: the favorite button is immediately to the left of the address bar
  it("Scenario: places the favorite button beside the address bar", () => {
    const html = readFileSync("index.html", "utf8");
    const page = new DOMParser().parseFromString(html, "text/html");
    const topbar = page.querySelector("#topbar")!;
    const children = [...topbar.children].map((child) => child.id);
    const favoriteIndex = children.indexOf("addressbar-fav");
    const shellIndex = children.indexOf("addressbar-shell");

    expect(favoriteIndex).toBe(shellIndex - 1);
  });
});

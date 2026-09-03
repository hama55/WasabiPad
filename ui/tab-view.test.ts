// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { RegisteredCommandMenuPorts } from "./registered-command-menu";
import { TabBarView } from "./tab-view";

function makePorts() {
  const writeClipboardText = vi.fn(async (_text: string) => {});
  const registeredCommandPorts: RegisteredCommandMenuPorts = {
    promptFields: vi.fn(async () => null as string[] | null),
    runExternalCommand: vi.fn(async () => {}),
    writeClipboardText,
  };
  return {
    onActivate: vi.fn(),
    onClose: vi.fn(),
    onNewBlank: vi.fn(),
    onKeepOnly: vi.fn(),
    onCloseRight: vi.fn(),
    onCloseSaved: vi.fn(),
    onMove: vi.fn(),
    onDetach: vi.fn(),
    onOpenInNewWindow: vi.fn(),
    onError: vi.fn(),
    revealInExplorer: vi.fn(),
    writeClipboardText,
    registeredCommandPorts,
  };
}

describe("Feature: TabBarView", () => {
  // Given: activeなファイルタブと非activeなフォルダタブ
  // When: TabBarViewへ状態を描画する
  // Then: active状態・未保存表示・タブ種別アイコン・新規タブボタンを表示する
  it("Scenario: タブバーの表示状態をDOMへ反映する", () => {
    const host = document.createElement("div");
    const ports = makePorts();
    const view = new TabBarView(host, ports);

    view.render({
      tabs: [
        { id: "file", path: "C:/memo.md", kind: "file", label: "memo.md" },
        { id: "folder", path: "C:/docs", kind: "folder", label: "docs" },
      ],
      activeId: "file",
      dirty: true,
    });

    expect(host.querySelectorAll(".doc-tab")).toHaveLength(2);
    expect(host.querySelector(".doc-tab[data-tab-id='file']")?.classList.contains("active")).toBe(true);
    expect(host.querySelector("[data-tab-id='file'] .doc-tab-label")?.textContent).toBe("● memo.md");
    expect(host.querySelector("[data-tab-id='folder'] .doc-tab-icon")?.textContent).toBe("📁");
    expect(host.querySelector(".doc-tab-add")?.getAttribute("aria-label")).toBe("新規タブ");
  });

  // Given: 描画済みのタブ
  // When: タブを中クリックする
  // Then: タブのパスをエクスプローラで開く操作だけを親へ通知する
  it("Scenario: 中クリックをエクスプローラ表示へ委譲する", async () => {
    const host = document.createElement("div");
    const ports = makePorts();
    const view = new TabBarView(host, ports);
    view.render({
      tabs: [{ id: "file", path: "C:/memo.md", kind: "file", label: "memo.md" }],
      activeId: "file",
      dirty: false,
    });

    host.querySelector<HTMLElement>(".doc-tab")!.dispatchEvent(new MouseEvent("auxclick", {
      button: 1, bubbles: true, cancelable: true,
    }));

    await vi.waitFor(() => expect(ports.revealInExplorer).toHaveBeenCalledWith("C:/memo.md", false));
    expect(ports.onClose).not.toHaveBeenCalled();
    expect(ports.onActivate).not.toHaveBeenCalled();
  });

  // Given: フォルダタブを描画し、エクスプローラ表示が失敗する
  // When: タブを中クリックする
  // Then: イベントを抑止し、フォルダ指定で呼び出し、失敗を通知する
  it("Scenario: フォルダの中クリック失敗を通知する", async () => {
    const host = document.createElement("div");
    const ports = makePorts();
    const error = new Error("explorer failed");
    ports.revealInExplorer.mockRejectedValue(error);
    const view = new TabBarView(host, ports);
    view.render({
      tabs: [{ id: "folder", path: "C:/docs", kind: "folder", label: "docs" }],
      activeId: "folder",
      dirty: false,
    });

    const event = new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true });
    host.querySelector<HTMLElement>(".doc-tab")!.dispatchEvent(event);

    await vi.waitFor(() => expect(ports.onError).toHaveBeenCalledWith(error, "エクスプローラで開けませんでした"));
    expect(event.defaultPrevented).toBe(true);
    expect(ports.revealInExplorer).toHaveBeenCalledWith("C:/docs", true);
  });

  // Given: パスを持つファイルタブを表示している
  // When: タブの右クリックメニューから新規ウィンドウで開く
  // Then: 現在のタブ情報を新規ウィンドウ操作へ渡す
  it("Scenario: タブを新規ウィンドウで開く", async () => {
    const host = document.createElement("div");
    const dropdown = document.createElement("div");
    dropdown.id = "dropdown";
    document.body.append(dropdown);
    const ports = makePorts();
    const view = new TabBarView(host, ports);
    view.render({
      tabs: [{ id: "file", path: "C:/memo.md", kind: "file", label: "memo.md" }],
      activeId: "file",
      dirty: false,
    });

    host.querySelector<HTMLElement>(".doc-tab")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "新規ウィンドウで開く")!.click();

    await vi.waitFor(() => expect(ports.onOpenInNewWindow).toHaveBeenCalledWith(expect.objectContaining({
      id: "file",
      path: "C:/memo.md",
    })));
  });

  // Feature: タブ右クリックメニューのパスコピー
  // Scenario: ファイルタブの絶対パスをクリップボードへコピーする
  // Given: writeClipboardTextが接続されたC:/work/memo.mdのファイルタブを表示している
  // When: タブの右クリックメニューで「パスをコピー」を実行する
  // Then: 既存項目の順序を保ったまま、C:/work/memo.mdをクリップボード境界へ渡す
  it("Scenario: ファイルタブの絶対パスをコピーする", async () => {
    const host = document.createElement("div");
    const dropdown = document.createElement("div");
    dropdown.id = "dropdown";
    document.body.replaceChildren(dropdown);
    const ports = makePorts();
    const view = new TabBarView(host, ports);
    view.render({
      tabs: [{ id: "file", path: "C:/work/memo.md", kind: "file", label: "memo.md" }],
      activeId: "file",
      dirty: false,
    });

    host.querySelector<HTMLElement>(".doc-tab")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));

    expect([...dropdown.querySelectorAll<HTMLElement>(".dd-label")].map((item) => item.textContent)).toEqual([
      "エクスプローラで開く",
      "新規ウィンドウで開く",
      "コマンドを登録...",
      "パスをコピー",
      "閉じる",
      "ほかのタブを閉じる",
      "右側のタブを閉じる",
      "保存済みのタブを閉じる",
    ]);
    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "パスをコピー")!.click();

    await vi.waitFor(() => expect(ports.writeClipboardText).toHaveBeenCalledWith("C:/work/memo.md"));
  });

  // Feature: タブ右クリックメニューのパスコピー
  // Scenario: フォルダタブの絶対パスをクリップボードへコピーする
  // Given: writeClipboardTextが接続されたC:/work/docsのフォルダタブを表示している
  // When: タブの右クリックメニューで「パスをコピー」を実行する
  // Then: C:/work/docsをクリップボード境界へ渡す
  it("Scenario: フォルダタブの絶対パスをコピーする", async () => {
    const host = document.createElement("div");
    const dropdown = document.createElement("div");
    dropdown.id = "dropdown";
    document.body.replaceChildren(dropdown);
    const ports = makePorts();
    const view = new TabBarView(host, ports);
    view.render({
      tabs: [{ id: "folder", path: "C:/work/docs", kind: "folder", label: "docs" }],
      activeId: "folder",
      dirty: false,
    });

    host.querySelector<HTMLElement>(".doc-tab")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "パスをコピー")!.click();

    await vi.waitFor(() => expect(ports.writeClipboardText).toHaveBeenCalledWith("C:/work/docs"));
  });

  // Feature: タブ右クリックメニューのパスコピー
  // Scenario: 無題タブではパスコピーを表示しない
  // Given: パスを持たない無題タブを表示している
  // When: 無題タブの右クリックメニューを開く
  // Then: 「パスをコピー」は表示されない
  it("Scenario: 無題タブではパスコピーを表示しない", () => {
    const host = document.createElement("div");
    const dropdown = document.createElement("div");
    dropdown.id = "dropdown";
    document.body.replaceChildren(dropdown);
    const ports = makePorts();
    const view = new TabBarView(host, ports);
    view.render({
      tabs: [{ id: "blank", path: null, kind: "blank", label: "無題" }],
      activeId: "blank",
      dirty: false,
    });

    host.querySelector<HTMLElement>(".doc-tab")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));

    expect(dropdown.textContent).not.toContain("パスをコピー");
  });

  // Feature: タブ右クリックメニューのパスコピー
  // Scenario: クリップボード書き込み失敗をタブ操作の非同期境界で通知する
  // Given: ファイルタブとwriteClipboardTextがあり、書き込みがError("clipboard failed")でrejectする
  // When: 「パスをコピー」を実行する
  // Then: パスコピー専用のエラー文言と元のErrorをonErrorへ渡す
  it("Scenario: パスコピーの非同期失敗を通知する", async () => {
    const host = document.createElement("div");
    const dropdown = document.createElement("div");
    dropdown.id = "dropdown";
    document.body.replaceChildren(dropdown);
    const ports = makePorts();
    const error = new Error("clipboard failed");
    ports.writeClipboardText.mockRejectedValueOnce(error);
    const view = new TabBarView(host, ports);
    view.render({
      tabs: [{ id: "file", path: "C:/work/memo.md", kind: "file", label: "memo.md" }],
      activeId: "file",
      dirty: false,
    });

    host.querySelector<HTMLElement>(".doc-tab")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "パスをコピー")!.click();

    await vi.waitFor(() => expect(ports.onError).toHaveBeenCalledWith(error, "パスをコピーできませんでした"));
  });

  // Feature: タブ右クリックメニューのグループ
  // Scenario: Explorerの直下へ区切り線を置く
  // Given: パスを持つファイルタブを表示している
  // When: タブの右クリックメニューを開く
  // Then: 最初の区切り線はExplorerの直後に表示される
  it("Scenario: タブメニューでもExplorerを単独の先頭グループにする", () => {
    const host = document.createElement("div");
    document.body.replaceChildren();
    const dropdown = document.createElement("div");
    dropdown.id = "dropdown";
    document.body.append(dropdown);
    const ports = makePorts();
    const view = new TabBarView(host, ports);
    view.render({
      tabs: [{ id: "file", path: "C:/memo.md", kind: "file", label: "memo.md" }],
      activeId: "file",
      dirty: false,
    });

    host.querySelector<HTMLElement>(".doc-tab")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));

    const firstSeparator = dropdown.querySelector<HTMLElement>(".dd-sep");
    expect(firstSeparator?.previousElementSibling?.textContent).toBe("エクスプローラで開く");
  });
});

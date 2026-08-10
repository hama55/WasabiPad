// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { RegisteredCommandMenuPorts } from "./registered-command-menu";
import { TabBarView } from "./tab-view";

function makePorts() {
  return {
    onActivate: vi.fn(),
    onClose: vi.fn(),
    onNewBlank: vi.fn(),
    onKeepOnly: vi.fn(),
    onCloseRight: vi.fn(),
    onCloseSaved: vi.fn(),
    onMove: vi.fn(),
    onDetach: vi.fn(),
    onError: vi.fn(),
    revealInExplorer: vi.fn(),
    registeredCommandPorts: {} as RegisteredCommandMenuPorts,
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
});

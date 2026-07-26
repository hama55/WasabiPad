// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "./sidebar";

describe("Sidebar workspace search", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("検索結果がない場合に除外条件を表示する", async () => {
    vi.useFakeTimers();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const sidebar = new Sidebar(host, {
      onSelect: () => {},
      onContextMenu: () => {},
      onExpandArchive: async () => [],
      onExpandFolder: async () => [],
      onWorkspaceSearch: async () => [],
      onSearchResult: () => {},
    });
    sidebar.setWorkspaceSearch(true);
    const input = host.querySelector<HTMLInputElement>(".ws-search > input")!;
    input.value = "missing";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(150);

    expect(host.querySelector(".ws-empty")?.textContent).toContain("見つかりません");
    expect(host.querySelector(".ws-empty-detail")?.textContent).toContain("16 MB超");
    expect(host.querySelector(".ws-empty-detail")?.textContent).toContain(".git / node_modules / target");
  });
});

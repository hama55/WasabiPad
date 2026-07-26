// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sidebar, type SidebarPorts } from "./sidebar";
import type { WorkspaceSearchOptions } from "./api";

describe("Sidebar workspace search", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
    localStorage.clear();
  });

  function mount(onWorkspaceSearch: SidebarPorts["onWorkspaceSearch"] = async () => []) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const sidebar = new Sidebar(host, {
      onSelect: () => {},
      onContextMenu: () => {},
      onExpandArchive: async () => [],
      onExpandFolder: async () => [],
      onWorkspaceSearch,
      onSearchResult: () => {},
    });
    sidebar.setWorkspaceSearch(true);
    return host;
  }

  async function search(host: HTMLElement, pattern: string) {
    const input = host.querySelector<HTMLInputElement>(".ws-search-row > input")!;
    input.value = pattern;
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(150);
  }

  it("検索結果がない場合に現在の検索条件を表示する", async () => {
    vi.useFakeTimers();
    const host = mount();
    await search(host, "missing");

    expect(host.querySelector(".ws-empty")?.textContent).toContain("見つかりません");
    expect(host.querySelector(".ws-empty-detail")?.textContent).toContain("16 MB超");
    expect(host.querySelector(".ws-empty-detail")?.textContent).toContain(".git / node_modules / target");
  });

  it("設定パネルの変更が検索条件と説明に反映される", async () => {
    vi.useFakeTimers();
    const calls: WorkspaceSearchOptions[] = [];
    const host = mount(async (_pat, options) => { calls.push(options); return []; });

    host.querySelector<HTMLButtonElement>(".ws-search-settings")!.click();
    const excludeGit = [...host.querySelectorAll<HTMLInputElement>(".ws-search-section input[type=checkbox]")]
      .find((input) => input.parentElement?.textContent === ".git")!;
    excludeGit.checked = false;
    excludeGit.dispatchEvent(new Event("change"));
    await search(host, "missing");

    expect(calls.at(-1)?.exclude_dirs).toEqual(["node_modules", "target"]);
    expect(host.querySelector(".ws-empty-detail")?.textContent).not.toContain(".git");
  });
});

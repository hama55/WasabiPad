// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { Sidebar, type SidebarPorts } from "./sidebar";
import { DEFAULT_SEARCH_OPTIONS } from "./workspace-search-options";

function mount() {
  const host = document.createElement("div");
  document.body.replaceChildren(host);
  const ports = {
    onSelect: vi.fn(),
    onContextMenu: vi.fn(),
    onExpandArchive: vi.fn(async () => []),
    onExpandFolder: vi.fn(async () => []),
    onTreeError: vi.fn(async () => {}),
    onSearch: vi.fn(async () => ({
      results: [], scanned_files: 0, hit_file_limit: false, hit_result_limit: false,
      pattern_error: null, file_name_match_mode: "strict" as const,
    })),
    onCancel: vi.fn(),
    onError: vi.fn(async () => {}),
    onOpen: vi.fn(),
    onOptionsChange: vi.fn(),
  } satisfies SidebarPorts;
  return { host, ports, sidebar: new Sidebar(host, ports, DEFAULT_SEARCH_OPTIONS) };
}

describe("Sidebar", () => {
  it("フォーカス中の上下キーで可視行を選択する", () => {
    const { host, sidebar } = mount();
    sidebar.setEntries([
      { name: "first.txt", is_dir: false, is_archive: false },
      { name: "second.txt", is_dir: false, is_archive: false },
    ]);
    const tree = host.querySelector<HTMLElement>("[tabindex=\"0\"]")!;
    tree.focus();
    tree.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(host.querySelector(".fv-row.sel")?.textContent).toContain("first.txt");

    tree.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(host.querySelector(".fv-row.sel")?.textContent).toContain("second.txt");

    tree.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(host.querySelector(".fv-row.sel")?.textContent).toContain("first.txt");
  });
});

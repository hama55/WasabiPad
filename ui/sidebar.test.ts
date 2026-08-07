// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sidebar, type SidebarPorts } from "./sidebar";
import { DEFAULT_SEARCH_OPTIONS } from "./workspace-search-options";
import type { FolderEntry } from "./api";

function mount(onSearch: SidebarPorts["onSearch"] = vi.fn(async () => ({
  results: [], scanned_files: 0, hit_file_limit: false, hit_result_limit: false,
  pattern_error: null, file_name_match_mode: "strict" as const,
}))) {
  const host = document.createElement("div");
  document.body.replaceChildren(host);
  const ports = {
    onSelect: vi.fn(),
    onContextMenu: vi.fn(),
    onExpandArchive: vi.fn(async () => []),
    onExpandFolder: vi.fn(async (): Promise<FolderEntry[]> => []),
    onTreeError: vi.fn(async () => {}),
    onSearch,
    onCancel: vi.fn(),
    onError: vi.fn(async () => {}),
    onOpen: vi.fn(),
    onOptionsChange: vi.fn(),
  } satisfies SidebarPorts;
  return { host, ports, sidebar: new Sidebar(host, ports, DEFAULT_SEARCH_OPTIONS) };
}

describe("Feature: Sidebar", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  // Given: `first.txt`と`second.txt`を設定し、tree要素にフォーカス
  // When: ArrowDown、ArrowDown、ArrowUpを順に送る
  // Then: 選択行は`first.txt`→`second.txt`→`first.txt`
  it("Scenario: フォーカス中の上下キーで可視行を選択する", () => {
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

  // Given: dir/a.txt を含むツリーで、dir の展開取得が保留中
  // When: a.txt の選択処理中に別の一覧を設定してから取得を解決する
  // Then: 古い選択処理は新しい一覧へ選択色や古い行を混入させない
  it("Scenario: 非同期な古い選択処理が新しい一覧を上書きしない", async () => {
    const { host, ports, sidebar } = mount();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    ports.onExpandFolder.mockImplementation(async () => {
      await gate;
      return [{ name: "a.txt", is_dir: false, is_archive: false }];
    });
    sidebar.setEntries([{ name: "dir", is_dir: true, is_archive: false }]);

    const selecting = sidebar.selectByRelPath("dir/a.txt");
    await Promise.resolve();
    sidebar.setEntries([{ name: "other.txt", is_dir: false, is_archive: false }]);
    release();
    await selecting;

    expect(host.querySelector(".fv-row.sel")).toBeNull();
    expect(host.querySelector(".fv-row")?.textContent).toContain("other.txt");
  });

  // Given: 検索結果ツリーを表示中に a.txt を開いたことを通常ツリーの状態へ記録する
  // When: 検索表示を閉じて通常ツリーへ戻る
  // Then: a.txt が通常ツリーでも選択済み色になる
  it("Scenario: 検索中に開いたファイルの選択を通常ツリーへ同期する", async () => {
    vi.useFakeTimers();
    const { host, sidebar } = mount();
    sidebar.setEntries([{ name: "a.txt", is_dir: false, is_archive: false }]);
    sidebar.setWorkspaceSearch("C:\\workspace");
    const input = host.querySelector<HTMLInputElement>(".ws-search-row > input")!;
    input.value = "needle";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(150);

    await sidebar.selectByRelPath("a.txt");
    sidebar.setWorkspaceSearch(null);

    expect(host.querySelector(".fv-row.sel")?.textContent).toContain("a.txt");
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({
  loadSettings: async () => "{}",
  saveSettings: async () => {},
}));

import { Sidebar, type SidebarPorts } from "./sidebar";
import type { WorkspaceSearchOptions, WorkspaceSearchOutcome, WorkspaceSearchResult } from "./api";
import { initSettings } from "./settings";

const hit = (rel_path: string, line: number, preview: string): WorkspaceSearchResult =>
  ({ rel_path, line, col: 0, preview, is_filename: false });

const outcome = (
  results: WorkspaceSearchResult[],
  extra: Partial<WorkspaceSearchOutcome> = {}
): WorkspaceSearchOutcome => ({
  results,
  scanned_files: results.length,
  hit_file_limit: false,
  hit_result_limit: false,
  ...extra,
});

describe("Sidebar workspace search", () => {
  afterEach(async () => {
    vi.useRealTimers();
    document.body.replaceChildren();
    await initSettings(); // 検索オプションの保存値を持ち越さない
  });

  function mount(
    onWorkspaceSearch: SidebarPorts["onWorkspaceSearch"] = async () => outcome([]),
    onSearchResult: SidebarPorts["onSearchResult"] = () => {}
  ) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const sidebar = new Sidebar(host, {
      onSelect: () => {},
      onContextMenu: () => {},
      onExpandArchive: async () => [],
      onExpandFolder: async () => [],
      onWorkspaceSearch,
      onCancelSearch: () => {},
      onSearchResult,
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

  const text = (host: HTMLElement, selector: string) => host.querySelector(selector)?.textContent ?? "";

  it("検索結果がない場合に現在の検索条件を表示する", async () => {
    vi.useFakeTimers();
    const host = mount();
    await search(host, "missing");

    expect(text(host, ".ws-empty")).toContain("見つかりません");
    expect(text(host, ".ws-empty-detail")).toContain("バイナリファイル");
    expect(text(host, ".ws-empty-detail")).toContain(".git / .svn / node_modules");
    // 既定は無制限なので、サイズや件数を対象外として読み上げてはいけない
    expect(text(host, ".ws-empty-detail")).not.toContain("MB超");
    expect(text(host, ".ws-empty-detail")).not.toContain("件目以降");
  });

  it("結果をファイル単位のツリーにまとめ、一致箇所を強調する", async () => {
    vi.useFakeTimers();
    const host = mount(async () => outcome([
      hit("core/src/a.rs", 0, "let x = needle;"),
      hit("core/src/a.rs", 4, "needle again"),
      hit("b.txt", 9, "a needle here"),
    ]));
    await search(host, "needle");

    const groups = [...host.querySelectorAll(".ws-group")];
    expect(groups.map((group) => group.querySelector(".ws-file")?.textContent)).toEqual(["a.rs", "b.txt"]);
    expect(groups[0].querySelector(".ws-dir")?.textContent).toBe("core/src");
    expect(groups[0].querySelector(".ws-count")?.textContent).toBe("2");
    expect(host.querySelectorAll(".ws-match")).toHaveLength(3);
    expect(text(host, ".ws-summary")).toContain("2 個のファイルに 3 件の結果");
    expect(host.querySelector(".ws-match mark")?.textContent).toBe("needle");
  });

  it("見出しのクリックでその ファイルの一致行だけを畳む", async () => {
    vi.useFakeTimers();
    const host = mount(async () => outcome([
      hit("a.txt", 0, "needle"),
      hit("b.txt", 0, "needle"),
    ]));
    await search(host, "needle");

    host.querySelector<HTMLElement>(".ws-group")!.click();
    expect(host.querySelectorAll(".ws-match")).toHaveLength(1);
  });

  it("ホイールクリックは別ウィンドウで開く依頼になる", async () => {
    vi.useFakeTimers();
    const opened: boolean[] = [];
    const host = mount(
      async () => outcome([hit("a.txt", 3, "needle")]),
      (_result, _pattern, newWindow) => opened.push(newWindow)
    );
    await search(host, "needle");

    const match = host.querySelector<HTMLElement>(".ws-match")!;
    match.click();
    match.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true }));
    expect(opened).toEqual([false, true]);
  });

  it("上限で打ち切ったことを黙らずに表示する", async () => {
    vi.useFakeTimers();
    const host = mount(async () => outcome([hit("a.txt", 0, "needle")], {
      hit_file_limit: true,
      hit_result_limit: true,
    }));
    await search(host, "needle");

    const warnings = [...host.querySelectorAll(".ws-warning")].map((el) => el.textContent);
    expect(warnings).toEqual(["最大ファイル数で列挙を打ち切った", "最大結果数で検索を打ち切った"]);
  });

  it("設定ダイアログでの除外フォルダの変更が検索条件と説明に反映される", async () => {
    vi.useFakeTimers();
    const calls: WorkspaceSearchOptions[] = [];
    const host = mount(async (_pat, options) => {
      calls.push(options);
      return outcome([]);
    });
    await search(host, "missing");

    host.querySelector<HTMLButtonElement>(".ws-settings")!.click();
    const row = [...document.querySelectorAll(".ss-dir-row")]
      .find((el) => el.querySelector("span")?.textContent === ".git")!;
    row.querySelector("button")!.click();
    document.querySelector<HTMLButtonElement>(".ss-box .pf-ok")!.click();
    await vi.advanceTimersByTimeAsync(150);

    expect(calls.at(-1)?.exclude_dirs).not.toContain(".git");
    expect(calls.at(-1)?.exclude_dirs).toContain("node_modules");
    expect(text(host, ".ws-empty-detail")).not.toContain(".git");
  });

  it("Aa ボタンで大文字小文字の区別を切り替える", async () => {
    vi.useFakeTimers();
    const calls: WorkspaceSearchOptions[] = [];
    const host = mount(async (_pat, options) => {
      calls.push(options);
      return outcome([]);
    });
    await search(host, "missing");
    expect(calls.at(-1)?.match_case).toBe(false);

    host.querySelector<HTMLButtonElement>(".ws-toggle")!.click();
    await vi.advanceTimersByTimeAsync(150);
    expect(calls.at(-1)?.match_case).toBe(true);
  });
});

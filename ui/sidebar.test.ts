// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({
  loadSettings: async () => "{}",
  saveSettings: async () => {},
}));

import { Sidebar, type SidebarPorts } from "./sidebar";
import type { WorkspaceSearchOptions, WorkspaceSearchOutcome, WorkspaceSearchResult } from "./api";
import { initSettings } from "./settings";

const hit = (
  rel_path: string,
  line: number,
  preview: string,
  highlights: [number, number][] = []
): WorkspaceSearchResult => ({
  rel_path,
  line,
  col: 0,
  preview,
  highlights,
  is_filename: false,
  score: 0,
});

const outcome = (
  results: WorkspaceSearchResult[],
  extra: Partial<WorkspaceSearchOutcome> = {}
): WorkspaceSearchOutcome => ({
  results,
  scanned_files: results.length,
  hit_file_limit: false,
  hit_result_limit: false,
  pattern_error: null,
  ...extra,
});

describe("Sidebar workspace search", () => {
  let mounted: Sidebar; // 途中経過を流し込むために直近の実体を握っておく

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
    const sidebar = (mounted = new Sidebar(host, {
      onSelect: () => {},
      onContextMenu: () => {},
      onExpandArchive: async () => [],
      onExpandFolder: async () => [],
      onWorkspaceSearch,
      onCancelSearch: () => {},
      onSearchResult,
    }));
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
    expect(text(host, ".ws-empty-detail")).toContain("*.min.js");
    // 既定は無制限なので、サイズや件数を対象外として読み上げてはいけない
    expect(text(host, ".ws-empty-detail")).not.toContain("MB超");
    expect(text(host, ".ws-empty-detail")).not.toContain("件目以降");
  });

  it("結果をファイル単位のツリーにまとめ、一致箇所を強調する", async () => {
    vi.useFakeTimers();
    const host = mount(async () => outcome([
      hit("core/src/a.rs", 0, "let x = needle;", [[8, 6]]),
      hit("core/src/a.rs", 4, "needle again", [[0, 6]]),
      hit("b.txt", 9, "a needle here", [[2, 6]]),
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

  it("検索の設定を何も変えずに閉じても、走査中の結果を捨てない", async () => {
    vi.useFakeTimers();
    let searchId = 0;
    let calls = 0;
    const host = mount((_pat, _options, id) => {
      searchId = id;
      calls += 1;
      return new Promise<WorkspaceSearchOutcome>(() => {}); // 走査中のまま止めておく
    });
    await search(host, "needle");
    mounted.acceptSearchBatch(searchId, [hit("a.txt", 0, "needle")]);
    await vi.advanceTimersByTimeAsync(100);
    expect(host.querySelectorAll(".ws-group")).toHaveLength(1);

    host.querySelector<HTMLButtonElement>(".ws-settings")!.click();
    document.querySelector<HTMLButtonElement>(".ss-box .pf-ok")!.click();
    await vi.advanceTimersByTimeAsync(150);

    expect(host.querySelectorAll(".ws-group")).toHaveLength(1);
    expect(calls, "条件が同じなら検索し直さない").toBe(1);
  });

  it("検索中でも折りたたみを操作でき、途中経過の到着で戻されない", async () => {
    vi.useFakeTimers();
    let searchId = 0;
    let finish: (found: WorkspaceSearchOutcome) => void = () => {};
    const host = mount((_pat, _options, id) => {
      searchId = id;
      return new Promise<WorkspaceSearchOutcome>((resolve) => { finish = resolve; });
    });
    await search(host, "needle");
    mounted.acceptSearchBatch(searchId, [hit("a.txt", 0, "needle"), hit("b.txt", 0, "needle")]);
    await vi.advanceTimersByTimeAsync(100);
    expect(host.querySelectorAll(".ws-match")).toHaveLength(2);

    host.querySelector<HTMLButtonElement>(".ws-fold")!.click();
    expect(host.querySelectorAll(".ws-match")).toHaveLength(0);
    expect(host.querySelectorAll(".ws-group")).toHaveLength(2);

    // 続きが届いても畳んだままにする (押した直後に開き直されない)
    mounted.acceptSearchBatch(searchId, [hit("c.txt", 0, "needle")]);
    await vi.advanceTimersByTimeAsync(100);
    expect(host.querySelectorAll(".ws-match")).toHaveLength(0);

    // 確定しても手で決めた状態を保つ
    finish(outcome([hit("a.txt", 0, "needle"), hit("b.txt", 0, "needle")]));
    await vi.advanceTimersByTimeAsync(0);
    expect(host.querySelectorAll(".ws-match")).toHaveLength(0);
  });

  it("検索中でも届いた分から並べ、確定したら backend の並びで置き換える", async () => {
    vi.useFakeTimers();
    let searchId = 0;
    let finish: (found: WorkspaceSearchOutcome) => void = () => {};
    const host = mount((_pat, _options, id) => {
      searchId = id;
      return new Promise<WorkspaceSearchOutcome>((resolve) => { finish = resolve; });
    });
    await search(host, "needle");

    // 届いた順ではなく、確定結果と同じ並びで見せる (終わった瞬間に並びが飛ばないように)
    mounted.acceptSearchBatch(searchId, [hit("z.txt", 0, "needle")]);
    mounted.acceptSearchBatch(searchId, [hit("a.txt", 0, "needle")]);
    await vi.advanceTimersByTimeAsync(100);
    expect([...host.querySelectorAll(".ws-file")].map((el) => el.textContent)).toEqual([
      "a.txt",
      "z.txt",
    ]);
    expect(text(host, ".ws-summary")).toContain("検索中");

    // 打ち切った検索の取りこぼしが混ざってはいけない
    mounted.acceptSearchBatch(searchId - 1, [hit("m.txt", 0, "needle")]);
    await vi.advanceTimersByTimeAsync(100);
    expect(host.querySelectorAll(".ws-file")).toHaveLength(2);

    finish(outcome([hit("b.txt", 0, "needle")]));
    await vi.advanceTimersByTimeAsync(0);
    expect([...host.querySelectorAll(".ws-file")].map((el) => el.textContent)).toEqual(["b.txt"]);
    expect(text(host, ".ws-summary")).not.toContain("検索中");
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

  it("入力欄のトグルが検索条件へそのまま渡る", async () => {
    vi.useFakeTimers();
    const calls: WorkspaceSearchOptions[] = [];
    const host = mount(async (_pat, options) => {
      calls.push(options);
      return outcome([]);
    });
    await search(host, "missing");
    expect(calls.at(-1)).toMatchObject({ match_case: false, whole_word: false, use_regex: false });

    const toggles = [...host.querySelectorAll<HTMLButtonElement>(".ws-toggle")];
    // 「どこを探すか」はヘッダ、「どう当てるか」は入力欄の中
    expect(toggles.map((button) => button.textContent)).toEqual(["名", "文", "Aa", "ab", ".*"]);
    const byLabel = (label: string) => toggles.find((button) => button.textContent === label)!;
    byLabel("Aa").click();
    byLabel(".*").click();
    await vi.advanceTimersByTimeAsync(150);
    expect(calls.at(-1)).toMatchObject({ match_case: true, use_regex: true, whole_word: false });
    expect(byLabel("Aa").classList.contains("on")).toBe(true);
    expect(byLabel("ab").classList.contains("on")).toBe(false);
  });

  it("正規表現が壊れている間は件数ではなく理由を出す", async () => {
    vi.useFakeTimers();
    const host = mount(async () => outcome([], { pattern_error: "検索パターンが不正: unclosed group" }));
    await search(host, "need(");

    expect(text(host, ".ws-warning")).toContain("unclosed group");
    expect(host.querySelector(".ws-empty")).toBeNull();
    expect(text(host, ".ws-summary")).toBe("");
  });
});

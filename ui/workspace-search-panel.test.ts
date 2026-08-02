// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

// 検索窓は IPC も設定の保存先も知らない (条件は渡されたものを使う) ため、
// ./api のモックは要らない。要るようになったら依存が逆流している。
import { WorkspaceSearchPanel, type WorkspaceSearchPorts } from "./workspace-search-panel";
import type { WorkspaceSearchOptions, WorkspaceSearchOutcome, WorkspaceSearchResult } from "./api";
import { DEFAULT_SEARCH_OPTIONS } from "./workspace-search-options";

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
  file_name_match_mode: "fuzzy",
  ...extra,
});

describe("WorkspaceSearchPanel", () => {
  let mounted: WorkspaceSearchPanel; // 途中経過を流し込むために直近の実体を握っておく

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  function mount(
    onSearch: WorkspaceSearchPorts["onSearch"] = async () => outcome([]),
    onOpen: WorkspaceSearchPorts["onOpen"] = () => {},
    onCancel: WorkspaceSearchPorts["onCancel"] = () => {},
    onError: WorkspaceSearchPorts["onError"] = async () => {}
  ) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const tree = document.createElement("div"); // 結果の置き場は呼び出し側が用意する
    const panel = (mounted = new WorkspaceSearchPanel({ ...DEFAULT_SEARCH_OPTIONS }, {
      onSearch,
      onCancel,
      onError,
      onOpen,
      onContextMenu: () => {},
      onOptionsChange: () => {},
      onViewChange: () => {
        tree.replaceChildren(...(panel.showing ? [panel.renderTree()] : []));
      },
    }));
    host.append(panel.bar, tree);
    panel.setFolderRoot("C:\\workspace");
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

  it("検索失敗時は検索中表示を解除してエラーを渡す", async () => {
    vi.useFakeTimers();
    const onError = vi.fn(async () => {});
    const host = mount(async () => { throw new Error("IPC disconnected"); }, () => {}, () => {}, onError);

    await search(host, "needle");

    expect(onError).toHaveBeenCalledOnce();
    expect(host.querySelector<HTMLButtonElement>(".ws-stop")?.hidden).toBe(true);
    expect(host.querySelector(".ws-empty")).toBeNull();
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
    // 見出しはパス順 ("b.txt" < "core/src/a.rs")。backend の返す順には依らない
    expect(groups.map((group) => group.querySelector(".ws-file")?.textContent)).toEqual(["b.txt", "a.rs"]);
    expect(groups[1].querySelector(".ws-dir")?.textContent).toBe("core/src");
    expect(groups[1].querySelector(".ws-count")?.textContent).toBe("2");
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
      (_result, newTab) => opened.push(newTab)
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

  it("条件を変えたら走行中の検索を止める", async () => {
    vi.useFakeTimers();
    let cancels = 0;
    const host = mount(
      () => new Promise<WorkspaceSearchOutcome>(() => {}), // 走査中のまま止めておく
      () => {},
      () => { cancels += 1; }
    );
    await search(host, "needle");
    expect(cancels).toBe(0);

    // 1文字足す / トグルを触る、どちらも走行中の検索を捨てると決めた瞬間
    await search(host, "needles");
    expect(cancels).toBe(1);
    host.querySelector<HTMLButtonElement>(".ws-toggle")!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(cancels).toBe(2);
  });

  it("条件が変わったら、走行中のものを畳んでから新しい条件で引き直す", async () => {
    vi.useFakeTimers();
    const calls: WorkspaceSearchOptions[] = [];
    let stopFirst: () => void = () => {};
    const host = mount(
      (_pat, options) => {
        calls.push(options);
        if (calls.length > 1) return Promise.resolve(outcome([hit("a.txt", 0, "needle")]));
        // 1本目は中止されるまで終わらない (backend の走査に相当)
        return new Promise<WorkspaceSearchOutcome>((resolve) => {
          stopFirst = () => resolve(outcome([]));
        });
      },
      () => {},
      () => stopFirst()
    );
    await search(host, "needle");
    expect(calls).toHaveLength(1);
    expect(calls[0].match_case).toBe(false);

    host.querySelector<HTMLButtonElement>(".ws-search-row .ws-toggle")!.click(); // Aa
    await vi.advanceTimersByTimeAsync(150);

    expect(calls).toHaveLength(2);
    expect(calls[1].match_case, "新しい条件で最初から引き直す").toBe(true);
    expect(text(host, ".ws-summary")).toContain("1 件の結果");
  });

  it("取消に失敗しても新しい条件の検索を古いPromise待ちにしない", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const host = mount(
      (pat) => {
        calls.push(pat);
        return calls.length === 1
          ? new Promise<WorkspaceSearchOutcome>(() => {})
          : Promise.resolve(outcome([hit("a.txt", 0, "needles")]));
      },
      () => {},
      async () => { throw new Error("cancel failed"); },
    );

    await search(host, "needle");
    await search(host, "needles");

    expect(calls).toEqual(["needle", "needles"]);
    expect(text(host, ".ws-summary")).toContain("1 件の結果");
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
    mounted.acceptBatch(searchId, [hit("a.txt", 0, "needle")]);
    await vi.advanceTimersByTimeAsync(100);
    expect(host.querySelectorAll(".ws-group")).toHaveLength(1);

    host.querySelector<HTMLButtonElement>(".ws-settings")!.click();
    document.querySelector<HTMLButtonElement>(".ss-box .pf-ok")!.click();
    await vi.advanceTimersByTimeAsync(150);

    expect(host.querySelectorAll(".ws-group")).toHaveLength(1);
    expect(calls, "条件が同じなら検索し直さない").toBe(1);
  });

  it("検索を中止しても、届いていた結果は残す", async () => {
    vi.useFakeTimers();
    let searchId = 0;
    const onCancel = vi.fn();
    const host = mount((_pat, _options, id) => {
      searchId = id;
      return new Promise<WorkspaceSearchOutcome>(() => {});
    }, () => {}, onCancel);
    await search(host, "needle");
    mounted.acceptBatch(searchId, [hit("a.txt", 0, "needle")]);
    await vi.advanceTimersByTimeAsync(100);

    host.querySelector<HTMLButtonElement>(".ws-stop")!.click();

    expect(onCancel).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledWith(searchId);
    expect(host.querySelectorAll(".ws-group")).toHaveLength(1);
    expect(text(host, ".ws-summary")).toContain("検索を中止");
    expect(text(host, ".ws-empty")).toContain("検索を中止しました");
  });

  it("フォルダごとに検索結果を保持する", async () => {
    vi.useFakeTimers();
    const host = mount(async () => outcome([hit("a.txt", 0, "needle")]));
    await search(host, "needle");

    mounted.setFolderRoot("C:\\other");
    expect(host.querySelectorAll(".ws-group")).toHaveLength(0);

    mounted.setFolderRoot("C:\\workspace");
    expect(host.querySelectorAll(".ws-group")).toHaveLength(1);
    expect(host.querySelector<HTMLInputElement>(".ws-search-row > input")?.value).toBe("needle");

    mounted.setFolderRoot(null);
    mounted.setFolderRoot("C:\\workspace");
    expect(host.querySelectorAll(".ws-group")).toHaveLength(1);
  });

  it("検索をクリアしたら、停止済みの結果も消す", async () => {
    vi.useFakeTimers();
    let searchId = 0;
    const host = mount((_pat, _options, id) => {
      searchId = id;
      return new Promise<WorkspaceSearchOutcome>(() => {});
    });
    await search(host, "needle");
    mounted.acceptBatch(searchId, [hit("a.txt", 0, "needle")]);
    await vi.advanceTimersByTimeAsync(100);

    host.querySelector<HTMLButtonElement>(".ws-clear")!.click();

    expect(host.querySelectorAll(".ws-group")).toHaveLength(0);
    expect(host.querySelector<HTMLInputElement>(".ws-search-row > input")?.value).toBe("");
  });

  it("結果が届く前に中止しても、中止状態を表示する", async () => {
    vi.useFakeTimers();
    const host = mount(() => new Promise<WorkspaceSearchOutcome>(() => {}));
    await search(host, "needle");

    host.querySelector<HTMLButtonElement>(".ws-stop")!.click();

    expect(text(host, ".ws-empty")).toContain("検索を中止しました");
    expect(text(host, ".ws-empty")).not.toContain("検索中");
    expect(host.querySelector<HTMLButtonElement>(".ws-stop")?.hidden).toBe(true);
  });

  it("中止通知が同期失敗しても、表示済みの結果を保持する", async () => {
    vi.useFakeTimers();
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    let searchId = 0;
    const onCancel = vi.fn(() => { throw new Error("cancel IPC failed"); });
    const host = mount((_pat, _options, id) => {
      searchId = id;
      return new Promise<WorkspaceSearchOutcome>(() => {});
    }, () => {}, onCancel);
    await search(host, "needle");
    mounted.acceptBatch(searchId, [hit("a.txt", 0, "needle")]);
    await vi.advanceTimersByTimeAsync(100);

    host.querySelector<HTMLButtonElement>(".ws-stop")!.click();

    expect(onCancel).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledOnce();
    expect(host.querySelectorAll(".ws-group")).toHaveLength(1);
    expect(text(host, ".ws-empty")).toContain("検索を中止しました");
  });

  it("検索開始の同期失敗でも、検索中の表示を残さない", async () => {
    vi.useFakeTimers();
    const onError = vi.fn(async () => {});
    const host = mount(() => { throw new Error("IPC setup failed"); }, () => {}, () => {}, onError);

    await search(host, "needle");

    expect(onError).toHaveBeenCalledOnce();
    expect(host.querySelector<HTMLButtonElement>(".ws-stop")?.hidden).toBe(true);
    expect(host.querySelector(".ws-empty")).toBeNull();
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
    mounted.acceptBatch(searchId, [hit("a.txt", 0, "needle"), hit("b.txt", 0, "needle")]);
    await vi.advanceTimersByTimeAsync(100);
    expect(host.querySelectorAll(".ws-match")).toHaveLength(2);

    host.querySelector<HTMLButtonElement>(".ws-fold")!.click();
    expect(host.querySelectorAll(".ws-match")).toHaveLength(0);
    expect(host.querySelectorAll(".ws-group")).toHaveLength(2);

    // 続きが届いても畳んだままにする (押した直後に開き直されない)
    mounted.acceptBatch(searchId, [hit("c.txt", 0, "needle")]);
    await vi.advanceTimersByTimeAsync(100);
    expect(host.querySelectorAll(".ws-match")).toHaveLength(0);

    // 確定しても手で決めた状態を保つ
    finish(outcome([hit("a.txt", 0, "needle"), hit("b.txt", 0, "needle")]));
    await vi.advanceTimersByTimeAsync(0);
    expect(host.querySelectorAll(".ws-match")).toHaveLength(0);
  });

  it("途中経過も確定結果も、届いた順ではなく同じ規則で並べる", async () => {
    vi.useFakeTimers();
    let searchId = 0;
    let finish: (found: WorkspaceSearchOutcome) => void = () => {};
    const host = mount((_pat, _options, id) => {
      searchId = id;
      return new Promise<WorkspaceSearchOutcome>((resolve) => { finish = resolve; });
    });
    await search(host, "needle");

    // 届いた順ではなく、確定結果と同じ並びで見せる (終わった瞬間に並びが飛ばないように)
    mounted.acceptBatch(searchId, [hit("z.txt", 0, "needle")]);
    mounted.acceptBatch(searchId, [hit("a.txt", 0, "needle")]);
    await vi.advanceTimersByTimeAsync(100);
    expect([...host.querySelectorAll(".ws-file")].map((el) => el.textContent)).toEqual([
      "a.txt",
      "z.txt",
    ]);
    expect(text(host, ".ws-summary")).toContain("検索中");

    // 打ち切った検索の取りこぼしが混ざってはいけない
    mounted.acceptBatch(searchId - 1, [hit("m.txt", 0, "needle")]);
    await vi.advanceTimersByTimeAsync(100);
    expect(host.querySelectorAll(".ws-file")).toHaveLength(2);

    // 確定結果は走査順で届く。並べるのは表示側の仕事なので、ここでも並べ直す
    finish(outcome([hit("z.txt", 0, "needle"), hit("b.txt", 0, "needle")]));
    await vi.advanceTimersByTimeAsync(0);
    expect([...host.querySelectorAll(".ws-file")].map((el) => el.textContent)).toEqual([
      "b.txt",
      "z.txt",
    ]);
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

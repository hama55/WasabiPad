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

describe("Feature: WorkspaceSearchPanel", () => {
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

  // Given: 既定設定で C:\workspace を検索ルートにし、onSearch が空の outcome を返す
  // When: 検索語 missing を入力して検索する
  // Then: empty に「見つかりません」、説明に「バイナリファイル」「.git / .svn / node_modules」「*.min.js」が表示され、MB超と件目以降は表示されない
  it("Scenario: 検索結果がない場合に現在の検索条件を表示する", async () => {
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

  // Given: onSearch が非同期に Error("IPC disconnected") を reject し、onError を spy する
  // When: needle を検索する
  // Then: onError は1回呼ばれ、停止ボタンは hidden=true、empty 要素は存在しない
  it("Scenario: 検索失敗時は検索中表示を解除してエラーを渡す", async () => {
    vi.useFakeTimers();
    const onError = vi.fn(async () => {});
    const host = mount(async () => { throw new Error("IPC disconnected"); }, () => {}, () => {}, onError);

    await search(host, "needle");

    expect(onError).toHaveBeenCalledOnce();
    expect(host.querySelector<HTMLButtonElement>(".ws-stop")?.hidden).toBe(true);
    expect(host.querySelector(".ws-empty")).toBeNull();
  });

  // Given: core/src/a.rs の line0/line4 と b.txt の line9 に needle の一致結果を返す
  // When: needle を検索する
  // Then: file 見出しは ["b.txt","a.rs"]、a.rs の dir は core/src、件数は2、match は3個、summary は「2 個のファイルに 3 件の結果」、mark は needle
  it("Scenario: 結果をファイル単位のツリーにまとめ、一致箇所を強調する", async () => {
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

  // Given: a.txt と b.txt に各1件の needle 結果がある
  // When: 検索後に最初の .ws-group をクリックする
  // Then: クリックしたファイルの一致行だけが畳まれ、全体の .ws-match は1個
  it("Scenario: 見出しのクリックでその ファイルの一致行だけを畳む", async () => {
    vi.useFakeTimers();
    const host = mount(async () => outcome([
      hit("a.txt", 0, "needle"),
      hit("b.txt", 0, "needle"),
    ]));
    await search(host, "needle");

    host.querySelector<HTMLElement>(".ws-group")!.click();
    expect(host.querySelectorAll(".ws-match")).toHaveLength(1);
  });

  // Given: a.txt line3 の1件を返し、onOpen が newTab の真偽値を記録する
  // When: 一般クリック後に button=1 の auxclick を同じ match へ送る
  // Then: onOpen に渡る newTab は [false,true]
  it("Scenario: ホイールクリックは別ウィンドウで開く依頼になる", async () => {
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

  // Given: a.txt の本文一致が20行目0列目に1件あり、onOpen が受け取った結果を記録する
  // When: 検索結果の本文行を通常クリックする
  // Then: onOpen は newTab=false と、行/列を含む元の検索結果を渡す
  it("Scenario: 本文一致のクリックは該当行を失わずメモビューへ開く依頼を出す", async () => {
    vi.useFakeTimers();
    const result = hit("a.txt", 19, "needle");
    const onOpen = vi.fn();
    const host = mount(async () => outcome([result]), onOpen);
    await search(host, "needle");

    host.querySelector<HTMLElement>(".ws-match")!.click();

    expect(onOpen).toHaveBeenCalledWith(result, false);
  });

  // Given: a.txt と b.txt に各1件の検索結果がある
  // When: a.txt の検索結果、続けて b.txt の検索結果を開く
  // Then: 最後に開いた b.txt の行だけが選択済みの色用クラスを持つ
  it("Scenario: 開いた検索結果を選択済みとして表示する", async () => {
    vi.useFakeTimers();
    const host = mount(async () => outcome([
      hit("a.txt", 0, "needle"),
      hit("b.txt", 0, "needle"),
    ]));
    await search(host, "needle");

    host.querySelectorAll<HTMLElement>(".ws-match")[0].click();
    expect(host.querySelectorAll<HTMLElement>(".ws-match")[0].classList.contains("sel")).toBe(true);

    host.querySelectorAll<HTMLElement>(".ws-match")[1].click();
    const matches = host.querySelectorAll<HTMLElement>(".ws-match");
    expect(matches[0].classList.contains("sel")).toBe(false);
    expect(matches[1].classList.contains("sel")).toBe(true);
  });

  // Given: a.txt の結果があり、hit_file_limit=true と hit_result_limit=true
  // When: needle を検索する
  // Then: warning は ["最大ファイル数で列挙を打ち切った","最大結果数で検索を打ち切った"]
  it("Scenario: 上限で打ち切ったことを黙らずに表示する", async () => {
    vi.useFakeTimers();
    const host = mount(async () => outcome([hit("a.txt", 0, "needle")], {
      hit_file_limit: true,
      hit_result_limit: true,
    }));
    await search(host, "needle");

    const warnings = [...host.querySelectorAll(".ws-warning")].map((el) => el.textContent);
    expect(warnings).toEqual(["最大ファイル数で列挙を打ち切った", "最大結果数で検索を打ち切った"]);
  });

  // Given: onSearch が未解決Promiseのまま走査中になり、onCancel が回数を増やす
  // When: needle を検索し、needles に変更し、さらに .ws-toggle をクリックする
  // Then: cancel 回数は順に 0→1→2
  it("Scenario: 条件を変えたら走行中の検索を止める", async () => {
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

  // Given: 1回目の検索は停止まで未解決、onCancel が1回目を解決し、2回目は a.txt の1件を返す
  // When: needle 検索後に Aa トグルをクリックして150ms進める
  // Then: 検索呼出しは2回、1回目の match_case は false、2回目は true、summary は「1 件の結果」
  it("Scenario: 条件が変わったら、走行中のものを畳んでから新しい条件で引き直す", async () => {
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

  // Given: 1回目の onSearch は未解決、2回目は needles の a.txt 1件を返し、onCancel は Error("cancel failed") を投げる
  // When: needle、続けて needles を検索する
  // Then: 呼出し語は ["needle","needles"]、summary は「1 件の結果」
  it("Scenario: 取消に失敗しても新しい条件の検索を古いPromise待ちにしない", async () => {
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

  // Given: needle の検索が未完了のまま、現在の searchId に a.txt の途中結果を受け取っている
  // When: 設定を開いて何も変更せず OK を押す
  // Then: 表示中の group は1個のまま、検索呼出し回数は1回
  it("Scenario: 検索の設定を何も変えずに閉じても、走査中の結果を捨てない", async () => {
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

  // Given: 未完了検索があり、searchId に a.txt の途中結果を受け取っている
  // When: 停止ボタンをクリックする
  // Then: onCancel は searchId を渡して1回呼ばれ、group は1個、summary に「検索を中止」、empty に「検索を中止しました」が表示される
  it("Scenario: 検索を中止しても、届いていた結果は残す", async () => {
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

  // Given: C:\workspace で needle の a.txt 1件を表示している
  // When: folder root を C:\other→C:\workspace→null→C:\workspace と切り替える
  // Then: C:\other では group 0個、C:\workspace 復帰時は group 1個で入力値は needle、null 経由の復帰後も group は1個
  it("Scenario: フォルダごとに検索結果を保持する", async () => {
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

  // Given: 未完了検索があり、a.txt の途中結果を受け取っている
  // When: クリアボタンをクリックする
  // Then: group は0個、検索入力の value は空文字
  it("Scenario: 検索をクリアしたら、停止済みの結果も消す", async () => {
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

  // Given: 検索Promiseが未解決のまま needle を検索中
  // When: 停止ボタンをクリックする
  // Then: empty に「検索を中止しました」が表示され、「検索中」は含まれず、停止ボタンは hidden=true
  it("Scenario: 結果が届く前に中止しても、中止状態を表示する", async () => {
    vi.useFakeTimers();
    const host = mount(() => new Promise<WorkspaceSearchOutcome>(() => {}));
    await search(host, "needle");

    host.querySelector<HTMLButtonElement>(".ws-stop")!.click();

    expect(text(host, ".ws-empty")).toContain("検索を中止しました");
    expect(text(host, ".ws-empty")).not.toContain("検索中");
    expect(host.querySelector<HTMLButtonElement>(".ws-stop")?.hidden).toBe(true);
  });

  // Given: 未完了検索に a.txt の表示済み結果があり、onCancel が同期的に Error("cancel IPC failed") を投げる
  // When: 停止ボタンをクリックする
  // Then: onCancel と console.error は各1回、group は1個のまま、empty に「検索を中止しました」が表示される
  it("Scenario: 中止通知が同期失敗しても、表示済みの結果を保持する", async () => {
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

  // Given: onSearch が同期的に Error("IPC setup failed") を投げ、onError を spy する
  // When: needle の検索開始を実行する
  // Then: onError は1回、停止ボタンは hidden=true、empty 要素は存在しない
  it("Scenario: 検索開始の同期失敗でも、検索中の表示を残さない", async () => {
    vi.useFakeTimers();
    const onError = vi.fn(async () => {});
    const host = mount(() => { throw new Error("IPC setup failed"); }, () => {}, () => {}, onError);

    await search(host, "needle");

    expect(onError).toHaveBeenCalledOnce();
    expect(host.querySelector<HTMLButtonElement>(".ws-stop")?.hidden).toBe(true);
    expect(host.querySelector(".ws-empty")).toBeNull();
  });

  // Given: 未完了検索に a.txt と b.txt の途中結果があり、完了関数 finish を保持している
  // When: 全体を畳み、c.txt の途中結果を受け取り、最後に a.txt/b.txt の確定結果で finish する
  // Then: 畳み込み直後・c.txt 到着後・確定後の .ws-match は常に0個で、group は2個のまま
  it("Scenario: 検索中でも折りたたみを操作でき、途中経過の到着で戻されない", async () => {
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

  // Given: 未完了検索で z.txt、a.txt の順に途中結果を受け取り、確定時は z.txt、b.txt を返す
  // When: 途中結果を描画し、旧 searchId の m.txt を送り、確定結果を描画する
  // Then: 途中表示は ["a.txt","z.txt"] で「検索中」、旧結果 m.txt は混ざらず2ファイル、確定表示は ["b.txt","z.txt"] で「検索中」を含まない
  it("Scenario: 途中経過も確定結果も、届いた順ではなく同じ規則で並べる", async () => {
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

  // Given: missing 検索の設定ダイアログを開き、.git の除外ボタンだけを解除する
  // When: OK を押して150ms進める
  // Then: 最新検索の exclude_dirs は .git を含まず node_modules を含み、empty-detail に .git は表示されない
  it("Scenario: 設定ダイアログでの除外フォルダの変更が検索条件と説明に反映される", async () => {
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

  // Given: 初回検索条件が match_case=false、whole_word=false、use_regex=false で、トグル表示が ["名","文","Aa","ab",".*"]
  // When: Aa と .* をクリックして150ms進める
  // Then: 最新条件は match_case=true、use_regex=true、whole_word=false、Aa は on、ab は off
  it("Scenario: 入力欄のトグルが検索条件へそのまま渡る", async () => {
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

  // Given: onSearch が pattern_error="検索パターンが不正: unclosed group" の空 outcome を返す
  // When: 正規表現として need( を検索する
  // Then: warning に unclosed group が表示され、empty はなく、summary は空文字
  it("Scenario: 正規表現が壊れている間は件数ではなく理由を出す", async () => {
    vi.useFakeTimers();
    const host = mount(async () => outcome([], { pattern_error: "検索パターンが不正: unclosed group" }));
    await search(host, "need(");

    expect(text(host, ".ws-warning")).toContain("unclosed group");
    expect(host.querySelector(".ws-empty")).toBeNull();
    expect(text(host, ".ws-summary")).toBe("");
  });
});

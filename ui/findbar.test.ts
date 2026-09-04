// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { FindBar } from "./findbar";

describe("Feature: FindBar", () => {
  // Feature: エディタ検索バーの一行置換操作
  // Scenario: 検索バーを開くと置換欄と置換操作を常時表示する
  // Given: 閉じたFindBarを持つエディタホスト
  // When: 検索バーを開く
  // Then: 検索と置換の操作を一つの行で利用でき、置換欄の開閉ボタンは表示されない
  it("Scenario: 検索バーを開くと置換欄を同じ行へ常時表示する", () => {
    const host = document.createElement("div");
    const bar = new FindBar(host, async () => true, async () => 0, async () => true, () => {}, async () => {});
    bar.open("");
    const rows = host.querySelectorAll(".ve-find-row");
    const row = rows[0];

    expect(rows).toHaveLength(1);
    expect(row.querySelector(".ve-find-toggle")).toBeNull();
    expect(row.querySelector(".ve-find-in")).not.toBeNull();
    expect(row.querySelector(".ve-find-prev")).not.toBeNull();
    expect(row.querySelector(".ve-find-next")).not.toBeNull();
    expect(row.querySelector(".ve-find-status")).not.toBeNull();
    expect(row.querySelector(".ve-rep-in")).not.toBeNull();
    expect(row.querySelector(".ve-rep-next")).not.toBeNull();
    expect(row.querySelector(".ve-rep-all")).not.toBeNull();
    expect(row.querySelector(".ve-find-close")).not.toBeNull();
  });

  // Feature: エディタ検索バーの占有表示
  // Scenario: 検索バーを開いている間は本文レイアウトが検索バー領域を確保する
  // Given: 閉じたFindBarを持つエディタホスト
  // When: 検索バーを開いて閉じる
  // Then: ホストの占有表示クラスが開閉に合わせて切り替わる
  it("Scenario: 検索バー表示中だけ本文領域を押し下げる", () => {
    const host = document.createElement("div");
    const bar = new FindBar(host, async () => true, async () => 0, async () => true, () => {}, async () => {});

    bar.open("");
    expect(host.classList.contains("ve-search-open")).toBe(true);
    expect(host.querySelector<HTMLElement>(".ve-find")?.hidden).toBe(false);
    expect(host.classList.contains("ve-search-with-rep")).toBe(false);

    bar.close();
    expect(host.classList.contains("ve-search-open")).toBe(false);
    expect(host.classList.contains("ve-search-with-rep")).toBe(false);
    expect(host.querySelector<HTMLElement>(".ve-find")?.hidden).toBe(true);
  });

  // Feature: 入力時点での本文検索
  // Scenario: 検索欄へ1文字入力した時点で最初の一致を検索する
  // Given: 開いているFindBarと検索処理
  // When: 検索欄へnを1文字入力する
  // Then: Enterを待たず前方検索を1回実行する
  it("Scenario: 検索欄へ1文字入力した時点で検索する", async () => {
    const onFind = vi.fn(async () => true);
    const host = document.createElement("div");
    const bar = new FindBar(host, onFind, async () => 0, async () => true, () => {}, async () => {});
    bar.open("");
    const input = host.querySelector<HTMLInputElement>(".ve-find-in")!;

    input.value = "n";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    await vi.waitFor(() => expect(onFind).toHaveBeenCalledWith("n", true, false));
  });

  // Feature: 非同期の検索・置換操作
  // Scenario: 連続置換を連打してもクリック順に直列化する
  // Given: 1回目の連続置換が未完了で、2回目の結果を待つFindBarがある
  // When: 連続置換を2回クリックし、1回目を解決する
  // Then: 2回目は1回目の完了後にだけ実行される
  it("Scenario: 非同期の検索・置換操作をクリック順に直列化する", async () => {
    let releaseFirst!: (found: boolean) => void;
    const first = new Promise<boolean>((resolve) => { releaseFirst = resolve; });
    const replaceNext = vi.fn()
      .mockReturnValueOnce(first)
      .mockResolvedValue(true);
    const host = document.createElement("div");
    document.body.replaceChildren(host);
    const bar = new FindBar(
      host,
      async () => true,
      async () => 0,
      replaceNext,
      () => {},
      async () => {},
    );
    bar.open("");
    host.querySelector<HTMLInputElement>(".ve-find-in")!.value = "needle";

    host.querySelector<HTMLButtonElement>(".ve-rep-next")!.click();
    host.querySelector<HTMLButtonElement>(".ve-rep-next")!.click();
    await vi.waitFor(() => expect(replaceNext).toHaveBeenCalledTimes(1));
    releaseFirst(true);
    await vi.waitFor(() => expect(replaceNext).toHaveBeenCalledTimes(2));

    expect(replaceNext).toHaveBeenCalledTimes(2);
  });
});

// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { FindBar } from "./findbar";
import { CHEVRON_DOWN, CHEVRON_RIGHT } from "./icon-button";

describe("Feature: FindBar", () => {
  // Given: 閉じた置換欄を持つFindBar
  // When: 置換欄のChevronを押す
  // Then: フォルダ検索と同じアイコンで開閉状態を示す
  it("Scenario: モダンなChevronで置換欄を開閉する", () => {
    const host = document.createElement("div");
    const bar = new FindBar(host, async () => true, async () => 0, async () => true, () => {}, async () => {});
    bar.open("");
    const toggle = host.querySelector<HTMLButtonElement>(".ve-find-toggle")!;

    expect(toggle.textContent).toBe(CHEVRON_RIGHT);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    toggle.click();

    expect(toggle.textContent).toBe(CHEVRON_DOWN);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector(".ve-find")?.classList.contains("with-rep")).toBe(true);
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

  it("Scenario: 非同期の検索・置換操作をクリック順に直列化する", async () => {
    // Given: 1回目の連続置換が未完了で、2回目の結果を待つFindBarがある
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

    // When: 連続置換を2回クリックし、1回目を解決する
    host.querySelector<HTMLButtonElement>(".ve-rep-next")!.click();
    host.querySelector<HTMLButtonElement>(".ve-rep-next")!.click();
    await vi.waitFor(() => expect(replaceNext).toHaveBeenCalledTimes(1));
    releaseFirst(true);
    await vi.waitFor(() => expect(replaceNext).toHaveBeenCalledTimes(2));

    // Then: 2回目は1回目の完了後にだけ実行される
    expect(replaceNext).toHaveBeenCalledTimes(2);
  });
});

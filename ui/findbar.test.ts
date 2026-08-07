// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { FindBar } from "./findbar";

describe("Feature: FindBar", () => {
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

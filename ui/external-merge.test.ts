// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { confirmExternalMerge } from "./external-merge";
import type { ExternalMergePreview } from "./api";

const preview: ExternalMergePreview = {
  changes: [{ start_line: 3, mine: ["自分の行"], theirs: ["外部の行"], conflict: true }],
  conflict_count: 1,
  modified_at: 1720000000000,
};

afterEach(() => document.body.replaceChildren());

describe("Feature: 外部変更マージ確認画面", () => {
  // Given: 自分側と外部側の競合差分を含むプレビュー
  // When: マージ確認画面を開いて「マージする」を押す
  // Then: 両側の差分を表示し、mergeを返す
  it("Scenario: 競合差分を表示してマージを選べる", async () => {
    const resultPromise = confirmExternalMerge(preview);

    expect(document.querySelector(".pf-merge-box")).not.toBeNull();
    expect(document.querySelector(".em-mine")?.textContent).toContain("自分の行");
    expect(document.querySelector(".em-theirs")?.textContent).toContain("外部の行");
    document.querySelectorAll<HTMLButtonElement>(".pf-btns button")[3].click();

    await expect(resultPromise).resolves.toBe("merge");
    expect(document.querySelector(".pf-merge-box")).toBeNull();
  });

  // Given: 外部変更マージ確認画面
  // When: 「自分を維持」を押す
  // Then: keepを返す
  it("Scenario: 自分の編集を維持する選択を返す", async () => {
    const resultPromise = confirmExternalMerge(preview);
    document.querySelectorAll<HTMLButtonElement>(".pf-btns button")[2].click();

    await expect(resultPromise).resolves.toBe("keep");
  });
});

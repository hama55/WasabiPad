// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { confirmExternalMerge, isExternalMergeRetryError } from "./external-merge";
import type { ExternalMergePreview } from "./api";

const preview: ExternalMergePreview = {
  changes: [
    {
      start_line: 3,
      mine_start_line: 3,
      theirs_start_line: 3,
      before: [{ text: "変更前の行", mine_line: 2, theirs_line: 2 }],
      mine: ["自分の行"],
      theirs: ["外部の行"],
      after: [{ text: "変更後の行", mine_line: 4, theirs_line: 4 }],
      conflict: true,
    },
    {
      start_line: 8,
      mine_start_line: 8,
      theirs_start_line: 8,
      before: [],
      mine: ["削除された行"],
      theirs: [],
      after: [],
      conflict: false,
    },
  ],
  conflict_count: 1,
};

afterEach(() => document.body.replaceChildren());

describe("Feature: 外部変更マージ確認画面", () => {
  // Given: マージ実行時にbackendが返す「外部ファイルが再変更された」エラー
  // When: 再確認が必要か判定する
  // Then: trueを返し、別種のエラーは再試行扱いにしない
  it("Scenario: プレビュー後の外部再変更だけを再確認対象にする", () => {
    expect(isExternalMergeRetryError("external_merge_retry")).toBe(true);
    expect(isExternalMergeRetryError("外部ファイルが再度変更されました。もう一度確認してください")).toBe(true);
    expect(isExternalMergeRetryError(new Error("ファイルがありません"))).toBe(false);
  });

  // Given: 自分側と外部側の競合差分を含むプレビュー
  // When: マージ確認画面を開いて「マージする」を押す
  // Then: 1つの左右分割差分画面で行番号・前後コンテキスト・差分と +/- 記号を表示し、mergeを返す
  it("Scenario: 競合差分を表示してマージを選べる", async () => {
    const resultPromise = confirmExternalMerge(preview);

    expect(document.querySelectorAll(".pf-merge-box")).toHaveLength(1);
    expect(document.querySelector(".em-diff")).not.toBeNull();
    expect(document.querySelector(".em-mine")?.textContent).toContain("自分の行");
    expect(document.querySelector(".em-theirs")?.textContent).toContain("外部の行");
    expect(document.querySelector(".em-mine .em-diff-marker")?.textContent).toBe("-");
    expect(document.querySelector(".em-theirs .em-diff-marker")?.textContent).toBe("+");
    expect(document.querySelector(".em-context")?.textContent).toContain("変更前の行");
    expect(document.querySelectorAll(".em-line-number").length).toBeGreaterThan(0);
    expect(document.querySelector(".em-change-heading")).toBeNull();
    expect(document.querySelectorAll(".em-diff-cell.em-mine.is-empty")).toHaveLength(0);
    expect(document.querySelectorAll(".em-diff-cell.em-theirs.is-empty")).toHaveLength(0);
    expect(document.querySelectorAll(".em-empty-cell.is-empty")).toHaveLength(1);
    expect(document.querySelectorAll(".em-diff-row")).toHaveLength(4);
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

  // Given: 外部変更マージ確認画面
  // When: 「外部を採用」を押す
  // Then: reloadを返す
  it("Scenario: 外部ファイルを採用する選択を返す", async () => {
    const resultPromise = confirmExternalMerge(preview);
    document.querySelectorAll<HTMLButtonElement>(".pf-btns button")[1].click();

    await expect(resultPromise).resolves.toBe("reload");
  });

  // Given: 差分確認画面が開いており、表示更新リスナーが登録されている
  // When: 外部変更監視から最新プレビューを通知する
  // Then: ダイアログを閉じずに左右の差分表示を最新内容へ更新する
  it("Scenario: 表示中のマージ画面を最新プレビューへ更新する", async () => {
    let update!: (next: ExternalMergePreview) => void;
    const resultPromise = confirmExternalMerge(preview, (listener) => {
      update = listener;
      return () => {};
    });
    const latest: ExternalMergePreview = {
      changes: [{
        start_line: 5,
        mine_start_line: 5,
        theirs_start_line: 5,
        before: [{ text: "最新の前", mine_line: 4, theirs_line: 4 }],
        mine: ["自分の最新"],
        theirs: ["外部の最新"],
        after: [{ text: "最新の後", mine_line: 6, theirs_line: 6 }],
        conflict: false,
      }],
      conflict_count: 0,
    };

    update(latest);

    expect(document.querySelector(".em-mine")?.textContent).toContain("自分の最新");
    expect(document.querySelector(".em-theirs")?.textContent).toContain("外部の最新");
    expect(document.querySelector(".pf-merge-box")).not.toBeNull();
    document.querySelector<HTMLButtonElement>(".pf-btns button")!.click();
    await expect(resultPromise).resolves.toBeNull();
  });

  // Given: 左右で先行する行数が異なる差分プレビュー
  // When: マージ確認画面を表示する
  // Then: 各ペインの行番号を別々に表示する
  it("Scenario: 左右ペインで異なる開始行番号を表示する", async () => {
    const resultPromise = confirmExternalMerge({
      changes: [{
        start_line: 3,
        mine_start_line: 4,
        theirs_start_line: 3,
        before: [
          { text: "a", mine_line: 1, theirs_line: 1 },
          { text: "b", mine_line: 3, theirs_line: 2 },
        ],
        mine: ["c"],
        theirs: ["外部のc"],
        after: [{ text: "d", mine_line: 5, theirs_line: 4 }],
        conflict: false,
      }],
      conflict_count: 0,
    });

    const rows = [...document.querySelectorAll<HTMLElement>(".em-diff-row")];
    expect(rows.map((row) => [...row.querySelectorAll(".em-line-number")].map((el) => el.textContent))).toEqual([
      ["1", "1"],
      ["3", "2"],
      ["4", "3"],
      ["5", "4"],
    ]);
    document.querySelector<HTMLButtonElement>(".pf-btns button")!.click();
    await expect(resultPromise).resolves.toBeNull();
  });
});

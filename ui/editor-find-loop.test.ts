import { describe, expect, it, vi } from "vitest";
import type { FindOutcome, Pos } from "./api";
import { findForward } from "./editor-find-loop";

const from: Pos = { line: 0, col: 0 };

describe("Feature: エディタ前方向検索ループ", () => {
  // Given: 1回目は継続カーソル、2回目は一致を返す検索クライアント
  // When: 前方向検索を実行する
  // Then: カーソルを引き継ぎ、一致結果を返し、進捗を通知する
  it("Scenario: 継続検索を一致まで進める", async () => {
    const found: FindOutcome = {
      kind: "Found",
      start: { line: 3, col: 0 },
      end: { line: 3, col: 6 },
    };
    const findStep = vi.fn()
      .mockResolvedValueOnce({ kind: "More", cursor: { line: 2, col: 0 } })
      .mockResolvedValueOnce(found);
    const progress = vi.fn();

    const result = await findForward(
      { findStep },
      "needle",
      from,
      false,
      20,
      () => true,
      progress,
    );

    expect(result).toEqual(found);
    expect(findStep).toHaveBeenLastCalledWith("needle", from, false, { line: 2, col: 0 }, 20);
    expect(progress).toHaveBeenCalledWith({ line: 2, col: 0 });
  });

  // Given: 検索の途中で文書世代が変わる
  // When: 継続検索の応答を受け取る
  // Then: 古い検索結果を返さず中断する
  it("Scenario: 文書世代が変わった検索を破棄する", async () => {
    const findStep = vi.fn().mockResolvedValue({ kind: "More", cursor: { line: 1, col: 0 } });
    let current = true;
    const result = await findForward(
      { findStep },
      "needle",
      from,
      false,
      20,
      () => current,
      () => { current = false; },
    );

    expect(result).toBeNull();
  });
});

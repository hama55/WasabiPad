import { describe, expect, it, vi } from "vitest";
import { openPath } from "./path-opener";

describe("Feature: absolute path opening", () => {
  // Given: 現在タブ遷移と新規タブ作成の操作口
  // When: newTab=trueで絶対パスを開く
  // Then: 新規タブ操作だけを呼ぶ
  it("Scenario: 新規タブ指定をopenへ振り分ける", async () => {
    const open = vi.fn(async () => {});
    const navigatePath = vi.fn(async () => true);

    await openPath({ open, navigatePath }, "C:\\work\\memo.txt", true);

    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith("C:\\work\\memo.txt");
    expect(navigatePath).not.toHaveBeenCalled();
  });

  // Given: 現在タブ遷移と新規タブ作成の操作口
  // When: newTab=falseで絶対パスを開く
  // Then: 現在タブ操作だけを呼ぶ
  it("Scenario: 通常指定をnavigatePathへ振り分ける", async () => {
    const open = vi.fn(async () => {});
    const navigatePath = vi.fn(async () => true);

    await openPath({ open, navigatePath }, "C:\\work\\memo.txt");

    expect(navigatePath).toHaveBeenCalledTimes(1);
    expect(navigatePath).toHaveBeenCalledWith("C:\\work\\memo.txt");
    expect(open).not.toHaveBeenCalled();
  });
});

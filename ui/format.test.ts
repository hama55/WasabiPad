import { describe, expect, it } from "vitest";
import { APP_NAME, formatByteSize, formatModifiedAt, formatWindowTitle } from "./format";
import { initialSession } from "./session";

describe("Feature: display formatting", () => {
  // Given: byte sizeが1023、1024、1048576、1073741824
  // When: `formatByteSize`
  // Then: `"1023 B"`、`"1.0 kB"`、`"1.0 MB"`、`"1.0 GB"`
  it("Scenario: formats byte boundaries", () => {
    expect(formatByteSize(1023)).toBe("1023 B");
    expect(formatByteSize(1024)).toBe("1.0 kB");
    expect(formatByteSize(1024 * 1024)).toBe("1.0 MB");
    expect(formatByteSize(1024 * 1024 * 1024)).toBe("1.0 GB");
  });

  // Given: initialSession
  // When: 初期状態と、display/save path=`C:\\work\\memo.txt`・dirty=trueへ変更後に`formatWindowTitle`
  // Then: `"無題 — APP_NAME"`、`"● memo.txt — APP_NAME"`
  it("Scenario: derives the window title from session state", () => {
    const session = initialSession();
    expect(formatWindowTitle(session)).toBe(`無題 — ${APP_NAME}`);
    session.displayPath = "C:\\work\\memo.txt";
    session.savePath = session.displayPath;
    session.dirty = true;
    expect(formatWindowTitle(session)).toBe(`● memo.txt — ${APP_NAME}`);
  });

  // Feature: ステータスバーの保存日時
  // Scenario Outline: 保存日時を現在からの経過時間で表示する
  // Given: 現在時刻が固定されている
  // When: 指定した経過時間の保存日時を`formatModifiedAt`へ渡す
  // Then: 分・時間・日・月・年の相対表記を返す
  // Examples:
  // | 経過時間 | 表示 |
  // | 5分前 | 保存: 5分前 |
  // | 2時間前 | 保存: 2時間前 |
  // | 3日前 | 保存: 3日前 |
  // | 2ヶ月前 | 保存: 2ヶ月前 |
  // | 1年前 | 保存: 1年前 |
  it.each([
    ["5分前", 5 * 60 * 1000, "保存: 5分前"],
    ["2時間前", 2 * 60 * 60 * 1000, "保存: 2時間前"],
    ["3日前", 3 * 24 * 60 * 60 * 1000, "保存: 3日前"],
    ["2ヶ月前", 60 * 24 * 60 * 60 * 1000, "保存: 2ヶ月前"],
    ["1年前", 365 * 24 * 60 * 60 * 1000, "保存: 1年前"],
  ])("Scenario: %sの保存日時を相対表示する", (_label, elapsed, expected) => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    expect(formatModifiedAt(now - elapsed, now)).toBe(expected);
  });
});

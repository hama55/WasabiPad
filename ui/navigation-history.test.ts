import { describe, expect, it } from "vitest";
import { NavigationHistory, type NavigationEntry } from "./navigation-history";

const file = (path: string): NavigationEntry => ({ path, kind: "file", line: 0 });

describe("Feature: NavigationHistory", () => {
  // Given: 履歴が空、`a.txt`,`b.txt`を用意
  // When: aをrecord、back完了、forward完了
  // Then: back/forward可否とtargetが各状態遷移どおり変化
  it("Scenario: 戻る/進むの対象を状態遷移として管理する", () => {
    const history = new NavigationHistory();
    const first = file("C:\\work\\a.txt");
    const second = file("C:\\work\\b.txt");

    history.record(first);
    expect(history.state).toEqual({ canGoBack: true, canGoForward: false });
    expect(history.target("back")).toEqual(first);

    history.complete("back", second);
    expect(history.state).toEqual({ canGoBack: false, canGoForward: true });
    expect(history.target("forward")).toEqual(second);

    history.complete("forward", first);
    expect(history.state).toEqual({ canGoBack: true, canGoForward: false });
    expect(history.target("back")).toEqual(first);
  });

  // Given: a.txtをrecord済み
  // When: back targetのlineを12へ変更
  // Then: 内部targetは元のline 0を保持
  it("Scenario: 取得した履歴項目を変更しても内部状態を変更しない", () => {
    const history = new NavigationHistory();
    const entry = file("C:\\work\\a.txt");
    history.record(entry);

    const target = history.target("back")!;
    target.line = 12;

    expect(history.target("back")).toEqual(entry);
  });
});

// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({
  loadSettings: async () => "{}",
  updateSetting: async () => {},
}));

import {
  addRegisteredString,
  loadRegisteredStrings,
  registeredStringLabel,
  removeRegisteredString,
} from "./registered-strings";
import { initSettings } from "./settings";

describe("Feature: registered strings", () => {
  beforeEach(() => initSettings());

  // Given: 設定初期化済み、fooを重複登録し空文字も登録
  // When: `addRegisteredString`後にload
  // Then: 一覧は`["foo"]`
  it("Scenario: 重複と空文字列は登録しない", () => {
    addRegisteredString("foo");
    addRegisteredString("foo");
    addRegisteredString("");
    expect(loadRegisteredStrings()).toEqual(["foo"]);
  });

  // Given: a,bを登録済み
  // When: aを削除
  // Then: 一覧は`["b"]`
  it("Scenario: 削除は指定した1件だけ", () => {
    addRegisteredString("a");
    addRegisteredString("b");
    removeRegisteredString("a");
    expect(loadRegisteredStrings()).toEqual(["b"]);
  });

  // Given: 改行文字列、60文字、空文字を入力
  // When: `registeredStringLabel`を呼ぶ
  // Then: 改行は`↵`、長文は48文字、空文字は`(空文字列)`
  it("Scenario: ラベルは改行を畳んで48文字で切る", () => {
    expect(registeredStringLabel("a\nb")).toBe("a↵b");
    expect(registeredStringLabel("x".repeat(60))).toHaveLength(48);
    expect(registeredStringLabel("")).toBe("(空文字列)");
  });
});

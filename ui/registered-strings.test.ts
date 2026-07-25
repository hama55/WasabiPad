// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  addRegisteredString,
  loadRegisteredStrings,
  registeredStringLabel,
  removeRegisteredString,
} from "./registered-strings";

describe("registered strings", () => {
  beforeEach(() => localStorage.clear());

  it("重複と空文字列は登録しない", () => {
    addRegisteredString("foo");
    addRegisteredString("foo");
    addRegisteredString("");
    expect(loadRegisteredStrings()).toEqual(["foo"]);
  });

  it("削除は指定した1件だけ", () => {
    addRegisteredString("a");
    addRegisteredString("b");
    removeRegisteredString("a");
    expect(loadRegisteredStrings()).toEqual(["b"]);
  });

  it("壊れた保存値は空として扱う", () => {
    localStorage.setItem("registeredStrings", "{ not json");
    expect(loadRegisteredStrings()).toEqual([]);
    localStorage.setItem("registeredStrings", JSON.stringify(["ok", 42, ""]));
    expect(loadRegisteredStrings()).toEqual(["ok"]);
  });

  it("ラベルは改行を畳んで48文字で切る", () => {
    expect(registeredStringLabel("a\nb")).toBe("a↵b");
    expect(registeredStringLabel("x".repeat(60))).toHaveLength(48);
    expect(registeredStringLabel("")).toBe("(空文字列)");
  });
});

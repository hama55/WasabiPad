import { describe, expect, it } from "vitest";
import { APP_NAME, formatByteSize, formatWindowTitle } from "./format";
import { initialSession } from "./session";

describe("Feature: display formatting", () => {
  // Given: byte sizeが1023、1024、1048576
  // When: `formatByteSize`
  // Then: `"1023 B"`、`"1.0 KB"`、`"1.0 MB"`
  it("Scenario: formats byte boundaries", () => {
    expect(formatByteSize(1023)).toBe("1023 B");
    expect(formatByteSize(1024)).toBe("1.0 KB");
    expect(formatByteSize(1024 * 1024)).toBe("1.0 MB");
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
});

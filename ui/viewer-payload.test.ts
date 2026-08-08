import { describe, expect, it } from "vitest";
import { isViewerPayload } from "./viewer-payload";

describe("Feature: viewer payload validation", () => {
  // Given: 形式・本文・選択範囲・各パスが揃ったviewer payload
  // When: `isViewerPayload`を呼ぶ
  // Then: 有効なpayloadとして受け入れる
  it("Scenario: accepts a complete viewer payload", () => {
    expect(isViewerPayload({
      format: "markdown",
      text: "# memo",
      selection: { start: { line: 0, col: 0 }, end: { line: 0, col: 4 } },
      source_path: "C:\\work\\memo.md",
      archive_path: null,
      archive_entry: null,
    })).toBe(true);
  });

  // Given: 未登録形式または不正な選択位置を含むpayload
  // When: `isViewerPayload`を呼ぶ
  // Then: iframeからの描画入力として受け入れない
  it("Scenario: rejects malformed viewer payloads before state mutation", () => {
    const base = {
      format: "markdown",
      text: "# memo",
      selection: null,
      source_path: null,
      archive_path: null,
      archive_entry: null,
    };
    expect(isViewerPayload({ ...base, format: "html" })).toBe(false);
    expect(isViewerPayload({
      ...base,
      selection: { start: { line: -1, col: 0 }, end: { line: 0, col: 0 } },
    })).toBe(false);
    expect(isViewerPayload({ ...base, archive_path: 42 })).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  ARCHIVE_FORMATS,
  ARCHIVE_ENTRY_SEPARATOR,
  ENCODING_LABELS,
  EOL_LABELS,
  EVENT_NAMES,
  IMAGE_FORMATS,
  IMAGE_MIME_TYPES,
  isArchiveFormat,
  PASSWORD_ERROR_MARKER,
} from "./generated/Protocol";

describe("Feature: 共有プロトコル定数", () => {
  // Given: Rust/TypeScriptへ生成される共有プロトコル定数
  // When: アーカイブ表現とパスワードエラーを参照する
  // Then: 既存の機械プロトコル値を維持する
  it("Scenario: アーカイブとパスワードの契約を維持する", () => {
    expect(ARCHIVE_ENTRY_SEPARATOR).toBe("::");
    expect(PASSWORD_ERROR_MARKER).toBe("7z-password");
  });

  // Given: 画像拡張子のaliasとencoding表示名
  // When: 生成された表を参照する
  // Then: JPEG aliasは同じMIMEを持ち、保存形式の表示名が一意に定義される
  it("Scenario: aliasと表示名を単一表から取得する", () => {
    expect(IMAGE_MIME_TYPES.jpeg).toBe(IMAGE_MIME_TYPES.jpg);
    expect(ENCODING_LABELS).toEqual({
      utf8: "UTF-8",
      utf8bom: "UTF-8 (BOM)",
      sjis: "Shift-JIS",
      utf16le: "UTF-16LE",
    });
    expect(EOL_LABELS).toEqual({ crlf: "CRLF", lf: "LF" });
  });

  // Feature: アーカイブ形式とTauriイベントの共有契約
  // Scenario: UIが生成済みの形式集合とイベント名を参照する
  // Given: shared/protocol.jsonを正本とする生成プロトコル
  // When: アーカイブ形式とイベント名を取得する
  // Then: 対応形式と4イベントを一つの生成物から取得できる
  it("Scenario: アーカイブ形式とイベント名を共有正本から取得する", () => {
    expect(ARCHIVE_FORMATS).toEqual(["zip", "7z", "xlsx", "xls"]);
    expect(IMAGE_FORMATS).toEqual(["svg", "png", "jpg", "gif", "webp", "bmp", "ico", "avif", "apng"]);
    expect(EVENT_NAMES).toEqual({
      externalWindowRequest: "external-window-request",
      workspaceSearchBatch: "workspace-search-batch",
      documentLoadProgress: "document-load-progress",
      viewerUpdate: "viewer-update",
    });
    expect(isArchiveFormat("7Z")).toBe(true);
    expect(isArchiveFormat("txt")).toBe(false);
  });
});

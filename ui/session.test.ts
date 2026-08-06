import { describe, expect, it } from "vitest";
import type { DocInfo } from "./api";
import { displayName, externalFilePathOf, initialSession, readEncodingOf, sessionFromDocInfo } from "./session";

const info = (overrides: Partial<DocInfo> = {}): DocInfo => ({
  kind: "text",
  line_count: 3,
  enc: "sjis",
  eol: "lf",
  path: "C:\\work\\memo.txt",
  entries: null,
  folder_entries: null,
  folder_root: "C:\\work",
  view_only: false,
  byte_len: 10,
  is_huge: false,
  ...overrides,
});

describe("Feature: DocumentSession", () => {
  // Given: 初期セッションを作成する
  // When: `initialSession()`を呼ぶ
  // Then: 未保存・未変更、utf8/crlf、lineCount=1の状態になる
  it("Scenario: defines the untitled document state once", () => {
    expect(initialSession()).toMatchObject({
      savePath: null,
      readOnly: false,
      dirty: false,
      encoding: "utf8",
      sourceEncoding: "utf8",
      eol: "crlf",
      sourceEol: "crlf",
      lineCount: 1,
    });
  });

  // Given: editableなDocInfoが`C:\work\memo.txt`/sjis/lf、archiveかつview_onlyのDocInfo
  // When: `sessionFromDocInfo`と`displayName`を呼ぶ
  // Then: 通常文書は編集可能なpath/encoding/eol、archiveはsavePath=null・readOnly=true・表示名memo.txt
  it("Scenario: derives editable and read-only save paths from DocInfo", () => {
    const editable = sessionFromDocInfo(initialSession(), info());
    expect(editable.savePath).toBe("C:\\work\\memo.txt");
    expect(editable.folderRoot).toBe("C:\\work");
    expect(editable.encoding).toBe("sjis");
    expect(editable.sourceEncoding).toBe("sjis");
    expect(editable.eol).toBe("lf");
    expect(editable.sourceEol).toBe("lf");

    const archive = sessionFromDocInfo(editable, info({ view_only: true, kind: "archive" }));
    expect(archive.savePath).toBeNull();
    expect(archive.readOnly).toBe(true);
    expect(displayName(archive)).toBe("memo.txt");
  });

  // Given: フォルダ自身のDocInfoと、フォルダ内で選択したファイルのDocInfo
  // When: externalFilePathOfを呼ぶ
  // Then: フォルダ自身はnull、選択ファイルは実パスになる
  it("Scenario: フォルダ表示と選択ファイルのExplorer対象を区別する", () => {
    expect(externalFilePathOf(info({ path: "C:\\work", folder_root: "C:\\work" }))).toBeNull();
    expect(externalFilePathOf(info({
      path: "C:\\work\\memo.txt",
      folder_root: "C:\\work",
    }))).toBe("C:\\work\\memo.txt");
  });

  // Given: encodingが`utf8bom`または`sjis`
  // When: `readEncodingOf`を呼ぶ
  // Then: utf8bomはutf8、sjisはsjis
  it("Scenario: folds BOM into the plain read encoding", () => {
    expect(readEncodingOf("utf8bom")).toBe("utf8");
    expect(readEncodingOf("sjis")).toBe("sjis");
  });
});

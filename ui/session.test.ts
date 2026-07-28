import { describe, expect, it } from "vitest";
import type { DocInfo } from "./api";
import { displayName, initialSession, readEncodingOf, sessionFromDocInfo } from "./session";

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

describe("DocumentSession", () => {
  it("defines the untitled document state once", () => {
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

  it("derives editable and read-only save paths from DocInfo", () => {
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

  it("folds BOM into the plain read encoding", () => {
    expect(readEncodingOf("utf8bom")).toBe("utf8");
    expect(readEncodingOf("sjis")).toBe("sjis");
  });
});

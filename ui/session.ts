import type { DocInfo, Encoding, Eol, ReadEncoding } from "./api";
import { basename } from "./path";

// BOM の有無は読込時に自動判定される (指定して読み直す対象ではない) ため、
// 読込側の選択肢は BOM 無しへ畳む。
export function readEncodingOf(encoding: Encoding): ReadEncoding {
  return encoding === "utf8bom" ? "utf8" : encoding;
}

export interface DocumentSession {
  displayPath: string;
  savePath: string | null;
  folderRoot: string | null;
  readOnly: boolean;
  dirty: boolean;
  encoding: Encoding;
  sourceEncoding: Encoding;
  eol: Eol;
  sourceEol: Eol;
  lineCount: number;
  selectedRelPath: string;
}

export function initialSession(): DocumentSession {
  return {
    displayPath: "",
    savePath: null,
    folderRoot: null,
    readOnly: false,
    dirty: false,
    encoding: "utf8",
    sourceEncoding: "utf8",
    eol: "crlf",
    sourceEol: "crlf",
    lineCount: 1,
    selectedRelPath: "",
  };
}

export function sessionFromDocInfo(
  previous: Readonly<DocumentSession>,
  info: DocInfo
): DocumentSession {
  const folderDraft = info.folder_root === info.path;
  return {
    displayPath: info.path,
    savePath: info.view_only || folderDraft ? null : info.path,
    folderRoot: info.folder_root,
    readOnly: info.view_only,
    dirty: false,
    encoding: info.enc,
    sourceEncoding: info.enc,
    eol: info.eol,
    sourceEol: info.eol,
    lineCount: info.line_count,
    selectedRelPath: previous.selectedRelPath,
  };
}

export function displayName(session: Readonly<DocumentSession>): string {
  const path = session.savePath ?? (session.readOnly ? session.displayPath : "");
  return path ? basename(path) : "無題";
}

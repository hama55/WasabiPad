import type { DocInfo, Encoding, Eol } from "./api";

export interface DocumentSession {
  displayPath: string;
  savePath: string | null;
  folderRoot: string | null;
  readOnly: boolean;
  dirty: boolean;
  encoding: Encoding;
  eol: Eol;
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
    eol: "crlf",
    lineCount: 1,
    selectedRelPath: "",
  };
}

export function sessionFromDocInfo(
  previous: DocumentSession,
  info: DocInfo
): DocumentSession {
  return {
    displayPath: info.path,
    savePath: info.view_only ? null : info.path,
    folderRoot: info.folder_root,
    readOnly: info.view_only,
    dirty: false,
    encoding: info.enc,
    eol: info.eol,
    lineCount: info.line_count,
    selectedRelPath: previous.selectedRelPath,
  };
}

export function displayName(session: DocumentSession): string {
  const path = session.savePath ?? (session.readOnly ? session.displayPath : "");
  return path.replace(/\\/g, "/").split("/").pop() || "無題";
}

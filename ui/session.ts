import type { DocInfo, Encoding, Eol, ReadEncoding } from "./api";
import { splitArchiveEntryPath } from "./archive-path";
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
  isBinary: boolean;
  dirty: boolean;
  encoding: Encoding;
  sourceEncoding: Encoding;
  eol: Eol;
  sourceEol: Eol;
  lineCount: number;
  selectedRelPath: string;
  archivePath: string | null;
  archiveEntry: string | null;
  effectiveExtension: string | null;
}

export function initialSession(): DocumentSession {
  return {
    displayPath: "",
    savePath: null,
    folderRoot: null,
    readOnly: false,
    isBinary: false,
    dirty: false,
    encoding: "utf8",
    sourceEncoding: "utf8",
    eol: "crlf",
    sourceEol: "crlf",
    lineCount: 1,
    selectedRelPath: "",
    archivePath: null,
    archiveEntry: null,
    effectiveExtension: null,
  };
}

export function isFolderDraftInfo(info: Pick<DocInfo, "path" | "folder_root">): boolean {
  return info.folder_root !== null && info.folder_root === info.path;
}

export function externalFilePathOf(info: Pick<DocInfo, "path" | "folder_root">): string | null {
  return info.path && !isFolderDraftInfo(info) ? info.path : null;
}

export function documentPathOf(
  session: Pick<DocumentSession, "selectedRelPath" | "savePath" | "displayPath">
    & Partial<Pick<DocumentSession, "archiveEntry" | "effectiveExtension">>,
): string {
  const path = session.selectedRelPath || session.savePath || session.displayPath;
  if (!path || !session.effectiveExtension || session.archiveEntry || splitArchiveEntryPath(path)) return path;
  return `${path}.${session.effectiveExtension}`;
}

export function sessionFromDocInfo(
  previous: Readonly<DocumentSession>,
  info: DocInfo
): DocumentSession {
  const folderDraft = isFolderDraftInfo(info);
  const archiveEntryPath = splitArchiveEntryPath(previous.selectedRelPath);
  const archivePath = archiveEntryPath
    ? info.path
    : info.kind === "archive" && previous.selectedRelPath ? info.path : null;
  const archiveEntry = archiveEntryPath?.entryName
    ?? (archivePath ? previous.selectedRelPath : null);
  return {
    displayPath: info.path,
    savePath: info.view_only || folderDraft ? null : info.path,
    folderRoot: info.folder_root,
    readOnly: info.view_only,
    isBinary: info.is_binary,
    dirty: false,
    encoding: info.enc,
    sourceEncoding: info.enc,
    eol: info.eol,
    sourceEol: info.eol,
    lineCount: info.line_count,
    selectedRelPath: previous.selectedRelPath,
    archivePath,
    archiveEntry,
    effectiveExtension: info.effective_extension,
  };
}

export function displayName(session: Readonly<DocumentSession>): string {
  const path = session.savePath ?? (session.readOnly ? session.displayPath : "");
  return path ? basename(path) : "無題";
}

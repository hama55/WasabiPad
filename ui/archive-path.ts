import { ARCHIVE_ENTRY_SEPARATOR } from "./generated/Protocol";

export { ARCHIVE_ENTRY_SEPARATOR } from "./generated/Protocol";

export interface ArchiveEntryPath {
  archiveRelPath: string;
  entryName: string;
}

export function splitArchiveEntryPath(relPath: string): ArchiveEntryPath | null {
  const separator = relPath.indexOf(ARCHIVE_ENTRY_SEPARATOR);
  if (separator < 0) return null;
  return {
    archiveRelPath: relPath.slice(0, separator),
    entryName: relPath.slice(separator + ARCHIVE_ENTRY_SEPARATOR.length),
  };
}

export function archiveRelOf(relPath: string): string {
  return splitArchiveEntryPath(relPath)?.archiveRelPath ?? "";
}

export function archiveEntryPath(archiveRelPath: string, entryName: string): string {
  return archiveRelPath ? `${archiveRelPath}${ARCHIVE_ENTRY_SEPARATOR}${entryName}` : entryName;
}

export function isArchiveEntryPath(relPath: string): boolean {
  return splitArchiveEntryPath(relPath) !== null;
}

export function isArchiveEntryUnder(relPath: string, archiveRelPath: string): boolean {
  return relPath.startsWith(`${archiveRelPath}${ARCHIVE_ENTRY_SEPARATOR}`);
}

import { ARCHIVE_ENTRY_SEPARATOR, splitArchiveEntryPath } from "./archive-path";

function normalizedPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function basename(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() || path;
}

export interface PathRebase {
  oldAbsolute: string;
  newAbsolute: string;
  oldRelPath: string;
  newRelPath: string;
}

export function dirname(relativePath: string): string | null {
  const index = relativePath.lastIndexOf("/");
  return index < 0 ? null : relativePath.slice(0, index);
}

export function joinWindowsRoot(root: string, relativePath: string): string {
  return `${root}\\${relativePath.replace(/\//g, "\\")}`;
}

export function relativePathFromRoot(root: string, absolutePath: string): string {
  return absolutePath.slice(root.length).replace(/^[\\/]/, "").replace(/\\/g, "/");
}

export function comparablePath(path: string): string {
  return normalizedPath(path).toLocaleLowerCase("en-US");
}

export function comparableDocumentPath(path: string): string {
  const normalized = normalizedPath(path);
  const archive = splitArchiveEntryPath(normalized);
  if (!archive) return comparablePath(normalized);
  return `${comparablePath(archive.archiveRelPath)}${ARCHIVE_ENTRY_SEPARATOR}${archive.entryName}`;
}

export function isSameOrDescendantDocumentPath(path: string, parent: string): boolean {
  const normalizedPathValue = normalizedPath(path);
  const normalizedParent = normalizedPath(parent);
  const pathArchive = splitArchiveEntryPath(normalizedPathValue);
  const parentArchive = splitArchiveEntryPath(normalizedParent);
  if (parentArchive) {
    if (!pathArchive || comparablePath(pathArchive.archiveRelPath) !== comparablePath(parentArchive.archiveRelPath)) {
      return false;
    }
    return pathArchive.entryName === parentArchive.entryName
      || pathArchive.entryName.startsWith(`${parentArchive.entryName}/`);
  }
  const physicalPath = pathArchive?.archiveRelPath ?? normalizedPathValue;
  const comparable = comparablePath(physicalPath);
  const comparableParent = comparablePath(normalizedParent);
  return comparable === comparableParent || comparable.startsWith(`${comparableParent}/`);
}

export function relativePathWithinRoot(root: string, absolutePath: string): string | null {
  const normalizedRoot = comparablePath(root);
  const normalizedPath = comparablePath(absolutePath);
  if (normalizedPath !== normalizedRoot && !normalizedPath.startsWith(`${normalizedRoot}/`)) return null;
  return absolutePath.replace(/\\/g, "/").slice(root.replace(/\\/g, "/").replace(/\/+$/, "").length).replace(/^\//, "");
}

export function rebaseWindowsPath(path: string, oldPrefix: string, newPrefix: string): string | null {
  const rel = relativePathWithinRoot(oldPrefix, path);
  if (rel === null) return null;
  return rel ? joinWindowsRoot(newPrefix, rel) : newPrefix;
}

export function rebaseDocumentPath(path: string, oldPrefix: string, newPrefix: string): string | null {
  if (!isSameOrDescendantDocumentPath(path, oldPrefix)) return null;
  const normalized = normalizedPath(path);
  const normalizedOld = normalizedPath(oldPrefix);
  const normalizedNew = normalizedPath(newPrefix);
  return `${normalizedNew}${normalized.slice(normalizedOld.length)}`.replace(/^\//, "");
}

export function movedRelativePath(
  currentRelPath: string,
  sourceRelPath: string,
  targetRelDir: string,
  targetName = basename(sourceRelPath),
): string {
  const current = normalizedPath(currentRelPath);
  const source = normalizedPath(sourceRelPath);
  const target = normalizedPath(targetRelDir);
  const comparableCurrent = comparableDocumentPath(current);
  const comparableSource = comparableDocumentPath(source);
  const suffix = comparableCurrent === comparableSource
    ? ""
    : comparableCurrent.startsWith(`${comparableSource}/`)
        || comparableCurrent.startsWith(`${comparableSource}${ARCHIVE_ENTRY_SEPARATOR}`)
      ? current.slice(source.length)
      : null;
  if (suffix === null) return currentRelPath;
  return `${target ? `${target}/` : ""}${targetName}${suffix}`;
}

export function isDescendantPath(path: string, parent: string): boolean {
  const normalizedPath = comparablePath(path);
  const normalizedParent = comparablePath(parent);
  return normalizedPath.startsWith(`${normalizedParent}/`);
}

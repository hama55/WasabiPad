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

function comparable(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase("en-US");
}

export function relativePathWithinRoot(root: string, absolutePath: string): string | null {
  const normalizedRoot = comparable(root);
  const normalizedPath = comparable(absolutePath);
  if (normalizedPath !== normalizedRoot && !normalizedPath.startsWith(`${normalizedRoot}/`)) return null;
  return absolutePath.replace(/\\/g, "/").slice(root.replace(/\\/g, "/").replace(/\/+$/, "").length).replace(/^\//, "");
}

export function rebaseWindowsPath(path: string, oldPrefix: string, newPrefix: string): string | null {
  const rel = relativePathWithinRoot(oldPrefix, path);
  if (rel === null) return null;
  return rel ? joinWindowsRoot(newPrefix, rel) : newPrefix;
}

export function movedRelativePath(
  currentRelPath: string,
  sourceRelPath: string,
  targetRelDir: string,
  targetName = basename(sourceRelPath),
): string {
  const current = currentRelPath.replace(/\\/g, "/");
  const source = sourceRelPath.replace(/\\/g, "/").replace(/\/$/, "");
  const target = targetRelDir.replace(/\\/g, "/").replace(/\/$/, "");
  const suffix = current === source
    ? ""
    : current.startsWith(`${source}/`) || current.startsWith(`${source}::`)
      ? current.slice(source.length)
      : null;
  if (suffix === null) return currentRelPath;
  return `${target ? `${target}/` : ""}${targetName}${suffix}`;
}

export function isDescendantPath(path: string, parent: string): boolean {
  const normalizedPath = path.replace(/\\/g, "/").replace(/\/$/, "").toLocaleLowerCase("en-US");
  const normalizedParent = parent.replace(/\\/g, "/").replace(/\/$/, "").toLocaleLowerCase("en-US");
  return normalizedPath.startsWith(`${normalizedParent}/`);
}

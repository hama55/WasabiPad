export function basename(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() || path;
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

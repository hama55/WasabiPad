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

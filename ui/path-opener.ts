export interface PathOpener {
  open: (path: string) => Promise<void>;
  navigatePath: (path: string) => Promise<boolean>;
}

export function openPath(opener: PathOpener, path: string, newTab = false) {
  return newTab ? opener.open(path) : opener.navigatePath(path);
}

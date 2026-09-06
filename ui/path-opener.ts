export interface PathOpener {
  openInNewTab: (path: string) => Promise<boolean>;
  navigatePath: (path: string) => Promise<boolean>;
}

export function openPath(opener: PathOpener, path: string, newTab = false) {
  return newTab ? opener.openInNewTab(path) : opener.navigatePath(path);
}

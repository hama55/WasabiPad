export interface PathOpener {
  openInNewTab: (path: string) => Promise<boolean>;
  navigatePath: (path: string) => Promise<boolean>;
}

export function openPath(opener: PathOpener, path: string, newTab = false) {
  return newTab ? opener.openInNewTab(path) : opener.navigatePath(path);
}
import type { SidebarViewState } from "./sidebar";


export async function reopenFolderPreservingTree(
  opener: PathOpener,
  path: string,
  tree: { captureViewState: () => SidebarViewState; restoreViewState: (state: SidebarViewState) => Promise<void> },
  isCurrent: () => boolean,
): Promise<boolean> {
  const view = tree.captureViewState();
  if (!await openPath(opener, path)) return false;
  if (isCurrent()) await tree.restoreViewState({ ...view, search: null });
  return true;
}

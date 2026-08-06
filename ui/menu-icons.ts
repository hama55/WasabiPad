export const MENU_ICON = {
  explorer: "menu-icon-explorer",
  undo: "menu-icon-undo",
  redo: "menu-icon-redo",
  cut: "menu-icon-cut",
  copy: "menu-icon-copy",
  paste: "menu-icon-paste",
  delete: "menu-icon-delete",
  registeredString: "menu-icon-registered-string",
  selectAll: "menu-icon-select-all",
  csv: "menu-icon-csv",
  markdown: "menu-icon-markdown",
  external: "menu-icon-external",
  newTab: "menu-icon-new-tab",
  newWindow: "menu-icon-new-window",
  command: "menu-icon-command",
  address: "menu-icon-address",
  newMemo: "menu-icon-new-memo",
  rename: "menu-icon-rename",
  favorite: "menu-icon-favorite",
  more: "menu-icon-more",
  addGroupTabs: "menu-icon-add-group-tabs",
  addPath: "menu-icon-add-path",
  addGroup: "menu-icon-add-group",
  move: "menu-icon-move",
  close: "menu-icon-close",
  closeOthers: "menu-icon-close-others",
  closeRight: "menu-icon-close-right",
  closeSaved: "menu-icon-close-saved",
  chart: "menu-icon-chart",
} as const;

export type MenuIconClass = typeof MENU_ICON[keyof typeof MENU_ICON];
export type FavoriteIconClass = `fav-icon fav-icon-${"file" | "directory" | "group"}`;
export type MenuItemIconClass = MenuIconClass | FavoriteIconClass;

export function favoriteIconClass(kind: "file" | "directory" | "group"): FavoriteIconClass {
  return `fav-icon fav-icon-${kind}`;
}

export function createMenuIcon(iconClass: MenuItemIconClass): HTMLSpanElement {
  const icon = document.createElement("span");
  icon.className = iconClass.startsWith("menu-icon-") ? `menu-icon ${iconClass}` : iconClass;
  icon.setAttribute("aria-hidden", "true");
  return icon;
}

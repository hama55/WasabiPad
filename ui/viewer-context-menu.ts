import { createMenuIcon, MENU_ICON } from "./menu-icons";

export function createViewerChartMenuItem(onClick: () => void): HTMLButtonElement {
  const item = document.createElement("button");
  item.append(createMenuIcon(MENU_ICON.chart), document.createTextNode("グラフを作成..."));
  item.addEventListener("click", onClick);
  return item;
}

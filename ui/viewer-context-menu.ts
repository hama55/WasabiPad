import { createMenuIcon, MENU_ICON } from "./menu-icons";

export function createViewerNewTabMenuItem(onClick: () => void): HTMLButtonElement {
  const item = document.createElement("button");
  item.append(createMenuIcon(MENU_ICON.newTab), document.createTextNode("新規タブで開く"));
  item.addEventListener("click", onClick);
  return item;
}

export function createViewerChartMenuItem(onClick: () => void): HTMLButtonElement {
  const item = document.createElement("button");
  item.dataset.viewerAction = "chart";
  item.append(createMenuIcon(MENU_ICON.chart), document.createTextNode("グラフを作成..."));
  item.addEventListener("click", onClick);
  return item;
}

export function createViewerDelimiterMenuItem(onClick: () => void): HTMLButtonElement {
  const item = document.createElement("button");
  item.dataset.viewerAction = "delimiter";
  item.append(createMenuIcon(MENU_ICON.csv), document.createTextNode("区切り文字を変更..."));
  item.addEventListener("click", onClick);
  return item;
}

export function createViewerBrowserMenuItem(onClick: () => void): HTMLButtonElement {
  const item = document.createElement("button");
  item.append(createMenuIcon(MENU_ICON.external), document.createTextNode("規定のブラウザで表示"));
  item.addEventListener("click", onClick);
  return item;
}

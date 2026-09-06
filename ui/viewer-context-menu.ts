import { createMenuIcon, MENU_ICON } from "./menu-icons";

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

export function createViewerExternalMenuItem(
  onClick: () => void,
  label = "連携プレビューで開く",
): HTMLButtonElement {
  const item = document.createElement("button");
  item.dataset.viewerAction = "external-preview";
  item.append(createMenuIcon(MENU_ICON.external), document.createTextNode(label));
  item.addEventListener("click", onClick);
  return item;
}

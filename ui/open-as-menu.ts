import type * as api from "./api";
import type { MenuItem } from "./menu";
import { MENU_ICON, type MenuIconClass } from "./menu-icons";
import { MENU_LABELS } from "./menu-labels";
import { ARCHIVE_FORMATS, IMAGE_FORMATS } from "./generated/Protocol";
import { VIEWER_FORMATS } from "./viewer-formats";

// 「形式を指定して開く」の一覧はファイルツリーとエディタで同じ内容を表示する。
export function createOpenAsMenu(
  onOpenAs: (openAs: api.OpenAs) => void | Promise<unknown>,
): MenuItem {
  const openAsItem = (
    label: string,
    openAs: api.OpenAs,
    iconClass: MenuIconClass = MENU_ICON.text,
  ): MenuItem => ({
    label,
    iconClass,
    action: () => onOpenAs(openAs),
  });

  const viewerItems = Object.values(VIEWER_FORMATS)
    .filter((format) => format.openAs !== undefined)
    .sort((left, right) => left.openAs!.order - right.openAs!.order)
    .map((format) => openAsItem(format.extensions[0], format.openAs!.id, format.iconClass));
  const imageItems = IMAGE_FORMATS.map((extension) =>
    openAsItem(`.${extension}`, extension, MENU_ICON.image));
  const archiveItems = ARCHIVE_FORMATS.map((format) =>
    openAsItem(`.${format}`, format, format === "xlsx" || format === "xls" ? MENU_ICON.csv : MENU_ICON.more));

  return {
    label: MENU_LABELS.openWithFormat,
    iconClass: MENU_ICON.more,
    sub: [
      openAsItem(".txt", "txt"),
      ...viewerItems,
      {
        label: "画像",
        iconClass: MENU_ICON.image,
        sub: [
          openAsItem("自動判別", "image-auto", MENU_ICON.image),
          ...imageItems,
        ],
      },
      ...archiveItems,
    ],
  };
}

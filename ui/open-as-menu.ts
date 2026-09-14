import type * as api from "./api";
import type { MenuItem } from "./menu";
import { MENU_ICON, type MenuIconClass } from "./menu-icons";
import { MENU_LABELS } from "./menu-labels";

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

  return {
    label: MENU_LABELS.openWithFormat,
    iconClass: MENU_ICON.more,
    sub: [
      openAsItem(".txt", "txt"),
      openAsItem(".md", "md", MENU_ICON.markdown),
      openAsItem(".csv", "csv", MENU_ICON.csv),
      openAsItem(".html", "html", MENU_ICON.html),
      openAsItem(".pdf", "pdf", MENU_ICON.pdf),
      {
        label: "画像",
        iconClass: MENU_ICON.image,
        sub: [
          openAsItem("自動判別", "image-auto", MENU_ICON.image),
          openAsItem(".svg", "svg", MENU_ICON.image),
          openAsItem(".png", "png", MENU_ICON.image),
          openAsItem(".jpg", "jpg", MENU_ICON.image),
          openAsItem(".gif", "gif", MENU_ICON.image),
          openAsItem(".webp", "webp", MENU_ICON.image),
          openAsItem(".bmp", "bmp", MENU_ICON.image),
          openAsItem(".ico", "ico", MENU_ICON.image),
          openAsItem(".avif", "avif", MENU_ICON.image),
          openAsItem(".apng", "apng", MENU_ICON.image),
        ],
      },
      openAsItem(".zip", "zip", MENU_ICON.more),
      openAsItem(".7z", "7z", MENU_ICON.more),
      openAsItem(".xlsx", "xlsx", MENU_ICON.csv),
      openAsItem(".xls", "xls", MENU_ICON.csv),
    ],
  };
}

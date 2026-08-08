// 共有ドロップダウンメニュー (タイトルバーのメニュー・お気に入りグループ・右クリックで使用)
import { createMenuIcon, type MenuItemIconClass } from "./menu-icons";
import { isMiddleClick } from "./interaction-constants";

type MenuAction = (event?: MouseEvent) => void | Promise<unknown>;
type MenuTrailingAction = { label: string; title: string; action: () => void | Promise<unknown> };

interface MenuItemBase {
  label: string;
  iconClass: MenuItemIconClass;
  key?: string; // ショートカット表示
  trailing?: MenuTrailingAction | MenuTrailingAction[];
  sep?: boolean; // trueならこの項目の前に区切り線
  favPath?: string; // お気に入りツリー上の位置。並べ替えD&Dの掴み手/落とし先になる
  onContextMenu?: (x: number, y: number) => void;
}

type SubmenuItem = MenuItemBase & { sub: MenuItem[]; action?: never };
type LeafMenuItem = MenuItemBase & { sub?: never; action: MenuAction };

export type MenuItem = SubmenuItem | LeafMenuItem;

function hasSubmenu(item: MenuItem): item is SubmenuItem {
  return Array.isArray(item.sub);
}

interface MenuState {
  root: HTMLElement;
  panels: HTMLElement[];
}

const dd = () => document.getElementById("dropdown")!;
let activeMenu: MenuState | null = null;

function invokeMenuCallback(callback: () => void | Promise<unknown>) {
  try {
    void Promise.resolve(callback()).catch((error) => {
      console.error("メニュー操作に失敗しました", error);
    });
  } catch (error) {
    console.error("メニュー操作に失敗しました", error);
  }
}

function invokeLeaf(item: LeafMenuItem, event: MouseEvent) {
  hideMenu();
  invokeMenuCallback(() => item.action(event));
}

function positionMenu(el: HTMLElement, x: number, y: number) {
  el.style.left = "0px";
  el.style.top = "0px";
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.min(x, window.innerWidth - r.width - 4)}px`;
  el.style.top = `${Math.min(y, window.innerHeight - r.height - 4)}px`;
}

function showSubmenu(state: MenuState, parent: HTMLElement, x: number, y: number, items: MenuItem[]) {
  if (activeMenu !== state) return;
  const parentIndex = state.panels.indexOf(parent);
  if (parentIndex < 0) return;
  for (const menu of state.panels.splice(parentIndex + 1)) {
    menu.remove();
  }
  const submenu = document.createElement("div");
  submenu.className = "dd-menu dd-submenu";
  state.root.appendChild(submenu);
  state.panels.push(submenu);
  renderItems(state, submenu, items);
  submenu.hidden = false;
  positionMenu(submenu, x, y);
}

function renderItems(state: MenuState, el: HTMLElement, items: MenuItem[]) {
  for (const item of items) {
    if (item.sep) {
      const s = document.createElement("div");
      s.className = "dd-sep";
      el.appendChild(s);
    }
    const div = document.createElement("div");
    div.className = "dd-item";
    if (item.favPath) {
      div.dataset.favPath = item.favPath;
    }
    const label = document.createElement("span");
    label.className = "dd-label";
    label.append(createMenuIcon(item.iconClass));
    label.append(document.createTextNode(hasSubmenu(item) ? `${item.label} ▸` : item.label));
    div.appendChild(label);
    if (item.key) {
      const k = document.createElement("span");
      k.className = "dd-key";
      k.textContent = item.key;
      div.appendChild(k);
    }
    const trailingActions = item.trailing
      ? Array.isArray(item.trailing) ? item.trailing : [item.trailing]
      : [];
    if (trailingActions.length) {
      const trailingGroup = document.createElement("span");
      trailingGroup.className = "dd-trailing-actions";
      for (const trailingAction of trailingActions) {
        const trailing = document.createElement("button");
        trailing.className = "dd-trailing";
        trailing.textContent = trailingAction.label;
        trailing.title = trailingAction.title;
        trailing.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          hideMenu();
          invokeMenuCallback(trailingAction.action);
        });
        trailingGroup.appendChild(trailing);
      }
      div.appendChild(trailingGroup);
    }
    div.addEventListener("click", (e) => {
      e.stopPropagation();
      if (hasSubmenu(item)) {
        const r = div.getBoundingClientRect();
        showSubmenu(state, el, r.right, r.top, item.sub);
      } else {
        invokeLeaf(item, e);
      }
    });
    div.addEventListener("auxclick", (e) => {
      if (!isMiddleClick(e) || hasSubmenu(item)) return;
      e.preventDefault();
      e.stopPropagation();
      invokeLeaf(item, e);
    });
    const onContextMenu = item.onContextMenu;
    if (onContextMenu) {
      div.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        invokeMenuCallback(() => onContextMenu(e.clientX, e.clientY));
      });
    }
    el.appendChild(div);
  }
}

export function showMenu(x: number, y: number, items: MenuItem[]) {
  const el = dd();
  const state: MenuState = { root: el, panels: [el] };
  activeMenu = state;
  el.classList.add("dd-menu");
  el.replaceChildren();
  renderItems(state, el, items);
  el.hidden = false;
  positionMenu(el, x, y);
}

export function hideMenu() {
  const el = dd();
  el.hidden = true;
  // 非表示後も古い項目のイベントハンドラを保持しないため、DOMごと破棄する。
  el.replaceChildren();
  activeMenu = null;
}

window.addEventListener("mousedown", (e) => {
  if (!dd().contains(e.target as Node)) hideMenu();
});
window.addEventListener("blur", hideMenu);

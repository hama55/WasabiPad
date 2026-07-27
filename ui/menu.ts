// 共有ドロップダウンメニュー (タイトルバーのメニュー・お気に入りグループ・右クリックで使用)
export interface MenuItem {
  label: string;
  iconClass?: string;
  key?: string; // ショートカット表示
  trailing?: { label: string; title: string; action: () => void };
  action: (event?: MouseEvent) => void;
  sub?: MenuItem[];
  sep?: boolean; // trueならこの項目の前に区切り線
  favPath?: string; // お気に入りツリー上の位置。並べ替えD&Dの掴み手/落とし先になる
  onContextMenu?: (x: number, y: number) => void;
}

const dd = () => document.getElementById("dropdown")!;

export function showMenu(x: number, y: number, items: MenuItem[]) {
  const el = dd();
  el.replaceChildren();
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
      div.dataset.favDrag = item.favPath;
    }
    const label = document.createElement("span");
    label.className = "dd-label";
    if (item.iconClass) {
      const icon = document.createElement("span");
      icon.className = item.iconClass;
      label.append(icon);
    }
    label.append(document.createTextNode(item.sub ? `${item.label} ▸` : item.label));
    div.appendChild(label);
    if (item.key) {
      const k = document.createElement("span");
      k.className = "dd-key";
      k.textContent = item.key;
      div.appendChild(k);
    }
    if (item.trailing) {
      const trailing = document.createElement("button");
      trailing.className = "dd-trailing";
      trailing.textContent = item.trailing.label;
      trailing.title = item.trailing.title;
      trailing.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        hideMenu();
        item.trailing!.action();
      });
      div.appendChild(trailing);
    }
    div.addEventListener("click", (e) => {
      e.stopPropagation();
      if (item.sub) {
        const r = div.getBoundingClientRect();
        showMenu(r.right, r.top, item.sub);
      } else {
        hideMenu();
        item.action(e);
      }
    });
    div.addEventListener("auxclick", (e) => {
      if (e.button !== 1 || item.sub) return;
      e.preventDefault();
      e.stopPropagation();
      hideMenu();
      item.action(e);
    });
    if (item.onContextMenu) {
      div.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        item.onContextMenu!(e.clientX, e.clientY);
      });
    }
    el.appendChild(div);
  }
  el.hidden = false;
  el.style.left = "0px";
  el.style.top = "0px";
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.min(x, window.innerWidth - r.width - 4)}px`;
  el.style.top = `${Math.min(y, window.innerHeight - r.height - 4)}px`;
}

export function hideMenu() {
  dd().hidden = true;
}

window.addEventListener("mousedown", (e) => {
  if (!dd().contains(e.target as Node)) hideMenu();
});
window.addEventListener("blur", hideMenu);

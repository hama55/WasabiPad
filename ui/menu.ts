// 共有ドロップダウンメニュー (タイトルバーのメニュー・お気に入りグループ・右クリックで使用)
export interface MenuItem {
  label: string;
  iconClass?: string;
  key?: string; // ショートカット表示
  action: (event?: MouseEvent) => void;
  sub?: MenuItem[];
  sep?: boolean; // trueならこの項目の前に区切り線
  dragData?: string;
  dropData?: string;
  onDrop?: (source: string, target: string) => void;
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
    if (item.dragData) {
      div.draggable = true;
      div.addEventListener("dragstart", (e) => {
        e.dataTransfer?.setData("application/x-wasabipad-favorite", item.dragData!);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      });
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
    if (item.dropData && item.onDrop) {
      let openTimer: number | undefined;
      div.addEventListener("dragover", (e) => {
        e.preventDefault();
        div.classList.add("dd-drop");
        if (item.sub && openTimer === undefined) {
          openTimer = window.setTimeout(() => {
            const r = div.getBoundingClientRect();
            showMenu(r.right, r.top, item.sub!);
          }, 650);
        }
      });
      div.addEventListener("dragleave", () => {
        div.classList.remove("dd-drop");
        window.clearTimeout(openTimer);
        openTimer = undefined;
      });
      div.addEventListener("drop", (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.clearTimeout(openTimer);
        const source = e.dataTransfer?.getData("application/x-wasabipad-favorite");
        if (source) item.onDrop!(source, item.dropData!);
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

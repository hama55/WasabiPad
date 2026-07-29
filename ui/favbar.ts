import { BmNode, loadBookmarks, pathIsDirectory, saveBookmarks } from "./api";
import { hideMenu, showMenu, MenuItem } from "./menu";
import { promptFields } from "./prompt";

type NodePath = number[];
type DropKind = "before" | "inside" | "after";
// お気に入りバーの空白部分に落とした場合はトップレベル末尾へ
type DropSpot = { kind: "root" } | { kind: DropKind; path: NodePath; el: HTMLElement };

const DRAG_THRESHOLD = 5;
const GROUP_OPEN_DELAY = 650;
const DROP_CLASSES = ["fav-drop", "fav-drop-before", "fav-drop-after"];

// お気に入りの保存先。既定は backend のブックマークファイル。
export interface BookmarkStore {
  load: () => Promise<BmNode[]>;
  save: (nodes: BmNode[]) => Promise<void>;
  isDirectory: (path: string) => Promise<boolean>;
}

export const bookmarkStore: BookmarkStore = {
  load: loadBookmarks,
  save: saveBookmarks,
  isDirectory: pathIsDirectory,
};

export interface FavBarPorts {
  onOpen: (path: string, newWindow: boolean) => void;
  onAddGroupToTabs: (items: { path: string; kind: "file" | "folder" }[]) => void;
  currentFile: () => string | null;
  onSetDefault: (path: string) => void;
  onError: (error: unknown) => Promise<void>;
}

export class FavBar {
  private nodes: BmNode[] = [];
  private pending: { source: NodePath; x: number; y: number } | null = null;
  private drag: {
    source: NodePath;
    ghost: HTMLElement;
    spot: DropSpot | null;
    openTimer?: number;
    openedFor: string | null;
  } | null = null;
  private justDragged = false;
  private menuRoot = document.getElementById("dropdown");
  private onOpen: (path: string, newWindow: boolean) => void;
  private onAddGroupToTabs: FavBarPorts["onAddGroupToTabs"];
  private currentFile: () => string | null;
  private onSetDefault: (path: string) => void;
  private onError: (error: unknown) => Promise<void>;

  constructor(
    private host: HTMLElement,
    ports: FavBarPorts,
    private store: BookmarkStore = bookmarkStore
  ) {
    this.onOpen = ports.onOpen;
    this.onAddGroupToTabs = ports.onAddGroupToTabs;
    this.currentFile = ports.currentFile;
    this.onSetDefault = ports.onSetDefault;
    this.onError = ports.onError;
    this.host.addEventListener("contextmenu", (e) => {
      if (e.target !== this.host) return;
      e.preventDefault();
      showMenu(e.clientX, e.clientY, [
        { label: "パスを追加...", action: () => this.addPath() },
        { label: "グループを追加...", action: () => this.addGroup() },
      ]);
    });
    // WebView2 のネイティブ drag-drop が HTML5 DnD を奪うため pointer で自作する
    this.host.addEventListener("pointerdown", this.onPointerDown);
    this.menuRoot?.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("click", this.swallowClickAfterDrag, true);
  }

  async init() {
    this.nodes = await this.store.load();
    this.render();
  }

  private render() {
    const frag = document.createDocumentFragment();
    this.nodes.forEach((node, i) => frag.appendChild(this.button(node, [i])));
    this.host.replaceChildren(frag);
  }

  private button(node: BmNode, path: NodePath): HTMLButtonElement {
    const button = document.createElement("button");
    button.dataset.favPath = path.join(".");
    button.dataset.favDrag = path.join(".");
    button.append(this.icon(node.kind), document.createTextNode(node.name));

    if (node.kind === "group") {
      button.append(document.createTextNode(" ▾"));
      button.addEventListener("click", (e) => {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        showMenu(rect.left, rect.bottom, this.groupItems(node.children, path));
      });
    } else {
      button.title = node.path;
      button.addEventListener("click", (e) => this.onOpen(node.path, e.ctrlKey));
      button.addEventListener("auxclick", (e) => {
        if (e.button === 1) this.onOpen(node.path, true);
      });
    }

    button.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showMenu(e.clientX, e.clientY, this.contextItems(node, path));
    });
    return button;
  }

  private icon(kind: BmNode["kind"]): HTMLElement {
    const icon = document.createElement("span");
    icon.className = `fav-icon fav-icon-${kind}`;
    return icon;
  }

  private groupItems(children: BmNode[], parent: NodePath): MenuItem[] {
    return children.map((child, index) => {
      const path = [...parent, index];
      const common = {
        favPath: path.join("."),
        iconClass: `fav-icon fav-icon-${child.kind}`,
      };
      const onContextMenu = (x: number, y: number) => showMenu(x, y, this.contextItems(child, path));
      return child.kind === "group"
        ? {
            ...common,
            onContextMenu,
            label: child.name,
            action: () => {},
            sub: this.groupItems(child.children, path),
          }
        : {
            ...common,
            onContextMenu,
            label: child.name,
            action: (e?: MouseEvent) => this.onOpen(child.path, e?.ctrlKey || e?.button === 1),
          };
    });
  }

  private contextItems(node: BmNode, path: NodePath): MenuItem[] {
    const items: MenuItem[] = [];
    if (node.kind === "group") {
      items.push(
        {
          label: "直下の項目をタブに一括追加",
          action: () => this.onAddGroupToTabs(node.children.flatMap((child) =>
            child.kind === "group" ? [] : [{
              path: child.path,
              kind: child.kind === "directory" ? "folder" as const : "file" as const,
            }]
          )),
        },
        { label: "パスを追加...", action: () => this.addPath(path), sep: true },
        { label: "グループを追加...", action: () => this.addGroup(path) }
      );
    } else {
      items.push(
        { label: "新規タブで開く", action: () => this.onOpen(node.path, true) },
        { label: "デフォルトに設定", action: () => this.onSetDefault(node.path), sep: true },
        { label: "編集...", action: () => this.editPath(path) }
      );
    }
    items.push(
      { label: "移動", action: () => {}, sub: this.moveDestinations(path), sep: true },
      { label: "削除", action: () => this.remove(path) }
    );
    return items;
  }

  private moveDestinations(source: NodePath): MenuItem[] {
    const items: MenuItem[] = [{ label: "お気に入りバー", action: () => this.moveTo(source, null) }];
    const visit = (nodes: BmNode[], parent: NodePath, names: string[]) => {
      nodes.forEach((node, index) => {
        if (node.kind !== "group") return;
        const path = [...parent, index];
        const isSourceOrChild = path.length >= source.length && source.every((part, i) => path[i] === part);
        if (isSourceOrChild) return;
        const groupNames = [...names, node.name];
        items.push({ label: groupNames.join(" / "), action: () => this.moveTo(source, path) });
        visit(node.children, path, groupNames);
      });
    };
    visit(this.nodes, [], []);
    return items;
  }

  private listAt(path: NodePath): BmNode[] | null {
    let list = this.nodes;
    for (const index of path) {
      const node = list[index];
      if (!node || node.kind !== "group") return null;
      list = node.children;
    }
    return list;
  }

  private nodeAt(path: NodePath): BmNode | null {
    if (!path.length) return null;
    return this.listAt(path.slice(0, -1))?.[path.at(-1)!] ?? null;
  }

  private childrenAt(path: NodePath): BmNode[] | null {
    const node = this.nodeAt(path);
    return node?.kind === "group" ? node.children : null;
  }

  private decodePath(raw: string): NodePath | null {
    if (!/^\d+(\.\d+)*$/.test(raw)) return null;
    return raw.split(".").map(Number);
  }

  private onPointerDown = (e: PointerEvent) => {
    this.justDragged = false;
    if (e.button !== 0) return;
    const origin = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-fav-drag]");
    const source = origin ? this.decodePath(origin.dataset.favDrag ?? "") : null;
    if (!source) return;
    this.pending = { source, x: e.clientX, y: e.clientY };
    // ウィンドウ外で指を離しても pointerup を受け取れるようにする
    origin!.setPointerCapture?.(e.pointerId);
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("keydown", this.onDragKey);
  };

  private onPointerMove = (e: PointerEvent) => {
    const pending = this.pending;
    if (pending && Math.hypot(e.clientX - pending.x, e.clientY - pending.y) >= DRAG_THRESHOLD) {
      this.pending = null;
      this.drag = { source: pending.source, ghost: this.spawnGhost(pending.source), spot: null, openedFor: null };
    }
    if (this.drag) this.track(this.drag, e.clientX, e.clientY);
  };

  private onPointerUp = () => {
    const drag = this.drag;
    this.endDrag();
    if (!drag) return;
    this.justDragged = true;
    hideMenu();
    void this.applyDrop(drag.source, drag.spot).catch((error) => this.reportDropError(error));
  };

  private onDragKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") this.endDrag();
  };

  // ドラッグ直後のclickはD&Dの副産物 → 「開く」に化けさせない
  private swallowClickAfterDrag = (e: MouseEvent) => {
    const target = e.target as Node | null;
    const mine = !!target && (this.host.contains(target) || !!this.menuRoot?.contains(target));
    if (!this.justDragged || !mine) return;
    this.justDragged = false;
    e.stopPropagation();
    e.preventDefault();
  };

  private track(drag: NonNullable<FavBar["drag"]>, x: number, y: number) {
    drag.ghost.style.transform = `translate(${x + 12}px, ${y + 12}px)`;
    drag.spot = this.resolveSpot(x, y);
    this.paint(drag.spot);
    this.scheduleGroupOpen(drag);
  }

  private resolveSpot(x: number, y: number): DropSpot | null {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const holder = el?.closest<HTMLElement>("[data-fav-path]") ?? null;
    if (!holder) return el?.closest("#favbar") ? { kind: "root" } : null;
    const path = this.decodePath(holder.dataset.favPath ?? "");
    if (!path) return null;
    return { kind: this.dropKind(holder, x, y, this.nodeAt(path)?.kind === "group"), path, el: holder };
  }

  // メニューは縦並び・バーは横並びなので挿入判定に使う軸を切り替える
  private dropKind(el: HTMLElement, x: number, y: number, isGroup: boolean): DropKind {
    const rect = el.getBoundingClientRect();
    const ratio = el.closest("#dropdown") ? (y - rect.top) / rect.height : (x - rect.left) / rect.width;
    if (isGroup && ratio >= 0.3 && ratio <= 0.7) return "inside";
    return ratio < 0.5 ? "before" : "after";
  }

  private paint(spot: DropSpot | null) {
    for (const el of document.querySelectorAll(`.${DROP_CLASSES.join(", .")}`)) el.classList.remove(...DROP_CLASSES);
    this.host.classList.toggle("fav-drop-root", spot?.kind === "root");
    if (!spot || spot.kind === "root") return;
    spot.el.classList.add(spot.kind === "inside" ? "fav-drop" : `fav-drop-${spot.kind}`);
  }

  // グループ上に留まったら中身を開き、入れ子への投入と並べ替えを可能にする
  private scheduleGroupOpen(drag: NonNullable<FavBar["drag"]>) {
    const spot = drag.spot;
    const key = spot?.kind === "inside" ? spot.path.join(".") : null;
    if (key === drag.openedFor) return;
    window.clearTimeout(drag.openTimer);
    drag.openedFor = key;
    if (!key || spot?.kind !== "inside") return;
    const children = this.childrenAt(spot.path);
    if (!children) return;
    drag.openTimer = window.setTimeout(() => {
      const rect = spot.el.getBoundingClientRect();
      const nested = !!spot.el.closest("#dropdown");
      const x = nested ? rect.right : rect.left;
      const y = nested ? rect.top : rect.bottom;
      showMenu(x, y, this.groupItems(children, spot.path));
    }, GROUP_OPEN_DELAY);
  }

  private spawnGhost(source: NodePath): HTMLElement {
    const ghost = document.createElement("div");
    ghost.className = "fav-ghost";
    ghost.textContent = this.nodeAt(source)?.name ?? "";
    document.body.appendChild(ghost);
    return ghost;
  }

  private endDrag() {
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("keydown", this.onDragKey);
    this.pending = null;
    if (!this.drag) return;
    window.clearTimeout(this.drag.openTimer);
    this.drag.ghost.remove();
    this.drag = null;
    this.paint(null);
  }

  private async applyDrop(source: NodePath, spot: DropSpot | null) {
    if (!spot) return;
    const before = structuredClone(this.nodes);
    try {
      if (spot.kind === "root") await this.moveTo(source, null);
      else if (spot.kind === "inside") await this.moveTo(source, spot.path);
      else await this.moveAdjacent(source, spot.path, spot.kind === "after");
    } catch (error) {
      this.nodes = before;
      this.render();
      throw error;
    }
  }

  private async reportDropError(error: unknown) {
    try {
      await this.onError(error);
    } catch (reportError) {
      console.error("お気に入りの移動エラーを表示できませんでした", reportError);
    }
  }

  private async moveAdjacent(source: NodePath, target: NodePath, after: boolean) {
    if (source.join(".") === target.join(".")) return;
    if (target.length > source.length && source.every((part, i) => target[i] === part)) return;
    const sourceList = this.listAt(source.slice(0, -1));
    const targetNode = this.nodeAt(target);
    const node = sourceList?.[source.at(-1)!];
    if (!sourceList || !targetNode || !node) return;
    sourceList.splice(source.at(-1)!, 1);
    const targetList = this.findParentList(targetNode, this.nodes);
    if (!targetList) return;
    const targetIndex = targetList.indexOf(targetNode);
    targetList.splice(targetIndex + (after ? 1 : 0), 0, node);
    await this.persist();
  }

  private findParentList(target: BmNode, nodes: BmNode[]): BmNode[] | null {
    if (nodes.includes(target)) return nodes;
    for (const node of nodes) {
      if (node.kind !== "group") continue;
      const found = this.findParentList(target, node.children);
      if (found) return found;
    }
    return null;
  }

  private async moveTo(source: NodePath, target: NodePath | null) {
    if (target && target.length >= source.length && source.every((n, i) => target[i] === n)) return;
    const sourceList = this.listAt(source.slice(0, -1));
    const node = sourceList?.[source.at(-1)!];
    const targetList = target ? this.childrenAt(target) : this.nodes;
    if (!sourceList || !node || !targetList) return;
    sourceList.splice(source.at(-1)!, 1);
    targetList.push(node);
    await this.persist();
  }

  private async addPath(parent: NodePath = []) {
    const result = await promptFields("パスを追加", [{ label: "パス", value: "" }]);
    const raw = result?.[0].trim() ?? "";
    const path = raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')
      ? raw.slice(1, -1)
      : raw;
    if (path) await this.addPaths([path], parent);
  }

  async addDropped(paths: string[], x: number, y: number) {
    const target = document.elementFromPoint(x, y)?.closest<HTMLElement>("#favbar [data-fav-path]");
    const targetPath = target?.dataset.favPath ? this.decodePath(target.dataset.favPath) : null;
    await this.addPaths(paths, targetPath ?? undefined);
  }

  private async addPaths(paths: string[], parent: NodePath = []) {
    const list = parent.length ? this.childrenAt(parent) : this.nodes;
    if (!list) return;
    for (const path of paths) {
      const name = path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? path;
      list.push({ kind: await this.store.isDirectory(path) ? "directory" : "file", name, path });
    }
    await this.persist();
  }

  private async addGroup(parent: NodePath = []) {
    const result = await promptFields("グループを追加", [{ label: "グループ名", value: "" }]);
    const name = result?.[0].trim();
    if (!name) return;
    const list = parent.length ? this.childrenAt(parent) : this.nodes;
    if (!list) return;
    list.push({ kind: "group", name, children: [] });
    await this.persist();
  }

  async addCurrent() {
    const raw = this.currentFile();
    if (raw) await this.addPaths([raw.replace(/[\\/]+$/, "") || raw]);
  }

  async addExternal(path: string) {
    await this.addPaths([path.replace(/[\\/]+$/, "") || path]);
  }

  private async editPath(path: NodePath) {
    const node = this.nodeAt(path);
    if (!node || node.kind === "group") return;
    const result = await promptFields("お気に入りを編集", [
      { label: "表示名", value: node.name },
      { label: "パス", value: node.path },
    ]);
    if (!result?.[0].trim() || !result[1].trim()) return;
    Object.assign(node, { name: result[0].trim(), path: result[1].trim(), kind: await this.store.isDirectory(result[1].trim()) ? "directory" : "file" });
    await this.persist();
  }

  private async remove(path: NodePath) {
    this.listAt(path.slice(0, -1))?.splice(path.at(-1)!, 1);
    await this.persist();
  }

  private async persist() {
    await this.store.save(this.nodes);
    this.render();
  }
}

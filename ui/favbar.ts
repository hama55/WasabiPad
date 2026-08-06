import { BmNode, loadBookmarks, pathIsDirectory, saveBookmarks } from "./api";
import { hideMenu, showMenu, MenuItem } from "./menu";
import { promptFields } from "./prompt";
import { revealInExplorer } from "./folder-actions";
import { DRAG_THRESHOLD } from "./interaction-constants";
import { favoriteIconClass, MENU_ICON } from "./menu-icons";
import { MENU_LABELS } from "./menu-labels";

type NodePath = number[];
type DropKind = "before" | "inside" | "after";
// お気に入りバーの空白部分に落とした場合はトップレベル末尾へ
type DropSpot = { kind: "root" } | { kind: DropKind; path: NodePath; el: HTMLElement };

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
  onOpen: (path: string, newTab: boolean) => unknown;
  onAddGroupToTabs: (items: { path: string; kind: "file" | "folder" }[]) => void;
  currentFile: () => string | null;
  onError: (error: unknown) => Promise<void>;
}

export class FavBar {
  private nodes: BmNode[] = [];
  private loadFailed = false;
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
  private onOpen: (path: string, newTab: boolean) => void;
  private onAddGroupToTabs: FavBarPorts["onAddGroupToTabs"];
  private currentFile: () => string | null;
  private onError: (error: unknown) => Promise<void>;

  constructor(
    private host: HTMLElement,
    ports: FavBarPorts,
    private store: BookmarkStore = bookmarkStore
  ) {
    this.onOpen = ports.onOpen;
    this.onAddGroupToTabs = ports.onAddGroupToTabs;
    this.currentFile = ports.currentFile;
    this.onError = ports.onError;
    this.host.addEventListener("contextmenu", (e) => {
      if (e.target !== this.host) return;
      e.preventDefault();
      showMenu(e.clientX, e.clientY, [
        { label: "パスを追加...", iconClass: MENU_ICON.addPath, action: () => this.runMutation(() => this.addPath()) },
        { label: "グループを追加...", iconClass: MENU_ICON.addGroup, action: () => this.runMutation(() => this.addGroup()) },
      ]);
    });
    // WebView2 のネイティブ drag-drop が HTML5 DnD を奪うため pointer で自作する
    this.host.addEventListener("pointerdown", this.onPointerDown);
    this.menuRoot?.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("click", this.swallowClickAfterDrag, true);
  }

  async init() {
    try {
      this.nodes = await this.store.load();
      this.loadFailed = false;
    } catch (error) {
      this.loadFailed = true;
      await this.reportDropError(error);
    }
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
    button.append(this.icon(node.kind), document.createTextNode(node.name));

    if (node.kind === "group") {
      button.append(document.createTextNode(" ▾"));
      button.addEventListener("click", (e) => {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        showMenu(rect.left, rect.bottom, this.groupItems(node.children, path));
      });
    } else {
      button.title = node.path;
      button.addEventListener("click", (e) => this.runOpen(node.path, e.ctrlKey));
      button.addEventListener("auxclick", (e) => {
        if (e.button === 1) this.runOpen(node.path, true);
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
    icon.className = favoriteIconClass(kind);
    return icon;
  }

  private groupItems(children: BmNode[], parent: NodePath): MenuItem[] {
    return children.map((child, index) => {
      const path = [...parent, index];
      const common = {
        favPath: path.join("."),
        iconClass: favoriteIconClass(child.kind),
      };
      const onContextMenu = (x: number, y: number) => showMenu(x, y, this.contextItems(child, path));
      return child.kind === "group"
        ? {
            ...common,
            onContextMenu,
            label: child.name,
            sub: this.groupItems(child.children, path),
          }
        : {
            ...common,
            onContextMenu,
            label: child.name,
            action: (e?: MouseEvent) => this.runOpen(child.path, Boolean(e?.ctrlKey || e?.button === 1)),
          };
    });
  }

  private contextItems(node: BmNode, path: NodePath): MenuItem[] {
    const items: MenuItem[] = [];
    if (node.kind === "group") {
      items.push(
        {
          label: "直下の項目をタブに一括追加",
          iconClass: MENU_ICON.addGroupTabs,
          action: () => this.onAddGroupToTabs(node.children.flatMap((child) =>
            child.kind === "group" ? [] : [{
              path: child.path,
              kind: child.kind === "directory" ? "folder" as const : "file" as const,
            }]
          )),
        },
        { label: "パスを追加...", iconClass: MENU_ICON.addPath, action: () => this.runMutation(() => this.addPath(path)), sep: true },
        { label: "グループを追加...", iconClass: MENU_ICON.addGroup, action: () => this.runMutation(() => this.addGroup(path)) }
      );
    } else {
      items.push(
        { label: MENU_LABELS.explorer, iconClass: MENU_ICON.explorer, action: () => this.runMutation(() => revealInExplorer(node.path, node.kind === "directory")) },
        { label: MENU_LABELS.newTab, iconClass: MENU_ICON.newTab, action: () => this.runOpen(node.path, true) },
        { label: "編集...", iconClass: MENU_ICON.rename, action: () => this.runMutation(() => this.editPath(path)), sep: true }
      );
    }
    items.push(
      { label: "移動", iconClass: MENU_ICON.move, sub: this.moveDestinations(path), sep: node.kind === "group" },
      { label: MENU_LABELS.delete, iconClass: MENU_ICON.delete, action: () => this.runMutation(() => this.remove(path)), sep: true }
    );
    return items;
  }

  private moveDestinations(source: NodePath): MenuItem[] {
    const items: MenuItem[] = [{
      label: "お気に入りバー",
      action: () => this.runMutation(() => this.moveTo(source, null)),
    }];
    const visit = (nodes: BmNode[], parent: NodePath, names: string[]) => {
      nodes.forEach((node, index) => {
        if (node.kind !== "group") return;
        const path = [...parent, index];
        const isSourceOrChild = path.length >= source.length && source.every((part, i) => path[i] === part);
        if (isSourceOrChild) return;
        const groupNames = [...names, node.name];
        items.push({
          label: groupNames.join(" / "),
          action: () => this.runMutation(() => this.moveTo(source, path)),
        });
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
    const origin = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-fav-path]");
    const source = origin ? this.decodePath(origin.dataset.favPath ?? "") : null;
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
    if (spot.kind === "root") await this.moveTo(source, null);
    else if (spot.kind === "inside") await this.moveTo(source, spot.path);
    else await this.moveAdjacent(source, spot.path, spot.kind === "after");
  }

  private async reportDropError(error: unknown) {
    try {
      await this.onError(error);
    } catch (reportError) {
      console.error("お気に入りの移動エラーを表示できませんでした", reportError);
    }
  }

  private runMutation(operation: () => Promise<void>) {
    try {
      void Promise.resolve(operation()).catch((error) => this.reportDropError(error));
    } catch (error) {
      void this.reportDropError(error);
    }
  }

  private runOpen(path: string, newTab: boolean) {
    try {
      void Promise.resolve(this.onOpen(path, newTab)).catch((error) => this.reportDropError(error));
    } catch (error) {
      void this.reportDropError(error);
    }
  }

  private async moveAdjacent(source: NodePath, target: NodePath, after: boolean) {
    if (source.join(".") === target.join(".")) return;
    if (target.length > source.length && source.every((part, i) => target[i] === part)) return;
    const sourceList = this.listAt(source.slice(0, -1));
    const targetNode = this.nodeAt(target);
    const node = sourceList?.[source.at(-1)!];
    if (!sourceList || !targetNode || !node) return;
    await this.mutateAndPersist(() => {
      sourceList.splice(source.at(-1)!, 1);
      const targetList = this.findParentList(targetNode, this.nodes);
      if (!targetList) return;
      const targetIndex = targetList.indexOf(targetNode);
      targetList.splice(targetIndex + (after ? 1 : 0), 0, node);
    });
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
    await this.mutateAndPersist(() => {
      sourceList.splice(source.at(-1)!, 1);
      targetList.push(node);
    });
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
    const additions = await Promise.all(paths.map(async (path): Promise<BmNode> => {
      const name = path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? path;
      return { kind: await this.store.isDirectory(path) ? "directory" : "file", name, path };
    }));
    await this.mutateAndPersist(() => list.push(...additions));
  }

  private async addGroup(parent: NodePath = []) {
    const result = await promptFields("グループを追加", [{ label: "グループ名", value: "" }]);
    const name = result?.[0].trim();
    if (!name) return;
    const list = parent.length ? this.childrenAt(parent) : this.nodes;
    if (!list) return;
    await this.mutateAndPersist(() => {
      list.push({ kind: "group", name, children: [] });
    });
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
    const next = {
      name: result[0].trim(),
      path: result[1].trim(),
      kind: await this.store.isDirectory(result[1].trim()) ? "directory" as const : "file" as const,
    };
    await this.mutateAndPersist(() => {
      Object.assign(node, next);
    });
  }

  private async remove(path: NodePath) {
    await this.mutateAndPersist(() => {
      this.listAt(path.slice(0, -1))?.splice(path.at(-1)!, 1);
    });
  }

  private async mutateAndPersist(mutate: () => void) {
    if (this.loadFailed) {
      throw new Error("お気に入りを読み込めないため変更を保存できません");
    }
    const before = structuredClone(this.nodes);
    try {
      mutate();
      await this.store.save(this.nodes);
    } catch (error) {
      this.nodes = before;
      try {
        this.render();
      } catch (renderError) {
        console.error("お気に入りの失敗状態を画面へ戻せませんでした", renderError);
      }
      throw error;
    }
    // 保存済みの変更を、後続の描画失敗で巻き戻すとメモリとディスクが不一致になる。
    this.render();
  }
}

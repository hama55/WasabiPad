import { BmNode, loadBookmarks, pathIsDirectory, saveBookmarks } from "./api";
import { hideMenu, showMenu, MenuItem } from "./menu";
import { promptFields } from "./prompt";

type NodePath = number[];

export class FavBar {
  private nodes: BmNode[] = [];

  constructor(
    private host: HTMLElement,
    private onOpen: (path: string, newWindow: boolean) => void,
    private currentFile: () => string | null,
    private onSetDefault: (path: string) => void
  ) {
    this.host.addEventListener("contextmenu", (e) => {
      if (e.target !== this.host) return;
      e.preventDefault();
      showMenu(e.clientX, e.clientY, [
        { label: "パスを追加...", action: () => this.addPath() },
        { label: "グループを追加...", action: () => this.addGroup() },
      ]);
    });
    this.host.addEventListener("dragover", (e) => {
      if (e.target === this.host && e.dataTransfer?.types.includes("application/x-wasabipad-favorite")) e.preventDefault();
    });
    this.host.addEventListener("drop", (e) => {
      if (e.target !== this.host) return;
      const source = this.decodePath(e.dataTransfer?.getData("application/x-wasabipad-favorite") ?? "");
      if (source) { e.preventDefault(); void this.moveTo(source, null); }
    });
  }

  async init() {
    this.nodes = await loadBookmarks();
    this.render();
  }

  private render() {
    const frag = document.createDocumentFragment();
    this.nodes.forEach((node, i) => frag.appendChild(this.button(node, [i])));
    this.host.replaceChildren(frag);
  }

  private button(node: BmNode, path: NodePath): HTMLButtonElement {
    const button = document.createElement("button");
    button.draggable = true;
    button.dataset.favPath = path.join(".");
    button.append(this.icon(node.kind), document.createTextNode(node.name));

    if (node.kind === "group") {
      let openTimer: number | undefined;
      button.append(document.createTextNode(" ▾"));
      button.addEventListener("click", (e) => {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        showMenu(rect.left, rect.bottom, this.groupItems(node.children, path));
      });
      button.addEventListener("dragover", (e) => {
        e.preventDefault();
        const position = this.dropPosition(button, e.clientX);
        button.classList.toggle("fav-drop", position === "inside");
        button.classList.toggle("fav-drop-before", position === "before");
        button.classList.toggle("fav-drop-after", position === "after");
        if (position === "inside" && openTimer === undefined) {
          openTimer = window.setTimeout(() => {
            const rect = button.getBoundingClientRect();
            showMenu(rect.left, rect.bottom, this.groupItems(node.children, path));
          }, 650);
        }
      });
      button.addEventListener("dragleave", () => {
        button.classList.remove("fav-drop", "fav-drop-before", "fav-drop-after");
        window.clearTimeout(openTimer);
        openTimer = undefined;
      });
      button.addEventListener("drop", async (e) => {
        e.preventDefault();
        window.clearTimeout(openTimer);
        button.classList.remove("fav-drop", "fav-drop-before", "fav-drop-after");
        const source = this.decodePath(e.dataTransfer?.getData("application/x-wasabipad-favorite") ?? "");
        if (!source) return;
        const position = this.dropPosition(button, e.clientX);
        if (position === "inside") await this.moveInto(source, path);
        else await this.moveAdjacent(source, path, position === "after");
      });
    } else {
      button.title = node.path;
      button.addEventListener("click", (e) => this.onOpen(node.path, e.ctrlKey));
      button.addEventListener("auxclick", (e) => {
        if (e.button === 1) this.onOpen(node.path, true);
      });
      button.addEventListener("dragover", (e) => {
        e.preventDefault();
        const after = this.dropPosition(button, e.clientX) === "after";
        button.classList.toggle("fav-drop-before", !after);
        button.classList.toggle("fav-drop-after", after);
      });
      button.addEventListener("dragleave", () => button.classList.remove("fav-drop-before", "fav-drop-after"));
      button.addEventListener("drop", async (e) => {
        e.preventDefault();
        button.classList.remove("fav-drop-before", "fav-drop-after");
        const source = this.decodePath(e.dataTransfer?.getData("application/x-wasabipad-favorite") ?? "");
        if (source) await this.moveAdjacent(source, path, this.dropPosition(button, e.clientX) === "after");
      });
    }

    button.addEventListener("dragstart", (e) => {
      e.dataTransfer?.setData("application/x-wasabipad-favorite", path.join("."));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
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
        dragData: path.join("."),
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
            dropData: path.join("."),
            onDrop: (source: string, target: string) => {
              const from = this.decodePath(source);
              const to = this.decodePath(target);
              if (from && to) {
                hideMenu();
                void this.moveInto(from, to);
              }
            },
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
        { label: "パスを追加...", action: () => this.addPath(path) },
        { label: "グループを追加...", action: () => this.addGroup(path) }
      );
    } else {
      items.push(
        { label: "デフォルトに設定", action: () => this.onSetDefault(node.path) },
        { label: "編集...", action: () => this.editPath(path) }
      );
    }
    items.push(
      { label: "移動", action: () => {}, sub: this.moveDestinations(path) },
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

  private async moveInto(source: NodePath, target: NodePath) {
    await this.moveTo(source, target);
  }

  private dropPosition(button: HTMLElement, clientX: number): "before" | "inside" | "after" {
    const rect = button.getBoundingClientRect();
    const ratio = (clientX - rect.left) / rect.width;
    if (button.querySelector(".fav-icon-group") && ratio >= 0.3 && ratio <= 0.7) return "inside";
    return ratio < 0.5 ? "before" : "after";
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
      list.push({ kind: await pathIsDirectory(path) ? "directory" : "file", name, path });
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
    Object.assign(node, { name: result[0].trim(), path: result[1].trim(), kind: await pathIsDirectory(result[1].trim()) ? "directory" : "file" });
    await this.persist();
  }

  private async remove(path: NodePath) {
    this.listAt(path.slice(0, -1))?.splice(path.at(-1)!, 1);
    await this.persist();
  }

  private async persist() {
    await saveBookmarks(this.nodes);
    this.render();
  }
}

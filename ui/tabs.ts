import type { Pos } from "./api";
import type { DocumentController } from "./document-controller";
import type { DocumentSession } from "./session";
import { basename } from "./path";
import { showMenu, type MenuItem } from "./menu";

export interface StoredTab {
  id: string;
  path: string | null;
  kind: "file" | "folder" | "blank";
  label: string;
  goto?: Pos;
}

export interface StoredTabs {
  tabs: StoredTab[];
  activeId: string | null;
}

interface TabPorts {
  onChange: (state: StoredTabs) => void;
}

const newId = () => `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const DRAG_THRESHOLD = 5;
type DropSpot = { targetId: string | null; after: boolean; el?: HTMLElement };

export class TabManager {
  private tabs: StoredTab[] = [];
  private activeId = "";
  private transitionTarget: string | null = null;
  private pendingDrag: { sourceId: string; x: number; y: number } | null = null;
  private drag: { sourceId: string; ghost: HTMLElement; spot: DropSpot | null } | null = null;
  private justDragged = false;

  constructor(private host: HTMLElement, private doc: DocumentController, private ports: TabPorts) {
    // WebView2ではネイティブDnDがHTML5 DnDを奪うため、お気に入りバーと同じpointer方式を使う。
    this.host.addEventListener("pointerdown", this.onPointerDown);
    this.host.addEventListener("click", this.swallowClickAfterDrag, true);
  }

  get state(): StoredTabs {
    return { tabs: this.tabs.map((tab) => ({ ...tab })), activeId: this.activeId || null };
  }

  async init(stored: StoredTabs, initialPath: string | null, startupPath: string | null, initialGoto?: Pos) {
    this.tabs = stored.tabs.length ? stored.tabs.map((tab) => ({ ...tab })) : [
      this.link(initialPath ?? startupPath, initialPath ? initialGoto : undefined),
    ];
    const incoming = initialPath && stored.tabs.length ? this.link(initialPath, initialGoto) : null;
    if (incoming) this.tabs.push(incoming);
    this.activeId = incoming?.id ?? (stored.activeId && this.tabs.some((tab) => tab.id === stored.activeId)
      ? stored.activeId
      : this.tabs[0].id);
    await this.loadActive();
    this.render();
    this.persist();
  }

  syncActive(session: DocumentSession) {
    const tab = this.active();
    if (!tab) return;
    tab.path = session.folderRoot ?? session.savePath ?? (session.readOnly ? session.displayPath : null);
    tab.kind = session.folderRoot ? "folder" : tab.path ? "file" : "blank";
    tab.label = tab.kind === "blank" ? "無題" : basename(tab.path!);
    // 保存完了通知はタブ切替処理の途中でも届く。ここでDOMを作り直すと、
    // 選択元のクリック処理がまだ継続中なのに操作対象だけが差し替わる。
    if (this.transitionTarget) return;
    this.render();
    this.persist();
  }

  async newBlank() {
    await this.addAndActivate(this.link(null));
  }

  async open(path: string, goto?: Pos) {
    const existing = this.tabs.find((tab) => tab.path?.toLocaleLowerCase("en-US") === path.toLocaleLowerCase("en-US"));
    if (existing) {
      existing.goto = goto;
      await this.activate(existing.id);
      return;
    }
    await this.addAndActivate(this.link(path, goto));
  }

  addLinks(items: { path: string; kind: "file" | "folder" }[]) {
    const known = new Set(this.tabs.flatMap((tab) =>
      tab.path ? [tab.path.toLocaleLowerCase("en-US")] : []
    ));
    for (const item of items) {
      const key = item.path.toLocaleLowerCase("en-US");
      if (known.has(key)) continue;
      const tab = this.link(item.path);
      tab.kind = item.kind;
      this.tabs.push(tab);
      known.add(key);
    }
    this.render();
    this.persist();
  }

  async activate(id: string): Promise<boolean> {
    if (id === this.activeId) return true;
    this.transitionTarget = id;
    const proceeded = await this.doc.confirmDiscard(() => this.switchTo(id));
    if (!proceeded) {
      this.transitionTarget = null;
      this.render();
      this.persist();
    }
    return this.activeId === id;
  }

  private async switchTo(id: string) {
    try {
      this.syncActive(this.doc.current);
      this.activeId = id;
      await this.loadActive();
    } finally {
      if (this.transitionTarget === id) this.transitionTarget = null;
      this.render();
      this.persist();
    }
  }

  async close(id: string) {
    if (this.tabs.length === 1) {
      if (id === this.activeId && !(await this.doc.confirmDiscard())) return;
      this.tabs = [this.link(null)];
      this.activeId = this.tabs[0].id;
      await this.doc.newFile(false);
      this.render();
      this.persist();
      return;
    }
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    if (id === this.activeId) {
      if (!(await this.doc.confirmDiscard())) return;
      this.tabs.splice(index, 1);
      this.activeId = this.tabs[Math.min(index, this.tabs.length - 1)].id;
      await this.loadActive();
    } else {
      this.tabs.splice(index, 1);
    }
    this.render();
    this.persist();
  }

  async saveForExit(): Promise<boolean> {
    if (this.doc.current.dirty && !await this.doc.save()) return false;
    this.syncActive(this.doc.current);
    return true;
  }

  private async addAndActivate(tab: StoredTab) {
    this.transitionTarget = tab.id;
    try {
      await this.doc.confirmDiscard(async () => {
        this.syncActive(this.doc.current);
        this.tabs.push(tab);
        this.activeId = tab.id;
        await this.loadActive();
      });
    } finally {
      this.transitionTarget = null;
      this.render();
      this.persist();
    }
  }

  private async loadActive() {
    const tab = this.active()!;
    if (tab.path) {
      const opened = await this.doc.openPath(tab.path, false);
      if (!opened) {
        tab.path = null;
        tab.kind = "blank";
        tab.label = "無題";
        await this.doc.newFile(false);
      } else if (tab.goto) {
        this.doc.goTo(tab.goto);
        delete tab.goto;
      }
    } else {
      await this.doc.newFile(false);
    }
  }

  private active() {
    return this.tabs.find((tab) => tab.id === this.activeId);
  }

  private link(path: string | null, goto?: Pos): StoredTab {
    return {
      id: newId(),
      path,
      kind: path ? "file" : "blank",
      label: path ? basename(path) : "無題",
      goto,
    };
  }

  private render() {
    const buttons = this.tabs.map((tab) => {
      const button = document.createElement("button");
      button.className = "doc-tab";
      button.dataset.tabId = tab.id;
      button.classList.toggle("active", tab.id === this.activeId);
      button.title = tab.path ?? "無題";
      button.innerHTML = `<span class="doc-tab-icon">${tab.kind === "folder" ? "📁" : "📄"}</span><span class="doc-tab-label"></span><span class="doc-tab-close">×</span>`;
      button.querySelector(".doc-tab-label")!.textContent = tab.label;
      button.addEventListener("click", (event) => {
        if (this.justDragged) {
          this.justDragged = false;
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if ((event.target as Element).closest(".doc-tab-close")) void this.close(tab.id);
        else void this.activate(tab.id);
      });
      button.addEventListener("auxclick", (event) => {
        if (event.button === 1) void this.close(tab.id);
      });
      button.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        showMenu(event.clientX, event.clientY, this.contextItems(tab));
      });
      return button;
    });
    const add = document.createElement("button");
    add.className = "doc-tab-add";
    add.title = "新規タブ";
    add.setAttribute("aria-label", "新規タブ");
    add.textContent = "+";
    add.addEventListener("click", () => { void this.newBlank(); });
    this.host.replaceChildren(...buttons, add);
  }

  private contextItems(tab: StoredTab): MenuItem[] {
    return [
      { label: "閉じる", action: () => void this.close(tab.id) },
      { label: "ほかのタブを閉じる", action: () => void this.keepOnly(tab.id), sep: true },
      { label: "右側のタブを閉じる", action: () => void this.closeRight(tab.id) },
      { label: "保存済みのタブを閉じる", action: () => void this.closeSaved(tab.id) },
    ];
  }

  private async keepOnly(id: string) {
    if (!await this.activate(id)) return;
    this.tabs = this.tabs.filter((tab) => tab.id === id);
    this.render();
    this.persist();
  }

  private async closeRight(id: string) {
    const index = this.tabs.findIndex((tab) => tab.id === id);
    const activeIndex = this.tabs.findIndex((tab) => tab.id === this.activeId);
    if (activeIndex > index && !await this.activate(id)) return;
    this.tabs = this.tabs.slice(0, index + 1);
    this.render();
    this.persist();
  }

  private async closeSaved(keepId: string) {
    this.tabs = this.tabs.filter((tab) => tab.id === keepId || tab.id === this.activeId || tab.kind === "blank");
    this.render();
    this.persist();
  }

  private persist() {
    this.ports.onChange(this.state);
  }

  private onPointerDown = (event: PointerEvent) => {
    this.justDragged = false;
    if (event.button !== 0 || (event.target as Element | null)?.closest(".doc-tab-close")) return;
    const tab = (event.target as Element | null)?.closest<HTMLElement>(".doc-tab");
    const sourceId = tab?.dataset.tabId;
    if (!sourceId) return;
    this.pendingDrag = { sourceId, x: event.clientX, y: event.clientY };
    tab.setPointerCapture?.(event.pointerId);
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("keydown", this.onDragKey);
  };

  private onPointerMove = (event: PointerEvent) => {
    const pending = this.pendingDrag;
    if (pending && Math.hypot(event.clientX - pending.x, event.clientY - pending.y) >= DRAG_THRESHOLD) {
      this.pendingDrag = null;
      this.drag = { sourceId: pending.sourceId, ghost: this.spawnGhost(pending.sourceId), spot: null };
    }
    if (!this.drag) return;
    this.drag.ghost.style.transform = `translate(${event.clientX + 12}px, ${event.clientY + 12}px)`;
    this.drag.spot = this.resolveDrop(event.clientX, event.clientY);
    this.paintDrop(this.drag.spot);
  };

  private onPointerUp = () => {
    const drag = this.drag;
    this.endDrag();
    if (!drag) return;
    this.justDragged = true;
    this.moveTab(drag.sourceId, drag.spot);
  };

  private onDragKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") this.endDrag();
  };

  private swallowClickAfterDrag = (event: MouseEvent) => {
    if (!this.justDragged) return;
    this.justDragged = false;
    event.preventDefault();
    event.stopPropagation();
  };

  private resolveDrop(x: number, y: number): DropSpot | null {
    const hit = document.elementFromPoint(x, y) as HTMLElement | null;
    const target = hit?.closest<HTMLElement>(".doc-tab");
    if (target?.dataset.tabId) {
      const rect = target.getBoundingClientRect();
      return { targetId: target.dataset.tabId, after: x >= rect.left + rect.width / 2, el: target };
    }
    return hit && this.host.contains(hit) ? { targetId: null, after: true } : null;
  }

  private paintDrop(spot: DropSpot | null) {
    this.host.querySelectorAll(".doc-tab-drop-before, .doc-tab-drop-after")
      .forEach((tab) => tab.classList.remove("doc-tab-drop-before", "doc-tab-drop-after"));
    spot?.el?.classList.add(spot.after ? "doc-tab-drop-after" : "doc-tab-drop-before");
  }

  private spawnGhost(sourceId: string): HTMLElement {
    const ghost = document.createElement("div");
    ghost.className = "doc-tab-ghost";
    ghost.textContent = this.tabs.find((tab) => tab.id === sourceId)?.label ?? "";
    document.body.appendChild(ghost);
    return ghost;
  }

  private endDrag() {
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("keydown", this.onDragKey);
    this.pendingDrag = null;
    this.drag?.ghost.remove();
    this.drag = null;
    this.paintDrop(null);
  }

  private moveTab(sourceId: string, spot: DropSpot | null) {
    if (!spot || spot.targetId === sourceId) return;
    const source = this.tabs.findIndex((tab) => tab.id === sourceId);
    if (source < 0) return;
    const [tab] = this.tabs.splice(source, 1);
    const target = spot.targetId === null
      ? this.tabs.length
      : this.tabs.findIndex((item) => item.id === spot.targetId) + (spot.after ? 1 : 0);
    this.tabs.splice(Math.max(0, target), 0, tab);
    this.render();
    this.persist();
  }
}

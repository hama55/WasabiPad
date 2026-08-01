import type { Pos, WindowRequest } from "./api";
import type { DocumentSession } from "./session";
import { cloneEditorViewState, type EditorViewState } from "./editor-view-state";
import { basename } from "./path";
import { showMenu, type MenuItem } from "./menu";
import { revealInExplorer } from "./folder-actions";
import { DRAG_THRESHOLD } from "./interaction-constants";

export interface StoredTab {
  id: string;
  path: string | null;
  kind: "file" | "folder" | "blank";
  label: string;
  goto?: Pos;
  viewState?: EditorViewState;
  selectedRelPath?: string;
  selectedLine?: number;
}

export interface StoredTabs {
  tabs: StoredTab[];
  activeId: string | null;
}

export interface TabDocumentPort {
  readonly current: DocumentSession;
  confirmDiscard: (onProceed?: () => void | Promise<void>) => Promise<boolean>;
  openPath: (path: string, confirm?: boolean) => Promise<boolean>;
  selectEntry: (relPath: string) => Promise<boolean | void>;
  newFile: (confirm?: boolean) => Promise<void>;
  goTo: (position: Pos) => void;
  captureViewState: () => EditorViewState;
  restoreViewState: (state: EditorViewState) => Promise<void>;
  save: () => Promise<boolean>;
}

interface TabPorts {
  onChange: (state: StoredTabs) => void;
  onError?: (error: unknown) => void | Promise<void>;
  onDetach?: (request: WindowRequest) => Promise<boolean>;
}

const newId = () => `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
type DropSpot = { targetId: string | null; after: boolean; el?: HTMLElement };

export class TabManager {
  private tabs: StoredTab[] = [];
  private activeId = "";
  private transitionTarget: string | null = null;
  private loadingActive = false;
  private pendingDrag: { sourceId: string; x: number; y: number } | null = null;
  private drag: { sourceId: string; ghost: HTMLElement; spot: DropSpot | null } | null = null;
  private justDragged = false;

  constructor(private host: HTMLElement, private doc: TabDocumentPort, private ports: TabPorts) {
    // WebView2ではネイティブDnDがHTML5 DnDを奪うため、お気に入りバーと同じpointer方式を使う。
    this.host.addEventListener("pointerdown", this.onPointerDown);
    this.host.addEventListener("click", this.swallowClickAfterDrag, true);
  }

  get state(): StoredTabs {
    return {
      tabs: this.tabs.map((tab) => ({
        ...tab,
        viewState: tab.viewState ? cloneEditorViewState(tab.viewState) : undefined,
      })),
      activeId: this.activeId || null,
    };
  }

  async init(
    stored: StoredTabs,
    initialPath: string | null,
    startupPath: string | null,
    initialGoto?: Pos,
    initialSelectedRelPath?: string,
    initialViewState?: EditorViewState,
  ) {
    const initialTab = this.link(initialPath ?? startupPath, initialPath ? initialGoto : undefined);
    initialTab.selectedRelPath = initialSelectedRelPath;
    initialTab.viewState = initialViewState;
    this.tabs = stored.tabs.length ? stored.tabs.map((tab) => ({ ...tab })) : [initialTab];
    const incoming = initialPath && stored.tabs.length ? this.link(initialPath, initialGoto) : null;
    if (incoming) {
      incoming.selectedRelPath = initialSelectedRelPath;
      incoming.viewState = initialViewState;
    }
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
    tab.selectedRelPath = session.selectedRelPath || undefined;
    if (tab.kind !== "folder" || !tab.selectedRelPath) delete tab.selectedLine;
    // 保存完了通知はタブ切替処理の途中でも届く。ここでDOMを作り直すと、
    // 選択元のクリック処理がまだ継続中なのに操作対象だけが差し替わる。
    if (this.transitionTarget) return;
    this.render();
    this.persist();
  }

  syncCursor(line: number) {
    if (this.transitionTarget || this.loadingActive) return;
    const tab = this.active();
    if (!tab || tab.kind !== "folder" || !tab.selectedRelPath) return;
    const selectedLine = Math.max(0, Math.floor(line));
    if (tab.selectedLine === selectedLine) return;
    tab.selectedLine = selectedLine;
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
    let proceeded: boolean;
    try {
      proceeded = await this.doc.confirmDiscard(() => this.switchTo(id));
    } catch (error) {
      this.transitionTarget = null;
      this.render();
      throw error;
    }
    if (!proceeded) {
      this.transitionTarget = null;
      this.render();
    }
    return this.activeId === id;
  }

  private async switchTo(id: string) {
    this.rememberActiveView();
    this.syncActive(this.doc.current);
    try {
      await this.commitTransition(async () => {
        this.activeId = id;
        await this.loadActive();
      });
    } finally {
      if (this.transitionTarget === id) this.transitionTarget = null;
    }
  }

  async close(id: string) {
    if (this.tabs.length === 1) {
      if (id === this.activeId && !(await this.doc.confirmDiscard())) return;
      await this.commitTransition(async () => {
        this.tabs = [this.link(null)];
        this.activeId = this.tabs[0].id;
        await this.doc.newFile(false);
      });
      return;
    }
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    if (id === this.activeId) {
      if (!(await this.doc.confirmDiscard())) return;
      this.rememberActiveView();
      this.syncActive(this.doc.current);
      await this.commitTransition(async () => {
        this.tabs.splice(index, 1);
        this.activeId = this.tabs[Math.min(index, this.tabs.length - 1)].id;
        await this.loadActive();
      });
    } else {
      this.tabs.splice(index, 1);
      this.render();
      this.persist();
    }
  }

  async saveForExit(): Promise<boolean> {
    if (this.doc.current.dirty && !await this.doc.save()) return false;
    this.rememberActiveView();
    this.syncActive(this.doc.current);
    return true;
  }

  private async addAndActivate(tab: StoredTab) {
    this.transitionTarget = tab.id;
    try {
      await this.doc.confirmDiscard(async () => {
        this.rememberActiveView();
        this.syncActive(this.doc.current);
        await this.commitTransition(async () => {
          this.tabs.push(tab);
          this.activeId = tab.id;
          await this.loadActive();
        });
      });
    } finally {
      this.transitionTarget = null;
    }
  }

  private async commitTransition(operation: () => Promise<void>) {
    const before = this.state;
    try {
      await operation();
    } catch (error) {
      this.tabs = before.tabs;
      this.activeId = before.activeId ?? before.tabs[0]?.id ?? "";
      try {
        if (this.activeId) await this.loadActive();
      } catch (recoveryError) {
        console.error("元のタブへ復帰できませんでした", recoveryError);
      }
      this.render();
      throw error;
    }
    this.render();
    this.persist();
  }

  private async loadActive() {
    this.loadingActive = true;
    try {
      const tab = this.active()!;
      const rememberedRelPath = tab.selectedRelPath;
      const rememberedLine = tab.selectedLine ?? (tab.kind === "folder" ? tab.viewState?.caret.line : undefined);
      if (tab.path) {
        const opened = await this.doc.openPath(tab.path, false);
        if (!opened) {
          tab.path = null;
          tab.kind = "blank";
          tab.label = "無題";
          await this.doc.newFile(false);
        } else if (rememberedRelPath) {
          let selectionFailed = false;
          try {
            selectionFailed = (await this.doc.selectEntry(rememberedRelPath)) === false;
          } catch {
            selectionFailed = true;
          }
          if (selectionFailed) {
            // 前回選択した項目が削除済みでも、親フォルダ自体は開ける。
            delete tab.selectedRelPath;
            delete tab.selectedLine;
            delete tab.viewState;
          }
        }
        const selectedLine = rememberedLine;
        if (opened && tab.goto) {
          this.doc.goTo(tab.goto);
          delete tab.goto;
        } else if (opened && tab.kind === "folder" && tab.selectedRelPath && selectedLine !== undefined) {
          tab.selectedLine = selectedLine;
          delete tab.viewState;
          this.doc.goTo({ line: selectedLine, col: 0 });
        } else if (opened && tab.kind !== "folder" && tab.viewState) {
          await this.doc.restoreViewState(tab.viewState);
        }
      } else {
        await this.doc.newFile(false);
        if (tab.viewState) await this.doc.restoreViewState(tab.viewState);
      }
    } finally {
      this.loadingActive = false;
    }
  }

  private rememberActiveView() {
    const tab = this.active();
    if (!tab) return;
    const view = this.doc.captureViewState();
    if (tab.kind === "folder") {
      if (tab.selectedRelPath) tab.selectedLine = view.caret.line;
      else delete tab.selectedLine;
      delete tab.viewState;
    } else {
      tab.viewState = view;
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
      const dirty = tab.id === this.activeId && this.doc.current.dirty;
      button.querySelector(".doc-tab-label")!.textContent = `${dirty ? "● " : ""}${tab.label}`;
      button.addEventListener("click", (event) => {
        if (this.justDragged) {
          this.justDragged = false;
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if ((event.target as Element).closest(".doc-tab-close")) this.run(() => this.close(tab.id));
        else this.run(() => this.activate(tab.id));
      });
      button.addEventListener("auxclick", (event) => {
        if (event.button === 1) this.run(() => this.close(tab.id));
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
    const items: MenuItem[] = [];
    if (tab.path) {
      items.push({
        label: "エクスプローラで開く",
        action: () => void revealInExplorer(tab.path!, tab.kind === "folder"),
      });
    }
    items.push(
      { label: "閉じる", action: () => this.run(() => this.close(tab.id)) },
      { label: "ほかのタブを閉じる", action: () => this.run(() => this.keepOnly(tab.id)), sep: true },
      { label: "右側のタブを閉じる", action: () => this.run(() => this.closeRight(tab.id)) },
      { label: "保存済みのタブを閉じる", action: () => this.run(() => this.closeSaved(tab.id)) },
    );
    return items;
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

  private onPointerUp = (event: PointerEvent) => {
    const drag = this.drag;
    this.endDrag();
    if (!drag) return;
    this.justDragged = true;
    if (drag.spot) this.moveTab(drag.sourceId, drag.spot);
    else if (this.outsideWindow(event.clientX, event.clientY)) this.run(() => this.detachTab(drag.sourceId));
  };

  private outsideWindow(x: number, y: number): boolean {
    return x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight;
  }

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

  private run(operation: () => Promise<unknown>) {
    void operation().catch(async (error) => {
      try {
        await this.ports.onError?.(error);
      } catch (reportError) {
        console.error("タブ操作エラーを表示できませんでした", reportError);
      }
    });
  }

  private async detachTab(id: string) {
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    const wasActive = id === this.activeId;
    if (wasActive && !(await this.doc.confirmDiscard())) return;
    if (wasActive) {
      this.rememberActiveView();
      this.syncActive(this.doc.current);
    }
    const tab = this.tabs.find((item) => item.id === id);
    if (!tab || !this.ports.onDetach || !await this.ports.onDetach({
      secondary: true,
      path: tab.path,
      goto: tab.viewState ? null : tab.goto ?? null,
      selectedRelPath: tab.selectedRelPath ?? null,
      viewState: tab.viewState ?? null,
    })) return;
    this.tabs.splice(this.tabs.indexOf(tab), 1);
    if (!wasActive) {
      this.render();
      this.persist();
      return;
    }
    if (this.tabs.length === 0) {
      const blank = this.link(null);
      this.tabs = [blank];
      this.activeId = blank.id;
      await this.doc.newFile(false);
    } else {
      this.activeId = this.tabs[Math.min(index, this.tabs.length - 1)].id;
      await this.loadActive();
    }
    this.render();
    this.persist();
  }
}

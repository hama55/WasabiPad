import { showMenu, type MenuItem } from "./menu";
import { createRegisteredCommandMenu, type RegisteredCommandMenuPorts } from "./registered-command-menu";
import { DRAG_THRESHOLD, isMiddleClick } from "./interaction-constants";
import { runAsyncBoundary } from "./async-boundary";
import { MENU_ICON } from "./menu-icons";
import { MENU_LABELS } from "./menu-labels";
import type { StoredTab } from "./stored-tabs";

export type TabDropSpot = { targetId: string | null; after: boolean; el?: HTMLElement };

export interface TabBarViewState {
  tabs: StoredTab[];
  activeId: string | null;
  dirty: boolean;
}

export interface TabBarViewPorts {
  onActivate: (id: string) => void | Promise<unknown>;
  onClose: (id: string) => void | Promise<unknown>;
  onNewBlank: () => void | Promise<unknown>;
  onKeepOnly: (id: string) => void | Promise<unknown>;
  onCloseRight: (id: string) => void | Promise<unknown>;
  onCloseSaved: (id: string) => void | Promise<unknown>;
  onMove: (sourceId: string, spot: TabDropSpot | null) => void;
  onDetach: (id: string) => void | Promise<unknown>;
  onError?: (error: unknown, message?: string) => void | Promise<void>;
  revealInExplorer?: (path: string, isDir: boolean) => void | Promise<unknown>;
  registeredCommandPorts: RegisteredCommandMenuPorts;
}

export class TabBarView {
  private state: TabBarViewState = { tabs: [], activeId: null, dirty: false };
  private pendingDrag: { sourceId: string; x: number; y: number } | null = null;
  private drag: { sourceId: string; ghost: HTMLElement; spot: TabDropSpot | null } | null = null;
  private justDragged = false;

  constructor(private host: HTMLElement, private ports: TabBarViewPorts) {
    // WebView2ではネイティブDnDがHTML5 DnDを奪うため、お気に入りバーと同じpointer方式を使う。
    this.host.addEventListener("pointerdown", this.onPointerDown);
    this.host.addEventListener("click", this.swallowClickAfterDrag, true);
  }

  render(state: TabBarViewState) {
    this.state = state;
    const buttons = state.tabs.map((tab) => {
      const button = document.createElement("button");
      button.className = "doc-tab";
      button.dataset.tabId = tab.id;
      button.classList.toggle("active", tab.id === state.activeId);
      button.title = tab.path ?? "無題";
      button.innerHTML = `<span class="doc-tab-icon">${tab.kind === "folder" ? "📁" : "📄"}</span><span class="doc-tab-label"></span><span class="doc-tab-close">×</span>`;
      button.querySelector(".doc-tab-label")!.textContent = `${tab.id === state.activeId && state.dirty ? "● " : ""}${tab.label}`;
      button.addEventListener("click", (event) => {
        if (this.justDragged) {
          this.justDragged = false;
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if ((event.target as Element).closest(".doc-tab-close")) this.run(() => this.ports.onClose(tab.id));
        else this.run(() => this.ports.onActivate(tab.id));
      });
      button.addEventListener("auxclick", (event) => {
        if (!isMiddleClick(event)) return;
        event.preventDefault();
        if (tab.path && this.ports.revealInExplorer) {
          this.run(() => this.ports.revealInExplorer!(tab.path!, tab.kind === "folder"), "エクスプローラで開けませんでした");
        }
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
    add.addEventListener("click", () => this.run(() => this.ports.onNewBlank()));
    this.host.replaceChildren(...buttons, add);
  }

  private contextItems(tab: StoredTab): MenuItem[] {
    const items: MenuItem[] = [];
    if (tab.path) {
      items.push({
        label: MENU_LABELS.explorer,
        iconClass: MENU_ICON.explorer,
        action: () => this.run(() => {
          if (!this.ports.revealInExplorer) throw new Error("エクスプローラ連携が未接続です");
          return this.ports.revealInExplorer(tab.path!, tab.kind === "folder");
        }),
      });
      if (tab.kind === "file") {
        items.push(createRegisteredCommandMenu(tab.path, {
          ...this.ports.registeredCommandPorts,
          run: (title, operation) => this.run(operation, title),
        }));
      }
    }
    items.push(
      { label: "閉じる", iconClass: MENU_ICON.close, action: () => this.run(() => this.ports.onClose(tab.id)), sep: Boolean(tab.path) },
      { label: "ほかのタブを閉じる", iconClass: MENU_ICON.closeOthers, action: () => this.run(() => this.ports.onKeepOnly(tab.id)) },
      { label: "右側のタブを閉じる", iconClass: MENU_ICON.closeRight, action: () => this.run(() => this.ports.onCloseRight(tab.id)) },
      { label: "保存済みのタブを閉じる", iconClass: MENU_ICON.closeSaved, action: () => this.run(() => this.ports.onCloseSaved(tab.id)) },
    );
    return items;
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
    if (drag.spot) this.ports.onMove(drag.sourceId, drag.spot);
    else if (this.outsideWindow(event.clientX, event.clientY)) this.run(() => this.ports.onDetach(drag.sourceId));
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

  private resolveDrop(x: number, y: number): TabDropSpot | null {
    const hit = document.elementFromPoint(x, y) as HTMLElement | null;
    const target = hit?.closest<HTMLElement>(".doc-tab");
    if (target?.dataset.tabId) {
      const rect = target.getBoundingClientRect();
      return { targetId: target.dataset.tabId, after: x >= rect.left + rect.width / 2, el: target };
    }
    return hit && this.host.contains(hit) ? { targetId: null, after: true } : null;
  }

  private paintDrop(spot: TabDropSpot | null) {
    this.host.querySelectorAll(".doc-tab-drop-before, .doc-tab-drop-after")
      .forEach((tab) => tab.classList.remove("doc-tab-drop-before", "doc-tab-drop-after"));
    spot?.el?.classList.add(spot.after ? "doc-tab-drop-after" : "doc-tab-drop-before");
  }

  private spawnGhost(sourceId: string): HTMLElement {
    const ghost = document.createElement("div");
    ghost.className = "doc-tab-ghost";
    ghost.textContent = this.state.tabs.find((tab) => tab.id === sourceId)?.label ?? "";
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

  private run(operation: () => void | Promise<unknown>, message = "タブを操作できませんでした") {
    runAsyncBoundary(operation, (error) => this.reportError(error, message));
  }

  private async reportError(error: unknown, message = "タブを操作できませんでした") {
    try {
      await this.ports.onError?.(error, message);
    } catch (reportError) {
      console.error(`${message}のエラーを表示できませんでした`, reportError);
    }
  }
}

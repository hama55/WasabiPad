import type { Pos, WindowRequest } from "./api";
import type { DocumentSession } from "./session";
import { cloneEditorViewState, type EditorViewState } from "./editor-view-state";
import { basename } from "./path";
import { showMenu, type MenuItem } from "./menu";
import { revealInExplorer } from "./folder-actions";
import { createRegisteredCommandMenu, type RegisteredCommandMenuPorts } from "./registered-command-menu";
import { DRAG_THRESHOLD } from "./interaction-constants";
import {
  NavigationHistory,
  type NavigationEntry,
  type NavigationState,
  sameNavigationLink,
} from "./navigation-history";
export { isStoredTab, isStoredTabs, type StoredTab, type StoredTabs } from "./stored-tabs";
import type { StoredTab, StoredTabs } from "./stored-tabs";

export interface TabDocumentPort {
  readonly current: Readonly<DocumentSession>;
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
  onHistoryChange?: (state: NavigationState) => void;
}

const newId = () => `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
type DropSpot = { targetId: string | null; after: boolean; el?: HTMLElement };
type NavigationRun<T> = {
  proceeded: boolean;
  result?: T;
  before: StoredTabs | null;
  previous: NavigationEntry | null;
};

export class TabManager {
  private tabs: StoredTab[] = [];
  private activeId = "";
  private transitionTarget: string | null = null;
  private loadingActive = false;
  private navigationInProgress = false;
  private navigationBusy = false;
  private navigationHistory = new Map<string, NavigationHistory>();
  private pendingDrag: { sourceId: string; x: number; y: number } | null = null;
  private drag: { sourceId: string; ghost: HTMLElement; spot: DropSpot | null } | null = null;
  private justDragged = false;

  constructor(
    private host: HTMLElement,
    private doc: TabDocumentPort,
    private ports: TabPorts,
    private registeredCommandPorts: RegisteredCommandMenuPorts,
  ) {
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
    this.navigationHistory.clear();
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

  syncActive(session: Readonly<DocumentSession>) {
    const tab = this.active();
    if (!tab) return;
    tab.path = session.folderRoot ?? session.savePath ?? (session.readOnly ? session.displayPath : null);
    tab.kind = session.folderRoot ? "folder" : tab.path ? "file" : "blank";
    tab.label = tab.kind === "blank" ? "無題" : basename(tab.path!);
    tab.selectedRelPath = session.selectedRelPath || undefined;
    if (tab.kind !== "folder" || !tab.selectedRelPath) delete tab.selectedLine;
    // 保存完了通知はタブ切替処理の途中でも届く。ここでDOMを作り直すと、
    // 選択元のクリック処理がまだ継続中なのに操作対象だけが差し替わる。
    if (this.transitionTarget || this.navigationInProgress) return;
    this.render();
    this.persist();
  }

  syncCursor(line: number) {
    if (this.transitionTarget || this.loadingActive || this.navigationInProgress) return;
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
      if (goto) existing.goto = goto;
      else delete existing.goto;
      const wasActive = existing.id === this.activeId;
      let activated: boolean;
      try {
        activated = await this.activate(existing.id);
      } catch (error) {
        delete existing.goto;
        throw error;
      }
      if (!activated) {
        delete existing.goto;
        return;
      }
      // activate() は既にactiveなtabでは即時終了するため、その経路だけは
      // loadActive()に任せず、要求した飛び先をここで消費する。
      if (wasActive && this.activeId === existing.id && goto) {
        try {
          this.doc.goTo(goto);
        } finally {
          delete existing.goto;
        }
      }
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
    if (this.navigationBusy) return false;
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

  navigatePath(path: string): Promise<boolean> {
    return this.runNavigationCommand(() => this.navigateCurrent(() => this.doc.openPath(path, false)));
  }

  navigateEntry(relPath: string): Promise<boolean> {
    return this.runNavigationCommand(() =>
      this.navigateCurrent(async () => (await this.doc.selectEntry(relPath)) === true)
    );
  }

  goBack(): Promise<boolean> {
    return this.runNavigationCommand(() => this.travel("back"));
  }

  goForward(): Promise<boolean> {
    return this.runNavigationCommand(() => this.travel("forward"));
  }

  private runNavigationCommand(operation: () => Promise<boolean>): Promise<boolean> {
    if (this.navigationBusy) return Promise.resolve(false);
    this.navigationBusy = true;
    return operation().finally(() => {
      this.navigationBusy = false;
    });
  }

  private async switchTo(id: string) {
    this.rememberActiveView();
    try {
      await this.commitTransition(async () => {
        this.activeId = id;
        await this.loadActive();
      });
    } finally {
      if (this.transitionTarget === id) this.transitionTarget = null;
    }
  }

  private async navigateCurrent(operation: () => Promise<boolean>): Promise<boolean> {
    if (!this.active()) return false;
    const run = await this.runDocumentNavigation(async () => {
      const succeeded = await operation();
      if (!succeeded) return { succeeded: false, current: null };
      this.syncActive(this.doc.current);
      return { succeeded: true, current: this.currentNavigationEntry() };
    });
    const succeeded = run.result?.succeeded === true;
    if (run.proceeded && succeeded && run.previous && run.result?.current
      && !sameNavigationLink(run.previous, run.result.current)) {
      this.clearActiveViewState();
      this.historyFor(this.activeId).record(run.previous);
      this.persist();
      this.render();
    }
    return succeeded;
  }

  private async travel(direction: "back" | "forward"): Promise<boolean> {
    const tab = this.active();
    if (!tab) return false;
    const history = this.historyFor(tab.id);
    const target = history.target(direction);
    if (!target) return false;

    const run = await this.runDocumentNavigation(async () => {
      if (!await this.loadNavigationEntry(target)) return { succeeded: false };
      this.syncActive(this.doc.current);
      return { succeeded: true };
    });

    if (!run.proceeded || run.result?.succeeded !== true) {
      if (run.proceeded && run.before) await this.restoreTabs(run.before);
      this.render();
      return false;
    }
    history.complete(direction, run.previous);
    this.render();
    return true;
  }

  private async runDocumentNavigation<T>(
    operation: (previous: NavigationEntry | null) => Promise<T>,
  ): Promise<NavigationRun<T>> {
    let before: StoredTabs | null = null;
    let result: T | undefined;
    let previous: NavigationEntry | null = null;
    try {
      const proceeded = await this.doc.confirmDiscard(async () => {
        this.rememberActiveView();
        before = this.state;
        previous = this.currentNavigationEntry();
        this.navigationInProgress = true;
        try {
          result = await operation(previous);
        } finally {
          this.navigationInProgress = false;
        }
      });
      return { proceeded, result, before, previous };
    } catch (error) {
      if (before) await this.restoreTabs(before);
      this.render();
      throw error;
    }
  }

  private async loadNavigationEntry(entry: NavigationEntry): Promise<boolean> {
    const tab = this.active();
    if (!tab) return false;
    tab.path = entry.path;
    tab.kind = entry.kind;
    tab.label = basename(entry.path);
    delete tab.goto;
    delete tab.viewState;
    if (entry.selectedRelPath) {
      tab.selectedRelPath = entry.selectedRelPath;
      tab.selectedLine = entry.line;
    } else {
      delete tab.selectedRelPath;
      delete tab.selectedLine;
    }
    if (!await this.doc.openPath(entry.path, false)) return false;
    if (entry.kind === "folder" && entry.selectedRelPath
      && (await this.doc.selectEntry(entry.selectedRelPath)) !== true) return false;
    this.doc.goTo({ line: entry.line, col: 0 });
    return true;
  }

  private currentNavigationEntry(): NavigationEntry | null {
    const tab = this.active();
    if (!tab?.path || tab.kind === "blank") return null;
    const line = tab.kind === "folder" && tab.selectedRelPath
      ? tab.selectedLine ?? tab.viewState?.caret.line ?? 0
      : tab.viewState?.caret.line ?? 0;
    return {
      path: tab.path,
      kind: tab.kind,
      selectedRelPath: tab.selectedRelPath,
      line: Math.max(0, Math.floor(line)),
    };
  }

  private clearActiveViewState() {
    const tab = this.active();
    if (!tab) return;
    delete tab.viewState;
    delete tab.selectedLine;
  }

  private historyFor(id: string): NavigationHistory {
    let history = this.navigationHistory.get(id);
    if (!history) {
      history = new NavigationHistory();
      this.navigationHistory.set(id, history);
    }
    return history;
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
    return true;
  }

  private async addAndActivate(tab: StoredTab) {
    this.transitionTarget = tab.id;
    try {
      await this.doc.confirmDiscard(async () => {
        this.rememberActiveView();
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
      await this.restoreTabs(before);
      this.render();
      throw error;
    }
    this.render();
    this.persist();
  }

  private async restoreTabs(before: StoredTabs) {
    this.tabs = before.tabs;
    this.activeId = before.activeId ?? before.tabs[0]?.id ?? "";
    try {
      if (this.activeId) await this.loadActive();
    } catch (error) {
      console.error("元のタブへ復帰できませんでした", error);
    }
  }

  private async loadActive() {
    this.loadingActive = true;
    try {
      const tab = this.active()!;
      const rememberedRelPath = tab.selectedRelPath;
      const rememberedLine = tab.selectedLine ?? (tab.kind === "folder" ? tab.viewState?.caret.line : undefined);
      let selectionRestored = false;
      if (tab.path) {
        const opened = await this.doc.openPath(tab.path, false);
        if (!opened) {
          tab.path = null;
          tab.kind = "blank";
          tab.label = "無題";
          await this.doc.newFile(false);
        } else if (rememberedRelPath) {
          try {
            selectionRestored = (await this.doc.selectEntry(rememberedRelPath)) === true;
          } catch (error) {
            // 一時的なIPC失敗で復元情報を消すと、次回タブ切替でも再試行できない。
            await this.reportError(error);
          }
          // 選択に失敗しても記録は保持する。項目削除と一時的な読込失敗を区別できないため、
          // 次回タブを開いたときに再試行できる状態を優先する。
          if (!selectionRestored) delete tab.selectedLine;
        }
        const selectedLine = rememberedLine;
        if (opened && tab.goto) {
          this.doc.goTo(tab.goto);
          delete tab.goto;
        } else if (opened && tab.kind === "folder" && selectionRestored && tab.selectedRelPath && selectedLine !== undefined) {
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
    this.syncActive(this.doc.current);
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
    this.pruneNavigationHistories();
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
    add.addEventListener("click", () => this.run(() => this.newBlank()));
    this.host.replaceChildren(...buttons, add);
    const history = this.navigationHistory.get(this.activeId);
    this.ports.onHistoryChange?.(history?.state ?? { canGoBack: false, canGoForward: false });
  }

  private pruneNavigationHistories() {
    const ids = new Set(this.tabs.map((tab) => tab.id));
    for (const id of this.navigationHistory.keys()) {
      if (!ids.has(id)) this.navigationHistory.delete(id);
    }
  }

  private contextItems(tab: StoredTab): MenuItem[] {
    const items: MenuItem[] = [];
    if (tab.path) {
      items.push({
        label: "エクスプローラで開く",
        action: () => this.run(() => revealInExplorer(tab.path!, tab.kind === "folder")),
      });
      if (tab.kind === "file") {
        items.push(createRegisteredCommandMenu(tab.path, {
          ...this.registeredCommandPorts,
          run: (_title, operation) => this.run(operation),
        }));
      }
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

  private run(operation: () => void | Promise<unknown>) {
    void Promise.resolve()
      .then(operation)
      .catch((error) => this.reportError(error));
  }

  private async reportError(error: unknown) {
    try {
      await this.ports.onError?.(error);
    } catch (reportError) {
      console.error("タブ操作エラーを表示できませんでした", reportError);
    }
  }

  private async detachTab(id: string) {
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    const wasActive = id === this.activeId;
    if (wasActive && !(await this.doc.confirmDiscard())) return;
    if (wasActive) {
      this.rememberActiveView();
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

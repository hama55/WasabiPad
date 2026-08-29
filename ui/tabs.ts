import type { OpenAs, Pos, WindowRequest } from "./api";
import type { DocumentSession } from "./session";
import { cloneEditorViewState, type EditorViewState } from "./editor-view-state";
import { basename, comparablePath, rebaseWindowsPath, type PathRebase } from "./path";
import { TabBarView, type TabDropSpot } from "./tab-view";
import type { RegisteredCommandMenuPorts } from "./registered-command-menu";
import type { SidebarViewState } from "./sidebar";
import {
  NavigationHistory,
  type NavigationEntry,
  type NavigationState,
  sameNavigationLink,
} from "./navigation-history";
export { isStoredTab, isStoredTabs, type StoredTab, type StoredTabs } from "./stored-tabs";
import type { StoredTab, StoredTabs } from "./stored-tabs";
import type { SearchHighlightQuery } from "./workspace-search-options";

export interface TabDocumentPort {
  readonly current: Readonly<DocumentSession>;
  confirmDiscard: (onProceed?: () => void | Promise<void>) => Promise<boolean>;
  openPath: (path: string, confirm?: boolean) => Promise<boolean>;
  selectEntry: (relPath: string, openAs?: OpenAs) => Promise<boolean>;
  newFile: (confirm?: boolean, draftDirectory?: string | null) => Promise<void>;
  goTo: (position: Pos) => void;
  captureViewState: () => EditorViewState;
  restoreViewState: (state: EditorViewState) => Promise<void>;
  save: () => Promise<boolean>;
}

export interface TabWorkspaceStatePort {
  capture: () => SidebarViewState | null;
  reset: () => void;
  restore: (state: SidebarViewState | null) => void | Promise<void>;
}

export interface TabFindHighlightPort {
  capture: () => SearchHighlightQuery | null;
  restore: (query: SearchHighlightQuery | null) => void;
}

interface TabPorts {
  onChange: (state: StoredTabs) => void;
  workspace?: TabWorkspaceStatePort;
  findHighlight?: TabFindHighlightPort;
  onError?: (error: unknown, message?: string) => void | Promise<void>;
  onDetach?: (request: WindowRequest) => Promise<boolean>;
  onOpenInNewWindow?: (request: WindowRequest) => Promise<boolean>;
  defaultMemoDirectory?: () => Promise<string>;
  onHistoryChange?: (state: NavigationState) => void;
  revealInExplorer?: (path: string, isDir: boolean) => void | Promise<unknown>;
}

const newId = () => `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function rebaseRelativePath(path: string, oldPrefix: string, newPrefix: string): string | null {
  const normalizedPath = path.replace(/\\/g, "/").replace(/\/$/, "");
  const normalizedOld = oldPrefix.replace(/\\/g, "/").replace(/\/$/, "");
  const normalizedNew = newPrefix.replace(/\\/g, "/").replace(/\/$/, "");
  const comparablePath = normalizedPath.toLocaleLowerCase("en-US");
  const comparableOld = normalizedOld.toLocaleLowerCase("en-US");
  if (
    comparablePath !== comparableOld
    && !comparablePath.startsWith(`${comparableOld}/`)
    && !comparablePath.startsWith(`${comparableOld}::`)
  ) return null;
  return `${normalizedNew}${normalizedPath.slice(normalizedOld.length)}`.replace(/^\//, "");
}

function sameTabPath(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return comparablePath(a) === comparablePath(b);
}

function isArchiveOpenAs(openAs: OpenAs): boolean {
  return openAs === "zip" || openAs === "7z" || openAs === "xlsx" || openAs === "xls";
}

function archiveScopeOf(relPath: string): string {
  return relPath.split("::", 1)[0].replace(/\\/g, "/").toLocaleLowerCase("en-US");
}

function cloneFindHighlightQuery(query: SearchHighlightQuery | null): SearchHighlightQuery | null {
  return query ? { ...query } : null;
}

type NavigationRun<T> = {
  proceeded: boolean;
  result?: T;
  before: StoredTabs | null;
  previous: NavigationEntry | null;
};

export class TabManager {
  private tabs: StoredTab[] = [];
  private activeId = "";
  private workspaceStates = new Map<string, { path: string | null; state: SidebarViewState }>();
  private findHighlightStates = new Map<string, { path: string | null; query: SearchHighlightQuery | null }>();
  private transitionTarget: string | null = null;
  private loadingActive = false;
  private navigationInProgress = false;
  private navigationBusy = false;
  private navigationHistory = new Map<string, NavigationHistory>();
  private openAsStates = new Map<string, { relPath: string; openAs: OpenAs }>();
  private closedTabs: { tab: StoredTab; index: number; replacementId?: string }[] = [];
  private view: TabBarView;

  constructor(
    host: HTMLElement,
    private doc: TabDocumentPort,
    private ports: TabPorts,
    registeredCommandPorts: RegisteredCommandMenuPorts,
  ) {
    this.view = new TabBarView(host, {
      onActivate: (id) => this.activate(id),
      onClose: (id) => this.close(id),
      onNewBlank: () => this.newBlank(),
      onKeepOnly: (id) => this.keepOnly(id),
      onCloseRight: (id) => this.closeRight(id),
      onCloseSaved: (id) => this.closeSaved(id),
      onMove: (sourceId, spot) => this.moveTab(sourceId, spot),
      onDetach: (id) => this.detachTab(id),
      onOpenInNewWindow: ports.onOpenInNewWindow
        ? (tab) => this.openTabInNewWindow(tab)
        : undefined,
      onError: (error, message) => this.reportError(error, message),
      revealInExplorer: ports.revealInExplorer,
      registeredCommandPorts,
    });
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
    this.openAsStates.clear();
    this.closedTabs = [];
    this.workspaceStates.clear();
    this.findHighlightStates.clear();
    const startupTarget = initialPath ?? startupPath;
    const initialTab = stored.tabs.length || startupTarget
      ? this.link(startupTarget, initialPath ? initialGoto : undefined)
      : await this.blankTab(null);
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
    this.renderAndPersist();
  }

  syncActive(session: Readonly<DocumentSession>) {
    const tab = this.active();
    if (!tab) return;
    tab.path = session.folderRoot ?? session.savePath ?? (session.readOnly ? session.displayPath : null);
    tab.kind = session.folderRoot ? "folder" : tab.path ? "file" : "blank";
    tab.label = tab.kind === "blank" ? "無題" : basename(tab.path!);
    if (tab.kind !== "blank") delete tab.draftDirectory;
    tab.selectedRelPath = session.selectedRelPath || undefined;
    if (tab.kind !== "folder" || !tab.selectedRelPath) delete tab.selectedLine;
    // セッション変更通知はタブ切替処理の途中でも届く。ここでDOMを作り直すと、
    // 選択元のクリック処理がまだ継続中なのに操作対象だけが差し替わる。
    if (this.transitionTarget || this.navigationInProgress) return;
    this.renderAndPersist();
  }

  rebasePaths({ oldAbsolute, newAbsolute, oldRelPath, newRelPath }: PathRebase) {
    let changed = false;
    for (const tab of this.tabs) {
      if (tab.path) {
        const rebased = rebaseWindowsPath(tab.path, oldAbsolute, newAbsolute);
        if (rebased && rebased !== tab.path) {
          tab.path = rebased;
          tab.label = basename(rebased);
          changed = true;
        }
      }
      if (tab.selectedRelPath && oldRelPath) {
        const rebased = rebaseRelativePath(tab.selectedRelPath, oldRelPath, newRelPath);
        if (rebased !== null && rebased !== tab.selectedRelPath) {
          tab.selectedRelPath = rebased;
          const openAsState = this.openAsStates.get(tab.id);
          if (openAsState) openAsState.relPath = rebased;
          changed = true;
        }
      }
    }
    const rebaseSavedPath = (saved: { path: string | null }) => {
      if (saved.path === null) return;
      const rebased = rebaseWindowsPath(saved.path, oldAbsolute, newAbsolute);
      if (!rebased || rebased === saved.path) return;
      saved.path = rebased;
      changed = true;
    };
    for (const saved of this.workspaceStates.values()) rebaseSavedPath(saved);
    for (const saved of this.findHighlightStates.values()) rebaseSavedPath(saved);
    if (changed) this.renderAndPersist();
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

  takeActiveFragment(): string | null {
    const tab = this.active();
    if (!tab || tab.fragment === undefined) return null;
    const fragment = tab.fragment;
    delete tab.fragment;
    this.persist();
    return fragment;
  }

  async newBlank() {
    await this.addAndActivate(await this.blankTab());
  }

  async open(path: string, goto?: Pos): Promise<boolean> {
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
        return false;
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
      return true;
    }
    return this.addAndActivate(this.link(path, goto));
  }

  async openMarkdownLink(path: string, sourceTabId: string | null, fragment: string | null): Promise<boolean> {
    const anchorId = sourceTabId ?? this.activeId;
    return this.addAndActivateAfter(
      this.link(path, undefined, undefined, fragment ?? undefined),
      anchorId,
    );
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
    this.renderAndPersist();
  }

  async activate(id: string): Promise<boolean> {
    if (this.navigationBusy || this.transitionTarget) return false;
    if (id === this.activeId) return true;
    this.transitionTarget = id;
    let proceeded: boolean;
    try {
      this.rememberActiveView();
      this.persist();
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
    return this.runNavigationCommand(() =>
      this.navigateCurrent(async () => {
        const succeeded = await this.doc.openPath(path, false);
        if (succeeded) this.openAsStates.delete(this.activeId);
        return succeeded;
      })
    );
  }

  navigateEntry(relPath: string, openAs?: OpenAs): Promise<boolean> {
    const rememberedOpenAs = this.openAsStates.get(this.activeId);
    const inheritedOpenAs = rememberedOpenAs
      && isArchiveOpenAs(rememberedOpenAs.openAs)
      && archiveScopeOf(rememberedOpenAs.relPath) === archiveScopeOf(relPath)
      ? rememberedOpenAs.openAs
      : undefined;
    const requestedOpenAs = openAs ?? inheritedOpenAs;
    // 同じファイルを検索結果から再度選んだだけなら、再読込も確認も不要。
    // dirty と編集中のバッファを維持したまま、呼び出し側が一致位置を扱う。
    if (!requestedOpenAs && this.doc.current.folderRoot
      && this.doc.current.selectedRelPath.replace(/\\/g, "/") === relPath.replace(/\\/g, "/")) {
      return Promise.resolve(true);
    }
    return this.runNavigationCommand(() =>
      this.navigateCurrent(async () => {
        const succeeded = (await (requestedOpenAs
          ? this.doc.selectEntry(relPath, requestedOpenAs)
          : this.doc.selectEntry(relPath))) === true;
        if (!succeeded) return false;
        if (requestedOpenAs) {
          this.openAsStates.set(this.activeId, { relPath, openAs: requestedOpenAs });
        }
        else this.openAsStates.delete(this.activeId);
        return true;
      })
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
    try {
      await this.commitTransition(async () => {
        this.activeId = id;
        return this.loadActive(false);
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
      if (run.proceeded && run.before) await this.restoreTabsSafely(run.before);
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
      if (before) await this.restoreTabsSafely(before);
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
    this.ports.workspace?.reset();
    if (!await this.doc.openPath(entry.path, false)) return false;
    if (entry.kind === "folder" && entry.selectedRelPath
      && (await this.doc.selectEntry(entry.selectedRelPath)) !== true) return false;
    // 履歴には形式指定を保存しない。移動に成功した時点で、通常の拡張子へ戻す。
    this.openAsStates.delete(tab.id);
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
      if (id !== this.activeId) return;
      this.rememberActiveView();
      if (id === this.activeId && !(await this.doc.confirmDiscard())) return;
      this.syncActive(this.doc.current);
      const closed = { tab: this.state.tabs[0], index: 0 };
      const replacement = await this.blankTab(null);
      this.workspaceStates.delete(id);
      this.findHighlightStates.delete(id);
      await this.commitTransition(async () => {
        this.tabs = [replacement];
        this.activeId = this.tabs[0].id;
        await this.doc.newFile(false, replacement.draftDirectory ?? null);
        this.ports.findHighlight?.restore(null);
      });
      this.closedTabs.push({ ...closed, replacementId: replacement.id });
      return;
    }
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    if (id === this.activeId) {
      this.rememberActiveView();
      if (!(await this.doc.confirmDiscard())) return;
      this.syncActive(this.doc.current);
      const closed = { tab: this.state.tabs[index], index };
      this.workspaceStates.delete(id);
      this.findHighlightStates.delete(id);
      await this.commitTransition(async () => {
        this.tabs.splice(index, 1);
        this.activateTabAfterRemoval(index);
        await this.loadActive();
      });
      this.closedTabs.push(closed);
    } else {
      const closed = { tab: this.state.tabs[index], index };
      this.workspaceStates.delete(id);
      this.findHighlightStates.delete(id);
      this.tabs.splice(index, 1);
      this.renderAndPersist();
      this.closedTabs.push(closed);
    }
  }

  async reopenLastClosed(): Promise<boolean> {
    const closed = this.closedTabs.at(-1);
    if (!closed || this.navigationBusy || this.transitionTarget) return false;
    this.transitionTarget = closed.tab.id;
    let reopened = false;
    try {
      await this.doc.confirmDiscard(async () => {
        this.rememberActiveView();
        reopened = await this.commitTransition(async () => {
          const tab = {
            ...closed.tab,
            viewState: closed.tab.viewState ? cloneEditorViewState(closed.tab.viewState) : undefined,
          };
          const replacementIndex = closed.replacementId
            ? this.tabs.findIndex((candidate) => candidate.id === closed.replacementId && candidate.kind === "blank")
            : -1;
          if (replacementIndex >= 0) this.tabs.splice(replacementIndex, 1);
          this.tabs.splice(Math.min(closed.index, this.tabs.length), 0, tab);
          this.activeId = tab.id;
          return this.loadActive(false);
        });
      });
      if (reopened) this.closedTabs.pop();
      return reopened;
    } finally {
      this.transitionTarget = null;
    }
  }

  async saveForExit(onProceed: () => void | Promise<void> = () => {}): Promise<boolean> {
    return this.doc.confirmDiscard(async () => {
      this.rememberActiveView();
      await onProceed();
    });
  }

  private async addAndActivate(
    tab: StoredTab,
  ): Promise<boolean> {
    return this.addAndActivateWith(tab, (tabs) => {
      tabs.push(tab);
      return true;
    });
  }

  private async addAndActivateAfter(tab: StoredTab, sourceTabId: string): Promise<boolean> {
    return this.addAndActivateWith(tab, (tabs) => {
      const sourceIndex = tabs.findIndex((candidate) => candidate.id === sourceTabId);
      if (sourceIndex < 0) return false;
      tabs.splice(sourceIndex + 1, 0, tab);
      return true;
    });
  }

  private async addAndActivateWith(
    tab: StoredTab,
    insert: (tabs: StoredTab[]) => boolean,
  ): Promise<boolean> {
    this.transitionTarget = tab.id;
    let activated = false;
    try {
      const proceeded = await this.doc.confirmDiscard(async () => {
        this.rememberActiveView();
        activated = await this.commitTransition(async () => {
          if (!insert(this.tabs)) return false;
          this.activeId = tab.id;
          return this.loadActive(false);
        });
      });
      return proceeded && activated;
    } finally {
      this.transitionTarget = null;
    }
  }

  private async commitTransition(operation: () => Promise<boolean | void>): Promise<boolean> {
    const before = this.state;
    try {
      if (await operation() === false) {
        await this.restoreTabsSafely(before);
        this.render();
        return false;
      }
    } catch (error) {
      await this.restoreTabsSafely(before);
      this.render();
      throw error;
    }
    this.renderAndPersist();
    return true;
  }

  private async restoreTabs(before: StoredTabs) {
    this.tabs = before.tabs;
    this.activeId = before.activeId ?? before.tabs[0]?.id ?? "";
    if (this.activeId) await this.loadActive();
  }

  private async restoreTabsSafely(before: StoredTabs) {
    try {
      await this.restoreTabs(before);
    } catch (error) {
      console.error("元のタブへ復帰できませんでした", error);
      await this.reportError(error, "タブを元に戻せませんでした");
    }
  }

  private async loadActive(fallbackToBlank = true): Promise<boolean> {
    this.loadingActive = true;
    try {
      const tab = this.active()!;
      const rememberedRelPath = tab.selectedRelPath;
      const rememberedOpenAs = this.openAsStates.get(tab.id);
      const rememberedViewState = tab.viewState ? cloneEditorViewState(tab.viewState) : undefined;
      const rememberedLine = tab.selectedLine ?? (tab.kind === "folder" ? rememberedViewState?.caret.line : undefined);
      let selectionRestored = false;
      this.ports.workspace?.reset();
      if (tab.path) {
        const opened = await this.doc.openPath(tab.path, false);
        if (!opened) {
          if (!fallbackToBlank) return false;
          tab.path = null;
          tab.kind = "blank";
          tab.label = "無題";
          await this.doc.newFile(false, tab.draftDirectory ?? null);
        } else if (rememberedRelPath) {
          try {
            const openAs = rememberedOpenAs
              && rememberedOpenAs.relPath.replace(/\\/g, "/") === rememberedRelPath.replace(/\\/g, "/")
              ? rememberedOpenAs.openAs
              : undefined;
            selectionRestored = (await (openAs
              ? this.doc.selectEntry(rememberedRelPath, openAs)
              : this.doc.selectEntry(rememberedRelPath))) === true;
          } catch (error) {
            // 一時的なIPC失敗で復元情報を消すと、次回タブ切替でも再試行できない。
            await this.reportError(error);
          }
          // 選択に失敗しても記録は保持する。項目削除と一時的な読込失敗を区別できないため、
          // 次回タブを開いたときに再試行できる状態を優先する。
        }
        const selectedLine = rememberedLine;
        if (opened && tab.goto) {
          this.doc.goTo(tab.goto);
          delete tab.goto;
        } else if (opened && tab.kind === "folder" && selectionRestored && tab.selectedRelPath) {
          if (rememberedViewState) {
            await this.doc.restoreViewState(rememberedViewState);
            tab.selectedLine = rememberedViewState.caret.line;
            delete tab.viewState;
          } else if (selectedLine !== undefined) {
            tab.selectedLine = selectedLine;
            this.doc.goTo({ line: selectedLine, col: 0 });
          }
        } else if (opened && tab.kind !== "folder" && tab.viewState) {
          await this.doc.restoreViewState(tab.viewState);
        }
      } else {
        await this.doc.newFile(false, tab.draftDirectory ?? null);
        if (tab.viewState) await this.doc.restoreViewState(tab.viewState);
      }
      const findHighlightState = this.findHighlightStates.get(tab.id);
      this.ports.findHighlight?.restore(
        findHighlightState && sameTabPath(findHighlightState.path, tab.path)
          ? cloneFindHighlightQuery(findHighlightState.query)
          : null,
      );
      const workspaceState = this.workspaceStates.get(tab.id);
      if (workspaceState && sameTabPath(workspaceState.path, tab.path)) {
        await this.ports.workspace?.restore(workspaceState.state);
      }
      return true;
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
      if (tab.selectedRelPath) {
        tab.selectedLine = view.caret.line;
        tab.viewState = view;
      } else {
        delete tab.selectedLine;
        delete tab.viewState;
      }
    } else {
      tab.viewState = view;
    }
    const workspaceState = this.ports.workspace?.capture() ?? null;
    if (!workspaceState || workspaceState.kind === null) this.workspaceStates.delete(tab.id);
    else this.workspaceStates.set(tab.id, { path: tab.path, state: workspaceState });
    const findHighlight = this.ports.findHighlight?.capture();
    if (findHighlight === undefined) this.findHighlightStates.delete(tab.id);
    else this.findHighlightStates.set(tab.id, {
      path: tab.path,
      query: cloneFindHighlightQuery(findHighlight),
    });
  }

  private active() {
    return this.tabs.find((tab) => tab.id === this.activeId);
  }

  private async blankTab(source: StoredTab | null = this.active() ?? null): Promise<StoredTab> {
    const draftDirectory = source?.kind === "folder" && source.path
      ? source.path
      : await this.resolveDefaultMemoDirectory();
    return this.link(null, undefined, draftDirectory);
  }

  private async resolveDefaultMemoDirectory(): Promise<string | null> {
    try {
      return await this.ports.defaultMemoDirectory?.() ?? null;
    } catch (error) {
      await this.reportError(error, "新規メモの既定保存先を取得できませんでした");
      return null;
    }
  }

  private link(
    path: string | null,
    goto?: Pos,
    draftDirectory?: string | null,
    fragment?: string,
  ): StoredTab {
    return {
      id: newId(),
      path,
      kind: path ? "file" : "blank",
      label: path ? basename(path) : "無題",
      ...(draftDirectory ? { draftDirectory } : {}),
      goto,
      ...(fragment !== undefined ? { fragment } : {}),
    };
  }

  private render() {
    this.pruneNavigationHistories();
    this.view.render({ tabs: this.tabs, activeId: this.activeId || null, dirty: this.doc.current.dirty });
    const history = this.navigationHistory.get(this.activeId);
    this.ports.onHistoryChange?.(history?.state ?? { canGoBack: false, canGoForward: false });
  }

  private renderAndPersist() {
    this.render();
    this.persist();
  }

  private pruneNavigationHistories() {
    const ids = new Set(this.tabs.map((tab) => tab.id));
    for (const id of this.navigationHistory.keys()) {
      if (!ids.has(id)) this.navigationHistory.delete(id);
    }
    for (const id of this.openAsStates.keys()) {
      if (!ids.has(id)) this.openAsStates.delete(id);
    }
  }

  private async keepOnly(id: string) {
    if (!await this.activate(id)) return;
    this.closeMatchingTabs((tab) => tab.id !== id);
  }

  private async closeRight(id: string) {
    const index = this.tabs.findIndex((tab) => tab.id === id);
    const activeIndex = this.tabs.findIndex((tab) => tab.id === this.activeId);
    if (activeIndex > index && !await this.activate(id)) return;
    this.closeMatchingTabs((_tab, candidateIndex) => candidateIndex > index);
  }

  private async closeSaved(keepId: string) {
    this.closeMatchingTabs((tab) => tab.id !== keepId && tab.id !== this.activeId && tab.kind !== "blank");
  }

  private closeMatchingTabs(remove: (tab: StoredTab, index: number) => boolean) {
    const snapshots = this.state.tabs;
    const kept: StoredTab[] = [];
    const closed: { tab: StoredTab; index: number }[] = [];
    this.tabs.forEach((tab, index) => {
      if (remove(tab, index)) {
        this.workspaceStates.delete(tab.id);
        this.findHighlightStates.delete(tab.id);
        closed.push({ tab: snapshots[index], index });
      }
      else kept.push(tab);
    });
    this.tabs = kept;
    this.closedTabs.push(...closed);
    this.renderAndPersist();
  }

  private persist() {
    this.ports.onChange(this.state);
  }

  private moveTab(sourceId: string, spot: TabDropSpot | null) {
    if (!spot || spot.targetId === sourceId) return;
    const source = this.tabs.findIndex((tab) => tab.id === sourceId);
    if (source < 0) return;
    const [tab] = this.tabs.splice(source, 1);
    const target = spot.targetId === null
      ? this.tabs.length
      : this.tabs.findIndex((item) => item.id === spot.targetId) + (spot.after ? 1 : 0);
    this.tabs.splice(Math.max(0, target), 0, tab);
    this.renderAndPersist();
  }

  private async reportError(error: unknown, message = "タブを操作できませんでした") {
    try {
      await this.ports.onError?.(error, message);
    } catch (reportError) {
      console.error(`${message}のエラーを表示できませんでした`, reportError);
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
    this.workspaceStates.delete(id);
    this.findHighlightStates.delete(id);
    this.tabs.splice(this.tabs.indexOf(tab), 1);
    if (!wasActive) {
      this.renderAndPersist();
      return;
    }
    if (this.tabs.length === 0) {
      const blank = this.link(null);
      this.tabs = [blank];
      this.activeId = blank.id;
      await this.doc.newFile(false);
      this.ports.findHighlight?.restore(null);
    } else {
      this.activateTabAfterRemoval(index);
      await this.loadActive();
    }
    this.renderAndPersist();
  }

  private activateTabAfterRemoval(index: number) {
    this.activeId = this.tabs[Math.max(0, index - 1)].id;
  }

  private openTabInNewWindow(tab: StoredTab) {
    return this.ports.onOpenInNewWindow?.({
      secondary: true,
      path: tab.path,
      goto: tab.viewState ? null : tab.goto ?? null,
      selectedRelPath: tab.selectedRelPath ?? null,
      viewState: tab.viewState ?? null,
    });
  }
}

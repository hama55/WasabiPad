export type CommandId = "new" | "open" | "openFolder" | "save" | "saveAs" | "refresh" | "quit" | "find" | "reopenClosedTab";

export interface Command {
  label: string;
  shortcut?: string;
  globalShortcut?: boolean;
  run: () => void | Promise<unknown>;
}

export type CommandRegistry = Record<CommandId, Command>;

interface CommandDependencies {
  newFile: () => Promise<unknown>;
  openFile: () => void;
  openFolder: () => void;
  save: () => Promise<unknown>;
  saveAs: () => Promise<unknown>;
  refresh: () => Promise<unknown>;
  quit: () => void;
  find: () => void;
  reopenClosedTab: () => Promise<unknown>;
}

type ClosestTarget = EventTarget & { closest?: (selector: string) => Element | null };

export interface FindCommandActions {
  openEditorSearch: () => void;
  focusWorkspaceSearch: () => void;
}

export function createCommandRegistry(deps: CommandDependencies): CommandRegistry {
  return {
    new: { label: "新規", shortcut: "Ctrl+N", globalShortcut: true, run: deps.newFile },
    open: { label: "開く...", shortcut: "Ctrl+O", globalShortcut: true, run: deps.openFile },
    openFolder: { label: "フォルダを開く...", run: deps.openFolder },
    save: { label: "上書き保存", shortcut: "Ctrl+S", globalShortcut: true, run: deps.save },
    saveAs: { label: "名前を付けて保存...", shortcut: "Ctrl+Shift+S", globalShortcut: true, run: deps.saveAs },
    refresh: { label: "ファイルを更新", shortcut: "F5", globalShortcut: true, run: deps.refresh },
    quit: { label: "終了", run: deps.quit },
    find: { label: "検索と置換", shortcut: "Ctrl+F", globalShortcut: true, run: deps.find },
    reopenClosedTab: {
      label: "閉じたタブを復活",
      shortcut: "Ctrl+Shift+T",
      globalShortcut: true,
      run: deps.reopenClosedTab,
    },
  };
}

export function runFindForTarget(
  target: EventTarget | null,
  actions: FindCommandActions,
): void {
  const element = target as ClosestTarget | null;
  if (element?.closest?.(".fv-tree") || element?.closest?.(".ws-search")) {
    actions.focusWorkspaceSearch();
    return;
  }
  if (element?.closest?.(".ve-find")) return;
  if (element?.closest?.(".ve")) actions.openEditorSearch();
}

export function isFindShortcut(event: KeyboardEvent): boolean {
  return event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === "f";
}

function shortcutFromEvent(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.shiftKey) parts.push("Shift");
  parts.push(event.key.length === 1 ? event.key.toUpperCase() : event.key);
  return parts.join("+");
}

export function globalCommandForEvent(
  registry: CommandRegistry,
  event: KeyboardEvent
): Command | undefined {
  if (event.defaultPrevented) return undefined;
  const target = event.target as ClosestTarget | null;
  const shortcut = shortcutFromEvent(event);
  const command = Object.values(registry).find(
    (command) => command.globalShortcut && command.shortcut === shortcut
  );
  if (command === registry.find && !isFindShortcut(event)) return undefined;
  if (target?.closest?.(".pf-overlay") && command !== registry.find) return undefined;
  return command;
}

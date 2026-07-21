export type CommandId = "new" | "open" | "openFolder" | "save" | "saveAs" | "quit" | "find";

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
  quit: () => void;
  find: () => void;
}

export function createCommandRegistry(deps: CommandDependencies): CommandRegistry {
  return {
    new: { label: "新規", shortcut: "Ctrl+N", globalShortcut: true, run: deps.newFile },
    open: { label: "開く...", shortcut: "Ctrl+O", globalShortcut: true, run: deps.openFile },
    openFolder: { label: "フォルダを開く...", run: deps.openFolder },
    save: { label: "上書き保存", shortcut: "Ctrl+S", globalShortcut: true, run: deps.save },
    saveAs: { label: "名前を付けて保存...", shortcut: "Ctrl+Shift+S", globalShortcut: true, run: deps.saveAs },
    quit: { label: "終了", run: deps.quit },
    find: { label: "検索と置換", shortcut: "Ctrl+F", run: deps.find },
  };
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
  const shortcut = shortcutFromEvent(event);
  return Object.values(registry).find(
    (command) => command.globalShortcut && command.shortcut === shortcut
  );
}

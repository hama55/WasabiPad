// 設定の永続化 (保存先は core/src/settings.rs が決める)。
// UI から同期的に読めるよう、起動時に一度だけ読み込んでメモリへ載せる。
// 配色モードだけは localStorage に残す (ウィンドウ間の即時同期を storage イベントに任せるため)。
import type { WorkspaceSearchOptions } from "./api";
import { loadSettings as loadSettingsJson, updateSetting } from "./api";
import { clampSearchOptions, DEFAULT_SEARCH_OPTIONS } from "./workspace-search-options";
import { isStoredTabs, type StoredTabs } from "./stored-tabs";
import { DEFAULT_EDITOR_CONFIG } from "./editor-config";
import { DEFAULT_INDENT_SIZE, INDENT_SIZES, isValidFontSize } from "./font-controls";

export interface Settings {
  indentSize: number;
  fontFamily: string;
  fontSize: number;
  startupPath: string | null;
  registeredStrings: string[];
  registeredCommands: RegisteredCommand[];
  // null は「未設定」。既定値は ui/workspace-search-options.ts だけが持つ
  workspaceSearchOptions: WorkspaceSearchOptions | null;
  openTabs: StoredTabs;
}

export interface RegisteredCommand {
  extension: string;
  label: string;
  prefix: string;
  command: string;
}

const DEFAULTS: Settings = {
  indentSize: DEFAULT_INDENT_SIZE,
  fontFamily: DEFAULT_EDITOR_CONFIG.fontFamily,
  fontSize: DEFAULT_EDITOR_CONFIG.fontSize,
  startupPath: null,
  registeredStrings: [],
  registeredCommands: [],
  workspaceSearchOptions: null,
  openTabs: { tabs: [], activeId: null },
};

let cache: Settings = { ...DEFAULTS };
let pendingSave = Promise.resolve();
const saveErrors = new Map<keyof Settings, unknown>();

// 手で編集されうるファイルなので、型が合わない項目は既定値へ落とす
export function parseSettings(text: string): Settings {
  let value: Partial<Settings>;
  try {
    value = JSON.parse(text) as Partial<Settings>;
  } catch {
    return { ...DEFAULTS };
  }
  if (typeof value !== "object" || value === null) return { ...DEFAULTS };
  return {
    indentSize: typeof value.indentSize === "number" && INDENT_SIZES.includes(value.indentSize as typeof INDENT_SIZES[number])
      ? value.indentSize
      : DEFAULTS.indentSize,
    fontFamily: typeof value.fontFamily === "string" && value.fontFamily.length > 0
      ? value.fontFamily
      : DEFAULTS.fontFamily,
    fontSize: isValidFontSize(value.fontSize)
      ? value.fontSize
      : DEFAULTS.fontSize,
    startupPath: typeof value.startupPath === "string" ? value.startupPath : null,
    registeredStrings: Array.isArray(value.registeredStrings)
      ? value.registeredStrings.filter((item): item is string => typeof item === "string" && item.length > 0)
      : [],
    registeredCommands: Array.isArray(value.registeredCommands)
      ? value.registeredCommands
        .filter(isRegisteredCommand)
        .map((item) => ({
          extension: item.extension.trim().toLowerCase(),
          label: item.label.trim(),
          prefix: typeof item.prefix === "string" ? item.prefix.trim() : "",
          command: item.command.trim(),
        }))
      : [],
    workspaceSearchOptions:
      typeof value.workspaceSearchOptions === "object" && value.workspaceSearchOptions !== null
        ? value.workspaceSearchOptions
        : null,
    openTabs: isStoredTabs(value.openTabs) ? value.openTabs : DEFAULTS.openTabs,
  };
}

function isRegisteredCommand(value: unknown): value is RegisteredCommand {
  if (typeof value !== "object" || value === null) return false;
  const command = value as Partial<RegisteredCommand>;
  return typeof command.extension === "string"
    && typeof command.label === "string"
    && command.label.trim().length > 0
    && typeof command.command === "string"
    && command.command.trim().length > 0;
}

export async function initSettings(): Promise<void> {
  try {
    cache = parseSettings(await loadSettingsJson());
  } catch (error) {
    console.error("設定を読み込めませんでした", error);
    cache = { ...DEFAULTS };
  }
  pendingSave = Promise.resolve();
  saveErrors.clear();
}

export function getSetting<K extends keyof Settings>(key: K): Settings[K] {
  return cache[key];
}

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  cache = { ...cache, [key]: value };
  pendingSave = pendingSave
    .then(async () => {
      try {
        await updateSetting(key, JSON.stringify(value));
        saveErrors.delete(key);
      } catch (error) {
        saveErrors.set(key, error);
        console.error("設定を保存できませんでした", error);
      }
    });
}

export async function flushSettings(): Promise<void> {
  await pendingSave;
  const error = saveErrors.values().next().value;
  if (error !== undefined) throw error;
}

// 検索条件は手で編集されうるファイルに載るので、既定値で埋めてから丸める
export function loadSearchOptions(): WorkspaceSearchOptions {
  const stored = getSetting("workspaceSearchOptions");
  if (!stored) return { ...DEFAULT_SEARCH_OPTIONS };
  return clampSearchOptions({ ...DEFAULT_SEARCH_OPTIONS, ...stored });
}

export function saveSearchOptions(options: WorkspaceSearchOptions): void {
  setSetting("workspaceSearchOptions", options);
}

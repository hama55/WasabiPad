// 設定の永続化 (保存先は core/src/settings.rs が決める)。
// UI から同期的に読めるよう、起動時に一度だけ読み込んでメモリへ載せる。
// 配色モードだけは localStorage に残す (ウィンドウ間の即時同期を storage イベントに任せるため)。
import type { WorkspaceSearchOptions } from "./api";
import { loadSettings as loadSettingsJson, saveSettings as saveSettingsJson } from "./api";
import { clampSearchOptions, DEFAULT_SEARCH_OPTIONS } from "./workspace-search-options";
import type { StoredTabs } from "./tabs";

export interface Settings {
  indentSize: number;
  startupPath: string | null;
  registeredStrings: string[];
  // null は「未設定」。既定値は ui/workspace-search-options.ts だけが持つ
  workspaceSearchOptions: WorkspaceSearchOptions | null;
  openTabs: StoredTabs;
}

const DEFAULTS: Settings = {
  indentSize: 8,
  startupPath: null,
  registeredStrings: [],
  workspaceSearchOptions: null,
  openTabs: { tabs: [], activeId: null },
};

let cache: Settings = { ...DEFAULTS };

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
    indentSize: typeof value.indentSize === "number" ? value.indentSize : DEFAULTS.indentSize,
    startupPath: typeof value.startupPath === "string" ? value.startupPath : null,
    registeredStrings: Array.isArray(value.registeredStrings)
      ? value.registeredStrings.filter((item): item is string => typeof item === "string" && item.length > 0)
      : [],
    workspaceSearchOptions:
      typeof value.workspaceSearchOptions === "object" && value.workspaceSearchOptions !== null
        ? value.workspaceSearchOptions
        : null,
    openTabs: validStoredTabs(value.openTabs) ? value.openTabs : DEFAULTS.openTabs,
  };
}

function validStoredTabs(value: unknown): value is StoredTabs {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<StoredTabs>;
  return Array.isArray(candidate.tabs)
    && candidate.tabs.every((tab) =>
      typeof tab === "object" && tab !== null
      && typeof tab.id === "string"
      && (typeof tab.path === "string" || tab.path === null)
      && (tab.kind === "file" || tab.kind === "folder" || tab.kind === "blank")
      && typeof tab.label === "string"
      && (!("viewState" in tab) || tab.viewState === undefined || validViewState(tab.viewState)))
    && (typeof candidate.activeId === "string" || candidate.activeId === null);
}

function validViewState(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  return validPos(state.anchor)
    && validPos(state.caret)
    && typeof state.topLine === "number"
    && typeof state.wrapIntraLinePx === "number"
    && typeof state.scrollLeft === "number";
}

function validPos(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const pos = value as Record<string, unknown>;
  return typeof pos.line === "number" && typeof pos.col === "number";
}

export async function initSettings(): Promise<void> {
  try {
    cache = parseSettings(await loadSettingsJson());
  } catch {
    cache = { ...DEFAULTS };
  }
}

export function getSetting<K extends keyof Settings>(key: K): Settings[K] {
  return cache[key];
}

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  cache = { ...cache, [key]: value };
  void saveSettingsJson(JSON.stringify(cache, null, 2)).catch((error: unknown) => {
    console.error("設定を保存できませんでした", error);
  });
}

export function flushSettings(): Promise<void> {
  return saveSettingsJson(JSON.stringify(cache, null, 2));
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

// 設定の永続化 (保存先は core/src/settings.rs が決める)。
// UI から同期的に読めるよう、起動時に一度だけ読み込んでメモリへ載せる。
// 配色モードだけは localStorage に残す (ウィンドウ間の即時同期を storage イベントに任せるため)。
import type { WorkspaceSearchOptions } from "./api";
import { loadSettings as loadSettingsJson, updateSetting } from "./api";
import { clampSearchOptions, DEFAULT_SEARCH_OPTIONS } from "./workspace-search-options";
import { normalizeStoredTabs, type StoredTabs } from "./stored-tabs";
import { DEFAULT_EDITOR_CONFIG } from "./editor-config";
import { DEFAULT_INDENT_SIZE, INDENT_SIZES, isValidFontSize } from "./font-controls";
import { isRegisteredCommand, normalizeRegisteredCommand, type RegisteredCommand } from "./registered-command-model";
import { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MIN_WIDTH } from "./preview-layout";

export type { RegisteredCommand } from "./registered-command-model";

export const DEFAULT_MARKDOWN_LINE_HEIGHT = 1.65;
export const MIN_MARKDOWN_LINE_HEIGHT = 1.4;
export const MAX_MARKDOWN_LINE_HEIGHT = 2;
export const DEFAULT_SQLITE_PREVIEW_ROWS = 100;

export function isValidSqlitePreviewRows(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

export function isValidMarkdownLineHeight(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
    && value >= MIN_MARKDOWN_LINE_HEIGHT && value <= MAX_MARKDOWN_LINE_HEIGHT;
}

export interface Settings {
  indentSize: number;
  sidebarWidth: number;
  fontFamily: string;
  fontSize: number;
  previewFontSize: number;
  markdownSoftBreaks: boolean;
  markdownLineHeight: number;
  markdownHeadingUnderlines: boolean;
  sqlitePreviewRows: number;
  previewCacheDirectory: string | null;
  startupPath: string | null;
  registeredStrings: string[];
  registeredCommands: RegisteredCommand[];
  // null は「未設定」。既定値は ui/workspace-search-options.ts だけが持つ
  workspaceSearchOptions: WorkspaceSearchOptions | null;
  openTabs: StoredTabs;
}

const DEFAULTS: Settings = {
  indentSize: DEFAULT_INDENT_SIZE,
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  fontFamily: DEFAULT_EDITOR_CONFIG.fontFamily,
  fontSize: DEFAULT_EDITOR_CONFIG.fontSize,
  previewFontSize: DEFAULT_EDITOR_CONFIG.fontSize,
  markdownSoftBreaks: true,
  markdownLineHeight: DEFAULT_MARKDOWN_LINE_HEIGHT,
  markdownHeadingUnderlines: false,
  sqlitePreviewRows: DEFAULT_SQLITE_PREVIEW_ROWS,
  previewCacheDirectory: null,
  startupPath: null,
  registeredStrings: [],
  registeredCommands: [],
  workspaceSearchOptions: null,
  openTabs: { tabs: [], activeId: null },
};

export const SIDEBAR_MAX_WIDTH = 640;

export function clampSidebarWidth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULTS.sidebarWidth;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(value)));
}

let cache: Settings = { ...DEFAULTS };
let pendingSave = Promise.resolve();
const saveErrors = new Map<keyof Settings, unknown>();

// 手で編集されうるファイルなので、型が合わない項目は既定値へ落とす
export function parseSettings(text: string): Settings {
  return parseSettingsResult(text).settings;
}

export interface SettingsParseResult {
  settings: Settings;
  corrupted: boolean;
}

export function parseSettingsResult(text: string): SettingsParseResult {
  let value: Partial<Settings>;
  try {
    value = JSON.parse(text) as Partial<Settings>;
  } catch {
    return { settings: { ...DEFAULTS }, corrupted: true };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { settings: { ...DEFAULTS }, corrupted: true };
  }
  const settings: Settings = {
    indentSize: typeof value.indentSize === "number" && INDENT_SIZES.includes(value.indentSize as typeof INDENT_SIZES[number])
      ? value.indentSize
      : DEFAULTS.indentSize,
    sidebarWidth: clampSidebarWidth(value.sidebarWidth),
    fontFamily: typeof value.fontFamily === "string" && value.fontFamily.length > 0
      ? value.fontFamily
      : DEFAULTS.fontFamily,
    fontSize: isValidFontSize(value.fontSize)
      ? value.fontSize
      : DEFAULTS.fontSize,
    previewFontSize: isValidFontSize(value.previewFontSize)
      ? value.previewFontSize
      : isValidFontSize(value.fontSize) ? value.fontSize : DEFAULTS.previewFontSize,
    markdownSoftBreaks: typeof value.markdownSoftBreaks === "boolean"
      ? value.markdownSoftBreaks
      : DEFAULTS.markdownSoftBreaks,
    markdownLineHeight: isValidMarkdownLineHeight(value.markdownLineHeight)
      ? value.markdownLineHeight
      : DEFAULTS.markdownLineHeight,
    markdownHeadingUnderlines: typeof value.markdownHeadingUnderlines === "boolean"
      ? value.markdownHeadingUnderlines
      : DEFAULTS.markdownHeadingUnderlines,
    sqlitePreviewRows: isValidSqlitePreviewRows(value.sqlitePreviewRows)
      ? value.sqlitePreviewRows
      : DEFAULTS.sqlitePreviewRows,
    previewCacheDirectory: typeof value.previewCacheDirectory === "string" && value.previewCacheDirectory.trim().length > 0
      ? value.previewCacheDirectory
      : DEFAULTS.previewCacheDirectory,
    startupPath: typeof value.startupPath === "string" ? value.startupPath : null,
    registeredStrings: Array.isArray(value.registeredStrings)
      ? value.registeredStrings.filter((item): item is string => typeof item === "string" && item.length > 0)
      : [],
    registeredCommands: Array.isArray(value.registeredCommands)
      ? value.registeredCommands
        .filter(isRegisteredCommand)
        .map(normalizeRegisteredCommand)
      : [],
    workspaceSearchOptions:
      typeof value.workspaceSearchOptions === "object" && value.workspaceSearchOptions !== null
        ? value.workspaceSearchOptions
        : null,
    openTabs: normalizeStoredTabs(value.openTabs) ?? DEFAULTS.openTabs,
  };
  return { settings, corrupted: false };
}

export async function initSettings(
  onWarning?: (error: unknown) => void | Promise<void>,
): Promise<void> {
  let shouldWarn = false;
  let warning: unknown;
  try {
    const parsed = parseSettingsResult(await loadSettingsJson());
    cache = parsed.settings;
    if (parsed.corrupted) {
      warning = new Error("設定JSONが壊れているため、既定値を使用しました");
      shouldWarn = true;
      console.error("設定JSONが壊れているため、既定値を使用しました");
    }
  } catch (error) {
    console.error("設定を読み込めませんでした", error);
    cache = { ...DEFAULTS };
    warning = error;
    shouldWarn = true;
  }
  pendingSave = Promise.resolve();
  saveErrors.clear();
  if (shouldWarn) await onWarning?.(warning);
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

// アプリ設定だけを既定値へ戻す。openTabs は作業再開に必要なセッション状態なので触らない。
export function resetUserSettings(): void {
  setSetting("indentSize", DEFAULTS.indentSize);
  setSetting("sidebarWidth", DEFAULTS.sidebarWidth);
  setSetting("fontFamily", DEFAULTS.fontFamily);
  setSetting("fontSize", DEFAULTS.fontSize);
  setSetting("previewFontSize", DEFAULTS.previewFontSize);
  setSetting("markdownSoftBreaks", DEFAULTS.markdownSoftBreaks);
  setSetting("markdownLineHeight", DEFAULTS.markdownLineHeight);
  setSetting("markdownHeadingUnderlines", DEFAULTS.markdownHeadingUnderlines);
  setSetting("sqlitePreviewRows", DEFAULTS.sqlitePreviewRows);
  setSetting("previewCacheDirectory", DEFAULTS.previewCacheDirectory);
  setSetting("startupPath", DEFAULTS.startupPath);
  setSetting("registeredStrings", []);
  setSetting("registeredCommands", []);
  setSetting("workspaceSearchOptions", DEFAULTS.workspaceSearchOptions);
}

export async function flushSettings(): Promise<void> {
  for (;;) {
    const current = pendingSave;
    await current;
    if (current === pendingSave) break;
  }
  const firstError = saveErrors.values().next();
  if (!firstError.done) throw firstError.value;
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

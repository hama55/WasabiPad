import type { WorkspaceSearchOptions } from "./api";
import { getSetting, setSetting } from "./settings";

// フォルダ検索の設定はここが単一の定義。backend は既定値を持たず、常にこの値を受け取る。

// 除外候補として設定パネルに並べるフォルダ名 (チェックを外せば検索対象になる)
export const EXCLUDE_DIR_CANDIDATES = [".git", "node_modules", "target", "dist", ".venv"];

export const DEFAULT_SEARCH_OPTIONS: WorkspaceSearchOptions = {
  match_case: false,
  max_file_bytes: 16 * 1024 * 1024,
  max_files: 20_000,
  max_results: 200,
  exclude_dirs: [".git", "node_modules", "target"],
  search_file_names: true,
  search_contents: true,
  workers: 0,
};

// 不正値で backend を長時間走らせないための上限。設定パネルの入力も同じ範囲で丸める
const LIMITS = {
  max_file_bytes: { min: 1024, max: 1024 * 1024 * 1024 },
  max_files: { min: 1, max: 1_000_000 },
  max_results: { min: 1, max: 10_000 },
  workers: { min: 0, max: 64 },
} as const;

export function clampSearchOptions(options: WorkspaceSearchOptions): WorkspaceSearchOptions {
  const clamp = (key: keyof typeof LIMITS) =>
    Math.min(LIMITS[key].max, Math.max(LIMITS[key].min, Math.round(Number(options[key]) || 0)));
  return {
    match_case: !!options.match_case,
    max_file_bytes: clamp("max_file_bytes"),
    max_files: clamp("max_files"),
    max_results: clamp("max_results"),
    exclude_dirs: [...new Set(options.exclude_dirs.map((dir) => dir.trim()).filter(Boolean))],
    search_file_names: !!options.search_file_names,
    search_contents: !!options.search_contents,
    workers: clamp("workers"),
  };
}

export function loadSearchOptions(): WorkspaceSearchOptions {
  const stored = getSetting("workspaceSearchOptions");
  if (!stored) return { ...DEFAULT_SEARCH_OPTIONS };
  return clampSearchOptions({ ...DEFAULT_SEARCH_OPTIONS, ...stored });
}

export function saveSearchOptions(options: WorkspaceSearchOptions) {
  setSetting("workspaceSearchOptions", options);
}

// 「見つかりません」の説明。現在の設定をそのまま読み上げ、除外理由を推測させない。
export function searchScopeSummary(options: WorkspaceSearchOptions): string {
  const parts = [
    `${(options.max_file_bytes / (1024 * 1024)).toFixed(0)} MB超`,
    "読み取り不能",
    ...(options.exclude_dirs.length ? [`${options.exclude_dirs.join(" / ")} 配下`] : []),
    `${options.max_files.toLocaleString()}件以降`,
  ];
  const target = options.search_contents
    ? options.search_file_names ? "ファイル名と本文" : "本文のみ"
    : "ファイル名のみ";
  const binary = options.search_contents ? "。バイナリはファイル名のみ検索" : "";
  return `検索対象: ${target}／検索対象外: ${parts.join("、")}${binary}`;
}

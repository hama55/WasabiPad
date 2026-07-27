import type { WorkspaceSearchOptions } from "./api";
import { getSetting, setSetting } from "./settings";

// フォルダ検索の設定はここが単一の定義。backend は既定値を持たず、常にこの値を受け取る。

// 中を検索してもまず得るものがないフォルダ。設定ダイアログから自由に足し引きできる。
export const DEFAULT_EXCLUDE_DIRS = [
  ".git",
  ".svn",
  "node_modules",
  "target",
  "dist",
  "build",
  "__pycache__",
  ".venv",
  "venv",
  ".idea",
  ".vscode",
  "$RECYCLE.BIN",
  "System Volume Information",
];

// 打ち切り条件はすべて 0 = 無制限。「あるはずのものが出ない」検索にしないため、
// 省略が起きるのは利用者が明示的に上限を入れたときだけにする。
export const DEFAULT_SEARCH_OPTIONS: WorkspaceSearchOptions = {
  match_case: false,
  max_file_bytes: 0,
  max_files: 0,
  max_results: 0,
  exclude_dirs: [...DEFAULT_EXCLUDE_DIRS],
  exclude_binary: true,
  search_file_names: true,
  search_contents: true,
  workers: 0,
};

// 入力欄の値を丸める範囲。下限 0 は「無制限」の意味を保つため
const LIMITS = {
  max_file_bytes: { min: 0, max: 1024 * 1024 * 1024 },
  max_files: { min: 0, max: 10_000_000 },
  max_results: { min: 0, max: 1_000_000 },
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
    exclude_binary: !!options.exclude_binary,
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
// 無制限の項目は挙げない (対象外でないものを対象外として読ませないため)。
export function searchScopeSummary(options: WorkspaceSearchOptions): string {
  const target = options.search_contents
    ? options.search_file_names ? "ファイル名と本文" : "本文のみ"
    : "ファイル名のみ";
  const skipped = ["読み取れないファイル"];
  if (options.exclude_binary) skipped.push("バイナリファイル");
  if (options.max_file_bytes) {
    skipped.push(`${(options.max_file_bytes / (1024 * 1024)).toFixed(0)} MB超のファイル`);
  }
  if (options.max_files) skipped.push(`${options.max_files.toLocaleString()}件目以降のファイル`);
  if (options.exclude_dirs.length) skipped.push(`${options.exclude_dirs.join(" / ")} 配下`);
  return `検索対象: ${target}／検索対象外: ${skipped.join("、")}`;
}

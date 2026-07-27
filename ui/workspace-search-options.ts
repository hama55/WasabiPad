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

// 中を検索しても意味が薄いファイル。glob なので拡張子以外も書ける。
export const DEFAULT_EXCLUDE_GLOBS = ["*.min.js", "*.map", "*.lock"];

// 打ち切り条件はすべて 0 = 無制限。「あるはずのものが出ない」検索にしないため、
// 省略が起きるのは利用者が明示的に上限を入れたときだけにする。
export const DEFAULT_SEARCH_OPTIONS: WorkspaceSearchOptions = {
  match_case: false,
  use_regex: false,
  whole_word: false,
  max_file_bytes: 0,
  max_files: 0,
  max_results: 0,
  exclude_dirs: [...DEFAULT_EXCLUDE_DIRS],
  exclude_globs: [...DEFAULT_EXCLUDE_GLOBS],
  exclude_binary: true,
  respect_gitignore: false, // プログラマー以外には意味のない除外なので既定は切る
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

const cleanList = (list: string[]) =>
  [...new Set((list ?? []).map((item) => item.trim()).filter(Boolean))];

export function clampSearchOptions(options: WorkspaceSearchOptions): WorkspaceSearchOptions {
  const clamp = (key: keyof typeof LIMITS) =>
    Math.min(LIMITS[key].max, Math.max(LIMITS[key].min, Math.round(Number(options[key]) || 0)));
  return {
    match_case: !!options.match_case,
    use_regex: !!options.use_regex,
    whole_word: !!options.whole_word,
    max_file_bytes: clamp("max_file_bytes"),
    max_files: clamp("max_files"),
    max_results: clamp("max_results"),
    exclude_dirs: cleanList(options.exclude_dirs),
    exclude_globs: cleanList(options.exclude_globs),
    exclude_binary: !!options.exclude_binary,
    respect_gitignore: !!options.respect_gitignore,
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
  // ファイル名の当て方は本文と同じとは限らない。当て方が違う条件のときだけ断る
  const fuzzyNames = options.search_file_names && !options.use_regex && !options.whole_word;
  const how = [
    options.match_case ? "大文字小文字を区別" : null,
    options.use_regex ? "正規表現" : null,
    options.whole_word ? "単語単位" : null,
    fuzzyNames ? "ファイル名はファジー一致" : null,
  ].filter(Boolean);
  const skipped = ["読み取れないファイル"];
  if (options.exclude_binary) skipped.push("バイナリファイル");
  if (options.respect_gitignore) skipped.push(".gitignore の対象");
  if (options.max_file_bytes) {
    skipped.push(`${(options.max_file_bytes / (1024 * 1024)).toFixed(0)} MB超のファイル`);
  }
  if (options.max_files) skipped.push(`${options.max_files.toLocaleString()}件目以降のファイル`);
  if (options.exclude_dirs.length) skipped.push(`${options.exclude_dirs.join(" / ")} 配下`);
  if (options.exclude_globs.length) skipped.push(options.exclude_globs.join(" / "));
  return [
    `検索対象: ${target}${how.length ? ` (${how.join("・")})` : ""}`,
    `検索対象外: ${skipped.join("、")}`,
  ].join("／");
}

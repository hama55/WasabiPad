import type { FileNameMatchMode, WorkspaceSearchOptions } from "./api";

// フォルダ検索の設定はここが単一の定義。backend は既定値を持たず、常にこの値を受け取る。
// 保存と読み出しは持たない (どこに置くかを知るのは ui/settings.ts)。

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

// 項目のキーは型から引く。画面ごとに手で並べると、項目を足したときに片方だけ古くなる
type KeysOfType<T> = {
  [K in keyof WorkspaceSearchOptions]: WorkspaceSearchOptions[K] extends T ? K : never;
}[keyof WorkspaceSearchOptions];
export type BoolOptionKey = KeysOfType<boolean>;
export type NumberOptionKey = KeysOfType<number>;
export type ListOptionKey = KeysOfType<string[]>;

// 最大ファイルサイズだけは MB で入力し、MB で読み上げる (バイトのままでは桁が読めない)
export const MB = 1024 * 1024;

// 入力欄の値を丸める範囲。下限 0 は「無制限」の意味を保つため
const LIMITS = {
  max_file_bytes: { min: 0, max: 1024 * MB },
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

// 条件が実際に変わったかどうか。変わっていないのに検索し直すと、
// 走査中だった結果がそこで捨てられる。
export function sameSearchOptions(a: WorkspaceSearchOptions, b: WorkspaceSearchOptions): boolean {
  const keys = Object.keys(DEFAULT_SEARCH_OPTIONS) as (keyof WorkspaceSearchOptions)[];
  return keys.every((key) => JSON.stringify(a[key]) === JSON.stringify(b[key]));
}

// 各フラグの意味はここが単一の定義。入力欄のトグル (ツールチップ) と設定ダイアログ
// (ラベル+補足) の両方がここを読む。別々に文言を持つと、同じフラグが画面ごとに
// 違う意味を持って見える。記号 (Aa / ab / .*) だけは入力欄の都合なので sidebar が持つ。
export const OPTION_TEXTS: Record<BoolOptionKey, { label: string; hint: string }> = {
  match_case: { label: "大文字小文字を区別する", hint: "" },
  whole_word: {
    label: "単語単位で一致",
    hint: "前後が単語の区切りのときだけ当てる。ファイル名もファジーをやめる",
  },
  use_regex: {
    label: "正規表現として扱う",
    hint: "Rust regex 構文。ファイル名もファジーをやめる。壊れている間は理由を結果欄に出す",
  },
  search_file_names: { label: "ファイル名", hint: "ファジー一致 (wsopt → workspace-search-options.ts)" },
  search_contents: { label: "本文", hint: "ripgrep のエンジンで走査する" },
  exclude_binary: { label: "バイナリファイル", hint: ".pyc / .exe / 画像など (先頭にNULを含むもの)" },
  respect_gitignore: { label: ".gitignore を尊重する", hint: ".ignore と親フォルダの設定もたどる" },
};

// 1行に畳んだ説明 (ツールチップ用)
export function optionTitle(key: BoolOptionKey): string {
  const { label, hint } = OPTION_TEXTS[key];
  return hint ? `${label} — ${hint}` : label;
}

// 「見つかりません」の説明。現在の設定をそのまま読み上げ、除外理由を推測させない。
// 無制限の項目は挙げない (対象外でないものを対象外として読ませないため)。
export function searchScopeSummary(
  options: WorkspaceSearchOptions,
  fileNameMatchMode: FileNameMatchMode
): string {
  const target = options.search_file_names && options.search_contents
    ? "ファイル名と本文"
    : options.search_file_names
      ? "ファイル名のみ"
      : options.search_contents
        ? "本文のみ"
        : "検索対象なし";
  // ファイル名の当て方は本文と同じとは限らない。当て方が違う条件のときだけ断る
  const how = [
    options.match_case ? "大文字小文字を区別" : null,
    options.use_regex ? "正規表現" : null,
    options.whole_word ? "単語単位" : null,
    fileNameMatchMode === "fuzzy" ? "ファイル名はファジー一致" : null,
  ].filter(Boolean);
  const skipped = ["読み取れないファイル"];
  if (options.exclude_binary) skipped.push("バイナリファイル");
  if (options.respect_gitignore) skipped.push(".gitignore の対象");
  if (options.max_file_bytes) {
    skipped.push(`${(options.max_file_bytes / MB).toFixed(0)} MB超のファイル`);
  }
  if (options.max_files) skipped.push(`${options.max_files.toLocaleString()}件目以降のファイル`);
  if (options.exclude_dirs.length) skipped.push(`${options.exclude_dirs.join(" / ")} 配下`);
  if (options.exclude_globs.length) skipped.push(options.exclude_globs.join(" / "));
  return [
    `検索対象: ${target}${how.length ? ` (${how.join("・")})` : ""}`,
    `検索対象外: ${skipped.join("、")}`,
  ].join("／");
}

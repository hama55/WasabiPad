import { invoke } from "@tauri-apps/api/core";

// char 単位の位置 (backend と共有)。col は Unicode スカラー index。
export interface Pos {
  line: number;
  col: number;
}

export type Encoding = "utf8" | "utf8bom" | "sjis" | "utf16le";
export type ReadEncoding = "utf8" | "sjis" | "utf16le";
export type Eol = "crlf" | "lf";

export interface DocInfo {
  kind: "text" | "archive";
  line_count: number;
  enc: Encoding;
  eol: Eol;
  path: string;
  entries: string[] | null; // ZIP/.xls の閲覧専用エントリ名
  folder_entries: FolderEntry[] | null; // フォルダ直下の子
  folder_root: string | null; // フォルダ閲覧中のルート絶対パス
  view_only: boolean;
  byte_len: number;
}

export interface FolderEntry {
  name: string;
  is_dir: boolean;
}

export interface WorkspaceSearchResult {
  rel_path: string;
  line: number;
  col: number;
  preview: string;
  is_filename: boolean;
}

export interface EditResult {
  caret: Pos;
  line_count: number;
}

export interface EditManyItem {
  start: Pos;
  end: Pos;
  text: string;
}

export interface EditManyResult {
  carets: Pos[];
  line_count: number;
}

export interface FindResult {
  start: Pos;
  end: Pos;
}

// チャンク分割検索の再開カーソル。find_step の呼び出し間でそのまま受け渡しする。
export interface FindCursor {
  wrapped: boolean;
  line: number;
}

export type FindOutcome =
  | { kind: "Found"; start: Pos; end: Pos }
  | { kind: "More"; cursor: FindCursor }
  | { kind: "NotFound" };

export interface ReplaceChunkResult {
  done: boolean;
  count: number;
  caret: Pos;
  line_count: number;
}

// 外部変更ポーリングの結果。reloaded は未編集文書が自動で読み直された場合
export type ExternalCheck =
  | { kind: "unchanged" }
  | { kind: "reloaded"; info: DocInfo }
  | { kind: "conflict" };

// 保存の結果。conflict は保存先が外部で変更されていたため退避ファイルへ保存した場合
export type SaveOutcome =
  | { kind: "saved" }
  | { kind: "conflict"; saved_to: string };

export type BmNode =
  | { kind: "file"; name: string; path: string }
  | { kind: "directory"; name: string; path: string }
  | { kind: "group"; name: string; children: BmNode[] };

export const openPath = (path: string) => invoke<DocInfo>("open_path", { path });
export const newDoc = () => invoke<void>("new_doc");
export const closeDoc = () => invoke<void>("close_doc");

// 可視範囲だけ取得 (全文は決して渡らない)
export const lines = (start: number, count: number) =>
  invoke<string[]>("lines", { start, count });
export const lineCharLen = (line: number) => invoke<number>("line_char_len", { line });
export const selectEntry = (relPath: string) => invoke<DocInfo>("select_entry", { relPath });

// ツリーの展開ボタン用。zip/xlsx/xls の中身一覧だけを取得する (本文は読まない)。
// relPath が空文字なら直接開いているアーカイブ自身、それ以外はフォルダ内の相対パス。
export const listArchiveEntries = (relPath: string) =>
  invoke<string[]>("list_archive_entries", { relPath });

// 指定フォルダの直下だけを取得する。サブフォルダの中身は展開時まで取得しない。
export const listFolderEntries = (relDir: string) =>
  invoke<FolderEntry[]>("list_folder_entries", { relDir });

// フォルダ検索の打ち切り条件。既定値は ui/workspace-search-options.ts が持つ
export interface WorkspaceSearchOptions {
  match_case: boolean;
  max_file_bytes: number;
  max_files: number;
  max_results: number;
  exclude_dirs: string[];
  search_file_names: boolean;
  search_contents: boolean;
  workers: number; // 0 = 自動
}

export const workspaceSearch = (pat: string, options: WorkspaceSearchOptions) =>
  invoke<WorkspaceSearchResult[]>("workspace_search", { pat, options });

// フォルダ内に空の新規ファイルを作り、その場で開く (dir はフォルダルートからの相対パス)
export const createNote = (dir: string | null, name: string) =>
  invoke<DocInfo>("create_note", { dir, name });

// サイドバー上のファイル/フォルダをリネームする (relPath はフォルダルートからの相対パス)
export const renameEntry = (relPath: string, newName: string) =>
  invoke<DocInfo>("rename_entry", { relPath, newName });

export const revealInExplorer = (path: string, isDir: boolean) =>
  invoke<void>("reveal_in_explorer", { path, isDir });

export const openInOtherApp = (path: string) =>
  invoke<void>("open_in_other_app", { path });

// 範囲[start,end)を削除して text を挿入する統一プリミティブ
// Tauri は Rust の snake_case 引数名を camelCase に変換して受け取るため、
// invoke に渡すキーは camelCase で揃える (caret_before ではなく caretBefore)。
export const edit = (
  start: Pos,
  end: Pos,
  caretBefore: Pos,
  text: string,
  coalesce: boolean
) => invoke<EditResult>("edit", { start, end, caretBefore, text, coalesce });

export const editMany = (edits: EditManyItem[], caretBefore: Pos, primaryIndex: number) =>
  invoke<EditManyResult>("edit_many", { edits, caretBefore, primaryIndex });

export const undo = () => invoke<EditResult | null>("undo");
export const redo = () => invoke<EditResult | null>("redo");

// 後方検索 (前へ / Shift+Enter) 用。単発フルスキャン
export const find = (pat: string, from: Pos, forward: boolean, matchCase: boolean) =>
  invoke<FindResult | null>("find", { pat, from, forward, matchCase });

// 前方検索 (次へ) 用。1回で最大 budget 行だけ走査し、続きがあれば cursor を返す。
// Found/NotFound になるまで cursor を渡して呼び出し側でループする。
export const findStep = (
  pat: string,
  from: Pos,
  matchCase: boolean,
  cursor: FindCursor | undefined,
  budget: number
) => invoke<FindOutcome>("find_step", { pat, from, matchCase, cursor: cursor ?? null, budget });

// 1回で最大 budget 件だけ置換する。done=false の間は呼び出し側でループする
// (再開状態は backend の Doc が保持するため、追加の引数は不要)。
export const replaceAllChunk = (pat: string, rep: string, matchCase: boolean, budget: number) =>
  invoke<ReplaceChunkResult>("replace_all_chunk", { pat, rep, matchCase, budget });

// 進行中の全置換を打ち切り、ここまでの変更を1つの undo エントリとして確定する
export const replaceAllCancel = () => invoke<EditResult>("replace_all_cancel");

export const saveFile = (path: string, enc: Encoding, eol: Eol) =>
  invoke<SaveOutcome>("save_file", { path, enc, eol });
export const reloadWithEncoding = (enc: ReadEncoding) =>
  invoke<DocInfo>("reload_with_encoding", { enc });

// 外部変更ポーリング (小ファイルのみ backend 側が対象を判定する)
export const pollExternal = (dirty: boolean) =>
  invoke<ExternalCheck>("poll_external", { dirty });
export const reloadFromDisk = () => invoke<DocInfo>("reload_from_disk");
export const ackExternal = () => invoke<void>("ack_external");
export const setEncoding = (enc: Encoding) => invoke<void>("set_encoding", { enc });
export const setEol = (eol: Eol) => invoke<void>("set_eol", { eol });

// 設定は不透明な JSON 文字列として往復させる (構造を知るのは ui/settings.ts だけ)
export const loadSettings = () => invoke<string>("load_settings");
export const saveSettings = (json: string) => invoke<void>("save_settings", { json });

export const loadBookmarks = () => invoke<BmNode[]>("load_bookmarks");
export const saveBookmarks = (nodes: BmNode[]) => invoke<void>("save_bookmarks", { nodes });
export const pathIsDirectory = (path: string) => invoke<boolean>("path_is_directory", { path });
export const nextMemoPath = (directory: string, stem: string, extension: string) =>
  invoke<string>("next_memo_path", { directory, stem, extension });
export const initialPath = () => invoke<string | null>("initial_path");
export const launchNew = (path?: string) => invoke<void>("launch_new", { path });

// エディタが必要とする文書操作だけを切り出した口。エディタはこの型にだけ依存し、
// 既定の実装 (下の documentClient) が Tauri の invoke を呼ぶ。
export interface DocumentClient {
  lines: typeof lines;
  lineCharLen: typeof lineCharLen;
  edit: typeof edit;
  editMany: typeof editMany;
  undo: typeof undo;
  redo: typeof redo;
  find: typeof find;
  findStep: typeof findStep;
  replaceAllChunk: typeof replaceAllChunk;
  replaceAllCancel: typeof replaceAllCancel;
}

export const documentClient: DocumentClient = {
  lines,
  lineCharLen,
  edit,
  editMany,
  undo,
  redo,
  find,
  findStep,
  replaceAllChunk,
  replaceAllCancel,
};

export type ViewerFormat = "csv" | "markdown";
export interface ViewerSelection {
  start: Pos;
  end: Pos;
}
export interface ViewerPayload {
  format: ViewerFormat;
  text: string;
  selection: ViewerSelection | null;
  source_path: string | null; // 相対パス画像の解決に使う元ファイル (未保存なら null)
}
export const openViewer = (
  format: ViewerFormat,
  text: string,
  selection: ViewerSelection | null,
  sourcePath: string | null
) => invoke<string>("open_viewer", { format, text, selection, sourcePath });
export const takeViewerPayload = (label: string) =>
  invoke<ViewerPayload>("take_viewer_payload", { label });
export const updateViewer = (label: string, text: string, selection: ViewerSelection | null) =>
  invoke<void>("update_viewer", { label, text, selection });

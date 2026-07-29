import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { EditManyItem } from "./generated/EditManyItem";
import type { EditManyResult } from "./generated/EditManyResult";
import type { EditResult } from "./generated/EditResult";
import type { BmNode } from "./generated/BmNode";
import type { DocInfo } from "./generated/DocInfo";
import type { Encoding } from "./generated/Encoding";
import type { Eol } from "./generated/Eol";
import type { ExternalCheck } from "./generated/ExternalCheck";
import type { OpenRequest } from "./generated/OpenRequest";
import type { FileNameMatchMode } from "./generated/FileNameMatchMode";
import type { FindCursor } from "./generated/FindCursor";
import type { FindResult } from "./generated/FindResult";
import type { FindOutcome } from "./generated/FindOutcome";
import type { FolderEntry } from "./generated/FolderEntry";
import type { Pos } from "./generated/Pos";
import type { ReplaceChunkResult } from "./generated/ReplaceChunkResult";
import type { SaveOutcome } from "./generated/SaveOutcome";
import type { ViewerFormat } from "./generated/ViewerFormat";
import type { ViewerPayload } from "./generated/ViewerPayload";
import type { ViewerSelection } from "./generated/ViewerSelection";
import type { WorkspaceSearchBatch } from "./generated/WorkspaceSearchBatch";
import type { WorkspaceSearchOptions } from "./generated/WorkspaceSearchOptions";
import type { WorkspaceSearchOutcome } from "./generated/WorkspaceSearchOutcome";
import type { WorkspaceSearchResult } from "./generated/WorkspaceSearchResult";

export type {
  EditManyItem,
  EditManyResult,
  EditResult,
  BmNode,
  DocInfo,
  Encoding,
  Eol,
  ExternalCheck,
  OpenRequest,
  FileNameMatchMode,
  FindCursor,
  FindResult,
  FindOutcome,
  FolderEntry,
  Pos,
  ReplaceChunkResult,
  SaveOutcome,
  ViewerFormat,
  ViewerPayload,
  ViewerSelection,
  WorkspaceSearchBatch,
  WorkspaceSearchOptions,
  WorkspaceSearchOutcome,
  WorkspaceSearchResult,
};

export type ReadEncoding = "utf8" | "sjis" | "utf16le";

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

// searchId は打ち切った検索の取りこぼしを次の検索から締め出すための世代番号
export const workspaceSearch = (pat: string, options: WorkspaceSearchOptions, searchId: number) =>
  invoke<WorkspaceSearchOutcome>("workspace_search", { pat, options, searchId });

// 検索中の途中経過。確定を待たずに出せるものを出す (走査順で、確定後の並びとは別)
export const onWorkspaceSearchBatch = (handler: (batch: WorkspaceSearchBatch) => void) =>
  listen<WorkspaceSearchBatch>("workspace-search-batch", (event) => handler(event.payload));

// 進行中の検索を打ち切る (無制限指定で走り出した検索から抜ける手段)
export const workspaceSearchCancel = () => invoke<void>("workspace_search_cancel");

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
export const updateSetting = (key: string, valueJson: string) =>
  invoke<void>("update_setting", { key, valueJson });

export const loadBookmarks = () => invoke<BmNode[]>("load_bookmarks");
export const saveBookmarks = (nodes: BmNode[]) => invoke<void>("save_bookmarks", { nodes });
export const pathIsDirectory = (path: string) => invoke<boolean>("path_is_directory", { path });
export const nextMemoPath = (directory: string, stem: string, extension: string) =>
  invoke<string>("next_memo_path", { directory, stem, extension });
export const initialPath = () => invoke<string | null>("initial_path");
export const isSecondaryInstance = () => invoke<boolean>("is_secondary_instance");
export const launchNewInstance = (
  path: string | null = null,
  goto: Pos | null = null,
  selectedRelPath: string | null = null,
  viewStateJson: string | null = null,
) => invoke<void>("launch_new_instance", { path, goto, selectedRelPath, viewStateJson });
// 起動時に飛ぶ位置 (検索結果を別ウィンドウで開いたとき backend が引数へ載せる)
export const initialGoto = () => invoke<Pos | null>("initial_goto");
export const initialSelectedRelPath = () => invoke<string | null>("initial_selected_rel_path");
export const initialViewState = () => invoke<string | null>("initial_view_state");
export const onOpenInTab = (handler: (request: OpenRequest) => void) =>
  listen<OpenRequest>("open-in-tab", (event) => handler(event.payload));

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

export const openViewer = (
  format: ViewerFormat,
  text: string,
  selection: ViewerSelection | null,
  sourcePath: string | null
) => invoke<string>("open_viewer", { format, text, selection, sourcePath });
export const takeViewerPayload = (label: string) =>
  invoke<ViewerPayload>("take_viewer_payload", { label });
export const updateViewer = (label: string, text: string, selection: ViewerSelection | null) =>
  invoke<boolean>("update_viewer", { label, text, selection });

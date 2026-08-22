import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { DOCUMENT_LOAD_PROGRESS_EVENT } from "./document-load-progress";
import type { DocumentLoadProgress } from "./document-load-progress";
import { IPC_COMMANDS } from "./generated/IpcCommands";
import type { EditManyItem } from "./generated/EditManyItem";
import type { EditManyResult } from "./generated/EditManyResult";
import type { EditResult } from "./generated/EditResult";
import type { BmNode } from "./generated/BmNode";
import type { DocInfo } from "./generated/DocInfo";
import type { Encoding } from "./generated/Encoding";
import type { Eol } from "./generated/Eol";
import type { ExternalCheck } from "./generated/ExternalCheck";
import type { ExternalMergePreview } from "./generated/ExternalMergePreview";
import type { WindowRequest } from "./generated/WindowRequest";
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
  ExternalMergePreview,
  WindowRequest,
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

export const READ_ENCODINGS = ["utf8", "sjis", "utf16le"] as const;
export type ReadEncoding = (typeof READ_ENCODINGS)[number];

export const EVENT_NAMES = {
  externalWindowRequest: "external-window-request",
  workspaceSearchBatch: "workspace-search-batch",
  documentLoadProgress: DOCUMENT_LOAD_PROGRESS_EVENT,
  viewerUpdate: "viewer-update",
} as const;

export type { DocumentLoadProgress } from "./document-load-progress";

export const openPath = (path: string) => invoke<DocInfo>(IPC_COMMANDS.openPath, { path });
export const newDoc = () => invoke<void>(IPC_COMMANDS.newDoc);
export const closeDoc = () => invoke<void>(IPC_COMMANDS.closeDoc);

// 可視範囲だけ取得 (全文は決して渡らない)
export const lines = (start: number, count: number) =>
  invoke<string[]>(IPC_COMMANDS.lines, { start, count });
export const lineCharLen = (line: number) => invoke<number>(IPC_COMMANDS.lineCharLen, { line });
export const selectEntry = (relPath: string) => invoke<DocInfo>(IPC_COMMANDS.selectEntry, { relPath });

// ツリーの展開ボタン用。zip/xlsx/xls の中身一覧だけを取得する (本文は読まない)。
// relPath が空文字なら直接開いているアーカイブ自身、それ以外はフォルダ内の相対パス。
export const listArchiveEntries = (relPath: string) =>
  invoke<string[]>(IPC_COMMANDS.listArchiveEntries, { relPath });

// パスワード付き 7z 用。入力されたパスワードを記憶させ、失敗した操作を再試行する。
export const setArchivePassword = (relPath: string, password: string) =>
  invoke<void>(IPC_COMMANDS.setArchivePassword, { relPath, password });

// 指定フォルダの直下だけを取得する。サブフォルダの中身は展開時まで取得しない。
export const listFolderEntries = (relDir: string) =>
  invoke<FolderEntry[]>(IPC_COMMANDS.listFolderEntries, { relDir });

// searchId は打ち切った検索の取りこぼしを次の検索から締め出すための世代番号
export const workspaceSearch = (pat: string, options: WorkspaceSearchOptions, searchId: number) =>
  invoke<WorkspaceSearchOutcome>(IPC_COMMANDS.workspaceSearch, { pat, options, searchId });

// 検索中の途中経過。確定を待たずに出せるものを出す (走査順で、確定後の並びとは別)
export const onWorkspaceSearchBatch = (handler: (batch: WorkspaceSearchBatch) => void) =>
  listen<WorkspaceSearchBatch>(EVENT_NAMES.workspaceSearchBatch, (event) => handler(event.payload));

export const onDocumentLoadProgress = (handler: (progress: DocumentLoadProgress) => void) =>
  listen<DocumentLoadProgress>(EVENT_NAMES.documentLoadProgress, (event) => handler(event.payload));

// 進行中の検索を打ち切る (無制限指定で走り出した検索から抜ける手段)
export const workspaceSearchCancel = (searchId: number) =>
  invoke<void>(IPC_COMMANDS.workspaceSearchCancel, { searchId });

// フォルダ内に空の新規ファイルを作り、その場で開く (dir はフォルダルートからの相対パス)
export const createNote = (dir: string | null, name: string, enc: Encoding, eol: Eol) =>
  invoke<DocInfo>(IPC_COMMANDS.createNote, { dir, name, enc, eol });

export const createFolder = (relDir: string, name: string) =>
  invoke<void>(IPC_COMMANDS.createFolder, { relDir, name });

// サイドバー上のファイル/フォルダをリネームする (relPath はフォルダルートからの相対パス)
export const renameEntry = (relPath: string, newName: string) =>
  invoke<DocInfo>(IPC_COMMANDS.renameEntry, { relPath, newName });
export const moveEntry = (sourceRelPath: string, targetRelDir: string) =>
  invoke<DocInfo>(IPC_COMMANDS.moveEntry, { sourceRelPath, targetRelDir });
export const deleteEntry = (relPath: string) =>
  invoke<DocInfo>(IPC_COMMANDS.deleteEntry, { relPath });

export const savePastedImage = (bytes: number[], mimeType: string) =>
  invoke<string>(IPC_COMMANDS.savePastedImage, { bytes, mimeType });
export const cleanupUnusedImages = (path: string) =>
  invoke<void>(IPC_COMMANDS.cleanupUnusedImages, { path });
export const readArchiveAsset = (archivePath: string, entry: string) =>
  invoke<ArrayBuffer>(IPC_COMMANDS.readArchiveAsset, { archivePath, entry });

export const revealInExplorer = (path: string, isDir: boolean) =>
  invoke<void>(IPC_COMMANDS.revealInExplorer, { path, isDir });

export const openInOtherApp = (path: string) =>
  invoke<void>(IPC_COMMANDS.openInOtherApp, { path });
export const openInDefaultBrowser = (path: string) =>
  invoke<void>(IPC_COMMANDS.openInDefaultBrowser, { path });
export const runExternalCommand = (command: string, path: string) =>
  invoke<void>(IPC_COMMANDS.runExternalCommand, { command, path });

// 範囲[start,end)を削除して text を挿入する統一プリミティブ
// Tauri は Rust の snake_case 引数名を camelCase に変換して受け取るため、
// invoke に渡すキーは camelCase で揃える (caret_before ではなく caretBefore)。
export const edit = (
  start: Pos,
  end: Pos,
  caretBefore: Pos,
  text: string,
  coalesce: boolean
) => invoke<EditResult>(IPC_COMMANDS.edit, { start, end, caretBefore, text, coalesce });

export const editMany = (edits: EditManyItem[], caretBefore: Pos, primaryIndex: number) =>
  invoke<EditManyResult>(IPC_COMMANDS.editMany, { edits, caretBefore, primaryIndex });

export const undo = () => invoke<EditResult | null>(IPC_COMMANDS.undo);
export const redo = () => invoke<EditResult | null>(IPC_COMMANDS.redo);

// 後方検索 (前へ / Shift+Enter) 用。単発フルスキャン
export const find = (pat: string, from: Pos, forward: boolean, matchCase: boolean) =>
  invoke<FindResult | null>(IPC_COMMANDS.find, { pat, from, forward, matchCase });

export const findAllInRange = (
  pat: string,
  firstLine: number,
  lastLine: number,
  matchCase: boolean,
  useRegex = false,
  wholeWord = false,
) => invoke<FindResult[]>(IPC_COMMANDS.findAllInRange, {
  pat,
  firstLine,
  lastLine,
  matchCase,
  useRegex,
  wholeWord,
});

// 前方検索 (次へ) 用。1回で最大 budget 行だけ走査し、続きがあれば cursor を返す。
// Found/NotFound になるまで cursor を渡して呼び出し側でループする。
export const findStep = (
  pat: string,
  from: Pos,
  matchCase: boolean,
  cursor: FindCursor | undefined,
  budget: number
) => invoke<FindOutcome>(IPC_COMMANDS.findStep, { pat, from, matchCase, cursor: cursor ?? null, budget });

// 1回で最大 budget 件だけ置換する。done=false の間は呼び出し側でループする
// (再開状態は backend の Doc が保持するため、追加の引数は不要)。
export const replaceAllChunk = (pat: string, rep: string, matchCase: boolean, budget: number) =>
  invoke<ReplaceChunkResult>(IPC_COMMANDS.replaceAllChunk, { pat, rep, matchCase, budget });

// 進行中の全置換を打ち切り、ここまでの変更を1つの undo エントリとして確定する
export const replaceAllCancel = () => invoke<EditResult>(IPC_COMMANDS.replaceAllCancel);

export const saveFile = (path: string, enc: Encoding, eol: Eol) =>
  invoke<SaveOutcome>(IPC_COMMANDS.saveFile, { path, enc, eol });
export const reloadWithEncoding = (enc: ReadEncoding) =>
  invoke<DocInfo>(IPC_COMMANDS.reloadWithEncoding, { enc });

// 外部変更ポーリング (小ファイルのみ backend 側が対象を判定する)
export const pollExternal = (dirty: boolean) =>
  invoke<ExternalCheck>(IPC_COMMANDS.pollExternal, { dirty });
export const reloadFromDisk = () => invoke<DocInfo>(IPC_COMMANDS.reloadFromDisk);
export const ackExternal = () => invoke<DocInfo>(IPC_COMMANDS.ackExternal);
export const externalMergePreview = () => invoke<ExternalMergePreview>(IPC_COMMANDS.externalMergePreview);
export const mergeExternal = () => invoke<DocInfo>(IPC_COMMANDS.mergeExternal);
export const setEncoding = (enc: Encoding) => invoke<void>(IPC_COMMANDS.setEncoding, { enc });
export const setEol = (eol: Eol) => invoke<void>(IPC_COMMANDS.setEol, { eol });

// 設定は不透明な JSON 文字列として往復させる (構造を知るのは ui/settings.ts だけ)
export const loadSettings = () => invoke<string>(IPC_COMMANDS.loadSettings);
export const updateSetting = (key: string, valueJson: string) =>
  invoke<void>(IPC_COMMANDS.updateSetting, { key, valueJson });

export const loadBookmarks = () => invoke<BmNode[]>(IPC_COMMANDS.loadBookmarks);
export const saveBookmarks = (nodes: BmNode[]) => invoke<void>(IPC_COMMANDS.saveBookmarks, { nodes });
export const pathIsDirectory = (path: string) => invoke<boolean>(IPC_COMMANDS.pathIsDirectory, { path });
export const nextMemoPath = (directory: string, stem: string, extension: string) =>
  invoke<string>(IPC_COMMANDS.nextMemoPath, { directory, stem, extension });
export const launchNewInstance = (request: WindowRequest) =>
  invoke<void>(IPC_COMMANDS.launchNewInstance, { request });
export const initialWindowRequest = () => invoke<WindowRequest>(IPC_COMMANDS.initialWindowRequest);
export const onExternalWindowRequest = (handler: () => void) =>
  listen(EVENT_NAMES.externalWindowRequest, () => handler());
export const takePendingWindowRequests = () =>
  invoke<WindowRequest[]>(IPC_COMMANDS.takePendingWindowRequests);

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
  findAllInRange: typeof findAllInRange;
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
  findAllInRange,
  findStep,
  replaceAllChunk,
  replaceAllCancel,
};

export const openViewer = (
  format: ViewerFormat,
  text: string,
  selection: ViewerSelection | null,
  sourcePath: string | null
) => invoke<string>(IPC_COMMANDS.openViewer, { format, text, selection, sourcePath });
export const takeViewerPayload = (label: string) =>
  invoke<ViewerPayload>(IPC_COMMANDS.takeViewerPayload, { label });
export const updateViewer = (label: string, text: string, selection: ViewerSelection | null) =>
  invoke<boolean>(IPC_COMMANDS.updateViewer, { label, text, selection });
export const closeViewer = (label: string) =>
  invoke<void>(IPC_COMMANDS.closeViewer, { label });

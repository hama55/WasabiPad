import type * as api from "./api";
import type { DocumentSession } from "./session";
import { documentPathOf, externalFilePathOf, initialSession, sessionFromDocInfo } from "./session";
import type { promptSaveFormat, saveFormatFields, saveFormatFromValues, SaveFormat } from "./save-format";
import type { confirmSaveDiscard, promptFields, PromptField, PromptFieldsOptions } from "./prompt";
import type { isPasswordCancelled, withArchivePassword } from "./archive-password";
import { archiveRelOf } from "./archive-path";
import type { showError } from "./dialogs";
import { formatWindowTitle } from "./format";
import { viewerFormatForPath } from "./viewer-formats";
import { basename, joinWindowsRoot, relativePathWithinRoot } from "./path";
import type { EditorViewState } from "./editor-view-state";
import { reportErrorSafely } from "./report-error";
import { fileNameOf, memoStemOf, type MemoSpec } from "./memo-name";

// 保存ダイアログのフィルタと新規メモの拡張子候補で共有する
export const SAVE_EXTENSIONS = [
  { name: "テキスト", extension: "txt" },
  { name: "Markdown", extension: "md" },
  { name: "ログ", extension: "log" },
] as const;

function markdownForSession(session: Readonly<DocumentSession>): boolean {
  return viewerFormatForPath(documentPathOf(session)) === "markdown";
}

export interface MemoCreationSpec {
  memo: MemoSpec;
  format: SaveFormat;
}

const DEFAULT_MEMO_STEM = "memo";
const DEFAULT_MEMO_EXTENSION = SAVE_EXTENSIONS[0].extension;

export type DocumentControllerApi = Pick<
  typeof api,
  "openPath" | "newDoc" | "selectEntry" | "reloadWithEncoding" | "saveFile" |
  "nextMemoPath" | "listFolderEntries"
>;

export interface DocumentControllerServices {
  api: DocumentControllerApi;
  showError: typeof showError;
  confirmSaveDiscard: typeof confirmSaveDiscard;
  promptFields: typeof promptFields;
  promptSaveFormat: typeof promptSaveFormat;
  saveFormatFields: typeof saveFormatFields;
  saveFormatFromValues: typeof saveFormatFromValues;
  isPasswordCancelled: typeof isPasswordCancelled;
  withArchivePassword: typeof withArchivePassword;
}

export interface DocumentEditorPort {
  open: (
    lineCount: number,
    readOnly: boolean,
    keepViewers?: boolean,
    externalFilePath?: string | null,
    markdown?: boolean,
  ) => void;
  setExternalFilePath: (path: string | null, markdown?: boolean) => void;
  focus: () => void;
  goTo: (line: number, col: number) => void;
  captureViewState: () => EditorViewState;
  restoreViewState: (state: EditorViewState) => Promise<void>;
}

export interface DocumentStatusPort {
  setFormat: (session: Readonly<DocumentSession>) => void;
  setByteSize: (bytes: number | null, isHuge?: boolean) => void;
  setModifiedAt: (timestamp: number | null) => void;
  setLineCount: (count: number) => void;
}

export interface DocumentAddressPort {
  render: (path: string) => void;
}

export interface DocumentSidebarPort {
  setWorkspaceSearch: (folderRoot: string | null) => void;
  setArchiveEntries: (entries: string[]) => void;
  setArchiveRoot: (displayName: string) => void;
  setEntries: (entries: api.FolderEntry[]) => void;
  selectByRelPath: (relPath: string) => void | Promise<void>;
}

// 文書の入れ替えに伴って更新される表示先。実装 (VirtualEditor など) のうち
// ここで実際に使う操作だけを要求する。
export interface DocumentView {
  editor: DocumentEditorPort;
  statusbar: DocumentStatusPort;
  addressbar: DocumentAddressPort;
  sidebar: DocumentSidebarPort;
  setSidebar: (on: boolean, label?: string) => void;
  setLoading: (active: boolean, message?: string) => void;
  setTitle: (title: string) => void;
  onDocumentChange?: (session: Readonly<DocumentSession>, keepViewers?: boolean) => void;
  onSessionChange?: (session: Readonly<DocumentSession>) => void;
  hideExternalBanner: () => void;
  // ファイル保存先を選ばせる (OS のダイアログ)
  pickSavePath: (defaultPath: string) => Promise<string | null>;
}

// 開いている文書そのもの。session を書き換えてよいのはこのクラスだけで、
// 他の部品は current で読むか、ここのメソッド経由で変更する。
export class DocumentController {
  private session = initialSession();
  private loadRequest = 0;
  private draftDirectory: string | null = null;

  constructor(
    private view: DocumentView,
    private services: DocumentControllerServices,
  ) {}

  get current(): Readonly<DocumentSession> {
    return this.session;
  }

  // 編集で変わるのは行数と dirty だけ。タイトルの再描画もここに寄せる。
  onEdit(lineCount: number) {
    this.session.lineCount = lineCount;
    if (!this.session.dirty) {
      this.session.dirty = true;
      this.updateTitle();
    }
  }

  updateTitle(notifySession = true) {
    try {
      this.view.setTitle(formatWindowTitle(this.session));
    } catch (error) {
      void this.reportError("タイトルを更新できませんでした", error);
    }
    if (!notifySession) return;
    try {
      this.view.onSessionChange?.(this.session);
    } catch (error) {
      void this.reportError("タブ状態を更新できませんでした", error);
    }
  }

  private notifyDocumentChange(keepViewers: boolean): boolean {
    if (!this.view.onDocumentChange) return false;
    try {
      this.view.onDocumentChange(this.session, keepViewers);
      return true;
    } catch (error) {
      void this.reportError("文書表示を更新できませんでした", error);
      return false;
    }
  }

  private setLoading(active: boolean, request: number) {
    if (request !== this.loadRequest) return;
    try {
      this.view.setLoading(active);
    } catch (error) {
      void this.reportError(active ? "読み込み表示を開始できませんでした" : "読み込み表示を終了できませんでした", error);
    }
  }

  private async reportError(title: string, error: unknown) {
    await reportErrorSafely(this.services.showError, title, error);
  }

  // アーカイブ選択後/フォルダのエントリ切替後で共通の状態反映。
  // keepViewers は「同じファイルの読み直し」= 開いているCSV/Markdownビューを維持する場合。
  applyDocInfo(info: api.DocInfo, keepViewers = false, updateTree = false) {
    this.view.hideExternalBanner();
    this.session = sessionFromDocInfo(this.session, info);
    this.view.statusbar.setFormat(this.session);
    this.view.statusbar.setByteSize(info.byte_len, info.is_huge);
    this.view.statusbar.setModifiedAt(info.modified_at);
    this.view.statusbar.setLineCount(info.line_count);
    this.view.addressbar.render(info.path);
    if (updateTree) this.showTree(info);
    this.view.editor.open(
      info.line_count,
      this.session.readOnly,
      keepViewers,
      externalFilePathOf(info),
      markdownForSession(this.session),
    );
    this.view.editor.focus();
    const documentChangeNotified = this.notifyDocumentChange(keepViewers);
    this.updateTitle(!documentChangeNotified);
  }

  applyMergedDocInfo(info: api.DocInfo) {
    this.applyDocInfo(info, true);
    this.onEdit(info.line_count);
  }

  // フォルダ内の移動後は本文を読み直さず、保存先と表示パスだけ追従させる。
  // dirty は維持する。
  applyMoved(info: api.DocInfo, selectedRelPath: string) {
    this.applyPathChange(info, selectedRelPath, false);
  }

  // 選択中の実ファイルがごみ箱へ移動された後も、編集中の本文を保持する。
  // 保存先だけを外しておくことで、次回保存時は名前を付けて保存へ進む。
  markDeleted() {
    this.view.hideExternalBanner();
    this.session.savePath = null;
    this.session.selectedRelPath = "";
    this.session.archivePath = null;
    this.session.archiveEntry = null;
    this.session.dirty = true;
    this.view.editor.setExternalFilePath(null, markdownForSession(this.session));
    this.view.statusbar.setModifiedAt(null);
    this.updateTitle();
  }

  markRestored(relPath: string, absolutePath: string) {
    this.view.hideExternalBanner();
    this.session.savePath = absolutePath;
    this.session.displayPath = absolutePath;
    this.session.selectedRelPath = relPath;
    this.session.dirty = true;
    this.view.editor.setExternalFilePath(absolutePath, markdownForSession(this.session));
    this.view.addressbar.render(absolutePath);
    this.updateTitle();
  }

  async openPath(path: string, confirm = true): Promise<boolean> {
    if (confirm && !(await this.confirmDiscard())) return false;
    const request = ++this.loadRequest;
    try {
      this.setLoading(true, request);
      const info = await this.services.api.openPath(path);
      if (request !== this.loadRequest) return false;
      this.session.selectedRelPath = "";
      this.showTree(info);
      this.applyDocInfo(info);
      return true;
    } catch (e) {
      if (request === this.loadRequest) await this.reportError("開けませんでした", e);
      return false;
    } finally {
      this.setLoading(false, request);
    }
  }

  // 開いた対象に応じてサイドバーの中身を決める (アーカイブ / フォルダ / 単一ファイル)
  private showTree(info: api.DocInfo) {
    if (info.kind === "archive") {
      // 編集可否は拡張子ではなく、アーカイブを開いたbackendの判定に従う。
      const editable = !info.view_only;
      this.view.setSidebar(true, editable ? "アーカイブ" : "閲覧モード");
      this.view.sidebar.setWorkspaceSearch(null);
      if (info.entries) {
        this.view.sidebar.setArchiveEntries(info.entries);
      } else {
        // zip/xlsx/xls は展開前: 名前だけの1行を表示し、展開ボタンで初めて中身を取得する
        this.view.sidebar.setArchiveRoot(basename(info.path));
      }
    } else if (info.folder_entries) {
      this.view.setSidebar(true, "");
      this.view.sidebar.setWorkspaceSearch(info.folder_root);
      this.view.sidebar.setEntries(info.folder_entries);
    } else {
      this.view.sidebar.setWorkspaceSearch(null);
      this.view.setSidebar(false);
    }
  }

  async selectEntry(relPath: string): Promise<boolean> {
    const request = ++this.loadRequest;
    try {
      this.setLoading(true, request);
      const info = await this.services.withArchivePassword(
        archiveRelOf(relPath),
        () => this.services.api.selectEntry(relPath),
      );
      if (request !== this.loadRequest) return false;
      this.session.selectedRelPath = relPath;
      this.applyDocInfo(info, false, false);
      // 選択した行を一覧側にも戻す。深い階層は必要ならここで展開する。
      try {
        await this.view.sidebar.selectByRelPath(relPath);
      } catch (error) {
        // 本文の読込は成功しているため、一覧の再展開失敗で選択を取り消さない。
        await this.reportError("一覧の選択状態を更新できませんでした", error);
      }
      if (request !== this.loadRequest) return false;
      return true;
    } catch (error) {
      if (request === this.loadRequest && !this.services.isPasswordCancelled(error)) {
        await this.reportError("開けませんでした", error);
      }
      return false;
    } finally {
      this.setLoading(false, request);
    }
  }

  async newFile(confirm = true, draftDirectory: string | null = null) {
    if (confirm && !(await this.confirmDiscard())) return;
    const request = ++this.loadRequest;
    try {
      await this.services.api.newDoc();
    } catch (error) {
      if (request === this.loadRequest) await this.reportError("新規文書を作成できませんでした", error);
      return;
    }
    if (request !== this.loadRequest) return;
    this.session = initialSession();
    this.draftDirectory = draftDirectory;
    this.view.statusbar.setFormat(this.session);
    this.view.statusbar.setByteSize(null);
    this.view.statusbar.setModifiedAt(null);
    this.view.statusbar.setLineCount(1);
    this.view.addressbar.render("");
    this.view.setSidebar(false);
    this.view.sidebar.setWorkspaceSearch(null);
    this.view.editor.open(1, false);
    this.view.editor.focus();
    const documentChangeNotified = this.notifyDocumentChange(false);
    this.updateTitle(!documentChangeNotified);
  }

  async reloadWithEncoding(encoding: api.ReadEncoding): Promise<boolean> {
    const request = ++this.loadRequest;
    try {
      this.setLoading(true, request);
      const info = await this.services.api.reloadWithEncoding(encoding);
      if (request !== this.loadRequest) return false;
      this.applyDocInfo(info);
      return true;
    } catch (error) {
      if (request === this.loadRequest) await this.reportError("再読込できませんでした", error);
      return false;
    } finally {
      this.setLoading(false, request);
    }
  }

  save(): Promise<boolean> {
    if (this.session.readOnly) return Promise.resolve(false);
    if (!this.session.savePath) return this.saveAs();
    return this.saveTo(this.session.savePath);
  }

  async saveAs(): Promise<boolean> {
    try {
      if (this.session.folderRoot && !this.session.savePath && !this.session.selectedRelPath) {
        return await this.saveFolderDraft();
      }
      let defaultPath = this.session.savePath ?? "";
      let newMemoFormat: SaveFormat | undefined;
      if (!defaultPath) {
        const spec = await this.promptNewMemoSave();
        if (!spec) return false;
        defaultPath = fileNameOf(spec.memo);
        if (this.draftDirectory) defaultPath = joinWindowsRoot(this.draftDirectory, defaultPath);
        newMemoFormat = spec.format;
      }
      const path = await this.view.pickSavePath(defaultPath);
      return path ? this.saveAsTo(path, null, newMemoFormat) : false;
    } catch (error) {
      await this.reportError("名前を付けて保存できませんでした", error);
      return false;
    }
  }

  // 新規メモ作成・別名保存が保存形式の決定点。以降の上書き保存はここで決めた形式を使い回す。
  private async saveAsTo(
    path: string,
    folderDraftRoot: string | null = null,
    format?: SaveFormat,
  ): Promise<boolean> {
    try {
      const chosen = format ?? await this.services.promptSaveFormat(this.session);
      if (!chosen) return false;
      return await this.saveTo(path, folderDraftRoot, chosen);
    } catch (error) {
      await this.reportError("保存形式を決められませんでした", error);
      return false;
    }
  }

  // フォルダを開いた状態の無題文書は、保存先ダイアログではなくフォルダ直下へ置く
  private async saveFolderDraft(): Promise<boolean> {
    const root = this.session.folderRoot;
    if (!root) return false;
    try {
      const spec = await this.promptNewMemoSave(root);
      if (!spec) return false;
      const path = joinWindowsRoot(root, fileNameOf(spec.memo));
      return this.saveAsTo(path, root, spec.format);
    } catch (e) {
      await this.reportError("ファイル名を決められませんでした", e);
      return false;
    }
  }

  private async saveTo(
    path: string,
    folderDraftRoot: string | null = null,
    format: SaveFormat = this.session,
  ): Promise<boolean> {
    const savingSelectedEntryInPlace = (this.session.folderRoot !== null || this.session.archivePath !== null)
      && this.session.selectedRelPath !== ""
      && this.session.savePath === path;
    let outcome: api.SaveOutcome;
    try {
      // 7z エントリの書き戻し中にパスワードが要求されたら入力させて再試行する
      outcome = await this.services.withArchivePassword(archiveRelOf(this.session.selectedRelPath), () =>
        this.services.api.saveFile(path, format.encoding, format.eol)
      );
    } catch (e) {
      if (!this.services.isPasswordCancelled(e)) await this.reportError("保存できませんでした", e);
      return false;
    }
    if (outcome.kind === "conflict") {
      // 本体は上書きされていない。dirty のまま残し、バナーで再読込/無視を選ばせる
      await this.reportError(
        "保存先が他のアプリで変更されています",
        `編集内容を退避保存しました:\n${outcome.saved_to}`
      );
      return false;
    }
    const saveWarning = outcome.kind === "savedwithwarning" ? outcome.warning : null;
    this.session.encoding = format.encoding;
    this.session.eol = format.eol;
    this.session.savePath = path;
    this.session.displayPath = path;
    this.session.sourceEncoding = this.session.encoding;
    this.session.sourceEol = this.session.eol;
    this.session.dirty = false;
    if (!folderDraftRoot && !savingSelectedEntryInPlace) {
      this.session.selectedRelPath = "";
      this.session.archivePath = null;
      this.session.archiveEntry = null;
    }
    try {
      this.view.editor.setExternalFilePath(path, markdownForSession(this.session));
      this.view.addressbar.render(path);
      this.view.statusbar.setFormat(this.session);
      this.view.statusbar.setModifiedAt(outcome.modified_at);
      this.updateTitle();
    } catch (error) {
      await this.reportError("保存後の画面更新に失敗しました", error);
    }
    if (saveWarning) {
      await this.reportError("保存後の再読込に失敗しました", saveWarning);
    }
    if (folderDraftRoot) await this.revealSavedDraft(folderDraftRoot, path);
    return true;
  }

  private async revealSavedDraft(folderDraftRoot: string, path: string) {
    const rel = relativePathWithinRoot(folderDraftRoot, path);
    if (rel === null) return;
    const previous = this.session.selectedRelPath;
    try {
      this.view.sidebar.setEntries(await this.services.api.listFolderEntries(""));
      await this.view.sidebar.selectByRelPath(rel);
      this.session.selectedRelPath = rel;
    } catch (error) {
      this.session.selectedRelPath = previous;
      // 保存自体は成功しているため、一覧更新の失敗でdirtyへ戻さない。
      await this.reportError("保存後に一覧を更新できませんでした", error);
    }
  }

  async confirmDiscard(onProceed?: () => void | Promise<void>): Promise<boolean> {
    if (!this.session.dirty || this.session.readOnly) {
      await onProceed?.();
      return true;
    }
    const choice = await this.services.confirmSaveDiscard();
    if (choice === "discard") {
      await onProceed?.();
      this.session.dirty = false;
      return true;
    }
    if (choice !== "save") return false;
    if (!await this.save()) return false;
    await onProceed?.();
    return true;
  }

  goTo(pos: api.Pos) {
    this.view.editor.goTo(pos.line, pos.col);
  }

  captureViewState(): EditorViewState {
    return this.view.editor.captureViewState();
  }

  restoreViewState(state: EditorViewState): Promise<void> {
    return this.view.editor.restoreViewState(state);
  }

  private memoFields(initialStem: string) {
    return [
      {
        label: "ファイル名",
        value: initialStem,
        validate: (value: string) => value.trim() ? null : "名前を入力してください",
      },
      {
        label: "拡張子",
        value: DEFAULT_MEMO_EXTENSION,
        options: [
          ...SAVE_EXTENSIONS.map(({ extension }) => ({ label: `.${extension}`, value: extension })),
          { label: "拡張子なし", value: "" },
        ],
      },
    ];
  }

  private async initialMemoStem(directory: string | null, extension: string): Promise<string> {
    if (!directory) return DEFAULT_MEMO_STEM;
    const path = await this.services.api.nextMemoPath(directory, DEFAULT_MEMO_STEM, extension);
    return memoStemOf(path, extension);
  }

  private memoPromptOptions(directory: string | null): PromptFieldsOptions {
    return directory
      ? { onChangeError: (error) => this.reportError("ファイル名を決められませんでした", error) }
      : {};
  }

  private async promptMemoValues(
    title: string,
    directory: string | null,
    extraFields: PromptField[] = [],
  ): Promise<string[] | null> {
    const stem = await this.initialMemoStem(directory, DEFAULT_MEMO_EXTENSION);
    return this.services.promptFields(title, [
      ...this.memoFields(stem),
      ...extraFields,
    ], this.memoPromptOptions(directory));
  }

  private memoCreationSpec(values: string[] | null): MemoCreationSpec | null {
    const enteredStem = values?.[0].trim();
    return enteredStem
      ? {
          memo: { stem: enteredStem, extension: values![1] },
          format: this.services.saveFormatFromValues(values!, 2),
        }
      : null;
  }

  async promptMemoSpec(directory: string | null = null): Promise<MemoCreationSpec | null> {
    return this.memoCreationSpec(await this.promptMemoValues(
      "新規メモ作成",
      directory,
      this.services.saveFormatFields(this.session),
    ));
  }

  private async promptNewMemoSave(directory: string | null = null): Promise<MemoCreationSpec | null> {
    return this.memoCreationSpec(await this.promptMemoValues(
      "新規メモ保存",
      directory,
      this.services.saveFormatFields(this.session),
    ));
  }

  // フォルダビューでの名前変更後、開いている文書のパスを追従させる
  applyRenamed(info: api.DocInfo, selectedRelPath: string) {
    this.applyPathChange(info, selectedRelPath, true);
  }

  private applyPathChange(info: api.DocInfo, selectedRelPath: string, replaceSavePath: boolean) {
    this.view.hideExternalBanner();
    this.session.displayPath = info.path;
    if (replaceSavePath) this.session.savePath = this.session.readOnly ? null : info.path;
    else if (this.session.savePath) this.session.savePath = info.path;
    if (this.session.archivePath) this.session.archivePath = info.path;
    this.session.selectedRelPath = selectedRelPath;
    this.view.addressbar.render(info.path);
    this.view.editor.setExternalFilePath(externalFilePathOf(info), markdownForSession(this.session));
    this.view.statusbar.setModifiedAt(info.modified_at);
    this.updateTitle();
  }

  setSelectedRelPath(relPath: string) {
    this.session.selectedRelPath = relPath;
  }
}

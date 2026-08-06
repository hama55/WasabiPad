import type * as api from "./api";
import type { DocumentSession } from "./session";
import { initialSession, sessionFromDocInfo } from "./session";
import type { promptSaveFormat, saveFormatFields, saveFormatFromValues, SaveFormat } from "./save-format";
import type { confirmSaveDiscard, promptFields } from "./prompt";
import type { isPasswordCancelled, withArchivePassword } from "./archive-password";
import { archiveRelOf } from "./archive-path";
import type { showError } from "./dialogs";
import { formatWindowTitle } from "./format";
import { basename, relativePathWithinRoot } from "./path";
import type { EditorViewState } from "./editor-view-state";

// 保存ダイアログのフィルタと新規メモの拡張子候補で共有する
export const SAVE_EXTENSIONS = [
  { name: "テキスト", extension: "txt" },
  { name: "Markdown", extension: "md" },
  { name: "ログ", extension: "log" },
] as const;

export interface MemoSpec {
  stem: string;
  extension: string;
}

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
  open: (lineCount: number, readOnly: boolean, keepViewers?: boolean, externalFilePath?: string | null) => void;
  focus: () => void;
  goTo: (line: number, col: number) => void;
  captureViewState: () => EditorViewState;
  restoreViewState: (state: EditorViewState) => Promise<void>;
}

export interface DocumentStatusPort {
  setFormat: (session: Readonly<DocumentSession>) => void;
  setByteSize: (bytes: number | null, isHuge?: boolean) => void;
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
  notify: (text: string) => void;
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

  updateTitle() {
    try {
      this.view.setTitle(formatWindowTitle(this.session));
    } catch (error) {
      void this.reportError("タイトルを更新できませんでした", error);
    }
    try {
      this.view.onSessionChange?.(this.session);
    } catch (error) {
      void this.reportError("タブ状態を更新できませんでした", error);
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
    try {
      await this.services.showError(title, error);
    } catch (reportError) {
      console.error(`${title}のエラーを表示できませんでした`, reportError);
    }
  }

  // アーカイブ選択後/フォルダのエントリ切替後で共通の状態反映。
  // keepViewers は「同じファイルの読み直し」= 開いているCSV/Markdownビューを維持する場合。
  applyDocInfo(info: api.DocInfo, keepViewers = false, updateTree = false) {
    this.view.hideExternalBanner();
    this.session = sessionFromDocInfo(this.session, info);
    this.view.statusbar.setFormat(this.session);
    this.view.statusbar.setByteSize(info.byte_len, info.is_huge);
    this.view.statusbar.setLineCount(info.line_count);
    this.view.addressbar.render(info.path);
    if (updateTree) this.showTree(info);
    const externalFilePath = info.path && info.folder_root !== info.path ? info.path : null;
    this.view.editor.open(info.line_count, this.session.readOnly, keepViewers, externalFilePath);
    this.view.editor.focus();
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

  async newFile(confirm = true) {
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
    this.view.statusbar.setFormat(this.session);
    this.view.statusbar.setByteSize(null);
    this.view.statusbar.setLineCount(1);
    this.view.addressbar.render("");
    this.view.setSidebar(false);
    this.view.sidebar.setWorkspaceSearch(null);
    this.view.editor.open(1, false);
    this.view.editor.focus();
    this.updateTitle();
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
        return this.saveFolderDraft();
      }
      let defaultPath = this.session.savePath ?? "";
      let newMemoFormat: SaveFormat | undefined;
      if (!defaultPath) {
        const spec = await this.promptNewMemoSave();
        if (!spec) return false;
        defaultPath = fileNameOf(spec.memo);
        newMemoFormat = spec.format;
      }
      const path = await this.view.pickSavePath(defaultPath);
      return path ? this.saveAsTo(path, null, newMemoFormat) : false;
    } catch (error) {
      await this.reportError("名前を付けて保存できませんでした", error);
      return false;
    }
  }

  // 別名保存だけが保存形式の決定点。以降の上書き保存はここで決めた形式を使い回す。
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

  // フォルダを開いた状態の無題文書は、保存先ダイアログではなくフォルダ直下へ採番して置く
  private async saveFolderDraft(): Promise<boolean> {
    const root = this.session.folderRoot;
    if (!root) return false;
    const spec = await this.promptNewMemoSave();
    if (!spec) return false;
    try {
      const path = await this.services.api.nextMemoPath(root, spec.memo.stem, spec.memo.extension);
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
    this.session.encoding = format.encoding;
    this.session.eol = format.eol;
    this.session.savePath = path;
    this.session.displayPath = path;
    this.session.sourceEncoding = this.session.encoding;
    this.session.sourceEol = this.session.eol;
    this.session.dirty = false;
    try {
      this.view.addressbar.render(path);
      this.view.statusbar.setFormat(this.session);
      this.updateTitle();
      this.view.notify("保存しました");
    } catch (error) {
      await this.reportError("保存後の画面更新に失敗しました", error);
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
      this.session.dirty = false;
      await onProceed?.();
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

  private memoFields() {
    return [
      {
        label: "ファイル名",
        value: "memo",
        validate: (value: string) => value.trim() ? null : "名前を入力してください",
      },
      { label: "拡張子", value: SAVE_EXTENSIONS[0].extension, options: [
        ...SAVE_EXTENSIONS.map(({ extension }) => ({ label: `.${extension}`, value: extension })),
        { label: "拡張子なし", value: "" },
      ] },
    ];
  }

  async promptMemoSpec(): Promise<MemoSpec | null> {
    const result = await this.services.promptFields("新規メモ作成", this.memoFields());
    const stem = result?.[0].trim();
    return stem ? { stem, extension: result![1] } : null;
  }

  private async promptNewMemoSave(): Promise<{ memo: MemoSpec; format: SaveFormat } | null> {
    const result = await this.services.promptFields("新規メモ保存", [
      ...this.memoFields(),
      ...this.services.saveFormatFields(this.session),
    ]);
    const stem = result?.[0].trim();
    return stem
      ? { memo: { stem, extension: result![1] }, format: this.services.saveFormatFromValues(result!, 2) }
      : null;
  }

  // フォルダビューでの名前変更後、開いている文書のパスを追従させる
  applyRenamed(info: api.DocInfo, selectedRelPath: string) {
    this.view.addressbar.render(info.path);
    this.session.displayPath = info.path;
    this.session.savePath = this.session.readOnly ? null : info.path;
    this.session.selectedRelPath = selectedRelPath;
    this.updateTitle();
  }

  setSelectedRelPath(relPath: string) {
    this.session.selectedRelPath = relPath;
  }
}

export function fileNameOf(spec: MemoSpec): string {
  return `${spec.stem}${spec.extension ? `.${spec.extension}` : ""}`;
}

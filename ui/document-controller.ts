import * as api from "./api";
import type { AddressBar } from "./addressbar";
import type { StatusBar } from "./statusbar";
import type { Sidebar } from "./sidebar";
import type { VirtualEditor } from "./editor";
import type { DocumentSession } from "./session";
import { initialSession, sessionFromDocInfo } from "./session";
import { promptSaveFormat } from "./save-format";
import { confirmSaveDiscard, promptFields } from "./prompt";
import { showError } from "./dialogs";
import { formatWindowTitle } from "./format";
import { basename, relativePathWithinRoot } from "./path";
import { windowsFileNameError } from "./filename";

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

// 文書の入れ替えに伴って更新される表示先。実装 (VirtualEditor など) のうち
// ここで実際に使う操作だけを要求する。
export interface DocumentView {
  editor: Pick<VirtualEditor, "open" | "focus">;
  statusbar: Pick<StatusBar, "setFormat" | "setByteSize" | "setLineCount">;
  addressbar: Pick<AddressBar, "render">;
  sidebar: Pick<Sidebar, "setWorkspaceSearch" | "setArchiveEntries" | "setArchiveRoot" | "setEntries" | "selectByRelPath">;
  setSidebar: (on: boolean, label?: string) => void;
  setLoading: (active: boolean, message?: string) => void;
  setTitle: (title: string) => void;
  notify: (text: string) => void;
  hideExternalBanner: () => void;
  // ファイル保存先を選ばせる (OS のダイアログ)
  pickSavePath: (defaultPath: string) => Promise<string | null>;
}

// 開いている文書そのもの。session を書き換えてよいのはこのクラスだけで、
// 他の部品は current で読むか、ここのメソッド経由で変更する。
export class DocumentController {
  private session = initialSession();

  constructor(private view: DocumentView) {}

  get current(): DocumentSession {
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
    this.view.setTitle(formatWindowTitle(this.session));
  }

  // アーカイブ選択後/フォルダのエントリ切替後で共通の状態反映。
  // keepViewers は「同じファイルの読み直し」= 開いているCSV/Markdownビューを維持する場合。
  applyDocInfo(info: api.DocInfo, keepViewers = false) {
    this.view.hideExternalBanner();
    this.session = sessionFromDocInfo(this.session, info);
    this.view.statusbar.setFormat(this.session);
    this.view.statusbar.setByteSize(info.byte_len);
    this.view.statusbar.setLineCount(info.line_count);
    this.view.addressbar.render(info.path);
    this.view.editor.open(info.line_count, this.session.readOnly, keepViewers);
    this.view.editor.focus();
    this.updateTitle();
  }

  async openPath(path: string): Promise<boolean> {
    if (!(await this.confirmDiscard())) return false;
    this.view.setLoading(true);
    try {
      const info = await api.openPath(path);
      this.session.selectedRelPath = "";
      this.showTree(info);
      this.applyDocInfo(info);
      return true;
    } catch (e) {
      await showError("開けませんでした", e);
      return false;
    } finally {
      this.view.setLoading(false);
    }
  }

  // 開いた対象に応じてサイドバーの中身を決める (アーカイブ / フォルダ / 単一ファイル)
  private showTree(info: api.DocInfo) {
    if (info.kind === "archive") {
      this.view.setSidebar(true, "閲覧モード");
      this.view.sidebar.setWorkspaceSearch(false);
      if (info.entries) {
        this.view.sidebar.setArchiveEntries(info.entries);
      } else {
        // zip/xlsx/xls は展開前: 名前だけの1行を表示し、展開ボタンで初めて中身を取得する
        this.view.sidebar.setArchiveRoot(basename(info.path));
      }
    } else if (info.folder_entries) {
      this.view.setSidebar(true, "");
      this.view.sidebar.setWorkspaceSearch(true);
      this.view.sidebar.setEntries(info.folder_entries);
    } else {
      this.view.sidebar.setWorkspaceSearch(false);
      this.view.setSidebar(false);
    }
  }

  async selectEntry(relPath: string) {
    this.session.selectedRelPath = relPath;
    this.applyDocInfo(await api.selectEntry(relPath));
  }

  async newFile() {
    if (!(await this.confirmDiscard())) return;
    await api.newDoc();
    this.session = initialSession();
    this.view.statusbar.setFormat(this.session);
    this.view.statusbar.setByteSize(null);
    this.view.statusbar.setLineCount(1);
    this.view.addressbar.render("");
    this.view.setSidebar(false);
    this.view.sidebar.setWorkspaceSearch(false);
    this.view.editor.open(1, false);
    this.view.editor.focus();
    this.updateTitle();
  }

  async reloadWithEncoding(encoding: api.ReadEncoding): Promise<boolean> {
    this.view.setLoading(true);
    try {
      this.applyDocInfo(await api.reloadWithEncoding(encoding));
      return true;
    } catch (error) {
      await showError("再読込できませんでした", error);
      return false;
    } finally {
      this.view.setLoading(false);
    }
  }

  save(): Promise<boolean> {
    if (this.session.readOnly) return Promise.resolve(false);
    if (!this.session.savePath) return this.saveAs();
    return this.saveTo(this.session.savePath);
  }

  async saveAs(): Promise<boolean> {
    if (this.session.folderRoot && !this.session.savePath && !this.session.selectedRelPath) {
      return this.saveFolderDraft();
    }
    let defaultPath = this.session.savePath ?? "";
    if (!defaultPath) {
      const spec = await this.promptMemoSpec();
      if (!spec) return false;
      defaultPath = fileNameOf(spec);
    }
    const path = await this.view.pickSavePath(defaultPath);
    return path ? this.saveAsTo(path) : false;
  }

  // 別名保存だけが保存形式の決定点。以降の上書き保存はここで決めた形式を使い回す。
  private async saveAsTo(path: string, folderDraftRoot: string | null = null): Promise<boolean> {
    const format = await promptSaveFormat(this.session);
    if (!format) return false;
    this.session.encoding = format.encoding;
    this.session.eol = format.eol;
    return this.saveTo(path, folderDraftRoot);
  }

  // フォルダを開いた状態の無題文書は、保存先ダイアログではなくフォルダ直下へ採番して置く
  private async saveFolderDraft(): Promise<boolean> {
    const root = this.session.folderRoot;
    if (!root) return false;
    const spec = await this.promptMemoSpec();
    if (!spec) return false;
    try {
      const path = await api.nextMemoPath(root, spec.stem, spec.extension);
      return this.saveAsTo(path, root);
    } catch (e) {
      await showError("ファイル名を決められませんでした", e);
      return false;
    }
  }

  private async saveTo(path: string, folderDraftRoot: string | null = null): Promise<boolean> {
    this.view.setLoading(true, "書き込み中…");
    let outcome: api.SaveOutcome;
    try {
      outcome = await api.saveFile(path, this.session.encoding, this.session.eol);
    } catch (e) {
      this.view.setLoading(false);
      await showError("保存できませんでした", e);
      return false;
    }
    this.view.setLoading(false);
    if (outcome.kind === "conflict") {
      // 本体は上書きされていない。dirty のまま残し、バナーで再読込/無視を選ばせる
      await showError(
        "保存先が他のアプリで変更されています",
        `編集内容を退避保存しました:\n${outcome.saved_to}`
      );
      return false;
    }
    this.session.savePath = path;
    this.session.displayPath = path;
    this.session.sourceEncoding = this.session.encoding;
    this.session.sourceEol = this.session.eol;
    this.session.dirty = false;
    this.view.addressbar.render(path);
    this.view.statusbar.setFormat(this.session);
    this.updateTitle();
    this.view.notify("保存しました");
    if (folderDraftRoot) await this.revealSavedDraft(folderDraftRoot, path);
    return true;
  }

  private async revealSavedDraft(folderDraftRoot: string, path: string) {
    const rel = relativePathWithinRoot(folderDraftRoot, path);
    if (rel === null) return;
    this.session.selectedRelPath = rel;
    try {
      this.view.sidebar.setEntries(await api.listFolderEntries(""));
      this.view.sidebar.selectByRelPath(rel);
    } catch {
      // 保存自体は成功しているため、一覧更新の失敗でdirtyへ戻さない。
    }
  }

  async confirmDiscard(): Promise<boolean> {
    if (!this.session.dirty || this.session.readOnly) return true;
    const choice = await confirmSaveDiscard();
    return choice === "discard" || (choice === "save" && await this.save());
  }

  async promptMemoSpec(): Promise<MemoSpec | null> {
    const result = await promptFields("新規メモ作成", [
      {
        label: "ファイル名",
        value: "memo",
        validate: (value, values) => {
          if (!value.trim()) return "名前を入力してください";
          return windowsFileNameError(fileNameOf({ stem: value.trim(), extension: values[1] }));
        },
      },
      { label: "拡張子", value: SAVE_EXTENSIONS[0].extension, options: [
        ...SAVE_EXTENSIONS.map(({ extension }) => ({ label: `.${extension}`, value: extension })),
        { label: "拡張子なし", value: "" },
      ] },
    ]);
    const stem = result?.[0].trim();
    return stem ? { stem, extension: result![1] } : null;
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

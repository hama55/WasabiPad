import * as api from "./api";
import type { ContextTarget, Sidebar } from "./sidebar";
import { fileNameOf, type MemoSpec } from "./document-controller";
import type { DocumentSession } from "./session";
import { showMenu, MenuItem } from "./menu";
import { confirmMessage, promptFields } from "./prompt";
import { showError } from "./dialogs";
import { basename, joinWindowsRoot, rebaseWindowsPath, relativePathFromRoot } from "./path";
import { getSetting } from "./settings";
import { VIEWER_FORMAT_LABELS } from "./format";

export interface FolderActionsPorts {
  sidebar: Pick<Sidebar, "setEntries" | "selectByRelPath" | "refreshFolderEntries">;
  onOpenInNewTab: (relPath: string, goto?: api.Pos) => void;
  onOpenInNewWindow: (path: string, goto?: api.Pos) => void;
  onOpenViewer: (relPath: string, format: api.ViewerFormat) => void;
  onAddFavorite: (path: string) => void;
  onSetStartupPath: (path: string) => void;
  onOpenPath: (path: string) => void;
}

export interface FolderDocumentPort {
  readonly current: DocumentSession;
  promptMemoSpec: () => Promise<MemoSpec | null>;
  setSelectedRelPath: (relPath: string) => void;
  applyDocInfo: (info: api.DocInfo, keepViewers?: boolean, updateTree?: boolean) => void;
  applyRenamed: (info: api.DocInfo, selectedRelPath: string) => void;
}

// フォルダビュー上のファイル操作 (右クリックメニューとその実行)。
export class FolderActions {
  constructor(private doc: FolderDocumentPort, private ports: FolderActionsPorts) {}

  private get root(): string | null {
    return this.doc.current.folderRoot;
  }

  private toAbsolute(relPath: string): string {
    return joinWindowsRoot(this.root!, relPath);
  }

  showContextMenu(x: number, y: number, target: ContextTarget | null) {
    const root = this.root;
    if (!root) return; // アーカイブ閲覧中はファイル操作の対象がない
    const items: MenuItem[] = [];
    if (target) {
      items.push({
        label: "新規タブで開く",
        action: () => this.ports.onOpenInNewTab(target.relPath, target.goto),
      });
      items.push({
        label: "新規ウィンドウで開く",
        action: () => this.ports.onOpenInNewWindow(this.toAbsolute(target.relPath), target.goto),
      });
      if (!target.isDir) {
        const viewerFormat = viewerFormatFor(target.relPath);
        if (viewerFormat) {
          items.push({
            label: VIEWER_FORMAT_LABELS[viewerFormat],
            action: () => this.ports.onOpenViewer(target.relPath, viewerFormat),
          });
        }
        items.push({ label: "アプリで開く", action: () => void openInOtherApp(this.toAbsolute(target.relPath)) });
      }
      items.push({ label: "アドレスバーに設定", action: () => this.ports.onOpenPath(this.toAbsolute(target.relPath)) });
    }
    items.push({
      label: "新規メモ作成...",
      action: () => void this.createNote(target?.isDir ? target.relPath : null),
      sep: items.length > 0,
    });
    if (target) {
      items.push({ label: "名前を変更...", action: () => void this.rename(target.relPath) });
      items.push({
        label: "その他",
        action: () => {},
        sub: [{ label: "削除", action: () => void this.delete(target) }],
      });
    }
    const revealPath = target ? this.toAbsolute(target.relPath) : root;
    const revealIsDir = target ? target.isDir : true;
    items.push({ label: "お気に入りに追加", action: () => this.ports.onAddFavorite(revealPath), sep: true });
    items.push({ label: "エクスプローラで開く", action: () => void revealInExplorer(revealPath, revealIsDir) });
    showMenu(x, y, items);
  }

  async createNote(relDir: string | null) {
    const spec = await this.doc.promptMemoSpec();
    if (!spec) return;
    const name = fileNameOf(spec);
    let info: api.DocInfo;
    try {
      info = await api.createNote(relDir, name);
    } catch (e) {
      await showError("新規メモを作成できませんでした", e);
      return;
    }
    const relPath = relDir ? `${relDir}/${name}` : name;
    this.doc.setSelectedRelPath(relPath);
    this.doc.applyDocInfo(info);
    try {
      await this.ports.sidebar.refreshFolderEntries();
      this.ports.sidebar.selectByRelPath(relPath);
    } catch (e) {
      await showError("メモは作成されましたが一覧を更新できませんでした", e);
    }
  }

  private async rename(relPath: string) {
    const current = basename(relPath);
    const result = await promptFields("名前を変更", [{
      label: "新しい名前",
      value: current,
      validate: (value) => value.trim() ? null : "名前を入力してください",
    }]);
    const newName = result?.[0].trim();
    if (!newName || newName === current) return;
    const oldAbsolute = this.toAbsolute(relPath);
    const separator = relPath.lastIndexOf("/");
    const newAbsolute = this.toAbsolute(separator < 0 ? newName : `${relPath.slice(0, separator + 1)}${newName}`);
    try {
      const info = await api.renameEntry(relPath, newName);
      this.ports.sidebar.setEntries(info.folder_entries ?? []);
      const root = this.root;
      if (info.path && root) {
        const rel = relativePathFromRoot(root, info.path);
        this.doc.applyRenamed(info, rel);
        this.ports.sidebar.selectByRelPath(rel);
      }
      // 起動時に開く既定パスが改名対象の下にあると、次回起動で開けなくなる
      const startupPath = getSetting("startupPath");
      const rebased = startupPath && rebaseWindowsPath(startupPath, oldAbsolute, newAbsolute);
      if (rebased) this.ports.onSetStartupPath(rebased);
    } catch (e) {
      await showError("名前を変更できませんでした", e);
    }
  }

  private async delete(target: ContextTarget) {
    const name = basename(target.relPath);
    const kind = target.isDir ? "フォルダと中身" : "ファイル";
    if (!await confirmMessage("削除", `「${name}」${kind}を削除します。元に戻せません。`, "削除")) return;
    try {
      const info = await api.deleteEntry(target.relPath);
      const selected = this.doc.current.selectedRelPath;
      const deletedSelection = selected === target.relPath
        || selected.startsWith(`${target.relPath}/`)
        || selected.startsWith(`${target.relPath}::`);
      if (deletedSelection) {
        this.doc.setSelectedRelPath("");
        this.doc.applyDocInfo(info, false, true);
      }
      await this.ports.sidebar.refreshFolderEntries();
    } catch (e) {
      await showError("削除できませんでした", e);
    }
  }
}

function viewerFormatFor(path: string): api.ViewerFormat | null {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  if (extension === ".csv") return "csv";
  return extension === ".md" || extension === ".markdown" ? "markdown" : null;
}

export function isImagePath(path: string): boolean {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  return [".apng", ".avif", ".bmp", ".gif", ".ico", ".jpeg", ".jpg", ".png", ".svg", ".webp"].includes(extension);
}

export async function revealInExplorer(path: string, isDir: boolean) {
  try {
    await api.revealInExplorer(path, isDir);
  } catch (e) {
    await showError("開けませんでした", e);
  }
}

export async function openInOtherApp(path: string) {
  try {
    await api.openInOtherApp(path);
  } catch (e) {
    await showError("アプリで開けませんでした", e);
  }
}

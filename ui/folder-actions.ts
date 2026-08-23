import * as api from "./api";
import type { ContextTarget } from "./context-target";
import type { SidebarFileCommand } from "./sidebar";
import { fileNameOf } from "./memo-name";
import type { DocumentSession } from "./session";
import { showMenu, MenuItem } from "./menu";
import type { confirmMessage, promptFields } from "./prompt";
import type { showError } from "./dialogs";
import {
  basename,
  isDescendantPath,
  joinWindowsRoot,
  movedRelativePath,
  rebaseWindowsPath,
  relativePathFromRoot,
  type PathRebase,
} from "./path";
import { isArchiveEntryUnder } from "./archive-path";
import { createRegisteredCommandMenu, type RegisteredCommandMenuPorts } from "./registered-command-menu";
import { MENU_ICON } from "./menu-icons";
import { MENU_LABELS } from "./menu-labels";
import { runAsyncBoundary } from "./async-boundary";
import { reportErrorSafely } from "./report-error";
import type { MemoCreationSpec } from "./document-controller";
import { FileOperationHistory, type FileOperation } from "./file-operation-history";
import type { FileTreeDropRequest, FileTreeDropResult } from "./file-tree-drop";
export { isImagePath } from "./image-formats";

type PasteConflictAction = "rename" | "replace" | "skip" | "cancel";

type FileEntryRef = Pick<ContextTarget, "relPath">;

function isPasteConflictAction(value: string | undefined): value is PasteConflictAction {
  return value === "rename" || value === "replace" || value === "skip" || value === "cancel";
}

function isAlreadyExistsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already\s*exists|alreadyexists|同名/.test(message);
}

export interface FolderActionsPorts {
  sidebar: FolderActionsSidebarPort;
  onOpenInNewTab: (relPath: string, goto?: api.Pos) => void;
  onOpenInNewWindow: (path: string, goto?: api.Pos) => void;
  onAddFavorite: (path: string) => void;
  onSetStartupPath: (path: string) => void;
  onOpenPath: (path: string) => void;
}

export interface FolderActionsSidebarPort {
  setEntries: (entries: api.FolderEntry[]) => void;
  selectByRelPath: (relPath: string) => void | Promise<void>;
  refreshFolderEntries: () => void | Promise<void>;
  clearFolderMoveUndo?: () => void;
  expandAllFolder: (relDir: string) => void | Promise<void>;
}

export type FolderActionsApi = Pick<
  typeof api,
  | "createNote"
  | "createFolder"
  | "listFolderEntries"
  | "renameEntry"
  | "deleteEntry"
  | "copyEntry"
  | "copyEntryAs"
  | "moveEntry"
  | "moveEntryAs"
  | "deleteEntryWithoutBackup"
  | "restoreDeletedEntry"
  | "selectEntry"
>;

export interface FolderActionsServices {
  api: FolderActionsApi;
  showError: typeof showError;
  confirmMessage: typeof confirmMessage;
  promptFields: typeof promptFields;
  registeredCommandPorts: Omit<RegisteredCommandMenuPorts, "promptFields">;
  getStartupPath: () => string | null;
  revealInExplorer: typeof revealInExplorer;
  openInOtherApp: typeof openInOtherApp;
  onClipboardChange?: () => void;
  writeClipboardText?: (text: string) => Promise<void>;
  onRebasePath?: (rebase: PathRebase) => void;
}

export interface FolderDocumentPort {
  readonly current: Readonly<DocumentSession>;
  promptMemoSpec: (directory: string) => Promise<MemoCreationSpec | null>;
  setSelectedRelPath: (relPath: string) => void;
  applyDocInfo: (info: api.DocInfo, keepViewers?: boolean, updateTree?: boolean) => void;
  applyMoved: (info: api.DocInfo, selectedRelPath: string) => void;
  markDeleted: () => void;
  markRestored: (relPath: string, absolutePath: string) => void;
  applyRenamed: (info: api.DocInfo, selectedRelPath: string) => void;
}

// フォルダビュー上のファイル操作 (右クリックメニューとその実行)。
export class FolderActions {
  private clipboard: { mode: "copy" | "cut"; entries: ContextTarget[] } | null = null;
  private history = new FileOperationHistory();
  private replayingHistory = false;
  private operationRoot: string | null | undefined;

  constructor(
    private doc: FolderDocumentPort,
    private ports: FolderActionsPorts,
    private services: FolderActionsServices,
  ) {}

  private get root(): string | null {
    return this.doc.current.folderRoot;
  }

  private syncOperationRoot(notify = true) {
    const root = this.root;
    if (this.operationRoot === undefined) {
      this.operationRoot = root;
      return;
    }
    if (sameWindowsPath(this.operationRoot, root)) return;
    this.operationRoot = root;
    this.clipboard = null;
    this.history.clear();
    this.ports.sidebar.clearFolderMoveUndo?.();
    if (notify) this.services.onClipboardChange?.();
  }

  private toAbsolute(relPath: string): string {
    return joinWindowsRoot(this.root!, relPath);
  }

  private pathContains(selectedRelPath: string, relPath: string): boolean {
    const selected = selectedRelPath.replace(/\\/g, "/").replace(/\/$/, "").toLocaleLowerCase("en-US");
    const target = relPath.replace(/\\/g, "/").replace(/\/$/, "").toLocaleLowerCase("en-US");
    return !!target && (selected === target
      || selected.startsWith(`${target}/`)
      || selected.startsWith(`${target}::`));
  }

  private async reloadSelectedEntry(selectedRelPath: string, affectedRelPath: string): Promise<void> {
    if (!this.pathContains(selectedRelPath, affectedRelPath)) return;
    this.doc.setSelectedRelPath(selectedRelPath);
    const info = await this.services.api.selectEntry(selectedRelPath);
    this.doc.applyDocInfo(info, true);
  }

  private run(title: string, operation: () => void | Promise<unknown>) {
    runAsyncBoundary(operation, (error) => this.reportError(title, error));
  }

  private async reportError(title: string, error: unknown) {
    await reportErrorSafely(this.services.showError, title, error);
  }

  showContextMenu(x: number, y: number, target: ContextTarget | null, selected: ContextTarget[] = target ? [target] : []) {
    this.syncOperationRoot();
    const root = this.root;
    if (!root) return; // アーカイブ閲覧中はファイル操作の対象がない
    const revealPath = target ? this.toAbsolute(target.relPath) : root;
    const revealIsDir = target ? target.isDir : true;
    const items: MenuItem[] = [];
    items.push({
      label: MENU_LABELS.explorer,
      iconClass: MENU_ICON.explorer,
      action: () => this.run("エクスプローラで開けませんでした", () => this.services.revealInExplorer(revealPath, revealIsDir)),
    });
    const operationTargets = this.operationTargets(target, selected);
    if (!target || target.isDir) {
      if (this.clipboard) {
        items.push({
          label: MENU_LABELS.paste,
          iconClass: MENU_ICON.paste,
          action: () => this.run("貼り付けできませんでした", () => this.paste(target)),
        });
      }
    }
    if (operationTargets.length) {
      items.push({
        label: MENU_LABELS.cut,
        iconClass: MENU_ICON.cut,
        action: () => this.copyToClipboard("cut", operationTargets),
      });
      items.push({
        label: MENU_LABELS.copy,
        iconClass: MENU_ICON.copy,
        action: () => this.copyToClipboard("copy", operationTargets),
      });
    }
    if (target) {
      items.push({
        label: MENU_LABELS.newTab,
        iconClass: MENU_ICON.newTab,
        action: () => this.ports.onOpenInNewTab(target.relPath, target.goto),
      });
      items.push({
        label: MENU_LABELS.newWindow,
        iconClass: MENU_ICON.newWindow,
        action: () => this.ports.onOpenInNewWindow(this.toAbsolute(target.relPath), target.goto),
      });
      if (target.isDir) {
        items.push({
          label: MENU_LABELS.expandFolder,
          iconClass: MENU_ICON.expandFolder,
          sep: true,
          action: () => this.run(`${MENU_LABELS.expandFolder}できませんでした`, () => this.ports.sidebar.expandAllFolder(target.relPath)),
        });
        items.push({
          label: MENU_LABELS.newFolder,
          iconClass: MENU_ICON.newFolder,
          action: () => this.run("新規フォルダを作成できませんでした", () => this.createFolder(target.relPath)),
        });
      }
      if (!target.isDir) {
        items.push({
          label: MENU_LABELS.external,
          iconClass: MENU_ICON.external,
          action: () => this.run("アプリで開けませんでした", () => this.services.openInOtherApp(this.toAbsolute(target.relPath))),
          sep: true,
        });
        items.push(this.registeredCommandMenu(target.relPath));
      }
      items.push({
        label: MENU_LABELS.address,
        iconClass: MENU_ICON.address,
        action: () => this.ports.onOpenPath(this.toAbsolute(target.relPath)),
      });
      if (operationTargets.length && this.services.writeClipboardText) {
        items.push({
          label: MENU_LABELS.copyPath,
          iconClass: MENU_ICON.copy,
          action: () => this.run("パスをコピーできませんでした", () => this.copyPath(operationTargets)),
        });
      }
    }
    const favoriteItem: MenuItem = {
      label: MENU_LABELS.favorite,
      iconClass: MENU_ICON.favorite,
      action: () => this.ports.onAddFavorite(revealPath),
      sep: true,
    };
    if (target) items.push(favoriteItem);
    items.push({
      label: MENU_LABELS.newMemo,
      iconClass: MENU_ICON.newMemo,
      action: () => this.run("新規メモを作成できませんでした", () => this.createNote(target?.isDir ? target.relPath : null)),
      sep: true,
    });
    if (!target) {
      items.push({
        label: MENU_LABELS.expandFolder,
        iconClass: MENU_ICON.expandFolder,
        action: () => this.run(`${MENU_LABELS.expandFolder}できませんでした`, () => this.ports.sidebar.expandAllFolder("")),
      });
    }
    if (target) {
      items.push({
        label: MENU_LABELS.rename,
        iconClass: MENU_ICON.rename,
        action: () => this.run("名前を変更できませんでした", () => this.rename(target.relPath)),
      });
      items.push({
        label: MENU_LABELS.more,
        iconClass: MENU_ICON.more,
        sep: true,
        sub: [{
          label: MENU_LABELS.delete,
          iconClass: MENU_ICON.delete,
          action: () => this.run(
            "削除できませんでした",
            () => this.deleteEntries(operationTargets.length ? operationTargets : [target]),
          ),
        }],
      });
    }
    if (!target) items.push(favoriteItem);
    showMenu(x, y, items);
  }

  executeCommand(command: SidebarFileCommand, selected: ContextTarget[]) {
    this.syncOperationRoot();
    if (!this.root) return;
    const targets = this.operationTargets(selected[0] ?? null, selected);
    switch (command) {
      case "copy":
        this.copyToClipboard("copy", targets);
        return;
      case "cut":
        this.copyToClipboard("cut", targets);
        return;
      case "paste":
        if (selected.length && (selected.length !== 1 || !selected[0].isDir)) return;
        this.run("貼り付けできませんでした", () => this.paste(selected[0] ?? null));
        return;
      case "undo":
        this.run("ファイル操作を元に戻せませんでした", () => this.undoFileOperation());
        return;
      case "redo":
        this.run("ファイル操作をやり直せませんでした", () => this.redoFileOperation());
        return;
      case "delete":
        if (targets.length) this.run("削除できませんでした", () => this.deleteEntries(targets));
        return;
      default:
        return;
    }
  }

  private operationTargets(target: ContextTarget | null, selected: ContextTarget[]): ContextTarget[] {
    const candidates = selected.length ? selected : target ? [target] : [];
    const seen = new Set<string>();
    const result: ContextTarget[] = [];
    for (const item of candidates) {
      const comparablePath = item.relPath.replace(/\\/g, "/").toLocaleLowerCase("en-US");
      if (!item.relPath || item.relPath.includes("::") || seen.has(comparablePath)) continue;
      seen.add(comparablePath);
      if (result.some((parent) => parent.isDir && isDescendantPath(item.relPath, parent.relPath))) continue;
      for (let i = result.length - 1; i >= 0; i--) {
        if (item.isDir && isDescendantPath(result[i].relPath, item.relPath)) result.splice(i, 1);
      }
      result.push(item);
    }
    return result;
  }

  private copyToClipboard(mode: "copy" | "cut", entries: ContextTarget[]) {
    if (!entries.length) return;
    this.clipboard = { mode, entries: entries.map((entry) => ({ ...entry })) };
    this.services.onClipboardChange?.();
  }

  private async copyPath(entries: ContextTarget[]) {
    if (!this.services.writeClipboardText) return;
    await this.services.writeClipboardText(entries.map((entry) => this.toAbsolute(entry.relPath)).join("\n"));
  }

  isCut(relPath: string): boolean {
    this.syncOperationRoot(false);
    return this.clipboard?.mode === "cut"
      && this.clipboard.entries.some((entry) => entry.relPath === relPath);
  }

  private async paste(target: ContextTarget | null) {
    this.syncOperationRoot();
    if (!this.clipboard || (target && !target.isDir)) return;
    const clipboard = this.clipboard;
    const targetRelDir = target?.relPath ?? "";
    const result = await this.pasteEntries(clipboard.mode, clipboard.entries, targetRelDir);
    this.recordOperations(result.operations);
    if (clipboard.mode === "cut" && result.completedSources.size) {
      clipboard.entries = clipboard.entries.filter((entry) => !result.completedSources.has(entry.relPath));
      if (!clipboard.entries.length) this.clipboard = null;
      this.services.onClipboardChange?.();
    }
    await this.ports.sidebar.refreshFolderEntries();
  }

  private async pasteEntries(
    mode: "copy" | "cut",
    entries: FileEntryRef[],
    targetRelDir: string,
  ): Promise<{
    operations: FileOperation[];
    completedSources: Set<string>;
  }> {
    let applyToAll = false;
    let conflictAction: PasteConflictAction | null = null;
    const completedSources = new Set<string>();
    const operations: FileOperation[] = [];
    for (const entry of entries) {
      try {
        const operation = await this.performPaste(mode, entry, targetRelDir);
        operations.push(operation);
        completedSources.add(entry.relPath);
      } catch (error) {
        if (!isAlreadyExistsError(error)) {
          await this.reportError("貼り付けできませんでした", error);
          continue;
        }
        let action: PasteConflictAction | null = applyToAll ? conflictAction : null;
        if (!action) {
          const choice = await this.services.promptFields("同名項目の処理", [
            {
              label: "処理",
              value: "rename",
              options: [
                { label: "自動で名前を変更", value: "rename" },
                { label: "置き換える", value: "replace" },
                { label: "スキップ", value: "skip" },
                { label: "キャンセル", value: "cancel" },
              ],
            },
            {
              label: "適用範囲",
              value: "one",
              options: [
                { label: "この項目だけ", value: "one" },
                { label: "以後すべて", value: "all" },
              ],
            },
          ]);
          action = isPasteConflictAction(choice?.[0]) ? choice[0] : "cancel";
          applyToAll = choice?.[1] === "all";
          conflictAction = action;
        }
        if (action === "cancel") break;
        if (action === "skip") continue;
        try {
          const name = action === "rename"
            ? await this.nextAvailableName(entry.relPath, targetRelDir)
            : basename(entry.relPath);
          const operation = await this.performPaste(
            mode,
            entry,
            targetRelDir,
            name,
            action === "replace",
          );
          operations.push(operation);
          completedSources.add(entry.relPath);
        } catch (retryError) {
          await this.reportError("貼り付けできませんでした", retryError);
        }
      }
    }
    return { operations, completedSources };
  }

  private recordOperations(operations: FileOperation[], drop = false) {
    if (!operations.length || this.replayingHistory) return;
    this.history.record(operations, drop);
    this.ports.sidebar.clearFolderMoveUndo?.();
  }

  async dropEntries(request: FileTreeDropRequest): Promise<FileTreeDropResult> {
    this.syncOperationRoot();
    if (!this.root) return { undoable: false };
    const entries = request.sourceRelPaths.map((relPath) => ({ relPath }));
    const result = await this.pasteEntries(
      request.mode === "copy" ? "copy" : "cut",
      entries,
      request.targetRelDir,
    );
    this.recordOperations(result.operations, true);
    await this.ports.sidebar.refreshFolderEntries();
    const selectedRelPath = [...result.operations]
      .reverse()
      .find((operation): operation is Extract<FileOperation, { kind: "copy" | "move" }> =>
        operation.kind === "copy" || operation.kind === "move")?.targetRelPath ?? "";
    if (selectedRelPath) await this.ports.sidebar.selectByRelPath(selectedRelPath);
    return { undoable: result.operations.length > 0 };
  }

  async undoLastDrop(): Promise<boolean> {
    if (!this.history.lastDropUndo()) return false;
    await this.undoFileOperation();
    return true;
  }

  private async performPaste(
    mode: "copy" | "cut",
    entry: FileEntryRef,
    targetRelDir: string,
    targetName?: string,
    overwrite = false,
  ): Promise<FileOperation> {
    const name = targetName ?? basename(entry.relPath);
    const targetRelPath = targetRelDir ? `${targetRelDir}/${name}` : name;
    const selectedBefore = this.doc.current.selectedRelPath;
    let info: api.DocInfo;
    if (targetName) {
      if (mode === "copy") {
        info = await this.services.api.copyEntryAs(entry.relPath, targetRelDir, targetName, overwrite);
      } else {
        info = await this.services.api.moveEntryAs(entry.relPath, targetRelDir, targetName, overwrite);
      }
    } else if (mode === "copy") {
      info = await this.services.api.copyEntry(entry.relPath, targetRelDir);
    } else {
      info = await this.services.api.moveEntry(entry.relPath, targetRelDir);
    }
    if (mode === "cut") {
      const selectedAfter = movedRelativePath(selectedBefore, entry.relPath, targetRelDir, name);
      this.doc.applyMoved(info, selectedAfter);
      const root = this.root;
      if (root) {
        this.services.onRebasePath?.({
          oldAbsolute: this.toAbsolute(entry.relPath),
          newAbsolute: this.toAbsolute(targetRelPath),
          oldRelPath: entry.relPath,
          newRelPath: targetRelPath,
        });
      }
    }
    if (overwrite) {
      const selectedAfter = mode === "cut"
        ? movedRelativePath(selectedBefore, entry.relPath, targetRelDir, name)
        : selectedBefore;
      await this.reloadSelectedEntry(selectedAfter, targetRelPath);
    }
    return {
      kind: mode === "cut" ? "move" : "copy",
      sourceRelPath: entry.relPath,
      targetRelPath,
      targetRelDir,
      targetName: name,
      overwrite,
    };
  }

  private async nextAvailableName(sourceRelPath: string, targetRelDir: string): Promise<string> {
    const entries = await this.services.api.listFolderEntries(targetRelDir);
    const names = new Set(entries.map((entry) => entry.name.toLocaleLowerCase("en-US")));
    const original = basename(sourceRelPath);
    const extensionIndex = original.lastIndexOf(".");
    const hasExtension = extensionIndex > 0;
    const stem = hasExtension ? original.slice(0, extensionIndex) : original;
    const extension = hasExtension ? original.slice(extensionIndex) : "";
    let index = 1;
    let candidate = `${stem} (${index})${extension}`;
    while (names.has(candidate.toLocaleLowerCase("en-US"))) {
      index += 1;
      candidate = `${stem} (${index})${extension}`;
    }
    return candidate;
  }

  private async undoFileOperation() {
    const operations = this.history.takeUndo();
    if (!operations) return;
    this.replayingHistory = true;
    try {
      for (const operation of [...operations].reverse()) await this.replayOperation(operation, "undo");
      this.history.completeUndo(operations);
    } catch (error) {
      this.history.restoreUndo(operations);
      throw error;
    } finally {
      this.replayingHistory = false;
    }
    await this.ports.sidebar.refreshFolderEntries();
    const restored = [...operations]
      .reverse()
      .find((operation): operation is Extract<FileOperation, { kind: "delete" }> =>
        operation.kind === "delete" && !!operation.restoreRelPath)?.restoreRelPath;
    if (restored) await this.ports.sidebar.selectByRelPath(restored);
  }

  private async redoFileOperation() {
    const operations = this.history.takeRedo();
    if (!operations) return;
    this.replayingHistory = true;
    try {
      for (const operation of operations) await this.replayOperation(operation, "redo");
      this.history.completeRedo(operations);
    } catch (error) {
      this.history.restoreRedo(operations);
      throw error;
    } finally {
      this.replayingHistory = false;
    }
    await this.ports.sidebar.refreshFolderEntries();
  }

  private async replayOperation(operation: FileOperation, direction: "undo" | "redo") {
    const undo = direction === "undo";
    if (operation.kind === "delete") {
      if (undo) {
        await this.services.api.restoreDeletedEntry(operation.relPath);
        if (operation.restoreRelPath && !this.doc.current.selectedRelPath) {
          this.doc.markRestored(operation.restoreRelPath, this.toAbsolute(operation.restoreRelPath));
        }
      } else {
        await this.services.api.deleteEntry(operation.relPath);
        if (operation.restoreRelPath) this.doc.markDeleted();
      }
      return;
    }
    if (operation.kind === "copy") {
      if (undo) {
        const selectedBefore = this.doc.current.selectedRelPath;
        await this.services.api.deleteEntryWithoutBackup(operation.targetRelPath);
        if (operation.overwrite) await this.services.api.restoreDeletedEntry(operation.targetRelPath);
        if (operation.overwrite) {
          await this.reloadSelectedEntry(selectedBefore, operation.targetRelPath);
        }
      } else {
        const selectedBefore = this.doc.current.selectedRelPath;
        await this.services.api.copyEntryAs(
          operation.sourceRelPath,
          operation.targetRelDir,
          operation.targetName,
          operation.overwrite,
        );
        if (operation.overwrite) {
          await this.reloadSelectedEntry(selectedBefore, operation.targetRelPath);
        }
      }
      return;
    }
    if (operation.kind === "move") {
      if (undo) {
        const selectedBefore = this.doc.current.selectedRelPath;
        const sourceRelDir = parentRelPath(operation.sourceRelPath);
        const info = await this.services.api.moveEntryAs(
          operation.targetRelPath,
          sourceRelDir,
          basename(operation.sourceRelPath),
        );
        this.rebaseTabs(operation.targetRelPath, operation.sourceRelPath);
        this.doc.applyMoved(
          info,
          movedRelativePath(selectedBefore, operation.targetRelPath, sourceRelDir, basename(operation.sourceRelPath)),
        );
        if (operation.overwrite) await this.services.api.restoreDeletedEntry(operation.targetRelPath);
        if (operation.overwrite) {
          await this.reloadSelectedEntry(selectedBefore, operation.targetRelPath);
        }
      } else {
        const selectedBefore = this.doc.current.selectedRelPath;
        const info = await this.services.api.moveEntryAs(
          operation.sourceRelPath,
          operation.targetRelDir,
          operation.targetName,
          operation.overwrite,
        );
        this.rebaseTabs(operation.sourceRelPath, operation.targetRelPath);
        this.doc.applyMoved(
          info,
          movedRelativePath(selectedBefore, operation.sourceRelPath, operation.targetRelDir, operation.targetName),
        );
        if (operation.overwrite) {
          await this.reloadSelectedEntry(selectedBefore, operation.targetRelPath);
        }
      }
      return;
    }
    if (operation.kind === "create") {
      if (undo) {
        const selectedBefore = this.doc.current.selectedRelPath;
        await this.services.api.deleteEntryWithoutBackup(operation.relPath);
        if (this.pathContains(selectedBefore, operation.relPath)) {
          this.doc.setSelectedRelPath("");
          this.doc.markDeleted();
        }
      } else if (operation.isDir) {
        await this.services.api.createFolder(parentRelPath(operation.relPath), basename(operation.relPath));
      } else {
        const info = await this.services.api.createNote(
          parentRelPath(operation.relPath) || null,
          basename(operation.relPath),
          operation.encoding,
          operation.eol,
        );
        const root = this.root;
        const actualRelPath = info.path && root
          ? relativePathFromRoot(root, info.path)
          : operation.relPath;
        operation.relPath = actualRelPath;
        this.doc.setSelectedRelPath(actualRelPath);
        this.doc.applyDocInfo(info);
      }
      return;
    }
    await this.renameEntryForHistory(
      undo ? operation.targetRelPath : operation.sourceRelPath,
      undo ? basename(operation.sourceRelPath) : basename(operation.targetRelPath),
    );
  }

  private registeredCommandMenu(relPath: string): MenuItem {
    const path = this.toAbsolute(relPath);
    return createRegisteredCommandMenu(path, {
      promptFields: this.services.promptFields,
      ...this.services.registeredCommandPorts,
      run: (title, operation) => this.run(title, operation),
    });
  }

  async createNote(relDir: string | null) {
    const root = this.root;
    if (!root) {
      await this.reportError("新規メモを作成できませんでした", new Error("フォルダを開いていません"));
      return;
    }
    const directory = relDir ? joinWindowsRoot(root, relDir) : root;
    let spec: MemoCreationSpec | null;
    try {
      spec = await this.doc.promptMemoSpec(directory);
    } catch (e) {
      await this.reportError("新規メモを作成できませんでした", e);
      return;
    }
    if (!spec) return;
    const requestedName = fileNameOf(spec.memo);
    let info: api.DocInfo;
    try {
      info = await this.services.api.createNote(relDir, requestedName, spec.format.encoding, spec.format.eol);
    } catch (e) {
      await this.reportError("新規メモを作成できませんでした", e);
      return;
    }
    const relPath = info.path && root
      ? relativePathFromRoot(root, info.path)
      : relDir ? `${relDir}/${requestedName}` : requestedName;
    this.recordOperations([{
      kind: "create",
      relPath,
      isDir: false,
      encoding: spec.format.encoding,
      eol: spec.format.eol,
    }]);
    try {
      this.doc.setSelectedRelPath(relPath);
      this.doc.applyDocInfo(info);
    } catch (e) {
      await this.reportError("メモは作成されましたが画面を更新できませんでした", e);
      return;
    }
    try {
      await this.ports.sidebar.refreshFolderEntries();
      await this.ports.sidebar.selectByRelPath(relPath);
    } catch (e) {
      await this.reportError("メモは作成されましたが一覧を更新できませんでした", e);
    }
  }

  async createFolder(relDir = "") {
    if (!this.root) {
      await this.reportError("新規フォルダを作成できませんでした", new Error("フォルダを開いていません"));
      return;
    }
    let result: string[] | null;
    try {
      result = await this.services.promptFields("新規フォルダ", [{
        label: "フォルダ名",
        value: "",
        validate: (value) => value.trim() ? null : "名前を入力してください",
      }]);
    } catch (error) {
      await this.reportError("新規フォルダを作成できませんでした", error);
      return;
    }
    const name = result?.[0].trim();
    if (!name) return;
    try {
      await this.services.api.createFolder(relDir, name);
    } catch (error) {
      await this.reportError("新規フォルダを作成できませんでした", error);
      return;
    }
    this.recordOperations([{
      kind: "create",
      relPath: relDir ? `${relDir}/${name}` : name,
      isDir: true,
    }]);
    try {
      await this.ports.sidebar.refreshFolderEntries();
    } catch (error) {
      await this.reportError("フォルダは作成されましたが一覧を更新できませんでした", error);
    }
  }

  private async rename(relPath: string) {
    const current = basename(relPath);
    const result = await this.services.promptFields("名前を変更", [{
      label: "新しい名前",
      value: current,
      validate: (value) => value.trim() ? null : "名前を入力してください",
    }]);
    const newName = result?.[0].trim();
    if (!newName || newName === current) return;
    await this.renameEntry(relPath, newName);
  }

  async renameEntry(relPath: string, newName: string) {
    this.syncOperationRoot();
    if (!this.root) return;
    const current = basename(relPath);
    if (!newName.trim() || newName.trim() === current) return;
    newName = newName.trim();
    const separator = relPath.lastIndexOf("/");
    const newRelPath = separator < 0 ? newName : `${relPath.slice(0, separator + 1)}${newName}`;
    const rebase: PathRebase = {
      oldAbsolute: this.toAbsolute(relPath),
      newAbsolute: this.toAbsolute(newRelPath),
      oldRelPath: relPath,
      newRelPath,
    };
    let info: api.DocInfo;
    try {
      info = await this.services.api.renameEntry(relPath, newName);
    } catch (e) {
      await this.reportError("名前を変更できませんでした", e);
      return;
    }
    if (!this.replayingHistory) {
      this.recordOperations([{
        kind: "rename",
        sourceRelPath: relPath,
        targetRelPath: newRelPath,
      }]);
    }
    this.services.onRebasePath?.(rebase);
    try {
      await this.applyRenameInfo(info, rebase);
    } catch (e) {
      await this.reportError("名前は変更されましたが画面を更新できませんでした", e);
    }
  }

  private async renameEntryForHistory(relPath: string, newName: string) {
    const separator = relPath.lastIndexOf("/");
    const newRelPath = separator < 0 ? newName : `${relPath.slice(0, separator + 1)}${newName}`;
    const rebase: PathRebase = {
      oldAbsolute: this.toAbsolute(relPath),
      newAbsolute: this.toAbsolute(newRelPath),
      oldRelPath: relPath,
      newRelPath,
    };
    const info = await this.services.api.renameEntry(relPath, newName);
    this.rebaseTabs(relPath, newRelPath);
    await this.applyRenameInfo(info, rebase);
  }

  private rebaseTabs(oldRelPath: string, newRelPath: string) {
    const root = this.root;
    if (!root) return;
    this.services.onRebasePath?.({
      oldAbsolute: this.toAbsolute(oldRelPath),
      newAbsolute: this.toAbsolute(newRelPath),
      oldRelPath,
      newRelPath,
    });
  }

  private async applyRenameInfo(
    info: api.DocInfo,
    rebase: PathRebase,
  ) {
    this.ports.sidebar.setEntries(info.folder_entries ?? []);
    const root = this.root;
    if (info.path && root) {
      const infoRelPath = relativePathFromRoot(root, info.path);
      const currentSelected = this.doc.current.selectedRelPath;
      const rebasedSelected = movedRelativePath(
        currentSelected,
        rebase.oldRelPath,
        parentRelPath(rebase.newRelPath),
        basename(rebase.newRelPath),
      );
      const selectedRelPath = rebasedSelected !== currentSelected ? rebasedSelected : infoRelPath;
      this.doc.applyRenamed(info, selectedRelPath);
      await this.ports.sidebar.selectByRelPath(selectedRelPath);
    }
    // 起動時に開く既定パスが改名対象の下にあると、次回起動で開けなくなる
    const startupPath = this.services.getStartupPath();
    const rebased = startupPath && rebaseWindowsPath(startupPath, rebase.oldAbsolute, rebase.newAbsolute);
    if (rebased) this.ports.onSetStartupPath(rebased);
  }

  private async deleteEntries(targets: ContextTarget[]) {
    this.syncOperationRoot();
    if (!this.root) return;
    if (!targets.length) return;
    const message = targets.length === 1
      ? `「${basename(targets[0].relPath)}」${targets[0].isDir ? "フォルダと中身" : "ファイル"}をごみ箱へ移動します。元に戻せます。`
      : `${targets.length}項目をごみ箱へ移動します。元に戻せます。`;
    if (!await this.services.confirmMessage("削除", message, "削除")) return;
    let changed = false;
    const operations: FileOperation[] = [];
    for (const target of targets) {
      try {
        await this.services.api.deleteEntry(target.relPath);
      } catch (error) {
        await this.reportError("削除できませんでした", error);
        continue;
      }
      changed = true;
      try {
        const selected = this.doc.current.selectedRelPath;
        const deletedSelection = selected === target.relPath
          || selected.startsWith(`${target.relPath}/`)
          || isArchiveEntryUnder(selected, target.relPath);
        operations.push({
          kind: "delete",
          relPath: target.relPath,
          restoreRelPath: deletedSelection ? selected : null,
        });
        if (deletedSelection) {
          this.doc.setSelectedRelPath("");
          this.doc.markDeleted();
        }
      } catch (error) {
        await this.reportError("削除は完了しましたが画面を更新できませんでした", error);
      }
    }
    if (!changed) return;
    this.recordOperations(operations);
    try {
      await this.ports.sidebar.refreshFolderEntries();
    } catch (error) {
      await this.reportError("削除は完了しましたが一覧を更新できませんでした", error);
    }
  }
}

function parentRelPath(relPath: string): string {
  const normalized = relPath.replace(/\\/g, "/").replace(/\/$/, "");
  const separator = normalized.lastIndexOf("/");
  return separator < 0 ? "" : normalized.slice(0, separator);
}

function sameWindowsPath(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right;
  return left.replace(/\\/g, "/").replace(/\/$/, "").toLocaleLowerCase("en-US")
    === right.replace(/\\/g, "/").replace(/\/$/, "").toLocaleLowerCase("en-US");
}

export async function revealInExplorer(path: string, isDir: boolean) {
  await api.revealInExplorer(path, isDir);
}

export async function openInOtherApp(path: string) {
  await api.openInOtherApp(path);
}

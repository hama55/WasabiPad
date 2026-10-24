// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { AddressBar } from "./addressbar";
import { DocumentController } from "./document-controller";
import { TabManager } from "./tabs";
import { FavBar } from "./favbar";
import { isPasswordCancelled, withArchivePassword } from "./archive-password";
import { saveFormatFields, saveFormatFromValues } from "./save-format";

describe("Feature: ＋から始めたメモの保存", () => {
  // Scenario: ＋で仮パスを表示し、未保存のまま開く操作をせず、選んだ実パスへ保存する
  // Given: ドキュメントフォルダを保存先にしたアプリ部品とOS・文書APIの境界
  // When: ＋、パス欄Enter、お気に入り追加、保存キャンセル、別名保存を順に実行する
  // Then: 未作成パスを開かず、キャンセルで文書を失わず、保存後だけ実ファイルを公開する
  it("Scenario: ＋からパス表示と初回保存までを実際の部品でつなぐ", async () => {
    const topbar = document.createElement("div");
    topbar.innerHTML = [
      "addressbar", "addressbar-breadcrumb", "addressbar-fav", "addressbar-save",
      "addressbar-save-as", "addressbar-new", "addressbar-find", "addressbar-open", "addressbar-settings",
    ].map((id) => id === "addressbar" ? `<input id="${id}">` : `<button id="${id}"></button>`).join("");
    const host = document.createElement("div");
    const open = vi.fn();
    const addressbar = new AddressBar(topbar, {
      onOpen: open, onSave: () => {}, onSaveAs: () => {}, onNew: () => {},
      onFind: () => {}, onPick: () => {}, onFavorite: () => {}, onSettings: () => {},
    });
    const newDoc = vi.fn(async () => {});
    const saveFile = vi.fn(async () => ({ kind: "saved" as const, modified_at: null }));
    const pickSavePath = vi.fn<(path: string) => Promise<string | null>>().mockResolvedValue(null);
    const unexpectedPrompt = vi.fn(async () => { throw new Error("追加の入力は不要"); });
    let tabs: TabManager;
    const doc = new DocumentController({
      editor: {
        open: () => {}, focus: () => {}, goTo: () => {}, setExternalFilePath: () => {}, setRegisteredCommandPath: () => {},
        captureViewState: () => ({ anchor: { line: 0, col: 0 }, caret: { line: 0, col: 0 }, topLine: 0, wrapIntraLinePx: 0, scrollLeft: 0 }),
        restoreViewState: async () => {},
      },
      statusbar: { setFormat: () => {}, setLineCount: () => {} },
      fileStatusbar: { setByteSize: () => {}, setModifiedAt: () => {} },
      sidebar: { setWorkspaceSearch: () => {}, setArchiveEntries: () => {}, setArchiveRoot: () => {}, setEntries: () => {}, selectByRelPath: () => {} },
      addressbar, setSidebar: () => {}, setLoading: () => {}, setTitle: () => {}, hideExternalBanner: () => {},
      pickSavePath,
      onDocumentChange: (session) => tabs?.syncActive(session),
      onSessionChange: (session) => tabs?.syncActive(session),
    }, {
      api: { ...api, newDoc, saveFile, pathIsDirectory: async () => true },
      showError: async (_title, error) => { throw new Error(String(error)); },
      confirmSaveDiscard: async () => "discard",
      promptFields: unexpectedPrompt, promptSaveFormat: unexpectedPrompt,
      saveFormatFields, saveFormatFromValues, isPasswordCancelled, withArchivePassword,
    });
    tabs = new TabManager(host, doc, {
      onChange: () => {}, defaultSaveDirectory: async () => "C:\\Users\\sample\\Documents\\",
      defaultMemoDirectory: async () => "C:\\Users\\sample\\Desktop\\",
      nextMemoPath: async () => "C:\\Users\\sample\\Documents\\memo1.txt",
    }, { promptFields: unexpectedPrompt, runExternalCommand: async () => {} });
    const store = { load: async () => [], save: vi.fn(async () => {}), isDirectory: async () => false };
    const favorites = new FavBar(document.createElement("div"), {
      onOpen: () => {}, onOpenInNewWindow: () => {}, onAddGroupToTabs: () => {}, revealInExplorer: () => {},
      currentFile: () => doc.current.draftSavePath !== undefined ? null : addressbar.path || null,
      onError: async (error) => { throw error; },
    }, store);
    await favorites.init();
    await tabs.init({ tabs: [], activeId: null }, null);
    host.querySelector<HTMLButtonElement>(".doc-tab-add")!.click();
    await vi.waitFor(() => expect(addressbar.path).toBe("C:\\Users\\sample\\Documents\\memo1.txt"));
    expect(tabs.state.tabs.at(-1)?.path).toBeNull();
    expect(saveFile).not.toHaveBeenCalled();
    addressbar.edit();
    topbar.querySelector<HTMLInputElement>("#addressbar")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(open).not.toHaveBeenCalled();
    await favorites.addCurrent();
    expect(store.save).not.toHaveBeenCalled();
    doc.onEdit(7);
    const created = newDoc.mock.calls.length;
    expect(await doc.save()).toBe(false);
    expect(doc.current).toMatchObject({ lineCount: 7, dirty: true, savePath: null });
    expect(newDoc).toHaveBeenCalledTimes(created);
    pickSavePath.mockResolvedValueOnce("C:\\chosen\\note.txt");
    expect(await doc.save()).toBe(true);
    expect(saveFile).toHaveBeenCalledExactlyOnceWith("C:\\chosen\\note.txt", "utf8", "crlf");
    expect(addressbar.path).toBe("C:\\chosen\\note.txt");
    expect(tabs.state.tabs.at(-1)).toMatchObject({ path: "C:\\chosen\\note.txt", kind: "file" });
    expect(tabs.state.tabs.at(-1)?.draftSavePath).toBeUndefined();
    expect(unexpectedPrompt).not.toHaveBeenCalled();
    await favorites.addCurrent();
    expect(store.save).toHaveBeenCalledWith([{ kind: "file", name: "note.txt", path: "C:\\chosen\\note.txt" }]);
    favorites.dispose();
  });
});

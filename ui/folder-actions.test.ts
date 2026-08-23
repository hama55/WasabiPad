// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { showError } from "./dialogs";
import { initialSession } from "./session";
import { initSettings } from "./settings";
import { addRegisteredCommand, commandsForPath } from "./registered-commands";
import {
  FolderActions,
  isImagePath,
  openInOtherApp,
  revealInExplorer,
  type FolderActionsPorts,
  type FolderDocumentPort,
} from "./folder-actions";
import type { RegisteredCommandMenuPorts } from "./registered-command-menu";
import type { MemoCreationSpec } from "./document-controller";
import { MENU_ICON } from "./menu-icons";

vi.mock("./dialogs", () => ({ showError: vi.fn(async () => {}) }));
vi.mock("./api", async (importOriginal) => ({
  ...await importOriginal<typeof import("./api")>(),
  loadSettings: vi.fn(async () => "{}"),
  updateSetting: vi.fn(async () => {}),
  runExternalCommand: vi.fn(async () => {}),
}));
vi.mock("./prompt", async (importOriginal) => ({
  ...await importOriginal<typeof import("./prompt")>(),
  confirmMessage: vi.fn(async () => true),
  promptFields: vi.fn(async () => null),
}));
import { confirmMessage, promptFields } from "./prompt";

const registeredCommandPorts: RegisteredCommandMenuPorts = {
  promptFields,
  runExternalCommand: vi.mocked(api.runExternalCommand),
};

function fixture(writeClipboardText?: (text: string) => Promise<void>) {
  const dropdown = document.createElement("div");
  dropdown.id = "dropdown";
  document.body.replaceChildren(dropdown);
  const session = initialSession();
  session.folderRoot = "C:\\work";
  const expandAllFolder = vi.fn();
  const doc = {
    current: session,
    promptMemoSpec: vi.fn(async (): Promise<MemoCreationSpec | null> => null),
    setSelectedRelPath: vi.fn(),
    applyDocInfo: vi.fn(),
    applyMoved: vi.fn(),
    markDeleted: vi.fn(),
    markRestored: vi.fn(),
    applyRenamed: vi.fn(),
  } satisfies FolderDocumentPort;
  const sidebar = {
    setEntries: vi.fn(),
    selectByRelPath: vi.fn(),
    refreshFolderEntries: vi.fn(async () => {}),
    expandAllFolder,
  };
  const ports = {
    sidebar,
    onOpenInNewTab: vi.fn(),
    onOpenInNewWindow: vi.fn(),
    onAddFavorite: vi.fn(),
    onSetStartupPath: vi.fn(),
    onOpenPath: vi.fn(),
  } satisfies FolderActionsPorts;
  return {
    actions: new FolderActions(doc, ports, {
      api,
      showError,
      confirmMessage,
      promptFields,
      registeredCommandPorts,
      getStartupPath: () => null,
      revealInExplorer,
      openInOtherApp,
      writeClipboardText,
    }),
    doc,
    dropdown,
    ports,
    expandAllFolder,
  };
}

describe("Feature: FolderActions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    document.body.replaceChildren();
    await initSettings();
    vi.mocked(api.runExternalCommand).mockClear();
    vi.mocked(showError).mockClear();
    vi.mocked(promptFields).mockReset();
    vi.mocked(promptFields).mockResolvedValue(null);
  });

  // Given: rootが`C:\work`、対象が`memo.txt`、gotoが`{line:499,col:8}`
  // When: コンテキストメニュー表示後に新規ウィンドウ項目をクリック
  // Then: 10項目・区切り4個、Explorerが先頭で、絶対パスとgotoを渡す
  it("Scenario: 右クリック項目を操作別に区切り、新規ウィンドウで開ける", () => {
    const { actions, dropdown, ports } = fixture();
    const goto = { line: 499, col: 8 };
    actions.showContextMenu(0, 0, { relPath: "memo.txt", isDir: false, goto });

    expect([...dropdown.querySelectorAll(".dd-label")].map((label) => label.textContent)).toEqual([
      "エクスプローラで開く",
      "切り取り",
      "コピー",
      "新規タブで開く",
      "新規ウィンドウで開く",
      "アプリで開く",
      "コマンドを登録...",
      "アドレスバーに設定",
      "お気に入りに追加",
      "新規メモ作成...",
      "名前を変更...",
      "その他 ▸",
    ]);
    expect(dropdown.querySelectorAll(".dd-sep")).toHaveLength(4);
    const expectedIcons = [
      ["エクスプローラで開く", MENU_ICON.explorer],
      ["切り取り", MENU_ICON.cut],
      ["コピー", MENU_ICON.copy],
      ["新規タブで開く", MENU_ICON.newTab],
      ["新規ウィンドウで開く", MENU_ICON.newWindow],
      ["アプリで開く", MENU_ICON.external],
      ["コマンドを登録...", MENU_ICON.command],
      ["アドレスバーに設定", MENU_ICON.address],
      ["お気に入りに追加", MENU_ICON.favorite],
      ["新規メモ作成...", MENU_ICON.newMemo],
      ["名前を変更...", MENU_ICON.rename],
      ["その他 ▸", MENU_ICON.more],
    ] as const;
    for (const [label, icon] of expectedIcons) {
      const item = [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
        .find((element) => element.textContent === label);
      expect(item?.querySelector(`.${icon}`), label).not.toBeNull();
    }

    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "新規ウィンドウで開く")!.click();
    expect(ports.onOpenInNewWindow).toHaveBeenCalledWith("C:\\work\\memo.txt", goto);
  });

  // Feature: ファイルツリーの内部クリップボード
  // Scenario: ファイルをコピーするとフォルダの貼り付けメニューが有効になる
  // Given: memo.txtを対象にコンテキストメニューを表示している
  // When: 「コピー」を選ぶ
  // Then: docsフォルダのメニューに「貼り付け」が表示される
  it("Scenario: コピー後はフォルダへ貼り付けできる", () => {
    const { actions, dropdown } = fixture();
    actions.showContextMenu(0, 0, { relPath: "memo.txt", isDir: false });
    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "コピー")
      ?.click();

    actions.showContextMenu(0, 0, { relPath: "docs", isDir: true });

    expect([...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .some((item) => item.textContent === "貼り付け")).toBe(true);
  });

  // Feature: 実ファイル項目のパスコピー
  // Scenario: コンテキストメニューから絶対パスをOSクリップボードへコピーする
  // Given: `memo.txt`を対象にメニューを表示している
  // When: 「パスをコピー」を選ぶ
  // Then: フォルダルートを含む絶対パスを渡す
  it("Scenario: ファイル項目の絶対パスをコピーできる", async () => {
    const writeClipboardText = vi.fn(async (_text: string) => {});
    const { actions, dropdown } = fixture(writeClipboardText);
    actions.showContextMenu(0, 0, { relPath: "memo.txt", isDir: false });
    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "パスをコピー")!.click();

    await vi.waitFor(() => expect(writeClipboardText).toHaveBeenCalledWith("C:\\work\\memo.txt"));
  });

  // Feature: ファイルツリーの内部クリップボード
  // Scenario: フォルダを切り替えたら前のフォルダの貼り付け対象を破棄する
  // Given: C:\work の memo.txt をコピーしている
  // When: C:\other の docs フォルダでコンテキストメニューを表示する
  // Then: 前のフォルダの項目を貼り付けるメニューは表示しない
  it("Scenario: フォルダ切り替え後は内部クリップボードを持ち越さない", () => {
    const { actions, dropdown, doc } = fixture();
    actions.showContextMenu(0, 0, { relPath: "memo.txt", isDir: false });
    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "コピー")!.click();

    doc.current.folderRoot = "C:\\other";
    actions.showContextMenu(0, 0, { relPath: "docs", isDir: true });

    expect([...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .some((item) => item.textContent === "貼り付け")).toBe(false);
  });

  // Feature: ファイルツリーの貼り付け
  // Scenario: コピーしたファイルを選択フォルダへ貼り付ける
  // Given: memo.txtをコピーし、docsフォルダのメニューを表示している
  // When: 「貼り付け」を選ぶ
  // Then: コピーAPIへ元パスとdocsを渡し、一覧を更新する
  it("Scenario: コピーしたファイルを選択フォルダへ貼り付ける", async () => {
    const copyEntry = vi.spyOn(api, "copyEntry").mockResolvedValue({} as api.DocInfo);
    const { actions, dropdown, ports } = fixture();
    actions.showContextMenu(0, 0, { relPath: "memo.txt", isDir: false });
    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "コピー")!.click();
    actions.showContextMenu(0, 0, { relPath: "docs", isDir: true });

    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "貼り付け")!.click();

    await vi.waitFor(() => expect(copyEntry).toHaveBeenCalledWith("memo.txt", "docs"));
    await vi.waitFor(() => expect(ports.sidebar.refreshFolderEntries).toHaveBeenCalled());
  });

  // Feature: ファイルツリーの切り取りと貼り付け
  // Scenario: 切り取ったファイルを選択フォルダへ移動する
  // Given: memo.txtを切り取り、docsフォルダのメニューを表示している
  // When: 「貼り付け」を選ぶ
  // Then: 移動APIへ元パスとdocsを渡し、貼り付け後は切り取り状態を解除する
  it("Scenario: 切り取ったファイルを選択フォルダへ移動する", async () => {
    const moveEntry = vi.spyOn(api, "moveEntry").mockResolvedValue({} as api.DocInfo);
    const { actions, dropdown, ports } = fixture();
    actions.showContextMenu(0, 0, { relPath: "memo.txt", isDir: false });
    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "切り取り")!.click();
    actions.showContextMenu(0, 0, { relPath: "docs", isDir: true });

    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "貼り付け")!.click();

    await vi.waitFor(() => expect(moveEntry).toHaveBeenCalledWith("memo.txt", "docs"));
    await vi.waitFor(() => expect(ports.sidebar.refreshFolderEntries).toHaveBeenCalled());
    actions.showContextMenu(0, 0, { relPath: "docs", isDir: true });
    expect([...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .some((item) => item.textContent === "貼り付け")).toBe(false);
  });

  // Feature: ファイルツリーのルート貼り付け
  // Scenario: 切り取った子ファイルをワークスペース直下へ移動する
  // Given: `folderA/fileA`を切り取り、選択状態がファイルのまま残っている
  // When: ワークスペースルートでCtrl+V相当の貼り付けを実行する
  // Then: 空の相対パスを移動先として移動APIを呼ぶ
  it("Scenario: 切り取った子ファイルをワークスペース直下へ移動する", async () => {
    const moveEntry = vi.spyOn(api, "moveEntry").mockResolvedValue({} as api.DocInfo);
    const { actions, dropdown, ports } = fixture();
    const source = { relPath: "folderA/fileA", isDir: false };
    actions.showContextMenu(0, 0, source);
    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "切り取り")!.click();

    actions.executeCommand("paste", [source]);

    await vi.waitFor(() => expect(moveEntry).toHaveBeenCalledWith("folderA/fileA", ""));
    await vi.waitFor(() => expect(ports.sidebar.refreshFolderEntries).toHaveBeenCalled());
  });

  // Feature: 貼り付け時の同名競合
  // Scenario: 自動リネームを選ぶと空いている連番名へ貼り付ける
  // Given: `memo.txt`のコピー先に同名項目がある
  // When: 競合ダイアログで「自動で名前を変更」を選ぶ
  // Then: `memo (1).txt`を指定したコピーAPIを呼ぶ
  it("Scenario: 貼り付けの同名競合を自動リネームで解決する", async () => {
    const copyEntry = vi.spyOn(api, "copyEntry")
      .mockRejectedValueOnce(new Error("コピー先に同名のファイルまたはフォルダがあります"));
    const copyEntryAs = vi.spyOn(api, "copyEntryAs").mockResolvedValue({} as api.DocInfo);
    vi.spyOn(api, "listFolderEntries").mockResolvedValue([
      { name: "memo.txt", is_dir: false, is_archive: false },
    ]);
    vi.mocked(promptFields).mockResolvedValueOnce(["rename", "one"]);
    const { actions, dropdown } = fixture();
    actions.showContextMenu(0, 0, { relPath: "memo.txt", isDir: false });
    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "コピー")!.click();
    actions.showContextMenu(0, 0, { relPath: "docs", isDir: true });
    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "貼り付け")!.click();

    await vi.waitFor(() => expect(copyEntry).toHaveBeenCalledWith("memo.txt", "docs"));
    await vi.waitFor(() => expect(copyEntryAs).toHaveBeenCalledWith(
      "memo.txt",
      "docs",
      "memo (1).txt",
      false,
    ));
  });

  // Feature: 貼り付け時の同名競合
  // Scenario: 置き換えた項目をセッション内Undoで元に戻す
  // Given: `memo.txt`のコピー先に同名項目がある
  // When: 競合ダイアログで「置き換える」を選び、Undoする
  // Then: 置換先の新しい項目を消して、元の項目を復元する
  it("Scenario: 貼り付けの置換をUndoで元に戻す", async () => {
    const copyEntry = vi.spyOn(api, "copyEntry")
      .mockRejectedValueOnce(new Error("コピー先に同名のファイルまたはフォルダがあります"));
    const copyEntryAs = vi.spyOn(api, "copyEntryAs").mockResolvedValue({} as api.DocInfo);
    const deleteEntryWithoutBackup = vi.spyOn(api, "deleteEntryWithoutBackup").mockResolvedValue({} as api.DocInfo);
    const restoreDeletedEntry = vi.spyOn(api, "restoreDeletedEntry").mockResolvedValue({} as api.DocInfo);
    vi.mocked(promptFields).mockResolvedValueOnce(["replace", "one"]);
    const { actions, dropdown } = fixture();
    actions.showContextMenu(0, 0, { relPath: "memo.txt", isDir: false });
    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "コピー")!.click();
    actions.showContextMenu(0, 0, { relPath: "docs", isDir: true });
    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "貼り付け")!.click();

    await vi.waitFor(() => expect(copyEntry).toHaveBeenCalledWith("memo.txt", "docs"));
    await vi.waitFor(() => expect(copyEntryAs).toHaveBeenCalledWith("memo.txt", "docs", "memo.txt", true));

    actions.executeCommand("undo", []);
    await vi.waitFor(() => expect(deleteEntryWithoutBackup).toHaveBeenCalledWith("docs/memo.txt"));
    await vi.waitFor(() => expect(restoreDeletedEntry).toHaveBeenCalledWith("docs/memo.txt"));
  });

  // Feature: 開いている文書を置き換える貼り付け
  // Scenario: 置換先を開いている状態で貼り付けとUndoを行う
  // Given: `docs/memo.txt`を開いており、コピー先に同名項目がある
  // When: 置き換えを実行してからUndoする
  // Then: 置換後と復元後の両方で文書セッションを同じパスへ再接続する
  it("Scenario: 開いている置換先を貼り付け後もUndo後も再接続する", async () => {
    const copyEntry = vi.spyOn(api, "copyEntry")
      .mockRejectedValueOnce(new Error("コピー先に同名のファイルまたはフォルダがあります"));
    const copiedInfo = { path: "C:\\work", folder_root: "C:\\work" } as api.DocInfo;
    vi.spyOn(api, "copyEntryAs").mockResolvedValue(copiedInfo);
    const deleteEntryWithoutBackup = vi.spyOn(api, "deleteEntryWithoutBackup").mockResolvedValue(copiedInfo);
    const restoreDeletedEntry = vi.spyOn(api, "restoreDeletedEntry").mockResolvedValue(copiedInfo);
    const selectEntry = vi.spyOn(api, "selectEntry").mockResolvedValue(copiedInfo);
    vi.mocked(promptFields).mockResolvedValueOnce(["replace", "one"]);
    const { actions, doc } = fixture();
    doc.current.selectedRelPath = "docs/memo.txt";

    const result = await actions.dropEntries({
      sourceRelPaths: ["memo.txt"],
      targetRelDir: "docs",
      mode: "copy",
    });

    expect(result.undoable).toBe(true);
    await vi.waitFor(() => expect(selectEntry).toHaveBeenCalledWith("docs/memo.txt"));
    expect(doc.applyDocInfo).toHaveBeenCalledWith(copiedInfo, true);

    actions.executeCommand("undo", []);
    await vi.waitFor(() => expect(deleteEntryWithoutBackup).toHaveBeenCalledWith("docs/memo.txt"));
    await vi.waitFor(() => expect(restoreDeletedEntry).toHaveBeenCalledWith("docs/memo.txt"));
    await vi.waitFor(() => expect(selectEntry).toHaveBeenCalledTimes(2));
    expect(selectEntry).toHaveBeenLastCalledWith("docs/memo.txt");
    expect(copyEntry).toHaveBeenCalledWith("memo.txt", "docs");
  });

  // Feature: 貼り付け時の同名競合
  // Scenario: スキップを全項目へ適用する
  // Given: 2つのコピー元で同名競合が起きる
  // When: 競合ダイアログで「スキップ」と「以後すべて」を選ぶ
  // Then: 2項目とも上書きせず、コピー先APIを再試行しない
  it("Scenario: 貼り付けのスキップを全項目へ適用する", async () => {
    const copyEntry = vi.spyOn(api, "copyEntry")
      .mockRejectedValue(new Error("コピー先に同名のファイルまたはフォルダがあります"));
    const copyEntryAs = vi.spyOn(api, "copyEntryAs").mockResolvedValue({} as api.DocInfo);
    vi.mocked(promptFields).mockResolvedValueOnce(["skip", "all"]);
    const { actions, dropdown } = fixture();
    const first = { relPath: "memo.txt", isDir: false };
    const second = { relPath: "note.txt", isDir: false };
    actions.showContextMenu(0, 0, first, [first, second]);
    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "コピー")!.click();
    actions.showContextMenu(0, 0, { relPath: "docs", isDir: true });
    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "貼り付け")!.click();

    await vi.waitFor(() => expect(copyEntry).toHaveBeenCalledTimes(2));
    expect(copyEntryAs).not.toHaveBeenCalled();
    expect(promptFields).toHaveBeenCalledOnce();
  });

  // Feature: 貼り付け時の同名競合
  // Scenario: キャンセルを選んだ時点で処理を止める
  // Given: 2つのコピー元があり、先頭で同名競合が起きる
  // When: 競合ダイアログで「キャンセル」を選ぶ
  // Then: 先頭項目以外へ貼り付けを進めない
  it("Scenario: 貼り付けのキャンセルで残りの項目を処理しない", async () => {
    const copyEntry = vi.spyOn(api, "copyEntry")
      .mockRejectedValue(new Error("コピー先に同名のファイルまたはフォルダがあります"));
    const { actions, dropdown } = fixture();
    vi.mocked(promptFields).mockResolvedValueOnce(["cancel", "one"]);
    const first = { relPath: "memo.txt", isDir: false };
    const second = { relPath: "note.txt", isDir: false };
    actions.showContextMenu(0, 0, first, [first, second]);
    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "コピー")!.click();
    actions.showContextMenu(0, 0, { relPath: "docs", isDir: true });
    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "貼り付け")!.click();

    await vi.waitFor(() => expect(promptFields).toHaveBeenCalledOnce());
    expect(copyEntry).toHaveBeenCalledOnce();
    expect(copyEntry).toHaveBeenCalledWith("memo.txt", "docs");
  });

  // Feature: ファイルツリーのD&D競合処理
  // Scenario: D&Dの同名競合でスキップを全項目へ適用する
  // Given: 2項目をdocsへ移動し、移動先に同名項目がある
  // When: 「スキップ」と「以後すべて」を選ぶ
  // Then: 2項目を順に確認し、後続項目の処理も継続する
  it("Scenario: D&Dの同名競合を全項目スキップできる", async () => {
    const moveEntry = vi.spyOn(api, "moveEntry")
      .mockRejectedValue(new Error("移動先に同名のファイルまたはフォルダがあります"));
    const moveEntryAs = vi.spyOn(api, "moveEntryAs").mockResolvedValue({} as api.DocInfo);
    vi.mocked(promptFields).mockResolvedValueOnce(["skip", "all"]);
    const { actions, ports } = fixture();

    const result = await actions.dropEntries({
      sourceRelPaths: ["memo.txt", "note.txt"],
      targetRelDir: "docs",
      mode: "move",
    });

    expect(result.undoable).toBe(false);
    expect(moveEntry).toHaveBeenCalledTimes(2);
    expect(moveEntryAs).not.toHaveBeenCalled();
    expect(promptFields).toHaveBeenCalledOnce();
    expect(ports.sidebar.refreshFolderEntries).toHaveBeenCalledOnce();
  });

  // Feature: ファイルツリーのD&D一括処理
  // Scenario: 1項目の失敗後も残りの項目を処理する
  // Given: 先頭項目の移動は成功し、次の項目は別のエラーになる
  // When: 2項目を同じフォルダへD&Dする
  // Then: 成功した項目を履歴対象にし、一覧更新まで完了する
  it("Scenario: D&Dは途中の非競合エラー後も後続項目を処理する", async () => {
    const moveEntry = vi.spyOn(api, "moveEntry")
      .mockResolvedValueOnce({} as api.DocInfo)
      .mockRejectedValueOnce(new Error("アクセスできません"));
    const { actions, ports } = fixture();

    const result = await actions.dropEntries({
      sourceRelPaths: ["memo.txt", "note.txt"],
      targetRelDir: "docs",
      mode: "move",
    });

    expect(result.undoable).toBe(true);
    expect(moveEntry).toHaveBeenNthCalledWith(1, "memo.txt", "docs");
    expect(moveEntry).toHaveBeenNthCalledWith(2, "note.txt", "docs");
    expect(ports.sidebar.refreshFolderEntries).toHaveBeenCalledOnce();
  });

  // Feature: ファイルツリーのD&Dアンドゥ
  // Scenario: D&D直後のUndoで移動を元に戻す
  // Given: memo.txtをdocsへ移動した
  // When: 直後にD&D専用Undoを実行する
  // Then: docs/memo.txtを元の親へ戻す
  it("Scenario: D&D直後のUndoで移動を元に戻せる", async () => {
    const moveEntry = vi.spyOn(api, "moveEntry").mockResolvedValue({} as api.DocInfo);
    const moveEntryAs = vi.spyOn(api, "moveEntryAs").mockResolvedValue({} as api.DocInfo);
    const { actions } = fixture();

    const result = await actions.dropEntries({
      sourceRelPaths: ["memo.txt"],
      targetRelDir: "docs",
      mode: "move",
    });
    const undone = await actions.undoLastDrop();

    expect(result.undoable).toBe(true);
    expect(undone).toBe(true);
    expect(moveEntry).toHaveBeenCalledWith("memo.txt", "docs");
    expect(moveEntryAs).toHaveBeenCalledWith("docs/memo.txt", "", "memo.txt");
  });

  // Feature: ファイル操作のセッション内アンドゥ
  // Scenario: コピー貼り付けをCtrl+Zで元に戻す
  // Given: `memo.txt`を`docs`へコピー貼り付け済み
  // When: undoコマンドを実行する
  // Then: コピー先を削除するAPIを呼ぶ
  it("Scenario: コピー貼り付けをセッション内で元に戻せる", async () => {
    const copyEntry = vi.spyOn(api, "copyEntry").mockResolvedValue({} as api.DocInfo);
    const deleteEntryWithoutBackup = vi.spyOn(api, "deleteEntryWithoutBackup").mockResolvedValue({} as api.DocInfo);
    const { actions, dropdown, ports } = fixture();
    actions.showContextMenu(0, 0, { relPath: "memo.txt", isDir: false });
    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "コピー")!.click();
    actions.showContextMenu(0, 0, { relPath: "docs", isDir: true });
    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "貼り付け")!.click();
    await vi.waitFor(() => expect(copyEntry).toHaveBeenCalledWith("memo.txt", "docs"));
    await vi.waitFor(() => expect(ports.sidebar.refreshFolderEntries).toHaveBeenCalled());

    actions.executeCommand("undo", []);
    await vi.waitFor(() => expect(deleteEntryWithoutBackup).toHaveBeenCalledWith("docs/memo.txt"));
  });

  // Given: rootが`C:\\work`、対象が`docs`フォルダ
  // When: フォルダの右クリックメニューから「フォルダを全展開」を選ぶ
  // Then: 対象の相対パスでフォルダ全展開を依頼する
  it("Scenario: フォルダメニューから対象フォルダを全展開する", () => {
    const { actions, dropdown, expandAllFolder } = fixture();
    actions.showContextMenu(0, 0, { relPath: "docs", isDir: true });

    const item = [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((element) => element.textContent === "フォルダを全展開");
    expect(item?.textContent).toBe("フォルダを全展開");
    expect(item?.querySelector(`.${MENU_ICON.expandFolder}`)).not.toBeNull();
    expect(item?.previousElementSibling?.classList.contains("dd-sep")).toBe(true);
    if (!item) return;
    item.click();

    expect(expandAllFolder).toHaveBeenCalledWith("docs");
  });

  // Given: フォルダ全展開の取得が`expand failed`でrejectする
  // When: フォルダの右クリックメニューから「フォルダを全展開」をクリックする
  // Then: フォルダ操作の失敗として`showError`へ通知する
  it("Scenario: フォルダ全展開の失敗を表示する", async () => {
    const error = new Error("expand failed");
    const { actions, dropdown, expandAllFolder } = fixture();
    expandAllFolder.mockRejectedValueOnce(error);
    actions.showContextMenu(0, 0, { relPath: "docs", isDir: true });

    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "フォルダを全展開")!.click();

    await vi.waitFor(() => expect(showError).toHaveBeenCalledWith(
      "フォルダを全展開できませんでした",
      error,
    ));
  });

  // Feature: フォルダ右クリックからの新規フォルダ作成
  // Scenario: 右クリックしたフォルダの配下へ新規フォルダを作る
  // Given: `docs`フォルダを対象にし、フォルダ名入力が`notes`を返す
  // When: フォルダメニューの「新規フォルダ」をクリックする
  // Then: `docs`を作成先としてAPIへ渡す
  it("Scenario: フォルダメニューから対象フォルダ配下へ新規フォルダを作成する", async () => {
    const { actions, dropdown, ports } = fixture();
    vi.mocked(promptFields).mockResolvedValueOnce(["notes"]);
    const createFolder = vi.spyOn(api, "createFolder").mockResolvedValueOnce();
    actions.showContextMenu(0, 0, { relPath: "docs", isDir: true });

    const item = [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((element) => element.textContent === "新規フォルダ");
    expect(item?.querySelector(`.${MENU_ICON.newFolder}`)).not.toBeNull();
    item!.click();

    await vi.waitFor(() => expect(createFolder).toHaveBeenCalledWith("docs", "notes"));
    expect(ports.sidebar.refreshFolderEntries).toHaveBeenCalledOnce();
  });

  // Feature: ファイルツリー操作のセッション内アンドゥ
  // Scenario: 新規フォルダの作成をUndo/Redoする
  // Given: docs配下にnotesフォルダを作成している
  // When: ファイル操作のUndoとRedoを実行する
  // Then: 作成した相対パスを削除・再作成する
  it("Scenario: 新規フォルダの作成をUndoとRedoで戻せる", async () => {
    const createFolder = vi.spyOn(api, "createFolder").mockResolvedValue();
    const deleteEntryWithoutBackup = vi.spyOn(api, "deleteEntryWithoutBackup").mockResolvedValue({} as api.DocInfo);
    vi.mocked(promptFields).mockResolvedValueOnce(["notes"]);
    const { actions, ports } = fixture();

    await actions.createFolder("docs");
    actions.executeCommand("undo", []);
    await vi.waitFor(() => expect(deleteEntryWithoutBackup).toHaveBeenCalledWith("docs/notes"));
    await vi.waitFor(() => expect(ports.sidebar.refreshFolderEntries).toHaveBeenCalled());

    actions.executeCommand("redo", []);
    await vi.waitFor(() => expect(createFolder).toHaveBeenCalledTimes(2));
    expect(createFolder).toHaveBeenLastCalledWith("docs", "notes");
  });

  // Given: ファイル、フォルダ、空白部の右クリックメニューを表示する
  // When: 各メニューの表示項目を調べる
  // Then: すべての項目にメニューアイコンが付いている
  it("Scenario: 右クリックメニューの全項目にアイコンを表示する", () => {
    const { actions, dropdown } = fixture();
    for (const target of [
      { relPath: "memo.txt", isDir: false },
      { relPath: "docs", isDir: true },
      null,
    ] as const) {
      actions.showContextMenu(0, 0, target);
      const missing = [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
        .filter((item) => !item.querySelector(".menu-icon, .fav-icon"))
        .map((item) => item.textContent);
      expect(missing, target?.relPath ?? "空白部").toEqual([]);
    }
  });

  // Given: CSV/Markdown/Image/PDF/HTMLのファイルを対象にする
  // When: ファイルツリーのコンテキストメニューを表示する
  // Then: プレビュー形式の項目は表示しない
  it("Scenario: ファイルツリーの右クリックメニューからプレビュー項目を除く", () => {
    const { actions, dropdown } = fixture();
    for (const relPath of ["table.csv", "notes.md", "photo.png", "manual.pdf", "index.html"]) {
      actions.showContextMenu(0, 0, { relPath, isDir: false });
      expect([...dropdown.querySelectorAll(".dd-label")].map((label) => label.textContent))
        .not.toEqual(expect.arrayContaining([
          "CSVビュー", "Markdownビュー", "Imageビュー", "PDFビュー", "html(静的)",
        ]));
    }
  });

  // Given: rootが`C:\work`で対象がない
  // When: フォルダ空白部のコンテキストメニューを表示する
  // Then: Explorerが先頭にあり、新規メモ・全展開・お気に入り追加が残る
  it("Scenario: 対象なしのフォルダメニューでもExplorerを先頭にする", async () => {
    const reveal = vi.spyOn(api, "revealInExplorer").mockResolvedValue();
    try {
      const { actions, dropdown, expandAllFolder } = fixture();
      actions.showContextMenu(0, 0, null);

      expect([...dropdown.querySelectorAll(".dd-label")].map((label) => label.textContent)).toEqual([
        "エクスプローラで開く",
        "新規メモ作成...",
        "フォルダを全展開",
        "お気に入りに追加",
      ]);
      expect(dropdown.querySelectorAll(".dd-sep")).toHaveLength(2);
      for (const [label, icon] of [
        ["エクスプローラで開く", MENU_ICON.explorer],
        ["新規メモ作成...", MENU_ICON.newMemo],
        ["フォルダを全展開", MENU_ICON.expandFolder],
        ["お気に入りに追加", MENU_ICON.favorite],
      ] as const) {
        const item = [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
          .find((element) => element.textContent === label);
        expect(item?.querySelector(`.${icon}`), label).not.toBeNull();
      }
      dropdown.querySelector<HTMLElement>(".dd-item:first-child")!.click();

      await vi.waitFor(() => expect(reveal).toHaveBeenCalledWith("C:\\work", true));
      actions.showContextMenu(0, 0, null);
      [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
        .find((item) => item.textContent === "フォルダを全展開")!.click();
      expect(expandAllFolder).toHaveBeenCalledWith("");
    } finally {
      reveal.mockRestore();
    }
  });

  // Given: `.html`用Chromeコマンドを登録済み
  // When: `index.html`の登録コマンドを開いて実行
  // Then: trailingが`⚙,×`、絶対パス入りコマンドを実行
  it("Scenario: 拡張子別の登録コマンドを表示して実行できる", async () => {
    addRegisteredCommand({ extension: ".html", label: "Chrome", prefix: "cmd.exe /D /C", command: "chrome {file}" });
    const { actions, dropdown } = fixture();
    actions.showContextMenu(0, 0, { relPath: "index.html", isDir: false });

    const registered = [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "登録コマンド ▸");
    registered!.click();
    const commandItem = dropdown.querySelector<HTMLElement>(".dd-submenu .dd-item")!;
    expect([...commandItem.querySelectorAll<HTMLButtonElement>(".dd-trailing")].map((button) => button.textContent))
      .toEqual(["⚙", "×"]);
    commandItem.click();

    await vi.waitFor(() => expect(api.runExternalCommand).toHaveBeenCalledWith(
      "cmd.exe /D /C chrome C:\\work\\index.html",
      "C:\\work\\index.html",
    ));
  });

  // Given: `.html`用コマンド実行が`command failed`でreject
  // When: 登録コマンドをクリック
  // Then: `showError("登録コマンドを実行できませんでした", Error)`
  it("Scenario: 登録コマンドの実行失敗を表示する", async () => {
    addRegisteredCommand({ extension: ".html", label: "Chrome", prefix: "", command: "chrome {file}" });
    vi.mocked(api.runExternalCommand).mockRejectedValueOnce(new Error("command failed"));
    const { actions, dropdown } = fixture();
    actions.showContextMenu(0, 0, { relPath: "index.html", isDir: false });

    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "登録コマンド ▸")!.click();
    dropdown.querySelector<HTMLElement>(".dd-submenu .dd-item")!.click();

    await vi.waitFor(() => expect(showError).toHaveBeenCalledWith(
      "登録コマンドを実行できませんでした",
      expect.any(Error),
    ));
  });

  // Given: promptが表示名`Chrome`と統合済みのコマンド`chrome {file}`を返す
  // When: `index.HTML`でコマンド登録
  // Then: 拡張子`.html`で登録し、表示名とコマンドの2項目を表示する
  it("Scenario: 登録時は選択ファイルの拡張子をコマンドへ紐付ける", async () => {
    vi.mocked(promptFields).mockResolvedValueOnce(["Chrome", "chrome {file}"]);
    const { actions, dropdown } = fixture();
    actions.showContextMenu(0, 0, { relPath: "index.HTML", isDir: false });

    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "コマンドを登録...")!.click();

    expect(vi.mocked(promptFields).mock.calls[0][1].map((field) => field.label)).toEqual([
      "表示名（.html用）",
      "コマンド（{file}=対象ファイル、引用符不要）",
    ]);

    await vi.waitFor(() => expect(commandsForPath("index.html")).toEqual([
      { extension: ".html", label: "Chrome", prefix: "", command: "chrome {file}" },
    ]));
  });

  // Given: Chromeコマンドを登録済み
  // When: gearで更新後、再表示して×で削除
  // Then: Chrome Devの内容へ更新後、一覧が空になる
  it("Scenario: 登録コマンドを歯車から編集し、×から削除できる", async () => {
    addRegisteredCommand({ extension: ".html", label: "Chrome", prefix: "", command: "chrome {file}" });
    const { actions, dropdown } = fixture();
    actions.showContextMenu(0, 0, { relPath: "index.html", isDir: false });
    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "登録コマンド ▸")!.click();

    vi.mocked(promptFields).mockResolvedValueOnce(["Chrome Dev", "cmd.exe /D /C chrome --incognito {file}"]);
    dropdown.querySelectorAll<HTMLButtonElement>(".dd-submenu .dd-trailing")[0].click();
    await vi.waitFor(() => expect(commandsForPath("index.html")).toEqual([
      { extension: ".html", label: "Chrome Dev", prefix: "", command: "cmd.exe /D /C chrome --incognito {file}" },
    ]));

    actions.showContextMenu(0, 0, { relPath: "index.html", isDir: false });
    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "登録コマンド ▸")!.click();
    dropdown.querySelectorAll<HTMLButtonElement>(".dd-submenu .dd-trailing")[1].click();
    expect(commandsForPath("index.html")).toEqual([]);
  });

  // Given: Explorer起動spy、対象`memo.txt`
  // When: Explorer項目をクリック
  // Then: `revealInExplorer("C:\\work\\memo.txt",false)`
  it("Scenario: ファイルのExplorerメニューはその絶対パスを渡す", async () => {
    const reveal = vi.spyOn(api, "revealInExplorer").mockResolvedValue();
    try {
      const { actions, dropdown } = fixture();
      actions.showContextMenu(0, 0, { relPath: "memo.txt", isDir: false });
      [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
        .find((item) => item.textContent === "エクスプローラで開く")?.click();

      await vi.waitFor(() => expect(reveal).toHaveBeenCalledWith("C:\\work\\memo.txt", false));
    } finally {
      reveal.mockRestore();
    }
  });

  // Given: Explorer起動が`explorer failed`でreject
  // When: Explorer項目をクリック
  // Then: `showError("エクスプローラで開けませんでした", Error)`
  it("Scenario: Explorer起動失敗をフォルダ操作の文脈で表示する", async () => {
    const reveal = vi.spyOn(api, "revealInExplorer").mockRejectedValueOnce(new Error("explorer failed"));
    try {
      const { actions, dropdown } = fixture();
      actions.showContextMenu(0, 0, { relPath: "memo.txt", isDir: false });
      [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
        .find((item) => item.textContent === "エクスプローラで開く")!.click();

      await vi.waitFor(() => expect(showError).toHaveBeenCalledWith(
        "エクスプローラで開けませんでした",
        expect.any(Error),
      ));
    } finally {
      reveal.mockRestore();
    }
  });

  // Given: 対象拡張子がPNG、webp、md
  // When: `isImagePath`を呼ぶ
  // Then: PNG/webpはtrue、mdはfalse
  it("Scenario: 画像ファイルの拡張子を大文字小文字に関係なく判定する", () => {
    expect(isImagePath("picture.PNG")).toBe(true);
    expect(isImagePath("picture.webp")).toBe(true);
    expect(isImagePath("memo.md")).toBe(false);
  });

  // Given: 対象が`memo.txt`、delete APIは成功
  // When: その他→削除をクリック
  // Then: `deleteEntry("memo.txt")`、確認文言表示、選択解除、展開状態を壊さない更新
  it("Scenario: 削除はその他サブメニューを経由する", async () => {
    const { actions, dropdown, ports, doc } = fixture();
    doc.current.selectedRelPath = "memo.txt";
    vi.spyOn(api, "deleteEntry").mockResolvedValueOnce({} as api.DocInfo);
    actions.showContextMenu(0, 0, { relPath: "memo.txt", isDir: false });

    const other = [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent?.includes("その他"));
    other!.click();
    expect(dropdown.querySelector<HTMLElement>(".dd-submenu .dd-item")?.textContent).toBe("削除");
    expect(dropdown.querySelector<HTMLElement>(`.dd-submenu .${MENU_ICON.delete}`)).not.toBeNull();
    dropdown.querySelector<HTMLElement>(".dd-submenu .dd-item")!.click();
    await vi.waitFor(() => expect(api.deleteEntry).toHaveBeenCalledWith("memo.txt"));

    expect(confirmMessage).toHaveBeenCalledWith(
      "削除",
      "「memo.txt」ファイルをごみ箱へ移動します。元に戻せます。",
      "削除",
    );
    expect(doc.markDeleted).toHaveBeenCalledOnce();
    expect(ports.sidebar.refreshFolderEntries).toHaveBeenCalled();
  });

  // Feature: ファイルツリーの複数選択削除
  // Scenario: 選択中の複数項目をコンテキストメニューから削除する
  // Given: memo.txt と notes.txt を選択している
  // When: その他→削除をクリックする
  // Then: 選択した2項目を確認後に削除する
  it("Scenario: コンテキストメニューの削除は複数選択へ適用する", async () => {
    const deleteEntry = vi.spyOn(api, "deleteEntry").mockResolvedValue({} as api.DocInfo);
    const { actions, dropdown } = fixture();
    actions.showContextMenu(
      0,
      0,
      { relPath: "memo.txt", isDir: false },
      [
        { relPath: "memo.txt", isDir: false },
        { relPath: "notes.txt", isDir: false },
      ],
    );

    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent?.includes("その他"))!.click();
    dropdown.querySelector<HTMLElement>(".dd-submenu .dd-item")!.click();

    await vi.waitFor(() => expect(deleteEntry).toHaveBeenCalledTimes(2));
    expect(confirmMessage).toHaveBeenCalledWith(
      "削除",
      "2項目をごみ箱へ移動します。元に戻せます。",
      "削除",
    );
  });

  // Feature: 削除のセッション内アンドゥ/リドゥ
  // Scenario: 削除をCtrl+Zで戻し、Ctrl+Yで再実行する
  // Given: 選択中の`memo.txt`を削除済み
  // When: undoとredoを順に実行する
  // Then: 復元APIと削除APIを順に呼ぶ
  it("Scenario: 削除をセッション内で元に戻してやり直せる", async () => {
    const deleteEntry = vi.spyOn(api, "deleteEntry").mockResolvedValue({} as api.DocInfo);
    const restoreDeletedEntry = vi.spyOn(api, "restoreDeletedEntry").mockResolvedValue({} as api.DocInfo);
    const { actions, dropdown, doc, ports } = fixture();
    doc.current.selectedRelPath = "memo.txt";
    doc.markDeleted.mockImplementation(() => { doc.current.selectedRelPath = ""; });
    const deleteCallsBefore = deleteEntry.mock.calls.length;
    actions.showContextMenu(0, 0, { relPath: "memo.txt", isDir: false });
    const other = [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent?.includes("その他"));
    other!.click();
    dropdown.querySelector<HTMLElement>(".dd-submenu .dd-item")!.click();
    await vi.waitFor(() => expect(deleteEntry).toHaveBeenCalledWith("memo.txt"));
    await vi.waitFor(() => expect(ports.sidebar.refreshFolderEntries).toHaveBeenCalledOnce());

    actions.executeCommand("undo", []);
    await vi.waitFor(() => expect(restoreDeletedEntry).toHaveBeenCalledWith("memo.txt"));
    expect(doc.markRestored).toHaveBeenCalledWith("memo.txt", "C:\\work\\memo.txt");
    await vi.waitFor(() => expect(ports.sidebar.refreshFolderEntries).toHaveBeenCalledTimes(2));

    actions.executeCommand("redo", []);
    await vi.waitFor(() => expect(deleteEntry).toHaveBeenCalledTimes(deleteCallsBefore + 2));
  });

  // Given: createNoteは成功、一覧更新だけ`refresh failed`でreject
  // When: `createNote(null)`
  // Then: 作成APIは呼ばれ、作成失敗ではなく一覧更新失敗を通知
  it("Scenario: 作成成功後の一覧更新失敗を作成失敗として表示しない", async () => {
    const { actions, doc, ports } = fixture();
    const docInfo = {
      kind: "text",
      line_count: 1,
      enc: "utf8",
      eol: "crlf",
      path: "C:\\work\\memo.txt",
      entries: null,
      folder_entries: [],
      folder_root: "C:\\work",
      view_only: false,
      is_binary: false,
      byte_len: 0,
      is_huge: false,
      modified_at: null,
    } satisfies api.DocInfo;
    doc.promptMemoSpec.mockResolvedValueOnce({
      memo: { stem: "memo", extension: "txt" },
      format: { encoding: "utf8", eol: "crlf" },
    });
    vi.spyOn(api, "createNote").mockResolvedValueOnce(docInfo);
    ports.sidebar.refreshFolderEntries.mockRejectedValueOnce(new Error("refresh failed"));

    await actions.createNote(null);

    expect(api.createNote).toHaveBeenCalled();
    expect(showError).toHaveBeenCalledWith(
      "メモは作成されましたが一覧を更新できませんでした",
      expect.any(Error),
    );
  });

  // Feature: ファイルツリーからの新規フォルダ作成
  // Scenario: 入力した名前で指定ディレクトリ直下にフォルダを作成して一覧を更新する
  // Given: C:\workを開き、フォルダ名入力がnotesを返す
  // When: createFolderを実行する
  // Then: notesの作成APIを呼び、フォルダ一覧を更新する
  it("Scenario: 新規フォルダを作成してツリーを更新する", async () => {
    const { actions, ports } = fixture();
    vi.mocked(promptFields).mockResolvedValueOnce(["notes"]);
    const createFolder = vi.spyOn(api, "createFolder").mockResolvedValueOnce(undefined);

    await actions.createFolder("docs");

    expect(createFolder).toHaveBeenCalledWith("docs", "notes");
    expect(ports.sidebar.refreshFolderEntries).toHaveBeenCalledOnce();
  });

  // Feature: 新規メモ名ダイアログのエラー境界
  // Scenario: 初期候補の取得に失敗しても作成APIを呼ばない
  // Given: promptMemoSpecがError("candidate failed")でrejectする
  // When: ルート直下で`createNote(null)`を実行する
  // Then: 新規メモ作成失敗を通知し、ファイル作成へ進まない
  it("Scenario: 新規メモの候補取得失敗を通知する", async () => {
    const { actions, doc } = fixture();
    const error = new Error("candidate failed");
    const createNote = vi.spyOn(api, "createNote").mockClear();
    doc.promptMemoSpec.mockRejectedValueOnce(error);

    await actions.createNote(null);

    expect(showError).toHaveBeenCalledWith("新規メモを作成できませんでした", error);
    expect(createNote).not.toHaveBeenCalled();
  });

  // Feature: フォルダ内の新規メモ採番
  // Scenario: 入力名が重複すると作成後の実パスを選択する
  // Given: 入力名が`memo`、作成APIが`memo1.txt`を返す
  // When: ルート直下で`createNote(null)`を実行する
  // Then: `memo.txt`を作成APIへ渡し、作成後は`memo1.txt`を選択する
  it("Scenario: 同名メモの作成後は採番された実パスを選択する", async () => {
    const { actions, doc } = fixture();
    const docInfo = {
      kind: "text",
      line_count: 1,
      enc: "utf8",
      eol: "crlf",
      path: "C:\\work\\memo1.txt",
      entries: null,
      folder_entries: [],
      folder_root: "C:\\work",
      view_only: false,
      is_binary: false,
      byte_len: 0,
      is_huge: false,
      modified_at: null,
    } satisfies api.DocInfo;
    doc.promptMemoSpec.mockResolvedValueOnce({
      memo: { stem: "memo", extension: "txt" },
      format: { encoding: "sjis", eol: "lf" },
    });
    vi.spyOn(api, "createNote").mockResolvedValueOnce(docInfo);

    await actions.createNote(null);

    expect(doc.promptMemoSpec).toHaveBeenCalledWith("C:\\work");
    expect(api.createNote).toHaveBeenCalledWith(null, "memo.txt", "sjis", "lf");
    expect(doc.setSelectedRelPath).toHaveBeenCalledWith("memo1.txt");
  });

  // Feature: ファイルツリー操作のセッション内アンドゥ
  // Scenario: 新規メモの作成をUndo/Redoする
  // Given: memo.txtを作成している
  // When: ファイル操作のUndoとRedoを実行する
  // Then: 作成したファイルを削除・同じ形式で再作成する
  it("Scenario: 新規メモの作成をUndoとRedoで戻せる", async () => {
    const docInfo = {
      kind: "text",
      line_count: 1,
      enc: "sjis",
      eol: "lf",
      path: "C:\\work\\memo.txt",
      entries: null,
      folder_entries: [],
      folder_root: "C:\\work",
      view_only: false,
      is_binary: false,
      byte_len: 0,
      is_huge: false,
      modified_at: null,
    } satisfies api.DocInfo;
    const createNote = vi.spyOn(api, "createNote").mockResolvedValue(docInfo);
    const deleteEntryWithoutBackup = vi.spyOn(api, "deleteEntryWithoutBackup").mockResolvedValue(docInfo);
    vi.mocked(promptFields).mockResolvedValueOnce(null);
    const { actions, doc, ports } = fixture();
    doc.promptMemoSpec.mockResolvedValueOnce({
      memo: { stem: "memo", extension: "txt" },
      format: { encoding: "sjis", eol: "lf" },
    });

    await actions.createNote(null);
    actions.executeCommand("undo", []);
    await vi.waitFor(() => expect(deleteEntryWithoutBackup).toHaveBeenCalledWith("memo.txt"));
    await vi.waitFor(() => expect(ports.sidebar.refreshFolderEntries).toHaveBeenCalled());

    actions.executeCommand("redo", []);
    await vi.waitFor(() => expect(createNote).toHaveBeenCalledTimes(2));
    expect(createNote).toHaveBeenLastCalledWith(null, "memo.txt", "sjis", "lf");
  });

  // Feature: アーカイブ内選択のパス追従
  // Scenario: アーカイブファイルをリネームする
  // Given: data.zip::Sheet1を選択している
  // When: data.zipをrenamed.zipへリネームする
  // Then: アーカイブ内の選択もrenamed.zip::Sheet1へ移す
  it("Scenario: アーカイブファイルのリネームで内部選択を維持する", async () => {
    const info = {
      kind: "archive",
      line_count: 1,
      enc: "utf8",
      eol: "crlf",
      path: "C:\\work\\renamed.zip",
      entries: [],
      folder_entries: [],
      folder_root: "C:\\work",
      view_only: false,
      is_binary: false,
      byte_len: 0,
      is_huge: false,
      modified_at: null,
    } satisfies api.DocInfo;
    vi.spyOn(api, "renameEntry").mockResolvedValue(info);
    const { actions, doc, ports } = fixture();
    doc.current.selectedRelPath = "data.zip::Sheet1";

    await actions.renameEntry("data.zip", "renamed.zip");

    expect(doc.applyRenamed).toHaveBeenCalledWith(info, "renamed.zip::Sheet1");
    expect(ports.sidebar.selectByRelPath).toHaveBeenCalledWith("renamed.zip::Sheet1");
  });
});

// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { TabManager, type StoredTabs, type TabDocumentPort } from "./tabs";
import { initialSession } from "./session";
import { initSettings } from "./settings";
import { addRegisteredCommand, commandsForPath } from "./registered-commands";
import type { RegisteredCommandMenuPorts } from "./registered-command-menu";
import { MENU_ICON } from "./menu-icons";

vi.mock("./api", async (importOriginal) => ({
  ...await importOriginal<typeof import("./api")>(),
  loadSettings: vi.fn(async () => "{}"),
  updateSetting: vi.fn(async () => {}),
}));

const registeredCommandPorts = {
  promptFields: vi.fn(async () => null as string[] | null),
  runExternalCommand: vi.fn(async () => {}),
} satisfies RegisteredCommandMenuPorts;

function fixture() {
  const session = initialSession();
  const doc = {
    current: session,
    confirmDiscard: vi.fn(async (onProceed?: () => void | Promise<void>) => {
      await onProceed?.();
      return true;
    }),
    openPath: vi.fn(async (path: string) => {
      session.savePath = path;
      session.displayPath = path;
      return true;
    }),
    selectEntry: vi.fn(async (relPath: string) => {
      session.selectedRelPath = relPath;
      return true;
    }),
    newFile: vi.fn(async () => {}),
    goTo: vi.fn(),
    captureViewState: vi.fn(() => ({
      anchor: { line: 0, col: 0 },
      caret: { line: 0, col: 0 },
      topLine: 0,
      wrapIntraLinePx: 0,
      scrollLeft: 0,
    })),
    restoreViewState: vi.fn(async () => {}),
    save: vi.fn(async () => true),
  } satisfies TabDocumentPort;
  const host = document.createElement("div");
  return { doc, host };
}

const stored: StoredTabs = {
  tabs: [
    { id: "a", path: "C:\\work\\a.txt", kind: "file", label: "a.txt" },
    { id: "b", path: "C:\\work\\b.txt", kind: "file", label: "b.txt" },
  ],
  activeId: "a",
};

function dragOnto(from: HTMLElement, to: HTMLElement, ratio: number) {
  const rect = { left: 0, top: 0, width: 100, height: 20, right: 100, bottom: 20 };
  to.getBoundingClientRect = () => ({ ...rect, x: 0, y: 0, toJSON: () => "" });
  document.elementFromPoint = () => to;
  const at = (type: string, x: number) =>
    new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: 10 });
  from.dispatchEvent(at("pointerdown", 0));
  window.dispatchEvent(at("pointermove", rect.width * ratio));
  window.dispatchEvent(at("pointerup", rect.width * ratio));
}

describe("Feature: TabManager", () => {
  beforeEach(async () => {
    document.body.replaceChildren(document.createElement("div"));
    await initSettings();
    registeredCommandPorts.promptFields.mockReset();
    registeredCommandPorts.promptFields.mockResolvedValue(null);
    registeredCommandPorts.runExternalCommand.mockReset();
  });

  // Given: activeId=a の stored に C:\work\a.txt と C:\work\b.txt の2タブがある
  // When: manager.init(stored, null, null) を呼ぶ
  // Then: doc.openPath は1回だけ C:\work\a.txt と false を引数に呼ばれる
  it("Scenario: 起動時はactive tabのリンクだけを開く", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    await manager.init(stored, null, null);

    expect(doc.openPath).toHaveBeenCalledTimes(1);
    expect(doc.openPath).toHaveBeenCalledWith("C:\\work\\a.txt", false);
  });

  // Feature: ファイル操作後のタブパス追従
  // Scenario: フォルダを移動すると開いている複数タブのパスをまとめて更新する
  // Given: `docs/memo.txt`のファイルタブと`docs/memo.txt`を選択したフォルダタブがある
  // When: `docs`を`archive`へ移動した通知を受ける
  // Then: 絶対パスとフォルダ内相対パスの両方を追従させる
  it("Scenario: ファイル操作で複数タブのパスを追従させる", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    await manager.init({
      tabs: [
        { id: "a", path: "C:\\work\\docs\\memo.txt", kind: "file", label: "memo.txt" },
        {
          id: "b", path: "C:\\work", kind: "folder", label: "work",
          selectedRelPath: "docs/memo.txt",
        },
      ],
      activeId: "a",
    }, null, null);

    manager.rebasePaths({
      oldAbsolute: "C:\\work\\docs",
      newAbsolute: "C:\\work\\archive",
      oldRelPath: "docs",
      newRelPath: "archive",
    });

    expect(manager.state.tabs[0].path).toBe("C:\\work\\archive\\memo.txt");
    expect(manager.state.tabs[1].selectedRelPath).toBe("archive/memo.txt");
  });

  // Feature: ファイル操作後のアーカイブ内選択追従
  // Scenario: アーカイブファイルを移動すると内部エントリの選択も追従する
  // Given: folder tab が `docs/data.zip::Sheet1` を選択中である
  // When: `docs/data.zip`を`archive/data.zip`へ移動した通知を受ける
  // Then: 選択中の内部エントリも`archive/data.zip::Sheet1`になる
  it("Scenario: アーカイブ内の選択パスもファイル操作に追従する", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    await manager.init({
      tabs: [{
        id: "folder",
        path: "C:\\work",
        kind: "folder",
        label: "work",
        selectedRelPath: "docs/data.zip::Sheet1",
      }],
      activeId: "folder",
    }, null, null);

    manager.rebasePaths({
      oldAbsolute: "C:\\work\\docs\\data.zip",
      newAbsolute: "C:\\work\\archive\\data.zip",
      oldRelPath: "docs/data.zip",
      newRelPath: "archive/data.zip",
    });

    expect(manager.state.tabs[0].selectedRelPath).toBe("archive/data.zip::Sheet1");
  });

  // Given: activeId=folder、folderRoot が C:\work、selectedRelPath が sub\memo.txt、viewState の anchor/caret が各 line 10、topLine が8、scrollLeft が20
  // When: manager.init(folderTabs, null, null) を呼ぶ
  // Then: selectEntry("sub\\memo.txt") の後に完全なviewStateを復元する
  it("Scenario: folder tabは選択中entryを開いてから完全な表示状態を復元する", async () => {
    const { doc, host } = fixture();
    const folderTabs: StoredTabs = {
      tabs: [{
        id: "folder",
        path: "C:\\work",
        kind: "folder",
        label: "work",
        selectedRelPath: "sub\\memo.txt",
        viewState: {
          anchor: { line: 10, col: 1 },
          caret: { line: 10, col: 4 },
          topLine: 8,
          wrapIntraLinePx: 0,
          scrollLeft: 20,
        },
      }],
      activeId: "folder",
    };
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);

    await manager.init(folderTabs, null, null);

    expect(doc.selectEntry).toHaveBeenCalledWith("sub\\memo.txt");
    expect(doc.goTo).not.toHaveBeenCalled();
    expect(doc.restoreViewState).toHaveBeenCalledWith(folderTabs.tabs[0].viewState);
    expect(vi.mocked(doc.selectEntry).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(doc.restoreViewState).mock.invocationCallOrder[0]);
  });

  // Given: folder tab の selectedRelPath が deleted.txt で、selectEntry が Error("missing") を返す
  // When: manager.init(folderTabs, null, null) を呼ぶ
  // Then: 初期化は reject せず、openPath("C:\\work", false) が呼ばれ、selectedRelPath は deleted.txt のまま
  it("Scenario: folder tabの選択中entryが削除済みでも親フォルダは開く", async () => {
    const { doc, host } = fixture();
    vi.mocked(doc.selectEntry).mockRejectedValueOnce(new Error("missing"));
    const folderTabs: StoredTabs = {
      tabs: [{
        id: "folder",
        path: "C:\\work",
        kind: "folder",
        label: "work",
        selectedRelPath: "deleted.txt",
      }],
      activeId: "folder",
    };
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);

    await expect(manager.init(folderTabs, null, null)).resolves.toBeUndefined();
    expect(doc.openPath).toHaveBeenCalledWith("C:\\work", false);
    expect(manager.state.tabs[0].selectedRelPath).toBe("deleted.txt");
  });

  // Feature: フォルダ検索結果からの連続操作
  // Scenario: 変更中の同じファイルを再選択する
  // Given: folder tab が sub/memo.txt を選択中で dirty
  // When: 区切りだけ異なる sub\\memo.txt へ navigateEntry する
  // Then: 確認と再読込を行わず dirty の本文を維持する
  it("Scenario: 同じフォルダ内ファイルへの再移動は未保存確認を出さない", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    await manager.init({
      tabs: [{ id: "folder", path: "C:\\work", kind: "folder", label: "work" }],
      activeId: "folder",
    }, null, null);
    doc.current.folderRoot = "C:\\work";
    doc.current.selectedRelPath = "sub/memo.txt";
    doc.current.dirty = true;
    vi.mocked(doc.confirmDiscard).mockClear();
    vi.mocked(doc.selectEntry).mockClear();

    await expect(manager.navigateEntry("sub\\memo.txt")).resolves.toBe(true);

    expect(doc.confirmDiscard).not.toHaveBeenCalled();
    expect(doc.selectEntry).not.toHaveBeenCalled();
    expect(doc.current.dirty).toBe(true);
  });

  // Feature: 終了時の未保存確認
  // Scenario: dirty なメモを閉じる
  // Given: active document が dirty で確認処理が false を返す
  // When: saveForExit を呼ぶ
  // Then: 終了を止め、save を自動実行しない
  it("Scenario: 終了前に未保存メモの確認結果を待つ", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    await manager.init(stored, null, null);
    doc.current.dirty = true;
    vi.mocked(doc.confirmDiscard).mockResolvedValue(false);

    await expect(manager.saveForExit()).resolves.toBe(false);

    expect(doc.confirmDiscard).toHaveBeenCalledOnce();
    expect(doc.save).not.toHaveBeenCalled();
  });

  // Given: 終了確認が継続処理を受け入れる
  // When: saveForExit に設定保存処理を渡す
  // Then: 確認後に1回だけ実行して終了を許可する
  it("Scenario: 終了確認後に渡された継続処理を実行する", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    const onProceed = vi.fn();
    await manager.init(stored, null, null);
    vi.mocked(doc.confirmDiscard).mockClear();

    await expect(manager.saveForExit(onProceed)).resolves.toBe(true);

    expect(doc.confirmDiscard).toHaveBeenCalledOnce();
    expect(onProceed).toHaveBeenCalledOnce();
  });

  // Given: activeId=a の stored があり、confirmDiscard は true を返す
  // When: init 後に manager.activate("b") を呼ぶ
  // Then: confirmDiscard は1回、openPath の最終呼出しは C:\work\b.txt と false、activeId は b
  it("Scenario: tab移動前に未保存確認を通し、移動先のリンクを読み込む", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    await manager.init(stored, null, null);
    await manager.activate("b");

    expect(doc.confirmDiscard).toHaveBeenCalledTimes(1);
    expect(doc.openPath).toHaveBeenLastCalledWith("C:\\work\\b.txt", false);
    expect(manager.state.activeId).toBe("b");
  });

  // Feature: tab切替の排他
  // Scenario: 未保存確認中に別のtab切替を開始しない
  // Given: a/b/c の3tabがあり、aからbへの確認処理が保留されている
  // When: 確認処理中にcへの切替を呼び、続けてbへの確認を完了する
  // Then: cへの読込は行わず、最初の要求だけをbへ完了する
  it("Scenario: tab切替の確認中は後続の切替を実行しない", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    let continueFirst!: () => Promise<void>;
    vi.mocked(doc.confirmDiscard).mockImplementation((onProceed) => new Promise((resolve) => {
      continueFirst = async () => {
        await onProceed?.();
        resolve(true);
      };
    }));
    await manager.init({
      tabs: [
        { id: "a", path: "C:\\work\\a.txt", kind: "file", label: "a.txt" },
        { id: "b", path: "C:\\work\\b.txt", kind: "file", label: "b.txt" },
        { id: "c", path: "C:\\work\\c.txt", kind: "file", label: "c.txt" },
      ],
      activeId: "a",
    }, null, null);

    const first = manager.activate("b");
    await vi.waitFor(() => expect(continueFirst).toBeTypeOf("function"));

    await expect(manager.activate("c")).resolves.toBe(false);
    await continueFirst();
    await first;

    expect(manager.state.activeId).toBe("b");
    expect(doc.openPath).not.toHaveBeenCalledWith("C:\\work\\c.txt", false);
    expect(doc.confirmDiscard).toHaveBeenCalledOnce();
  });

  // Given: activeId=a で、最初のcaptureViewStateがline4、次がline8を返す
  // When: 編集のUndo/Redoではなく、C:\work\c.txtへ移動してから履歴のgoBack→goForwardを呼ぶ
  // Then: 戻る/進むはそれぞれopenPathとgoToでリンク・キャレット行を復元し、履歴状態も逆方向へ切り替わる
  it("Scenario: Undo/Redoではなく同じtabの移動履歴でファイルとキャレット行を戻す", async () => {
    const { doc, host } = fixture();
    const navigationStates: { canGoBack: boolean; canGoForward: boolean }[] = [];
    const manager = new TabManager(host, doc, {
      onChange: () => {},
      onHistoryChange: (state) => navigationStates.push(state),
    }, registeredCommandPorts);
    await manager.init(stored, null, null);
    vi.mocked(doc.captureViewState).mockReturnValueOnce({
      anchor: { line: 4, col: 1 }, caret: { line: 4, col: 1 }, topLine: 4, wrapIntraLinePx: 0, scrollLeft: 0,
    });

    await manager.navigatePath("C:\\work\\c.txt");
    expect(navigationStates.at(-1)).toEqual({ canGoBack: true, canGoForward: false });

    vi.mocked(doc.captureViewState).mockReturnValueOnce({
      anchor: { line: 8, col: 1 }, caret: { line: 8, col: 1 }, topLine: 8, wrapIntraLinePx: 0, scrollLeft: 0,
    });
    await manager.goBack();
    expect(doc.openPath).toHaveBeenLastCalledWith("C:\\work\\a.txt", false);
    expect(doc.goTo).toHaveBeenLastCalledWith({ line: 4, col: 0 });
    expect(navigationStates.at(-1)).toEqual({ canGoBack: false, canGoForward: true });

    await manager.goForward();
    expect(doc.openPath).toHaveBeenLastCalledWith("C:\\work\\c.txt", false);
    expect(doc.goTo).toHaveBeenLastCalledWith({ line: 8, col: 0 });
    expect(navigationStates.at(-1)).toEqual({ canGoBack: true, canGoForward: false });
  });

  // Given: folder tab が C:\work を開き a.txt を選択中で、captureViewState が line 6 col 0 を返す
  // When: navigateEntry("b.txt") の後に goBack() を呼ぶ
  // Then: C:\work を開き直し、a.txt を選択し、goTo({ line: 6, col: 0 }) を呼ぶ
  it("Scenario: folder内の選択切替もリンクと行を履歴に保存する", async () => {
    const { doc, host } = fixture();
    doc.current.folderRoot = "C:\\work";
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    await manager.init({
      tabs: [{
        id: "folder", path: "C:\\work", kind: "folder", label: "work", selectedRelPath: "a.txt",
      }],
      activeId: "folder",
    }, null, null);
    vi.mocked(doc.captureViewState).mockReturnValueOnce({
      anchor: { line: 6, col: 0 }, caret: { line: 6, col: 0 }, topLine: 6, wrapIntraLinePx: 0, scrollLeft: 0,
    });

    await manager.navigateEntry("b.txt");
    await manager.goBack();

    expect(doc.openPath).toHaveBeenLastCalledWith("C:\\work", false);
    expect(doc.selectEntry).toHaveBeenLastCalledWith("a.txt");
    expect(doc.goTo).toHaveBeenLastCalledWith({ line: 6, col: 0 });
  });

  // Given: active tab a で c.txt へ移動してから戻る
  // When: d.txt へ新規移動した後に goForward() を呼ぶ
  // Then: goForward() は false を返す
  it("Scenario: 戻った後に別のファイルへ移動すると進む履歴を破棄する", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    await manager.init(stored, null, null);
    await manager.navigatePath("C:\\work\\c.txt");
    await manager.goBack();
    await manager.navigatePath("C:\\work\\d.txt");

    expect(await manager.goForward()).toBe(false);
  });

  // Given: active tab a から c.txt〜n.txt の12件へ順に移動する
  // When: goBack() を10回呼び、さらに1回呼ぶ
  // Then: 10回後の path は C:\work\d.txt で、追加の goBack() は false
  it("Scenario: 戻る履歴は10件まで保持する", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    await manager.init(stored, null, null);
    const paths = Array.from({ length: 12 }, (_, index) => `C:\\work\\${String.fromCharCode(99 + index)}.txt`);
    for (const path of paths) await manager.navigatePath(path);

    for (let index = 0; index < 10; index++) await manager.goBack();

    expect(manager.state.tabs[0].path).toBe(paths[1]);
    expect(await manager.goBack()).toBe(false);
  });

  // Given: c.txt への navigatePath が openPath の未解決Promiseで停止し、release が解放関数を保持する
  // When: c.txt への移動中に d.txt への移動を呼び、release(true) で c.txt を完了させる
  // Then: d.txt への openPath は呼ばれず、2回目の移動は false、tab path は C:\work\c.txt
  it("Scenario: ナビゲーション中の連打は2件目を実行しない", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    await manager.init(stored, null, null);
    let release!: (result: boolean) => void;
    vi.mocked(doc.openPath).mockImplementationOnce((path) => new Promise((resolve) => {
      release = (result) => {
        doc.current.savePath = path;
        doc.current.displayPath = path;
        resolve(result);
      };
    }));

    const first = manager.navigatePath("C:\\work\\c.txt");
    expect(await manager.navigatePath("C:\\work\\d.txt")).toBe(false);
    release(true);
    await first;

    expect(doc.openPath).not.toHaveBeenCalledWith("C:\\work\\d.txt", false);
    expect(manager.state.tabs[0].path).toBe("C:\\work\\c.txt");
  });

  // Given: active tab a から c.txt へ移動し、戻り先読込の openPath が Error("history load failed") を返す
  // When: goBack() を呼ぶ
  // Then: 同じエラーで reject し、現在 path は c.txt、最終 openPath は C:\work\c.txt と false、履歴状態は {canGoBack:true,canGoForward:false}
  it("Scenario: 戻る先の読込が例外になっても現在位置と履歴を復元する", async () => {
    const { doc, host } = fixture();
    const navigationStates: { canGoBack: boolean; canGoForward: boolean }[] = [];
    const manager = new TabManager(host, doc, {
      onChange: () => {},
      onHistoryChange: (state) => navigationStates.push(state),
    }, registeredCommandPorts);
    await manager.init(stored, null, null);
    await manager.navigatePath("C:\\work\\c.txt");
    vi.mocked(doc.openPath).mockRejectedValueOnce(new Error("history load failed"));

    await expect(manager.goBack()).rejects.toThrow("history load failed");

    expect(manager.state.tabs[0].path).toBe("C:\\work\\c.txt");
    expect(navigationStates.at(-1)).toEqual({ canGoBack: true, canGoForward: false });
    expect(doc.openPath).toHaveBeenLastCalledWith("C:\\work\\c.txt", false);
  });

  // Given: 通常遷移の読込が Error("transition failed")、復帰読込が Error("restore failed") になる
  // When: C:\work\c.txt への navigatePath() を呼ぶ
  // Then: 元の遷移失敗でrejectし、復帰失敗は別エラーとして通知する
  it("Scenario: タブ復帰失敗で元の遷移エラーを隠さない", async () => {
    const { doc, host } = fixture();
    const onError = vi.fn();
    const manager = new TabManager(host, doc, { onChange: () => {}, onError }, registeredCommandPorts);
    await manager.init(stored, null, null);
    vi.mocked(doc.openPath)
      .mockRejectedValueOnce(new Error("transition failed"))
      .mockRejectedValueOnce(new Error("restore failed"));

    await expect(manager.navigatePath("C:\\work\\c.txt")).rejects.toThrow("transition failed");
    expect(onError).toHaveBeenCalledWith(expect.any(Error), "タブを元に戻せませんでした");
  });

  // Given: active tab a で、次の openPath が false を返す
  // When: C:\work\c.txt への navigatePath() を呼ぶ
  // Then: 戻り値は false、path は C:\work\a.txt のまま、履歴状態は {canGoBack:false,canGoForward:false}
  it("Scenario: 通常の切替がfalseで終わった場合は履歴を追加しない", async () => {
    const { doc, host } = fixture();
    const navigationStates: { canGoBack: boolean; canGoForward: boolean }[] = [];
    const manager = new TabManager(host, doc, {
      onChange: () => {},
      onHistoryChange: (state) => navigationStates.push(state),
    }, registeredCommandPorts);
    await manager.init(stored, null, null);
    vi.mocked(doc.openPath).mockResolvedValueOnce(false);

    expect(await manager.navigatePath("C:\\work\\c.txt")).toBe(false);
    expect(manager.state.tabs[0].path).toBe("C:\\work\\a.txt");
    expect(navigationStates.at(-1)).toEqual({ canGoBack: false, canGoForward: false });
  });

  // Given: folder tab で a.txt を選択後 b.txt へ移動し、戻り時の selectEntry が false を返す
  // When: goBack() を呼ぶ
  // Then: 戻り値は false、selectedRelPath は b.txt のまま、selectEntry の最終引数は b.txt
  it("Scenario: folder内の戻る先を選択できない場合は現在位置へ復元する", async () => {
    const { doc, host } = fixture();
    doc.current.folderRoot = "C:\\work";
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    await manager.init({
      tabs: [{ id: "folder", path: "C:\\work", kind: "folder", label: "work", selectedRelPath: "a.txt" }],
      activeId: "folder",
    }, null, null);
    await manager.navigateEntry("b.txt");
    vi.mocked(doc.selectEntry).mockResolvedValueOnce(false);

    expect(await manager.goBack()).toBe(false);
    expect(manager.state.tabs[0].selectedRelPath).toBe("b.txt");
    expect(doc.selectEntry).toHaveBeenLastCalledWith("b.txt");
  });

  // Given: a tabでc.txtへ移動後、b tabへ切り替える
  // When: b tabでgoBack→d.txtへ移動→goBack、a tabでgoBackし、再起動相当のinit(stored, null, null)後にgoBackを呼ぶ
  // Then: 履歴はタブ間で混ざらず、再起動相当の初期化後は戻る対象が残らない
  it("Scenario: タブごとに移動履歴を分離し、再起動相当の初期化で履歴を消去する", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    await manager.init(stored, null, null);
    await manager.navigatePath("C:\\work\\c.txt");
    await manager.activate("b");

    expect(await manager.goBack()).toBe(false);
    await manager.navigatePath("C:\\work\\d.txt");
    expect(await manager.goBack()).toBe(true);
    await manager.activate("a");
    expect(await manager.goBack()).toBe(true);

    await manager.init(stored, null, null);
    expect(await manager.goBack()).toBe(false);
  });

  // Given: active tab が C:\work\a.txt
  // When: open("C:\\work\\a.txt", { line: 8, col: 3 }) を呼ぶ
  // Then: doc.goTo({ line: 8, col: 3 }) が呼ばれ、tab の goto は undefined
  it("Scenario: active tabを検索結果の飛び先付きで開いたら、その場で位置を適用する", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    await manager.init(stored, null, null);

    await manager.open("C:\\work\\a.txt", { line: 8, col: 3 });

    expect(doc.goTo).toHaveBeenCalledWith({ line: 8, col: 3 });
    expect(manager.state.tabs[0].goto).toBeUndefined();
  });

  // Given: a.txtとb.txtの2タブがあり、activeIdはa
  // When: 既存のb.txtをopenする
  // Then: タブを複製せずbをactiveにする
  it("Scenario: 新規タブ経路でも同じパスの既存タブを再利用する", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    await manager.init(stored, null, null);

    await manager.open("C:\\work\\b.txt");

    expect(manager.state.tabs).toHaveLength(2);
    expect(manager.state.activeId).toBe("b");
    expect(doc.openPath).toHaveBeenLastCalledWith("C:\\work\\b.txt", false);
  });

  // Given: a tabがactiveで、同じパスのa.txtが既に開かれている
  // When: Markdownリンクからa.txtを起点タブの直後へ開く
  // Then: 重複を許可した新規タブが直後へ入り、fragmentを保持してactiveになる
  it("Scenario: Markdownリンクを起点タブの直後へ重複タブとして開く", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    await manager.init(stored, null, null);

    await expect(manager.openMarkdownLink("C:\\work\\a.txt", "a", "install")).resolves.toBe(true);

    expect(manager.state.tabs.map((tab) => tab.id)).toEqual(["a", expect.any(String), "b"]);
    const opened = manager.state.tabs[1];
    expect(opened.path).toBe("C:\\work\\a.txt");
    expect(opened.fragment).toBe("install");
    expect(manager.state.activeId).toBe(opened.id);
    expect(manager.takeActiveFragment()).toBe("install");
    expect(manager.takeActiveFragment()).toBeNull();
  });

  // Given: a tabがactiveで、リンク先のopenPathが失敗する
  // When: Markdownリンク用の新規タブを開く
  // Then: タブを増やさずfalseを返す
  it("Scenario: Markdownリンク先が存在しない場合はタブを増やさない", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    await manager.init(stored, null, null);
    vi.mocked(doc.openPath).mockResolvedValueOnce(false);
    const before = manager.state;

    await expect(manager.openMarkdownLink("C:\\work\\missing.md", "a", "install")).resolves.toBe(false);

    expect(manager.state.tabs.map((tab) => tab.id)).toEqual(before.tabs.map((tab) => tab.id));
    expect(manager.state.activeId).toBe(before.activeId);
  });

  // Given: active tab が a で、doc.goTo が Error("invalid position") を投げる
  // When: a.txt に { line: 8, col: 3 } を付けて open() を呼ぶ
  // Then: invalid position で reject し、tab の goto は undefined
  it("Scenario: active tabの飛び先適用に失敗しても、消費済みの要求を残さない", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    await manager.init(stored, null, null);
    vi.mocked(doc.goTo).mockImplementationOnce(() => { throw new Error("invalid position"); });

    await expect(manager.open("C:\\work\\a.txt", { line: 8, col: 3 })).rejects.toThrow("invalid position");

    expect(manager.state.tabs[0].goto).toBeUndefined();
  });

  // Given: b tab への未保存確認が false を返す
  // When: b.txt へ goto={line:8,col:3} 付きで open() し、その後確認を true にして activate("b") を呼ぶ
  // Then: doc.goTo({ line: 8, col: 3 }) は一度も呼ばれない
  it("Scenario: 未保存確認で既存tabへの移動を取り消したら飛び先を残さない", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    await manager.init(stored, null, null);
    vi.mocked(doc.confirmDiscard).mockResolvedValue(false);

    await manager.open("C:\\work\\b.txt", { line: 8, col: 3 });

    vi.mocked(doc.confirmDiscard).mockResolvedValue(true);
    await manager.activate("b");
    expect(doc.goTo).not.toHaveBeenCalledWith({ line: 8, col: 3 });
  });

  // Scenario: 未保存確認で新規tabを開く操作を取り消す
  // Given: active tab aで未保存確認がfalseを返す
  // When: c.txtを新規tabで開く
  // Then: falseを返し、c tabを追加せずaを維持する
  it("Scenario: 新規tabの作成を取り消した結果を呼び出し元へ返す", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    await manager.init(stored, null, null);
    vi.mocked(doc.confirmDiscard).mockResolvedValue(false);

    await expect(manager.open("C:\\work\\c.txt")).resolves.toBe(false);

    expect(manager.state.tabs.map((tab) => tab.id)).toEqual(["a", "b"]);
    expect(manager.state.activeId).toBe("a");
    expect(doc.openPath).not.toHaveBeenCalledWith("C:\\work\\c.txt", false);
  });

  // Given: active tab a で、b tab の openPath が Error("load failed") を返し、変更通知配列を空にする
  // When: activate("b") を呼ぶ
  // Then: load failed で reject し、activeId は a、変更通知は空、最終 openPath は C:\work\a.txt と false
  it("Scenario: 移動先の読込失敗時は元active tabへ戻し、壊れた状態を保存しない", async () => {
    const { doc, host } = fixture();
    const changes: StoredTabs[] = [];
    const manager = new TabManager(host, doc, { onChange: (state) => changes.push(state) }, registeredCommandPorts);
    await manager.init(stored, null, null);
    changes.length = 0;
    vi.mocked(doc.openPath).mockRejectedValueOnce(new Error("load failed"));

    await expect(manager.activate("b")).rejects.toThrow("load failed");

    expect(manager.state.activeId).toBe("a");
    expect(changes).toHaveLength(1);
    expect(changes[0].activeId).toBe("a");
    expect(doc.openPath).toHaveBeenLastCalledWith("C:\\work\\a.txt", false);
  });

  // Given: active tab a で b、続けて a を activate し、captureViewState の既定値が全て0
  // When: 2回の tab 切替を完了する
  // Then: captureViewState は2回呼ばれ、restoreViewState は topLine=0 と scrollLeft=0 を含む状態で呼ばれる
  it("Scenario: tabごとに選択位置と表示位置を復元する", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    await manager.init(stored, null, null);
    await manager.activate("b");
    await manager.activate("a");

    expect(doc.captureViewState).toHaveBeenCalledTimes(2);
    expect(doc.restoreViewState).toHaveBeenCalledWith(expect.objectContaining({
      topLine: 0,
      scrollLeft: 0,
    }));
  });

  // Given: 切替先の読み込みが継続中で、active tab a の現在位置が保存対象にある
  // When: tab b への切替を開始する
  // Then: 非同期の読み込み完了を待たず、aのviewStateを永続化通知へ渡す
  it("Scenario: tab切替開始時に現在位置を先に永続化する", async () => {
    const { doc, host } = fixture();
    const changes: StoredTabs[] = [];
    const manager = new TabManager(host, doc, { onChange: (state) => changes.push(state) }, registeredCommandPorts);
    await manager.init(stored, null, null);
    changes.length = 0;
    vi.mocked(doc.captureViewState).mockReturnValue({
      anchor: { line: 12, col: 2 },
      caret: { line: 12, col: 5 },
      topLine: 10,
      wrapIntraLinePx: 1,
      scrollLeft: 24,
    });
    let release!: (value: boolean) => void;
    vi.mocked(doc.openPath).mockReturnValueOnce(new Promise<boolean>((resolve) => { release = resolve; }));

    const switching = manager.activate("b");
    await vi.waitFor(() => expect(changes.length).toBeGreaterThan(0));

    expect(changes[0].tabs.find((tab) => tab.id === "a")?.viewState).toEqual({
      anchor: { line: 12, col: 2 },
      caret: { line: 12, col: 5 },
      topLine: 10,
      wrapIntraLinePx: 1,
      scrollLeft: 24,
    });
    release(true);
    await switching;
  });

  // Given: activate("b") の確認処理中に syncActive(doc.current) が実行されてから onProceed が続行される
  // When: activate("b") を呼ぶ
  // Then: activeId は b、active な .doc-tab の title は C:\work\b.txt
  it("Scenario: 保存完了時にtabが再描画されても要求したtabへ切り替える", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    await manager.init(stored, null, null);
    vi.mocked(doc.confirmDiscard).mockImplementation(async (onProceed) => {
      manager.syncActive(doc.current);
      await onProceed?.();
      return true;
    });

    await manager.activate("b");

    expect(manager.state.activeId).toBe("b");
    expect(host.querySelector<HTMLButtonElement>(".doc-tab.active")?.title).toBe("C:\\work\\b.txt");
  });

  // Given: active tab a の doc.current.dirty が true で、confirmDiscard が false を返す
  // When: activate("b") を呼ぶ
  // Then: activeId は a のまま
  it("Scenario: 確認処理がfalseかつdirtyのままなら切り替えない", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    await manager.init(stored, null, null);
    doc.current.dirty = true;
    vi.mocked(doc.confirmDiscard).mockResolvedValue(false);

    await manager.activate("b");

    expect(manager.state.activeId).toBe("a");
  });

  // Feature: tab切替失敗からの復帰
  // Scenario: 未保存確認が例外になった後に再度tabを切り替える
  // Given: a/b の2tabがあり、最初の確認処理がError("confirm failed")を投げる
  // When: bへの切替を失敗させ、同じbへの切替を再実行する
  // Then: 2回目の切替はtransition状態に阻害されず完了する
  it("Scenario: 未保存確認の例外後もtab切替を再試行できる", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    await manager.init(stored, null, null);
    const error = new Error("confirm failed");
    vi.mocked(doc.confirmDiscard).mockRejectedValueOnce(error);

    await expect(manager.activate("b")).rejects.toBe(error);
    await expect(manager.activate("b")).resolves.toBe(true);

    expect(manager.state.activeId).toBe("b");
  });

  // Given: active tab a の dirty を true にして syncActive(doc.current) を呼ぶ
  // When: tab label の文字列を取得する
  // Then: labels は ["● a.txt", "b.txt"]
  it("Scenario: 変更中のactive tabだけファイル名の先頭に印を付ける", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    await manager.init(stored, null, null);

    doc.current.dirty = true;
    manager.syncActive(doc.current);
    const labels = [...host.querySelectorAll<HTMLElement>(".doc-tab-label")].map((label) => label.textContent);

    expect(labels).toEqual(["● a.txt", "b.txt"]);
  });

  // Given: activate("b") の確認処理が保留され、継続関数が onProceed 実行後に true を解決する
  // When: activate("b") を開始し、継続関数を取得して実行する
  // Then: activeId は b、active な .doc-tab の title は C:\work\b.txt
  it("Scenario: 保存処理へ渡した継続処理が、確定した移動先tabを開く", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    await manager.init(stored, null, null);
    let continuation: (() => void | Promise<void>) | undefined;
    vi.mocked(doc.confirmDiscard).mockImplementation((onProceed) => new Promise((resolve) => {
      continuation = async () => {
        await onProceed?.();
        resolve(true);
      };
    }));

    const activation = manager.activate("b");
    await vi.waitFor(() => expect(continuation).toBeTypeOf("function"));
    await continuation!();
    await activation;

    expect(manager.state.activeId).toBe("b");
    expect(host.querySelector<HTMLButtonElement>(".doc-tab.active")?.title).toBe("C:\\work\\b.txt");
  });

  // Feature: 未保存タブの復帰
  // Scenario: 保存して継続した後に元のタブへ戻る
  // Given: a.txt が dirty で、保存処理がエディタ表示状態を更新し、a/b それぞれに非ゼロの表示状態がある
  // When: b.txt へ移動し、b.txt を編集してから a.txt へ戻る
  // Then: a.txt を開き、保存前に編集していたキャレットと表示位置を復元する
  it("Scenario: 保存して継続したタブへ戻ると編集位置を復元する", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    const firstView = {
      anchor: { line: 23, col: 2 },
      caret: { line: 23, col: 7 },
      topLine: 18,
      wrapIntraLinePx: 1,
      scrollLeft: 24,
    };
    const secondView = {
      anchor: { line: 8, col: 1 },
      caret: { line: 8, col: 4 },
      topLine: 3,
      wrapIntraLinePx: 0,
      scrollLeft: 12,
    };
    let currentView = firstView;
    vi.mocked(doc.captureViewState).mockImplementation(() => ({ ...currentView }));
    vi.mocked(doc.save).mockImplementation(async () => {
      currentView = {
        anchor: { line: 0, col: 0 },
        caret: { line: 0, col: 0 },
        topLine: 0,
        wrapIntraLinePx: 0,
        scrollLeft: 0,
      };
      return true;
    });
    vi.mocked(doc.confirmDiscard).mockImplementation(async (onProceed) => {
      if (doc.current.dirty) {
        if (!await doc.save()) return false;
        doc.current.dirty = false;
      }
      await onProceed?.();
      return true;
    });

    await manager.init(stored, null, null);
    doc.current.dirty = true;
    await manager.activate("b");

    currentView = secondView;
    doc.current.dirty = true;
    await manager.activate("a");

    expect(doc.openPath).toHaveBeenLastCalledWith("C:\\work\\a.txt", false);
    expect(doc.restoreViewState).toHaveBeenLastCalledWith(firstView);
  });

  // Feature: 未保存フォルダタブの復帰
  // Scenario: 保存して継続した後にフォルダ内の選択ファイルへ戻る
  // Given: C:\work の folder tab で memo.txt を選択し、保存処理が選択状態を維持する
  // When: b.txt へ移動し、b.txt を編集してから C:\work の tab へ戻る
  // Then: C:\work を開き直し、memo.txtを選択してキャレット・選択・中央位置を復元する
  it("Scenario: 保存して継続したフォルダタブへ戻ると完全な編集位置を復元する", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    const firstView = {
      anchor: { line: 23, col: 2 },
      caret: { line: 23, col: 7 },
      topLine: 18,
      wrapIntraLinePx: 1,
      scrollLeft: 24,
    };
    const secondView = {
      anchor: { line: 8, col: 1 },
      caret: { line: 8, col: 4 },
      topLine: 3,
      wrapIntraLinePx: 0,
      scrollLeft: 12,
    };
    let currentView = firstView;
    vi.mocked(doc.openPath).mockImplementation(async (path: string) => {
      doc.current.savePath = path;
      doc.current.displayPath = path;
      doc.current.folderRoot = path === "C:\\work" ? path : null;
      doc.current.selectedRelPath = "";
      return true;
    });
    vi.mocked(doc.captureViewState).mockImplementation(() => ({ ...currentView }));
    vi.mocked(doc.save).mockImplementation(async () => {
      manager.syncActive(doc.current);
      currentView = {
        anchor: { line: 0, col: 0 },
        caret: { line: 0, col: 0 },
        topLine: 0,
        wrapIntraLinePx: 0,
        scrollLeft: 0,
      };
      return true;
    });
    vi.mocked(doc.confirmDiscard).mockImplementation(async (onProceed) => {
      if (doc.current.dirty) {
        if (!await doc.save()) return false;
        doc.current.dirty = false;
      }
      await onProceed?.();
      return true;
    });

    await manager.init({
      tabs: [
        {
          id: "folder",
          path: "C:\\work",
          kind: "folder",
          label: "work",
          selectedRelPath: "memo.txt",
        },
        { id: "b", path: "C:\\work\\b.txt", kind: "file", label: "b.txt" },
      ],
      activeId: "folder",
    }, null, null);
    doc.current.dirty = true;
    await manager.activate("b");

    currentView = secondView;
    doc.current.dirty = true;
    await manager.activate("folder");

    expect(doc.openPath).toHaveBeenLastCalledWith("C:\\work", false);
    expect(doc.selectEntry).toHaveBeenCalledTimes(2);
    expect(doc.selectEntry).toHaveBeenLastCalledWith("memo.txt");
    expect(doc.restoreViewState).toHaveBeenLastCalledWith(firstView);
  });

  // Given: activeId=a で a.txt と b.txt の2タブがある
  // When: 末尾の .doc-tab-add をクリックする
  // Then: .doc-tab は3個になり、state.tabs[2].kind は blank
  it("Scenario: tab列の末尾にある＋で新規tabを追加する", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    await manager.init(stored, null, null);

    host.querySelector<HTMLButtonElement>(".doc-tab-add")!.click();
    await vi.waitFor(() => expect(host.querySelectorAll(".doc-tab")).toHaveLength(3));

    expect(manager.state.tabs[2].kind).toBe("blank");
  });

  // Feature: ＋から作る無題メモの既定保存先
  // Scenario: カレントタブがフォルダの場合はフォルダを下書き保存先にする
  // Given: C:\workのフォルダタブがアクティブ
  // When: タブバーの＋を押す
  // Then: 新規文書へC:\workを渡す
  it("Scenario: フォルダタブから作る無題メモは同じフォルダを使う", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    await manager.init({
      tabs: [{ id: "folder", path: "C:\\work", kind: "folder", label: "work" }],
      activeId: "folder",
    }, null, null);

    host.querySelector<HTMLButtonElement>(".doc-tab-add")!.click();
    await vi.waitFor(() => expect(doc.newFile).toHaveBeenLastCalledWith(false, "C:\\work"));

    expect(manager.state.tabs.at(-1)?.draftDirectory).toBe("C:\\work");
  });

  // Scenario: カレントタブがファイルの場合はデスクトップを下書き保存先にする
  // Given: ファイルタブがアクティブで、デスクトップ取得口がC:\Users\sample\Desktopを返す
  // When: タブバーの＋を押す
  // Then: 新規文書へデスクトップを渡す
  it("Scenario: ファイルタブから作る無題メモはデスクトップを使う", async () => {
    const { doc, host } = fixture();
    const defaultMemoDirectory = vi.fn(async () => "C:\\Users\\sample\\Desktop");
    const manager = new TabManager(host, doc, {
      onChange: () => {},
      defaultMemoDirectory,
    }, registeredCommandPorts);
    await manager.init(stored, null, null);

    host.querySelector<HTMLButtonElement>(".doc-tab-add")!.click();
    await vi.waitFor(() => expect(doc.newFile).toHaveBeenLastCalledWith(false, "C:\\Users\\sample\\Desktop"));

    expect(defaultMemoDirectory).toHaveBeenCalledOnce();
    expect(manager.state.tabs.at(-1)?.draftDirectory).toBe("C:\\Users\\sample\\Desktop");
  });

  // Scenario: デスクトップ取得に失敗しても無題タブ作成を中断しない
  // Given: ファイルタブがアクティブで、デスクトップ取得口が失敗する
  // When: タブバーの＋を押す
  // Then: エラーを通知し、保存先なしの無題タブを作成する
  it("Scenario: デスクトップ取得失敗時も無題タブを作成する", async () => {
    const { doc, host } = fixture();
    const error = new Error("desktop unavailable");
    const defaultMemoDirectory = vi.fn(async () => { throw error; });
    const onError = vi.fn();
    const manager = new TabManager(host, doc, {
      onChange: () => {},
      defaultMemoDirectory,
      onError,
    }, registeredCommandPorts);
    await manager.init(stored, null, null);

    host.querySelector<HTMLButtonElement>(".doc-tab-add")!.click();
    await vi.waitFor(() => expect(manager.state.tabs.at(-1)?.kind).toBe("blank"));

    expect(onError).toHaveBeenCalledWith(error, "新規メモの既定保存先を取得できませんでした");
    expect(doc.newFile).toHaveBeenLastCalledWith(false, null);
  });

  // Feature: 無題タブの既定保存先の復元
  // Scenario: 保存済みの無題タブは記録した下書き保存先を文書へ渡す
  // Given: C:\workを下書き保存先に持つ無題タブ
  // When: タブを初期化する
  // Then: 文書作成へC:\workを渡す
  it("Scenario: 保存済み無題タブの下書き保存先を復元する", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    await manager.init({
      tabs: [{ id: "blank", path: null, kind: "blank", label: "無題", draftDirectory: "C:\\work" }],
      activeId: "blank",
    }, null, null);

    expect(doc.newFile).toHaveBeenCalledWith(false, "C:\\work");
  });

  // Scenario: 初期タブが無題の場合はデスクトップを下書き保存先にする
  // Given: 保存済みタブも起動パスもなく、デスクトップ取得口が値を返す
  // When: タブを初期化する
  // Then: 初期文書へデスクトップを渡す
  it("Scenario: 初期無題タブはデスクトップを使う", async () => {
    const { doc, host } = fixture();
    const defaultMemoDirectory = vi.fn(async () => "C:\\Users\\sample\\Desktop");
    const manager = new TabManager(host, doc, {
      onChange: () => {},
      defaultMemoDirectory,
    }, registeredCommandPorts);
    await manager.init({ tabs: [], activeId: null }, null, null);

    expect(defaultMemoDirectory).toHaveBeenCalledOnce();
    expect(doc.newFile).toHaveBeenCalledWith(false, "C:\\Users\\sample\\Desktop");
  });

  // Scenario: 最後のタブを閉じた後の無題文書はデスクトップを使う
  // Given: ファイルタブが1つだけあり、デスクトップ取得口が値を返す
  // When: 最後のタブを閉じる
  // Then: 置き換えた無題文書へデスクトップを渡す
  it("Scenario: 最後のタブを閉じた後の無題タブはデスクトップを使う", async () => {
    const { doc, host } = fixture();
    const defaultMemoDirectory = vi.fn(async () => "C:\\Users\\sample\\Desktop");
    const manager = new TabManager(host, doc, {
      onChange: () => {},
      defaultMemoDirectory,
    }, registeredCommandPorts);
    await manager.init({
      tabs: [{ id: "a", path: "C:\\work\\a.txt", kind: "file", label: "a.txt" }],
      activeId: "a",
    }, null, null);
    doc.newFile.mockClear();

    await manager.close("a");

    expect(doc.newFile).toHaveBeenCalledWith(false, "C:\\Users\\sample\\Desktop");
  });

  // Feature: 同一起動中に閉じたタブを復活する
  // Scenario: 最後に閉じたタブを元の位置と表示状態で復活する
  // Given: aタブと、b.mdを表示中のフォルダタブがあり、後者がアクティブ
  // When: bを閉じてからreopenLastClosedを呼ぶ
  // Then: bを元の位置へ戻してアクティブにし、表示位置を復元する
  it("Scenario: 最後に閉じたタブを元の位置と表示状態で復活する", async () => {
    const { doc, host } = fixture();
    vi.mocked(doc.openPath).mockImplementation(async (path) => {
      doc.current.folderRoot = path === "C:\\work" ? path : null;
      doc.current.savePath = path === "C:\\work" ? null : path;
      doc.current.displayPath = path;
      return true;
    });
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    const viewState = {
      anchor: { line: 9, col: 1 }, caret: { line: 9, col: 3 },
      topLine: 7, wrapIntraLinePx: 0, scrollLeft: 12,
    };
    await manager.init({
      tabs: [
        stored.tabs[0],
        {
          id: "b", path: "C:\\work", kind: "folder", label: "work",
          selectedRelPath: "notes\\b.md", viewState,
        },
      ],
      activeId: "b",
    }, null, null);
    vi.mocked(doc.captureViewState).mockReturnValue(viewState);

    await manager.close("b");
    await expect(manager.reopenLastClosed()).resolves.toBe(true);

    expect(manager.state.tabs.map((tab) => tab.id)).toEqual(["a", "b"]);
    expect(manager.state.activeId).toBe("b");
    expect(doc.selectEntry).toHaveBeenLastCalledWith("notes\\b.md");
    expect(doc.restoreViewState).toHaveBeenLastCalledWith(expect.objectContaining({
      anchor: { line: 9, col: 1 }, caret: { line: 9, col: 3 }, topLine: 7, scrollLeft: 12,
    }));
  });

  // Scenario: 読み込みに失敗した閉じたtabを後から再試行する
  // Given: b tabを閉じ、b.txtの最初のopenPathだけfalseを返す
  // When: reopenLastClosedを2回呼ぶ
  // Then: 1回目は履歴を保持してfalse、2回目はbを復活してtrueを返す
  it("Scenario: 復活時の一時的な読込失敗で閉じたtab履歴を失わない", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    await manager.init(stored, null, null);
    await manager.close("b");
    let bAttempts = 0;
    vi.mocked(doc.openPath).mockImplementation(async (path) => {
      if (path === "C:\\work\\b.txt") return ++bAttempts > 1;
      doc.current.savePath = path;
      doc.current.displayPath = path;
      return true;
    });

    await expect(manager.reopenLastClosed()).resolves.toBe(false);
    expect(manager.state.tabs.map((tab) => tab.id)).toEqual(["a"]);
    expect(manager.state.activeId).toBe("a");

    await expect(manager.reopenLastClosed()).resolves.toBe(true);
    expect(manager.state.tabs.map((tab) => tab.id)).toEqual(["a", "b"]);
    expect(manager.state.activeId).toBe("b");
    expect(bAttempts).toBe(2);
  });

  // Scenario: 保存して閉じた無題タブを保存先ファイルとして復活する
  // Given: 未保存の無題タブで「保存して継続」を選び、savePathがmemo.mdへ変わる
  // When: タブを閉じてreopenLastClosedを呼ぶ
  // Then: 保存前の無題状態ではなくmemo.mdのファイルタブを復活する
  it("Scenario: 保存して閉じた無題タブは保存先ファイルとして復活する", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    await manager.init({
      tabs: [stored.tabs[0], { id: "draft", path: null, kind: "blank", label: "無題" }],
      activeId: "draft",
    }, null, null);
    doc.current.dirty = true;
    vi.mocked(doc.confirmDiscard).mockImplementation(async (onProceed) => {
      doc.current.savePath = "C:\\work\\memo.md";
      doc.current.displayPath = "C:\\work\\memo.md";
      doc.current.dirty = false;
      await onProceed?.();
      return true;
    });

    await manager.close("draft");
    await manager.reopenLastClosed();

    expect(manager.state.tabs.at(-1)).toEqual(expect.objectContaining({
      id: "draft", path: "C:\\work\\memo.md", kind: "file", label: "memo.md",
    }));
  });

  // Scenario: 最後の1タブを閉じて復活する
  // Given: a.txtタブだけが開いている
  // When: aを閉じて自動生成された無題タブ上でreopenLastClosedを呼ぶ
  // Then: 無題タブを残さずaだけを復活する
  it("Scenario: 最後の1タブを復活すると自動生成した無題タブを置き換える", async () => {
    const { doc, host } = fixture();
    vi.mocked(doc.newFile).mockImplementation(async () => {
      doc.current.folderRoot = null;
      doc.current.savePath = null;
      doc.current.displayPath = "";
      doc.current.selectedRelPath = "";
      doc.current.dirty = false;
    });
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    await manager.init({ tabs: [stored.tabs[0]], activeId: "a" }, null, null);

    await manager.close("a");
    await manager.reopenLastClosed();

    expect(manager.state.tabs.map((tab) => tab.id)).toEqual(["a"]);
    expect(manager.state.activeId).toBe("a");
  });

  // Scenario Outline: 一括クローズで最後に削除したタブを復活する
  // Given: a、b、cの保存済みタブがありaがアクティブ
  // When: bのコンテキストメニューから各一括クローズ操作を行いCtrl+Shift+T相当を実行する
  // Then: 各操作で最後に削除されたcを復活する
  // Examples: ほかのタブを閉じる | 右側のタブを閉じる | 保存済みのタブを閉じる
  it.each([
    "ほかのタブを閉じる",
    "右側のタブを閉じる",
    "保存済みのタブを閉じる",
  ])("Scenario: %sでも閉じたタブ履歴を残す", async (actionLabel) => {
    const { doc, host } = fixture();
    document.body.appendChild(Object.assign(document.createElement("div"), { id: "dropdown" }));
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    await manager.init({
      tabs: [...stored.tabs, { id: "c", path: "C:\\work\\c.txt", kind: "file", label: "c.txt" }],
      activeId: "a",
    }, null, null);

    host.querySelectorAll<HTMLElement>(".doc-tab")[1]
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    [...document.querySelectorAll<HTMLElement>("#dropdown .dd-item")]
      .find((item) => item.textContent === actionLabel)!.click();
    await vi.waitFor(() => expect(manager.state.tabs.some((tab) => tab.id === "c")).toBe(false));

    await expect(manager.reopenLastClosed()).resolves.toBe(true);
    expect(manager.state.activeId).toBe("c");
  });

  // Scenario: アプリ再初期化後は閉じたタブを復活しない
  // Given: bを閉じた後のTabManager
  // When: initでアプリ状態を再初期化してreopenLastClosedを呼ぶ
  // Then: 閉じたタブ履歴は破棄されてfalseを返す
  it("Scenario: 再初期化後は閉じたタブを復活しない", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    await manager.init(stored, null, null);
    await manager.close("b");

    await manager.init(stored, null, null);

    await expect(manager.reopenLastClosed()).resolves.toBe(false);
  });

  // Given: activeId=a で a.txt と b.txt があり、addLinks に a.txt(file) と src(folder) を渡す
  // When: addLinks() を呼ぶ
  // Then: activeId は a のまま、path は [C:\work\a.txt,C:\work\b.txt,C:\work\src]、openPath は初期化時の1回だけ
  it("Scenario: 一括追加は重複を除き、active tabを切り替えない", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    await manager.init(stored, null, null);
    manager.addLinks([
      { path: "C:\\work\\a.txt", kind: "file" },
      { path: "C:\\work\\src", kind: "folder" },
    ]);

    expect(manager.state.activeId).toBe("a");
    expect(manager.state.tabs.map((tab) => tab.path)).toEqual([
      "C:\\work\\a.txt",
      "C:\\work\\b.txt",
      "C:\\work\\src",
    ]);
    expect(doc.openPath).toHaveBeenCalledTimes(1);
  });

  // Given: activeId=a で a,b の順にタブがある
  // When: b を a の左側へドラッグし、直後に b を click する
  // Then: tab id は ["b","a"]、activeId は a、openPath は1回だけ、最後の変更通知も ["b","a"]
  it("Scenario: タブをドラッグして並べ替え、直後のclickでは切り替えない", async () => {
    const { doc, host } = fixture();
    const changes: StoredTabs[] = [];
    const manager = new TabManager(host, doc, { onChange: (state) => changes.push(state) }, registeredCommandPorts);
    await manager.init(stored, null, null);
    const [a, b] = host.querySelectorAll<HTMLElement>(".doc-tab");

    dragOnto(b, a, 0.1);
    b.click();

    expect(manager.state.tabs.map((tab) => tab.id)).toEqual(["b", "a"]);
    expect(manager.state.activeId).toBe("a");
    expect(doc.openPath).toHaveBeenCalledTimes(1);
    expect(changes.at(-1)?.tabs.map((tab) => tab.id)).toEqual(["b", "a"]);
  });

  // Given: activeId=a で、elementFromPoint が null を返し、onDetach が true を返す
  // When: a tab を pointerdown してウィンドウ外の x=-20 へドラッグする
  // Then: onDetach に secondary=true、path=C:\work\a.txt、goto=null、selectedRelPath=null、caret/anchor が line0 col0 の viewState を渡し、残る tab は b だけで activeId は b
  it("Scenario: ウィンドウの外へドラッグすると新規ウィンドウへ移す", async () => {
    const { doc, host } = fixture();
    const onDetach = vi.fn(async () => true);
    const manager = new TabManager(host, doc, { onChange: () => {}, onDetach }, registeredCommandPorts);
    await manager.init(stored, null, null);
    const a = host.querySelector<HTMLElement>(".doc-tab")!;
    document.elementFromPoint = () => null;
    const at = (type: string, x: number) =>
      new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: 100 });

    a.dispatchEvent(at("pointerdown", 0));
    window.dispatchEvent(at("pointermove", -20));
    window.dispatchEvent(at("pointerup", -20));
    await vi.waitFor(() => expect(onDetach).toHaveBeenCalledWith(expect.objectContaining({
      secondary: true,
      path: "C:\\work\\a.txt",
      goto: null,
      selectedRelPath: null,
      viewState: expect.objectContaining({
        caret: { line: 0, col: 0 },
        anchor: { line: 0, col: 0 },
      }),
    })));

    expect(manager.state.tabs.map((tab) => tab.id)).toEqual(["b"]);
    expect(manager.state.activeId).toBe("b");
  });

  // Given: activeId=a で、drop 判定が document.body を返す
  // When: a tab を同じウィンドウ内のタブ領域外へドラッグする
  // Then: onDetach は呼ばれず、tab id は ["a","b"] のまま
  it("Scenario: 同じウィンドウ内のタブ領域外へのdropはキャンセルする", async () => {
    const { doc, host } = fixture();
    const onDetach = vi.fn(async () => true);
    const manager = new TabManager(host, doc, { onChange: () => {}, onDetach }, registeredCommandPorts);
    await manager.init(stored, null, null);
    const a = host.querySelector<HTMLElement>(".doc-tab")!;
    document.elementFromPoint = () => document.body;
    const at = (type: string, x: number) =>
      new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: 100 });

    a.dispatchEvent(at("pointerdown", 0));
    window.dispatchEvent(at("pointermove", 20));
    window.dispatchEvent(at("pointerup", 20));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onDetach).not.toHaveBeenCalled();
    expect(manager.state.tabs.map((tab) => tab.id)).toEqual(["a", "b"]);
  });

  // Given: C:\work\memo.txt の file tab があり、登録入力が ["メモ帳","","notepad {file}"] を返す
  // When: コンテキストメニューから登録し、登録コマンドの submenu 項目を実行する
  // Then: commandsForPath は extension=.txt,label=メモ帳,prefix="",command=notepad {file} を返し、runExternalCommand は `notepad "C:\work\memo.txt"` と path を渡される
  it("Scenario: ファイルタブから登録し、登録コマンドを実行できる", async () => {
    const { doc, host } = fixture();
    document.body.appendChild(Object.assign(document.createElement("div"), { id: "dropdown" }));
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    await manager.init({
      tabs: [{ id: "file", path: "C:\\work\\memo.txt", kind: "file", label: "memo.txt" }],
      activeId: "file",
    }, null, null);

    registeredCommandPorts.promptFields.mockResolvedValueOnce(["メモ帳", "notepad {file}"]);
    const tab = host.querySelector<HTMLElement>(".doc-tab")!;
    tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    [...document.querySelectorAll<HTMLElement>("#dropdown .dd-item")]
      .find((item) => item.textContent === "コマンドを登録...")!.click();

    await vi.waitFor(() => expect(commandsForPath("C:\\work\\memo.txt")).toEqual([
      { extension: ".txt", label: "メモ帳", prefix: "", command: "notepad {file}" },
    ]));

    tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    [...document.querySelectorAll<HTMLElement>("#dropdown .dd-item")]
      .find((item) => item.textContent === "登録コマンド ▸")!.click();
    document.querySelector<HTMLElement>("#dropdown .dd-submenu .dd-item")!.click();

    await vi.waitFor(() => expect(registeredCommandPorts.runExternalCommand).toHaveBeenCalledWith(
      "notepad C:\\work\\memo.txt",
      "C:\\work\\memo.txt",
    ));
  });

  // Given: .txt の登録コマンドを追加し、実行処理が Error("command failed") を返す
  // When: memo.txt のコンテキストメニューから登録コマンドを実行する
  // Then: onError は Error と「登録コマンドを実行できませんでした」を引数に1回呼ばれる
  it("Scenario: タブの登録コマンド失敗は専用のエラー文言を渡す", async () => {
    addRegisteredCommand({ extension: ".txt", label: "メモ帳", prefix: "", command: "notepad {file}" });
    registeredCommandPorts.runExternalCommand.mockRejectedValueOnce(new Error("command failed"));
    const { doc, host } = fixture();
    const onError = vi.fn(async () => {});
    document.body.appendChild(Object.assign(document.createElement("div"), { id: "dropdown" }));
    const manager = new TabManager(host, doc, { onChange: () => {}, onError }, registeredCommandPorts);
    await manager.init({
      tabs: [{ id: "file", path: "C:\\work\\memo.txt", kind: "file", label: "memo.txt" }],
      activeId: "file",
    }, null, null);

    const tab = host.querySelector<HTMLElement>(".doc-tab")!;
    tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    [...document.querySelectorAll<HTMLElement>("#dropdown .dd-item")]
      .find((item) => item.textContent === "登録コマンド ▸")!.click();
    document.querySelector<HTMLElement>("#dropdown .dd-submenu .dd-item")!.click();

    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      "登録コマンドを実行できませんでした",
    ));
  });

  // Given: file tab が C:\work\memo.txt、folder tab が C:\work\docs にあり、revealInExplorer を spy する
  // When: file と folder の各コンテキストメニューで「エクスプローラで開く」を実行する
  // Then: revealInExplorer は memo.txt に false、docs に true を渡して順に2回呼ばれ、folder メニューに「登録コマンド ▸」はない
  it("Scenario: ファイルとフォルダのタブをExplorerで開く", async () => {
    const reveal = vi.spyOn(api, "revealInExplorer").mockResolvedValue();
    try {
      const { doc, host } = fixture();
      document.body.appendChild(Object.assign(document.createElement("div"), { id: "dropdown" }));
      const manager = new TabManager(host, doc, {
        onChange: () => {},
        revealInExplorer: api.revealInExplorer,
      }, registeredCommandPorts);
      await manager.init({
        tabs: [
          { id: "file", path: "C:\\work\\memo.txt", kind: "file", label: "memo.txt" },
          { id: "folder", path: "C:\\work\\docs", kind: "folder", label: "docs" },
        ],
        activeId: "file",
      }, null, null);

      const tabs = host.querySelectorAll<HTMLElement>(".doc-tab");
      tabs[0].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
      expect([...document.querySelectorAll<HTMLElement>("#dropdown .dd-label")].map((item) => item.textContent)).toEqual([
        "エクスプローラで開く",
        "コマンドを登録...",
        "閉じる",
        "ほかのタブを閉じる",
        "右側のタブを閉じる",
        "保存済みのタブを閉じる",
      ]);
      const fileTabIcons = [
        ["エクスプローラで開く", MENU_ICON.explorer],
        ["コマンドを登録...", MENU_ICON.command],
        ["閉じる", MENU_ICON.close],
        ["ほかのタブを閉じる", MENU_ICON.closeOthers],
        ["右側のタブを閉じる", MENU_ICON.closeRight],
        ["保存済みのタブを閉じる", MENU_ICON.closeSaved],
      ] as const;
      for (const [label, icon] of fileTabIcons) {
        const menuItem = [...document.querySelectorAll<HTMLElement>("#dropdown .dd-item")]
          .find((element) => element.textContent === label);
        expect(menuItem?.querySelector(`.${icon}`), label).not.toBeNull();
      }
      [...document.querySelectorAll<HTMLElement>("#dropdown .dd-item")]
        .find((item) => item.textContent === "エクスプローラで開く")?.click();
      tabs[1].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
      expect([...document.querySelectorAll<HTMLElement>("#dropdown .dd-label")].map((item) => item.textContent))
        .toEqual([
          "エクスプローラで開く",
          "閉じる",
          "ほかのタブを閉じる",
          "右側のタブを閉じる",
          "保存済みのタブを閉じる",
        ]);
      const folderTabIcons = [
        ["エクスプローラで開く", MENU_ICON.explorer],
        ["閉じる", MENU_ICON.close],
        ["ほかのタブを閉じる", MENU_ICON.closeOthers],
        ["右側のタブを閉じる", MENU_ICON.closeRight],
        ["保存済みのタブを閉じる", MENU_ICON.closeSaved],
      ] as const;
      for (const [label, icon] of folderTabIcons) {
        const menuItem = [...document.querySelectorAll<HTMLElement>("#dropdown .dd-item")]
          .find((element) => element.textContent === label);
        expect(menuItem?.querySelector(`.${icon}`), label).not.toBeNull();
      }
      [...document.querySelectorAll<HTMLElement>("#dropdown .dd-item")]
        .find((item) => item.textContent === "エクスプローラで開く")?.click();

      await vi.waitFor(() => expect(reveal).toHaveBeenCalledTimes(2));
      expect(reveal).toHaveBeenNthCalledWith(1, "C:\\work\\memo.txt", false);
      expect(reveal).toHaveBeenNthCalledWith(2, "C:\\work\\docs", true);
    } finally {
      reveal.mockRestore();
    }
  });

  // Given: Explorer起動が Error("explorer failed") で失敗するファイルタブがある
  // When: タブのコンテキストメニューから「エクスプローラで開く」を実行する
  // Then: onErrorへErrorと標準メッセージを渡す
  it("Scenario: タブのExplorer起動失敗をエラー通知する", async () => {
    const reveal = vi.spyOn(api, "revealInExplorer").mockRejectedValueOnce(new Error("explorer failed"));
    const onError = vi.fn(async () => {});
    try {
      const { doc, host } = fixture();
      document.body.appendChild(Object.assign(document.createElement("div"), { id: "dropdown" }));
      const manager = new TabManager(host, doc, {
        onChange: () => {},
        onError,
        revealInExplorer: api.revealInExplorer,
      }, registeredCommandPorts);
      await manager.init({
        tabs: [{ id: "file", path: "C:\\work\\memo.txt", kind: "file", label: "memo.txt" }],
        activeId: "file",
      }, null, null);

      host.querySelector<HTMLElement>(".doc-tab")!.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true }),
      );
      [...document.querySelectorAll<HTMLElement>("#dropdown .dd-item")]
        .find((item) => item.textContent === "エクスプローラで開く")?.click();

      await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(
        expect.any(Error),
        "タブを操作できませんでした",
      ));
    } finally {
      reveal.mockRestore();
    }
  });

  // Given: パスを持たない無題タブが1つある
  // When: 無題タブのコンテキストメニューを表示する
  // Then: Explorerは表示せず、タブを閉じる操作だけを末尾グループとして並べる
  it("Scenario: 無題タブではExplorerを表示せず閉じる操作を並べる", async () => {
    const { doc, host } = fixture();
    document.body.appendChild(Object.assign(document.createElement("div"), { id: "dropdown" }));
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    await manager.init({
      tabs: [{ id: "blank", path: null, kind: "blank", label: "無題" }],
      activeId: "blank",
    }, null, null);

    host.querySelector<HTMLElement>(".doc-tab")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));

    expect([...document.querySelectorAll<HTMLElement>("#dropdown .dd-label")].map((item) => item.textContent)).toEqual([
      "閉じる",
      "ほかのタブを閉じる",
      "右側のタブを閉じる",
      "保存済みのタブを閉じる",
    ]);
    expect(document.querySelectorAll("#dropdown .dd-sep")).toHaveLength(0);
    const blankTabIcons = [
      ["閉じる", MENU_ICON.close],
      ["ほかのタブを閉じる", MENU_ICON.closeOthers],
      ["右側のタブを閉じる", MENU_ICON.closeRight],
      ["保存済みのタブを閉じる", MENU_ICON.closeSaved],
    ] as const;
    for (const [label, icon] of blankTabIcons) {
      const menuItem = [...document.querySelectorAll<HTMLElement>("#dropdown .dd-item")]
        .find((element) => element.textContent === label);
      expect(menuItem?.querySelector(`.${icon}`), label).not.toBeNull();
    }
  });
});

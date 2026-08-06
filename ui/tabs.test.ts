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

  // Given: activeId=folder、folderRoot が C:\work、selectedRelPath が sub\memo.txt、viewState の anchor/caret が各 line 10、topLine が8、scrollLeft が20
  // When: manager.init(folderTabs, null, null) を呼ぶ
  // Then: selectEntry("sub\\memo.txt") が goTo({ line: 10, col: 0 }) より先に呼ばれ、restoreViewState は呼ばれない
  it("Scenario: folder tabは選択中entryを開いてから選択行を復元する", async () => {
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
    expect(doc.goTo).toHaveBeenCalledWith({ line: 10, col: 0 });
    expect(doc.restoreViewState).not.toHaveBeenCalled();
    expect(vi.mocked(doc.selectEntry).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(doc.goTo).mock.invocationCallOrder[0]);
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
    expect(changes).toEqual([]);
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

    registeredCommandPorts.promptFields.mockResolvedValueOnce(["メモ帳", "", "notepad {file}"]);
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
      'notepad "C:\\work\\memo.txt"',
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
      const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
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

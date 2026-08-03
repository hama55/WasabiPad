// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { TabManager, type StoredTabs, type TabDocumentPort } from "./tabs";
import { initialSession } from "./session";
import { initSettings } from "./settings";
import { addRegisteredCommand, commandsForPath } from "./registered-commands";
import type { RegisteredCommandMenuPorts } from "./registered-command-menu";

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

describe("TabManager", () => {
  beforeEach(async () => {
    document.body.replaceChildren(document.createElement("div"));
    await initSettings();
    registeredCommandPorts.promptFields.mockReset();
    registeredCommandPorts.promptFields.mockResolvedValue(null);
    registeredCommandPorts.runExternalCommand.mockReset();
  });

  it("起動時はactive tabのリンクだけを開く", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    await manager.init(stored, null, null);

    expect(doc.openPath).toHaveBeenCalledTimes(1);
    expect(doc.openPath).toHaveBeenCalledWith("C:\\work\\a.txt", false);
  });

  it("folder tabは選択中entryを開いてから選択行を復元する", async () => {
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

  it("folder tabの選択中entryが削除済みでも親フォルダは開く", async () => {
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

  it("tab移動前に未保存確認を通し、移動先のリンクを読み込む", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    await manager.init(stored, null, null);
    await manager.activate("b");

    expect(doc.confirmDiscard).toHaveBeenCalledTimes(1);
    expect(doc.openPath).toHaveBeenLastCalledWith("C:\\work\\b.txt", false);
    expect(manager.state.activeId).toBe("b");
  });

  it("同じtabのファイル切替を戻る/進むで移動し、キャレット行を復元する", async () => {
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

  it("folder内の選択切替もリンクと行を履歴に保存する", async () => {
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

  it("戻った後に別のファイルへ移動すると進む履歴を破棄する", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    await manager.init(stored, null, null);
    await manager.navigatePath("C:\\work\\c.txt");
    await manager.goBack();
    await manager.navigatePath("C:\\work\\d.txt");

    expect(await manager.goForward()).toBe(false);
  });

  it("戻る履歴は10件まで保持する", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    await manager.init(stored, null, null);
    const paths = Array.from({ length: 12 }, (_, index) => `C:\\work\\${String.fromCharCode(99 + index)}.txt`);
    for (const path of paths) await manager.navigatePath(path);

    for (let index = 0; index < 10; index++) await manager.goBack();

    expect(manager.state.tabs[0].path).toBe(paths[1]);
    expect(await manager.goBack()).toBe(false);
  });

  it("ナビゲーション中の連打は2件目を実行しない", async () => {
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

  it("戻る先の読込が例外になっても現在位置と履歴を復元する", async () => {
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

  it("通常の切替がfalseで終わった場合は履歴を追加しない", async () => {
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

  it("folder内の戻る先を選択できない場合は現在位置へ復元する", async () => {
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

  it("タブごとに履歴を分離し、再初期化で履歴を消去する", async () => {
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

  it("active tabを検索結果の飛び先付きで開いたら、その場で位置を適用する", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    await manager.init(stored, null, null);

    await manager.open("C:\\work\\a.txt", { line: 8, col: 3 });

    expect(doc.goTo).toHaveBeenCalledWith({ line: 8, col: 3 });
    expect(manager.state.tabs[0].goto).toBeUndefined();
  });

  it("active tabの飛び先適用に失敗しても、消費済みの要求を残さない", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    await manager.init(stored, null, null);
    vi.mocked(doc.goTo).mockImplementationOnce(() => { throw new Error("invalid position"); });

    await expect(manager.open("C:\\work\\a.txt", { line: 8, col: 3 })).rejects.toThrow("invalid position");

    expect(manager.state.tabs[0].goto).toBeUndefined();
  });

  it("未保存確認で既存tabへの移動を取り消したら飛び先を残さない", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    await manager.init(stored, null, null);
    vi.mocked(doc.confirmDiscard).mockResolvedValue(false);

    await manager.open("C:\\work\\b.txt", { line: 8, col: 3 });

    vi.mocked(doc.confirmDiscard).mockResolvedValue(true);
    await manager.activate("b");
    expect(doc.goTo).not.toHaveBeenCalledWith({ line: 8, col: 3 });
  });

  it("移動先の読込失敗時は元active tabへ戻し、壊れた状態を保存しない", async () => {
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

  it("tabごとに選択位置と表示位置を復元する", async () => {
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

  it("保存完了時にtabが再描画されても要求したtabへ切り替える", async () => {
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

  it("確認処理がfalseかつdirtyのままなら切り替えない", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    await manager.init(stored, null, null);
    doc.current.dirty = true;
    vi.mocked(doc.confirmDiscard).mockResolvedValue(false);

    await manager.activate("b");

    expect(manager.state.activeId).toBe("a");
  });

  it("変更中のactive tabだけファイル名の先頭に印を付ける", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    await manager.init(stored, null, null);

    doc.current.dirty = true;
    manager.syncActive(doc.current);
    const labels = [...host.querySelectorAll<HTMLElement>(".doc-tab-label")].map((label) => label.textContent);

    expect(labels).toEqual(["● a.txt", "b.txt"]);
  });

  it("保存処理へ渡した継続処理が、確定した移動先tabを開く", async () => {
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

  it("tab列の末尾にある＋で新規tabを追加する", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} }, registeredCommandPorts);
    await manager.init(stored, null, null);

    host.querySelector<HTMLButtonElement>(".doc-tab-add")!.click();
    await vi.waitFor(() => expect(host.querySelectorAll(".doc-tab")).toHaveLength(3));

    expect(manager.state.tabs[2].kind).toBe("blank");
  });

  it("一括追加は重複を除き、active tabを切り替えない", async () => {
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

  it("タブをドラッグして並べ替え、直後のclickでは切り替えない", async () => {
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

  it("ウィンドウの外へドラッグすると新規ウィンドウへ移す", async () => {
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

  it("同じウィンドウ内のタブ領域外へのdropはキャンセルする", async () => {
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

  it("ファイルタブから登録し、登録コマンドを実行できる", async () => {
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

  it("タブの登録コマンド失敗は専用のエラー文言を渡す", async () => {
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

  it("ファイルとフォルダのタブをExplorerで開く", async () => {
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
      [...document.querySelectorAll<HTMLElement>("#dropdown .dd-item")]
        .find((item) => item.textContent === "エクスプローラで開く")?.click();
      tabs[1].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
      expect([...document.querySelectorAll<HTMLElement>("#dropdown .dd-label")].map((item) => item.textContent))
        .not.toContain("登録コマンド ▸");
      [...document.querySelectorAll<HTMLElement>("#dropdown .dd-item")]
        .find((item) => item.textContent === "エクスプローラで開く")?.click();

      await vi.waitFor(() => expect(reveal).toHaveBeenCalledTimes(2));
      expect(reveal).toHaveBeenNthCalledWith(1, "C:\\work\\memo.txt", false);
      expect(reveal).toHaveBeenNthCalledWith(2, "C:\\work\\docs", true);
    } finally {
      reveal.mockRestore();
    }
  });
});

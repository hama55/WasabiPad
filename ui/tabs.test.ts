// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TabManager, type StoredTabs } from "./tabs";
import type { DocumentController } from "./document-controller";
import { initialSession } from "./session";

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
  } as unknown as DocumentController;
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
  beforeEach(() => document.body.replaceChildren(document.createElement("div")));

  it("起動時はactive tabのリンクだけを開く", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} });
    await manager.init(stored, null, null);

    expect(doc.openPath).toHaveBeenCalledTimes(1);
    expect(doc.openPath).toHaveBeenCalledWith("C:\\work\\a.txt", false);
  });

  it("tab移動前に未保存確認を通し、移動先のリンクを読み込む", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} });
    await manager.init(stored, null, null);
    await manager.activate("b");

    expect(doc.confirmDiscard).toHaveBeenCalledTimes(1);
    expect(doc.openPath).toHaveBeenLastCalledWith("C:\\work\\b.txt", false);
    expect(manager.state.activeId).toBe("b");
  });

  it("tabごとに選択位置と表示位置を復元する", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} });
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
    const manager = new TabManager(host, doc, { onChange: () => {} });
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
    const manager = new TabManager(host, doc, { onChange: () => {} });
    await manager.init(stored, null, null);
    doc.current.dirty = true;
    vi.mocked(doc.confirmDiscard).mockResolvedValue(false);

    await manager.activate("b");

    expect(manager.state.activeId).toBe("a");
  });

  it("変更中のactive tabだけファイル名の先頭に印を付ける", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} });
    await manager.init(stored, null, null);

    doc.current.dirty = true;
    manager.syncActive(doc.current);
    const labels = [...host.querySelectorAll<HTMLElement>(".doc-tab-label")].map((label) => label.textContent);

    expect(labels).toEqual(["● a.txt", "b.txt"]);
  });

  it("保存処理へ渡した継続処理が、確定した移動先tabを開く", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} });
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
    const manager = new TabManager(host, doc, { onChange: () => {} });
    await manager.init(stored, null, null);

    host.querySelector<HTMLButtonElement>(".doc-tab-add")!.click();
    await vi.waitFor(() => expect(host.querySelectorAll(".doc-tab")).toHaveLength(3));

    expect(manager.state.tabs[2].kind).toBe("blank");
  });

  it("一括追加は重複を除き、active tabを切り替えない", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} });
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
    const manager = new TabManager(host, doc, { onChange: (state) => changes.push(state) });
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
    const manager = new TabManager(host, doc, { onChange: () => {}, onDetach });
    await manager.init(stored, null, null);
    const a = host.querySelector<HTMLElement>(".doc-tab")!;
    document.elementFromPoint = () => null;
    const at = (type: string, x: number) =>
      new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: 100 });

    a.dispatchEvent(at("pointerdown", 0));
    window.dispatchEvent(at("pointermove", -20));
    window.dispatchEvent(at("pointerup", -20));
    await vi.waitFor(() => expect(onDetach).toHaveBeenCalledWith("C:\\work\\a.txt"));

    expect(manager.state.tabs.map((tab) => tab.id)).toEqual(["b"]);
    expect(manager.state.activeId).toBe("b");
  });

  it("同じウィンドウ内のタブ領域外へのdropはキャンセルする", async () => {
    const { doc, host } = fixture();
    const onDetach = vi.fn(async () => true);
    const manager = new TabManager(host, doc, { onChange: () => {}, onDetach });
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
});

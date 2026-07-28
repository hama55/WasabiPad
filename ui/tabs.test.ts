// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TabManager, type StoredTabs } from "./tabs";
import type { DocumentController } from "./document-controller";
import { initialSession } from "./session";

function fixture() {
  const session = initialSession();
  const doc = {
    current: session,
    confirmDiscard: vi.fn(async () => true),
    openPath: vi.fn(async (path: string) => {
      session.savePath = path;
      session.displayPath = path;
      return true;
    }),
    newFile: vi.fn(async () => {}),
    goTo: vi.fn(),
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

  it("保存完了時にtabが再描画されても要求したtabへ切り替える", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} });
    await manager.init(stored, null, null);
    vi.mocked(doc.confirmDiscard).mockImplementation(async () => {
      manager.syncActive(doc.current);
      return true;
    });

    await manager.activate("b");

    expect(manager.state.activeId).toBe("b");
    expect(host.querySelector<HTMLButtonElement>(".doc-tab.active")?.title).toBe("C:\\work\\b.txt");
  });

  it("保存後に確認処理がfalseを返してもdirtyが消えていれば切り替える", async () => {
    const { doc, host } = fixture();
    const manager = new TabManager(host, doc, { onChange: () => {} });
    await manager.init(stored, null, null);
    doc.current.dirty = true;
    vi.mocked(doc.confirmDiscard).mockImplementation(async () => {
      doc.current.dirty = false;
      return false;
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
});

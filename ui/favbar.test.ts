// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { BmNode } from "./api";
import { FavBar, type BookmarkStore } from "./favbar";

function mount(initial: BmNode[] = [], storeOverrides: Partial<BookmarkStore> = {}) {
  document.body.innerHTML = `<div id="favbar"></div><div id="dropdown" hidden></div>`;
  const saved: BmNode[][] = [];
  const store: BookmarkStore = {
    load: async () => initial,
    save: async (nodes) => { saved.push(structuredClone(nodes)); },
    isDirectory: async (path) => !path.split("/").pop()!.includes("."),
    ...storeOverrides,
  };
  const opened: string[] = [];
  const addedGroups: { path: string; kind: "file" | "folder" }[][] = [];
  const favbar = new FavBar(
    document.getElementById("favbar")!,
    {
      onOpen: (path) => opened.push(path),
      onAddGroupToTabs: (items) => addedGroups.push(items),
      onError: async () => {},
      currentFile: () => "C:/work/memo.txt",
      onSetDefault: () => {},
    },
    store
  );
  return { favbar, saved, opened, addedGroups };
}

// jsdom は elementFromPoint / レイアウトを持たないので、落とし先とその矩形を差し替える
function dragOnto(from: HTMLElement, to: HTMLElement, ratio: number) {
  const rect = { left: 0, top: 0, width: 100, height: 20, right: 100, bottom: 20 };
  to.getBoundingClientRect = () => ({ ...rect, x: 0, y: 0, toJSON: () => "" });
  document.elementFromPoint = () => to;
  const at = (type: string, x: number) =>
    new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: rect.height * ratio });
  from.dispatchEvent(at("pointerdown", 0));
  window.dispatchEvent(at("pointermove", rect.width * ratio));
  window.dispatchEvent(at("pointerup", rect.width * ratio));
}

describe("FavBar", () => {
  it("保存も読込みも注入されたストアだけを使う", async () => {
    const { favbar, saved } = mount([{ kind: "file", name: "memo.txt", path: "C:/memo.txt" }]);
    await favbar.init();
    expect(document.querySelectorAll("#favbar button")).toHaveLength(1);

    await favbar.addExternal("C:/work/notes/");
    expect(saved).toHaveLength(1);
    expect(saved[0].map((node) => node.kind)).toEqual(["file", "directory"]);
    expect(document.querySelectorAll("#favbar button")).toHaveLength(2);
  });

  it("現在のファイルを追加すると末尾の区切りを落とす", async () => {
    const { favbar, saved } = mount([]);
    await favbar.init();
    await favbar.addCurrent();
    expect(saved[0]).toEqual([{ kind: "file", name: "memo.txt", path: "C:/work/memo.txt" }]);
  });

  it("保存失敗した追加を次の成功操作へ混入させない", async () => {
    const persisted: BmNode[][] = [];
    const save = vi.fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockImplementationOnce(async (nodes: BmNode[]) => {
        persisted.push(structuredClone(nodes));
      });
    const { favbar } = mount(
      [{ kind: "file", name: "base", path: "C:/base.txt" }],
      { save },
    );
    await favbar.init();

    await expect(favbar.addExternal("C:/failed.txt")).rejects.toThrow("disk full");
    await favbar.addExternal("C:/success.txt");

    expect(persisted[0].map((node) => node.name)).toEqual(["base", "success.txt"]);
    expect(document.querySelectorAll("#favbar button")).toHaveLength(2);
  });

  it("ドラッグで並べ替えできる", async () => {
    const { favbar, saved } = mount([
      { kind: "file", name: "a", path: "C:/a.txt" },
      { kind: "file", name: "b", path: "C:/b.txt" },
    ]);
    await favbar.init();
    const [a, b] = document.querySelectorAll<HTMLButtonElement>("#favbar button");
    dragOnto(a, b, 0.9);
    await vi.waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].map((node) => node.name)).toEqual(["b", "a"]);
  });

  it("ドラッグ直後のクリックは開かない", async () => {
    const { favbar, saved, opened } = mount([{ kind: "file", name: "a", path: "C:/a.txt" }]);
    await favbar.init();
    const a = document.querySelector<HTMLButtonElement>("#favbar button")!;
    dragOnto(a, a, 0.4);
    a.click();
    expect(saved).toEqual([]);
    expect(opened).toEqual([]);
  });

  it("グループの中央へ落とすと子になる", async () => {
    const { favbar, saved } = mount([
      { kind: "group", name: "g", children: [] },
      { kind: "file", name: "a", path: "C:/a.txt" },
    ]);
    await favbar.init();
    const [group, file] = document.querySelectorAll<HTMLButtonElement>("#favbar button");
    dragOnto(file, group, 0.5);
    await vi.waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toEqual([
      { kind: "group", name: "g", children: [{ kind: "file", name: "a", path: "C:/a.txt" }] },
    ]);
  });

  it("クリックは onOpen を呼ぶ", async () => {
    const { favbar, opened } = mount([{ kind: "file", name: "memo.txt", path: "C:/memo.txt" }]);
    await favbar.init();
    document.querySelector<HTMLButtonElement>("#favbar button")!.click();
    expect(opened).toEqual(["C:/memo.txt"]);
  });

  it("グループ直下の項目だけをタブへ一括追加する", async () => {
    const { favbar, addedGroups } = mount([{
      kind: "group",
      name: "work",
      children: [
        { kind: "file", name: "a", path: "C:/a.txt" },
        { kind: "directory", name: "src", path: "C:/src" },
        { kind: "group", name: "nested", children: [
          { kind: "file", name: "b", path: "C:/b.txt" },
        ] },
      ],
    }]);
    await favbar.init();
    document.querySelector<HTMLButtonElement>("#favbar button")!.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true })
    );
    const item = [...document.querySelectorAll<HTMLElement>("#dropdown > div")]
      .find((element) => element.textContent === "直下の項目をタブに一括追加")!;
    item.click();

    expect(addedGroups).toEqual([[
      { path: "C:/a.txt", kind: "file" },
      { path: "C:/src", kind: "folder" },
    ]]);
  });
});

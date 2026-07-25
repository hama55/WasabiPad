// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { BmNode } from "./api";
import { FavBar, type BookmarkStore } from "./favbar";

function mount(initial: BmNode[] = []) {
  document.body.innerHTML = `<div id="favbar"></div><div id="dropdown" hidden></div>`;
  const saved: BmNode[][] = [];
  const store: BookmarkStore = {
    load: async () => initial,
    save: async (nodes) => { saved.push(structuredClone(nodes)); },
    isDirectory: async (path) => !path.split("/").pop()!.includes("."),
  };
  const opened: string[] = [];
  const favbar = new FavBar(
    document.getElementById("favbar")!,
    { onOpen: (path) => opened.push(path), currentFile: () => "C:/work/memo.txt", onSetDefault: () => {} },
    store
  );
  return { favbar, saved, opened };
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

  it("クリックは onOpen を呼ぶ", async () => {
    const { favbar, opened } = mount([{ kind: "file", name: "memo.txt", path: "C:/memo.txt" }]);
    await favbar.init();
    document.querySelector<HTMLButtonElement>("#favbar button")!.click();
    expect(opened).toEqual(["C:/memo.txt"]);
  });
});

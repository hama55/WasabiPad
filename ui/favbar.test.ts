// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import * as api from "./api";
import type { BmNode } from "./api";
import { FavBar, type BookmarkStore } from "./favbar";
import { MENU_ICON } from "./menu-icons";

function mount(
  initial: BmNode[] = [],
  storeOverrides: Partial<BookmarkStore> = {},
  onError: (error: unknown) => Promise<void> = async () => {},
) {
  document.body.innerHTML = `<div id="favbar"></div><div id="dropdown" hidden></div>`;
  const saved: BmNode[][] = [];
  const store: BookmarkStore = {
    load: async () => initial,
    save: async (nodes) => { saved.push(structuredClone(nodes)); },
    isDirectory: async (path) => !path.split("/").pop()!.includes("."),
    ...storeOverrides,
  };
  const opened: { path: string; newTab: boolean }[] = [];
  const addedGroups: { path: string; kind: "file" | "folder" }[][] = [];
  const favbar = new FavBar(
    document.getElementById("favbar")!,
    {
      onOpen: (path, newTab) => { opened.push({ path, newTab }); },
      onAddGroupToTabs: (items) => addedGroups.push(items),
      revealInExplorer: (path, isDir) => api.revealInExplorer(path, isDir),
      onError,
      currentFile: () => "C:/work/memo.txt",
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

describe("Feature: FavBar", () => {
  // Given: 注入ストアが`memo.txt`を返し、保存結果を記録する
  // When: `init()`後に`addExternal("C:/work/notes/")`
  // Then: 保存1回、kindが`file,directory`、button数2
  it("Scenario: 保存も読込みも注入されたストアだけを使う", async () => {
    const { favbar, saved } = mount([{ kind: "file", name: "memo.txt", path: "C:/memo.txt" }]);
    await favbar.init();
    expect(document.querySelectorAll("#favbar button")).toHaveLength(1);

    await favbar.addExternal("C:/work/notes/");
    expect(saved).toHaveLength(1);
    expect(saved[0].map((node) => node.kind)).toEqual(["file", "directory"]);
    expect(document.querySelectorAll("#favbar button")).toHaveLength(2);
  });

  // Given: 現在ファイルが`C:/work/memo.txt`、お気に入り空
  // When: `init()`後に`addCurrent()`
  // Then: `{kind:"file",name:"memo.txt",path:"C:/work/memo.txt"}`を保存
  it("Scenario: 現在のファイルを追加すると末尾の区切りを落とす", async () => {
    const { favbar, saved } = mount([]);
    await favbar.init();
    await favbar.addCurrent();
    expect(saved[0]).toEqual([{ kind: "file", name: "memo.txt", path: "C:/work/memo.txt" }]);
  });

  // Given: 初回saveが`disk full`で失敗し、次回saveは成功する
  // When: 失敗追加後に`C:/success.txt`を追加
  // Then: 保存内容は`base,success.txt`、button数2
  it("Scenario: 保存失敗した追加を次の成功操作へ混入させない", async () => {
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

  // Given: お気に入りが`a`,`b`の順
  // When: `a`を`b`の末尾へドラッグ
  // Then: 保存順が`b,a`
  it("Scenario: ドラッグで並べ替えできる", async () => {
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

  // Given: お気に入りが`a`だけ
  // When: `a`自身へドラッグ後にクリック
  // Then: 保存も`onOpen`も発生しない
  it("Scenario: ドラッグ直後のクリックは開かない", async () => {
    const { favbar, saved, opened } = mount([{ kind: "file", name: "a", path: "C:/a.txt" }]);
    await favbar.init();
    const a = document.querySelector<HTMLButtonElement>("#favbar button")!;
    dragOnto(a, a, 0.4);
    a.click();
    expect(saved).toEqual([]);
    expect(opened).toEqual([]);
  });

  // Given: お気に入りのドラッグ中でゴースト要素が表示されている
  // When: OSから pointercancel を受け取る
  // Then: ドラッグ状態、ゴースト、windowイベントを後始末する
  it("Scenario: pointercancel時にドラッグを後始末する", async () => {
    const { favbar } = mount([{ kind: "file", name: "a", path: "C:/a.txt" }]);
    await favbar.init();
    const a = document.querySelector<HTMLButtonElement>("#favbar button")!;
    a.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 0, clientY: 0 }));
    window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 20, clientY: 0 }));
    expect(document.querySelector(".fav-ghost")).not.toBeNull();

    window.dispatchEvent(new Event("pointercancel"));

    expect(document.querySelector(".fav-ghost")).toBeNull();
  });

  // Given: お気に入りのドラッグ中でゴースト要素が表示されている
  // When: ウィンドウのblurを受け取る
  // Then: ドラッグ状態とゴーストを後始末する
  it("Scenario: window blur時にドラッグを後始末する", async () => {
    const { favbar } = mount([{ kind: "file", name: "a", path: "C:/a.txt" }]);
    await favbar.init();
    const a = document.querySelector<HTMLButtonElement>("#favbar button")!;
    a.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 0, clientY: 0 }));
    window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 20, clientY: 0 }));
    expect(document.querySelector(".fav-ghost")).not.toBeNull();

    window.dispatchEvent(new Event("blur"));

    expect(document.querySelector(".fav-ghost")).toBeNull();
  });

  // Given: 空group`g`とfile`a`がトップレベルにある
  // When: `a`をgroup中央へドラッグ
  // Then: `g.children`に`a`が入り、トップレベルから外れる
  it("Scenario: グループの中央へ落とすと子になる", async () => {
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

  // Given: `memo.txt`がお気に入りにある
  // When: buttonをクリック
  // Then: `onOpen("C:/memo.txt", true)`を呼ぶ
  it("Scenario: 左クリックは新規タブで開く", async () => {
    const { favbar, opened } = mount([{ kind: "file", name: "memo.txt", path: "C:/memo.txt" }]);
    await favbar.init();
    document.querySelector<HTMLButtonElement>("#favbar button")!.click();
    expect(opened).toEqual([{ path: "C:/memo.txt", newTab: true }]);
  });

  // Given: group直下にfile`a`とdirectory`src`、nested groupに`b`がある
  // When: groupのコンテキストメニューから一括追加
  // Then: `a`と`src`だけをタブ追加
  it("Scenario: グループ直下の項目だけをタブへ一括追加する", async () => {
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
    expect([...document.querySelectorAll("#dropdown .dd-label")].map((label) => label.textContent))
      .toEqual(["直下の項目をタブに一括追加", "パスを追加...", "グループを追加...", "移動 ▸", "削除"]);
    expect(document.querySelectorAll("#dropdown .dd-sep")).toHaveLength(3);
    const groupIcons = [
      ["直下の項目をタブに一括追加", MENU_ICON.addGroupTabs],
      ["パスを追加...", MENU_ICON.addPath],
      ["グループを追加...", MENU_ICON.addGroup],
      ["移動 ▸", MENU_ICON.move],
      ["削除", MENU_ICON.delete],
    ] as const;
    for (const [label, icon] of groupIcons) {
      const menuItem = [...document.querySelectorAll<HTMLElement>("#dropdown .dd-item")]
        .find((element) => element.textContent === label);
      expect(menuItem?.querySelector(`.${icon}`), label).not.toBeNull();
    }
    const item = [...document.querySelectorAll<HTMLElement>("#dropdown > div")]
      .find((element) => element.textContent === "直下の項目をタブに一括追加")!;
    item.click();

    expect(addedGroups).toEqual([[
      { path: "C:/a.txt", kind: "file" },
      { path: "C:/src", kind: "folder" },
    ]]);
  });

  // Given: file`memo.txt`とdirectory`docs`がある
  // When: 各Explorer項目をクリック
  // Then: デフォルト設定項目なし、`reveal`にfile=`false`、directory=`true`
  it("Scenario: お気に入りのファイルとフォルダをExplorerで開き、デフォルト設定項目を表示しない", async () => {
    const reveal = vi.spyOn(api, "revealInExplorer").mockResolvedValue();
    try {
      const { favbar } = mount([
        { kind: "file", name: "memo.txt", path: "C:/memo.txt" },
        { kind: "directory", name: "docs", path: "C:/docs" },
      ]);
      await favbar.init();
      const buttons = document.querySelectorAll<HTMLButtonElement>("#favbar button");

      buttons[0].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
      expect([...document.querySelectorAll("#dropdown .dd-label")].map((label) => label.textContent))
        .toEqual(["エクスプローラで開く", "新規タブで開く", "編集...", "移動 ▸", "削除"]);
      expect(document.querySelectorAll("#dropdown .dd-sep")).toHaveLength(2);
      const itemIcons = [
        ["エクスプローラで開く", MENU_ICON.explorer],
        ["新規タブで開く", MENU_ICON.newTab],
        ["編集...", MENU_ICON.rename],
        ["移動 ▸", MENU_ICON.move],
        ["削除", MENU_ICON.delete],
      ] as const;
      for (const [label, icon] of itemIcons) {
        const menuItem = [...document.querySelectorAll<HTMLElement>("#dropdown .dd-item")]
          .find((element) => element.textContent === label);
        expect(menuItem?.querySelector(`.${icon}`), label).not.toBeNull();
      }
      expect([...document.querySelectorAll("#dropdown .dd-label")].map((label) => label.textContent))
        .not.toContain("デフォルトに設定");
      [...document.querySelectorAll<HTMLElement>("#dropdown .dd-item")]
        .find((item) => item.textContent === "エクスプローラで開く")?.click();

      buttons[1].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
      [...document.querySelectorAll<HTMLElement>("#dropdown .dd-item")]
        .find((item) => item.textContent === "エクスプローラで開く")?.click();
      await vi.waitFor(() => expect(reveal).toHaveBeenCalledTimes(2));

      expect(reveal).toHaveBeenNthCalledWith(1, "C:/memo.txt", false);
      expect(reveal).toHaveBeenNthCalledWith(2, "C:/docs", true);
    } finally {
      reveal.mockRestore();
    }
  });

  // Given: お気に入りのExplorer起動が Error("explorer failed") で失敗する
  // When: ファイルのコンテキストメニューから「エクスプローラで開く」を実行する
  // Then: onErrorへ失敗したErrorを渡す
  it("Scenario: お気に入りのExplorer起動失敗をエラー通知する", async () => {
    const reveal = vi.spyOn(api, "revealInExplorer").mockRejectedValueOnce(new Error("explorer failed"));
    const onError = vi.fn(async () => {});
    try {
      const { favbar } = mount([
        { kind: "file", name: "memo.txt", path: "C:/memo.txt" },
      ], {}, onError);
      await favbar.init();
      document.querySelector<HTMLButtonElement>("#favbar button")!.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true }),
      );
      [...document.querySelectorAll<HTMLElement>("#dropdown .dd-item")]
        .find((item) => item.textContent === "エクスプローラで開く")?.click();

      await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.any(Error)));
    } finally {
      reveal.mockRestore();
    }
  });
});

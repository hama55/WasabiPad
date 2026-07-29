// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentController } from "./document-controller";
import { FolderActions, type FolderActionsPorts } from "./folder-actions";

function fixture() {
  const dropdown = document.createElement("div");
  dropdown.id = "dropdown";
  document.body.replaceChildren(dropdown);
  const doc = {
    current: { folderRoot: "C:\\work" },
  } as unknown as DocumentController;
  const ports = {
    sidebar: {
      setEntries: vi.fn(),
      selectByRelPath: vi.fn(),
      refreshFolderEntries: vi.fn(async () => {}),
    },
    onOpenInNewTab: vi.fn(),
    onOpenInNewWindow: vi.fn(),
    onAddFavorite: vi.fn(),
    onSetStartupPath: vi.fn(),
    onOpenPath: vi.fn(),
  } satisfies FolderActionsPorts;
  return { actions: new FolderActions(doc, ports), dropdown, ports };
}

describe("FolderActions", () => {
  beforeEach(() => document.body.replaceChildren());

  it("右クリック項目を操作別に区切り、新規ウィンドウで開ける", () => {
    const { actions, dropdown, ports } = fixture();
    const goto = { line: 499, col: 8 };
    actions.showContextMenu(0, 0, { relPath: "memo.txt", isDir: false, goto });

    expect([...dropdown.querySelectorAll(".dd-label")].map((label) => label.textContent)).toEqual([
      "新規タブで開く",
      "新規ウィンドウで開く",
      "アプリで開く",
      "アドレスバーに設定",
      "新規メモ作成...",
      "名前を変更...",
      "お気に入りに追加",
      "エクスプローラで開く",
    ]);
    expect(dropdown.querySelectorAll(".dd-sep")).toHaveLength(2);

    dropdown.querySelectorAll<HTMLElement>(".dd-item")[1].click();
    expect(ports.onOpenInNewWindow).toHaveBeenCalledWith("C:\\work\\memo.txt", goto);
  });
});

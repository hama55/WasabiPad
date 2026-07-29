// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { showError } from "./dialogs";
import { initialSession } from "./session";
import {
  FolderActions,
  type FolderActionsPorts,
  type FolderDocumentPort,
} from "./folder-actions";
import type { MemoSpec } from "./document-controller";

vi.mock("./dialogs", () => ({ showError: vi.fn(async () => {}) }));

function fixture() {
  const dropdown = document.createElement("div");
  dropdown.id = "dropdown";
  document.body.replaceChildren(dropdown);
  const session = initialSession();
  session.folderRoot = "C:\\work";
  const doc = {
    current: session,
    promptMemoSpec: vi.fn(async (): Promise<MemoSpec | null> => null),
    setSelectedRelPath: vi.fn(),
    applyDocInfo: vi.fn(),
    applyRenamed: vi.fn(),
  } satisfies FolderDocumentPort;
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
  return { actions: new FolderActions(doc, ports), doc, dropdown, ports };
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

  it("作成成功後の一覧更新失敗を作成失敗として表示しない", async () => {
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
      byte_len: 0,
      is_huge: false,
    } satisfies api.DocInfo;
    doc.promptMemoSpec.mockResolvedValueOnce({ stem: "memo", extension: "txt" });
    vi.spyOn(api, "createNote").mockResolvedValueOnce(docInfo);
    ports.sidebar.refreshFolderEntries.mockRejectedValueOnce(new Error("refresh failed"));

    await actions.createNote(null);

    expect(api.createNote).toHaveBeenCalled();
    expect(showError).toHaveBeenCalledWith(
      "メモは作成されましたが一覧を更新できませんでした",
      expect.any(Error),
    );
  });
});

// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { showError } from "./dialogs";
import { initialSession } from "./session";
import { initSettings } from "./settings";
import { addRegisteredCommand, commandsForPath } from "./registered-commands";
import {
  FolderActions,
  isImagePath,
  openInOtherApp,
  revealInExplorer,
  type FolderActionsPorts,
  type FolderDocumentPort,
} from "./folder-actions";
import type { RegisteredCommandMenuPorts } from "./registered-command-menu";
import type { MemoSpec } from "./document-controller";

vi.mock("./dialogs", () => ({ showError: vi.fn(async () => {}) }));
vi.mock("./api", async (importOriginal) => ({
  ...await importOriginal<typeof import("./api")>(),
  loadSettings: vi.fn(async () => "{}"),
  updateSetting: vi.fn(async () => {}),
  runExternalCommand: vi.fn(async () => {}),
}));
vi.mock("./prompt", async (importOriginal) => ({
  ...await importOriginal<typeof import("./prompt")>(),
  confirmMessage: vi.fn(async () => true),
  promptFields: vi.fn(async () => null),
}));
import { confirmMessage, promptFields } from "./prompt";

const registeredCommandPorts: RegisteredCommandMenuPorts = {
  promptFields,
  runExternalCommand: vi.mocked(api.runExternalCommand),
};

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
    onOpenViewer: vi.fn(),
    onAddFavorite: vi.fn(),
    onSetStartupPath: vi.fn(),
    onOpenPath: vi.fn(),
  } satisfies FolderActionsPorts;
  return {
    actions: new FolderActions(doc, ports, {
      api,
      showError,
      confirmMessage,
      promptFields,
      registeredCommandPorts,
      getStartupPath: () => null,
      revealInExplorer,
      openInOtherApp,
    }),
    doc,
    dropdown,
    ports,
  };
}

describe("FolderActions", () => {
  beforeEach(async () => {
    document.body.replaceChildren();
    await initSettings();
    vi.mocked(api.runExternalCommand).mockClear();
    vi.mocked(showError).mockClear();
    vi.mocked(promptFields).mockReset();
    vi.mocked(promptFields).mockResolvedValue(null);
  });

  it("右クリック項目を操作別に区切り、新規ウィンドウで開ける", () => {
    const { actions, dropdown, ports } = fixture();
    const goto = { line: 499, col: 8 };
    actions.showContextMenu(0, 0, { relPath: "memo.txt", isDir: false, goto });

    expect([...dropdown.querySelectorAll(".dd-label")].map((label) => label.textContent)).toEqual([
      "新規タブで開く",
      "新規ウィンドウで開く",
      "アプリで開く",
      "コマンドを登録...",
      "アドレスバーに設定",
      "新規メモ作成...",
      "名前を変更...",
      "その他 ▸",
      "お気に入りに追加",
      "エクスプローラで開く",
    ]);
    expect(dropdown.querySelectorAll(".dd-sep")).toHaveLength(2);

    dropdown.querySelectorAll<HTMLElement>(".dd-item")[1].click();
    expect(ports.onOpenInNewWindow).toHaveBeenCalledWith("C:\\work\\memo.txt", goto);
  });

  it("CSVとMarkdownだけに対応するビューを表示する", () => {
    const { actions, dropdown, ports } = fixture();
    actions.showContextMenu(0, 0, { relPath: "table.CSV", isDir: false });

    expect([...dropdown.querySelectorAll(".dd-label")].map((label) => label.textContent)).toContain("CSVビュー");
    dropdown.querySelectorAll<HTMLElement>(".dd-item")[2].click();
    expect(ports.onOpenViewer).toHaveBeenCalledWith("table.CSV", "csv");

    actions.showContextMenu(0, 0, { relPath: "memo.txt", isDir: false });
    expect([...dropdown.querySelectorAll(".dd-label")].map((label) => label.textContent)).not.toContain("CSVビュー");
    expect([...dropdown.querySelectorAll(".dd-label")].map((label) => label.textContent)).not.toContain("Markdownビュー");
  });

  it("拡張子別の登録コマンドを表示して実行できる", async () => {
    addRegisteredCommand({ extension: ".html", label: "Chrome", prefix: "cmd.exe /D /C", command: "chrome {file}" });
    const { actions, dropdown } = fixture();
    actions.showContextMenu(0, 0, { relPath: "index.html", isDir: false });

    const registered = [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "登録コマンド ▸");
    registered!.click();
    const commandItem = dropdown.querySelector<HTMLElement>(".dd-submenu .dd-item")!;
    expect([...commandItem.querySelectorAll<HTMLButtonElement>(".dd-trailing")].map((button) => button.textContent))
      .toEqual(["⚙", "×"]);
    commandItem.click();

    await vi.waitFor(() => expect(api.runExternalCommand).toHaveBeenCalledWith(
      'cmd.exe /D /C chrome "C:\\work\\index.html"',
      "C:\\work\\index.html",
    ));
  });

  it("登録コマンドの実行失敗を表示する", async () => {
    addRegisteredCommand({ extension: ".html", label: "Chrome", prefix: "", command: "chrome {file}" });
    vi.mocked(api.runExternalCommand).mockRejectedValueOnce(new Error("command failed"));
    const { actions, dropdown } = fixture();
    actions.showContextMenu(0, 0, { relPath: "index.html", isDir: false });

    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "登録コマンド ▸")!.click();
    dropdown.querySelector<HTMLElement>(".dd-submenu .dd-item")!.click();

    await vi.waitFor(() => expect(showError).toHaveBeenCalledWith(
      "登録コマンドを実行できませんでした",
      expect.any(Error),
    ));
  });

  it("登録時は選択ファイルの拡張子をコマンドへ紐付ける", async () => {
    vi.mocked(promptFields).mockResolvedValueOnce(["Chrome", "", "chrome {file}"]);
    const { actions, dropdown } = fixture();
    actions.showContextMenu(0, 0, { relPath: "index.HTML", isDir: false });

    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "コマンドを登録...")!.click();

    expect(vi.mocked(promptFields).mock.calls[0][1][2]).toMatchObject({
      label: "コマンド（{file}=対象ファイル、引用符不要）",
    });
    expect(vi.mocked(promptFields).mock.calls[0][1][1]).toMatchObject({
      label: "プレフィックス（任意。必要時の例: cmd.exe /D /C）",
      value: "",
    });

    await vi.waitFor(() => expect(commandsForPath("index.html")).toEqual([
      { extension: ".html", label: "Chrome", prefix: "", command: "chrome {file}" },
    ]));
  });

  it("登録コマンドを歯車から編集し、×から削除できる", async () => {
    addRegisteredCommand({ extension: ".html", label: "Chrome", prefix: "", command: "chrome {file}" });
    const { actions, dropdown } = fixture();
    actions.showContextMenu(0, 0, { relPath: "index.html", isDir: false });
    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "登録コマンド ▸")!.click();

    vi.mocked(promptFields).mockResolvedValueOnce(["Chrome Dev", "cmd.exe /D /C", "chrome --incognito {file}"]);
    dropdown.querySelectorAll<HTMLButtonElement>(".dd-submenu .dd-trailing")[0].click();
    await vi.waitFor(() => expect(commandsForPath("index.html")).toEqual([
      { extension: ".html", label: "Chrome Dev", prefix: "cmd.exe /D /C", command: "chrome --incognito {file}" },
    ]));

    actions.showContextMenu(0, 0, { relPath: "index.html", isDir: false });
    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "登録コマンド ▸")!.click();
    dropdown.querySelectorAll<HTMLButtonElement>(".dd-submenu .dd-trailing")[1].click();
    expect(commandsForPath("index.html")).toEqual([]);
  });

  it("ファイルのExplorerメニューはその絶対パスを渡す", async () => {
    const reveal = vi.spyOn(api, "revealInExplorer").mockResolvedValue();
    try {
      const { actions, dropdown } = fixture();
      actions.showContextMenu(0, 0, { relPath: "memo.txt", isDir: false });
      [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
        .find((item) => item.textContent === "エクスプローラで開く")?.click();

      await vi.waitFor(() => expect(reveal).toHaveBeenCalledWith("C:\\work\\memo.txt", false));
    } finally {
      reveal.mockRestore();
    }
  });

  it("Explorer起動失敗をフォルダ操作の文脈で表示する", async () => {
    const reveal = vi.spyOn(api, "revealInExplorer").mockRejectedValueOnce(new Error("explorer failed"));
    try {
      const { actions, dropdown } = fixture();
      actions.showContextMenu(0, 0, { relPath: "memo.txt", isDir: false });
      [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
        .find((item) => item.textContent === "エクスプローラで開く")!.click();

      await vi.waitFor(() => expect(showError).toHaveBeenCalledWith(
        "エクスプローラで開けませんでした",
        expect.any(Error),
      ));
    } finally {
      reveal.mockRestore();
    }
  });

  it("画像ファイルの拡張子を大文字小文字に関係なく判定する", () => {
    expect(isImagePath("picture.PNG")).toBe(true);
    expect(isImagePath("picture.webp")).toBe(true);
    expect(isImagePath("memo.md")).toBe(false);
  });

  it("削除はその他サブメニューを経由する", async () => {
    const { actions, dropdown, ports } = fixture();
    vi.spyOn(api, "deleteEntry").mockResolvedValueOnce({} as api.DocInfo);
    actions.showContextMenu(0, 0, { relPath: "memo.txt", isDir: false });

    const other = [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent?.includes("その他"));
    other!.click();
    expect(dropdown.querySelector<HTMLElement>(".dd-submenu .dd-item")?.textContent).toBe("削除");
    dropdown.querySelector<HTMLElement>(".dd-submenu .dd-item")!.click();
    await vi.waitFor(() => expect(api.deleteEntry).toHaveBeenCalledWith("memo.txt"));

    expect(confirmMessage).toHaveBeenCalledWith(
      "削除",
      "「memo.txt」ファイルを削除します。元に戻せません。",
      "削除",
    );
    expect(ports.sidebar.refreshFolderEntries).toHaveBeenCalled();
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

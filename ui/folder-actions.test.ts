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
import { MENU_ICON } from "./menu-icons";

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
  const expandAllFolder = vi.fn();
  const doc = {
    current: session,
    promptMemoSpec: vi.fn(async (): Promise<MemoSpec | null> => null),
    setSelectedRelPath: vi.fn(),
    applyDocInfo: vi.fn(),
    applyRenamed: vi.fn(),
  } satisfies FolderDocumentPort;
  const sidebar = {
    setEntries: vi.fn(),
    selectByRelPath: vi.fn(),
    refreshFolderEntries: vi.fn(async () => {}),
    expandAllFolder,
  };
  const ports = {
    sidebar,
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
    expandAllFolder,
  };
}

describe("Feature: FolderActions", () => {
  beforeEach(async () => {
    document.body.replaceChildren();
    await initSettings();
    vi.mocked(api.runExternalCommand).mockClear();
    vi.mocked(showError).mockClear();
    vi.mocked(promptFields).mockReset();
    vi.mocked(promptFields).mockResolvedValue(null);
  });

  // Given: rootが`C:\work`、対象が`memo.txt`、gotoが`{line:499,col:8}`
  // When: コンテキストメニュー表示後に新規ウィンドウ項目をクリック
  // Then: 10項目・区切り3個、Explorerが先頭で、絶対パスとgotoを渡す
  it("Scenario: 右クリック項目を操作別に区切り、新規ウィンドウで開ける", () => {
    const { actions, dropdown, ports } = fixture();
    const goto = { line: 499, col: 8 };
    actions.showContextMenu(0, 0, { relPath: "memo.txt", isDir: false, goto });

    expect([...dropdown.querySelectorAll(".dd-label")].map((label) => label.textContent)).toEqual([
      "エクスプローラで開く",
      "新規タブで開く",
      "新規ウィンドウで開く",
      "アプリで開く",
      "コマンドを登録...",
      "アドレスバーに設定",
      "お気に入りに追加",
      "新規メモ作成...",
      "名前を変更...",
      "その他 ▸",
    ]);
    expect(dropdown.querySelectorAll(".dd-sep")).toHaveLength(3);
    const expectedIcons = [
      ["エクスプローラで開く", MENU_ICON.explorer],
      ["新規タブで開く", MENU_ICON.newTab],
      ["新規ウィンドウで開く", MENU_ICON.newWindow],
      ["アプリで開く", MENU_ICON.external],
      ["コマンドを登録...", MENU_ICON.command],
      ["アドレスバーに設定", MENU_ICON.address],
      ["お気に入りに追加", MENU_ICON.favorite],
      ["新規メモ作成...", MENU_ICON.newMemo],
      ["名前を変更...", MENU_ICON.rename],
      ["その他 ▸", MENU_ICON.more],
    ] as const;
    for (const [label, icon] of expectedIcons) {
      const item = [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
        .find((element) => element.textContent === label);
      expect(item?.querySelector(`.${icon}`), label).not.toBeNull();
    }

    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "新規ウィンドウで開く")!.click();
    expect(ports.onOpenInNewWindow).toHaveBeenCalledWith("C:\\work\\memo.txt", goto);
  });

  // Given: rootが`C:\\work`、対象が`docs`フォルダ
  // When: フォルダの右クリックメニューから「フォルダを全展開」を選ぶ
  // Then: 対象の相対パスでフォルダ全展開を依頼する
  it("Scenario: フォルダメニューから対象フォルダを全展開する", () => {
    const { actions, dropdown, expandAllFolder } = fixture();
    actions.showContextMenu(0, 0, { relPath: "docs", isDir: true });

    const item = [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((element) => element.textContent === "フォルダを全展開");
    expect(item?.textContent).toBe("フォルダを全展開");
    expect(item?.querySelector(`.${MENU_ICON.expandFolder}`)).not.toBeNull();
    if (!item) return;
    item.click();

    expect(expandAllFolder).toHaveBeenCalledWith("docs");
  });

  // Given: フォルダ全展開の取得が`expand failed`でrejectする
  // When: フォルダの右クリックメニューから「フォルダを全展開」をクリックする
  // Then: フォルダ操作の失敗として`showError`へ通知する
  it("Scenario: フォルダ全展開の失敗を表示する", async () => {
    const error = new Error("expand failed");
    const { actions, dropdown, expandAllFolder } = fixture();
    expandAllFolder.mockRejectedValueOnce(error);
    actions.showContextMenu(0, 0, { relPath: "docs", isDir: true });

    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "フォルダを全展開")!.click();

    await vi.waitFor(() => expect(showError).toHaveBeenCalledWith(
      "フォルダを全展開できませんでした",
      error,
    ));
  });

  // Given: ファイル、フォルダ、空白部の右クリックメニューを表示する
  // When: 各メニューの表示項目を調べる
  // Then: すべての項目にメニューアイコンが付いている
  it("Scenario: 右クリックメニューの全項目にアイコンを表示する", () => {
    const { actions, dropdown } = fixture();
    for (const target of [
      { relPath: "memo.txt", isDir: false },
      { relPath: "docs", isDir: true },
      null,
    ] as const) {
      actions.showContextMenu(0, 0, target);
      const missing = [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
        .filter((item) => !item.querySelector(".menu-icon, .fav-icon"))
        .map((item) => item.textContent);
      expect(missing, target?.relPath ?? "空白部").toEqual([]);
    }
  });

  // Given: 対象が`table.CSV`、`photo.PNG`、`memo.txt`
  // When: 各コンテキストメニューを表示し対応ビュー項目をクリック
  // Then: CSV/Imageビューは対応形式を渡し、memoにはビューを表示しない
  it("Scenario: CSVとImageの対応ファイルにビューを表示する", () => {
    const { actions, dropdown, ports } = fixture();
    actions.showContextMenu(0, 0, { relPath: "table.CSV", isDir: false });

    expect([...dropdown.querySelectorAll(".dd-label")].map((label) => label.textContent)).toContain("CSVビュー");
    expect(dropdown.querySelector(`.dd-item .${MENU_ICON.csv}`)).not.toBeNull();
    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "CSVビュー")!.click();
    expect(ports.onOpenViewer).toHaveBeenCalledWith("table.CSV", "csv");

    actions.showContextMenu(0, 0, { relPath: "photo.PNG", isDir: false });
    expect([...dropdown.querySelectorAll(".dd-label")].map((label) => label.textContent)).toContain("Imageビュー");
    expect(dropdown.querySelector(`.dd-item .${MENU_ICON.image}`)).not.toBeNull();
    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "Imageビュー")!.click();
    expect(ports.onOpenViewer).toHaveBeenCalledWith("photo.PNG", "image");

    actions.showContextMenu(0, 0, { relPath: "memo.txt", isDir: false });
    expect([...dropdown.querySelectorAll(".dd-label")].map((label) => label.textContent)).not.toContain("CSVビュー");
    expect([...dropdown.querySelectorAll(".dd-label")].map((label) => label.textContent)).not.toContain("Markdownビュー");
    expect([...dropdown.querySelectorAll(".dd-label")].map((label) => label.textContent)).not.toContain("Imageビュー");
  });

  // Given: rootが`C:\work`で対象がない
  // When: フォルダ空白部のコンテキストメニューを表示する
  // Then: Explorerが先頭にあり、新規作成とお気に入り追加が残り、rootをフォルダとして開く
  it("Scenario: 対象なしのフォルダメニューでもExplorerを先頭にする", async () => {
    const reveal = vi.spyOn(api, "revealInExplorer").mockResolvedValue();
    try {
      const { actions, dropdown } = fixture();
      actions.showContextMenu(0, 0, null);

      expect([...dropdown.querySelectorAll(".dd-label")].map((label) => label.textContent)).toEqual([
        "エクスプローラで開く",
        "新規メモ作成...",
        "お気に入りに追加",
      ]);
      expect(dropdown.querySelectorAll(".dd-sep")).toHaveLength(2);
      for (const [label, icon] of [
        ["エクスプローラで開く", MENU_ICON.explorer],
        ["新規メモ作成...", MENU_ICON.newMemo],
        ["お気に入りに追加", MENU_ICON.favorite],
      ] as const) {
        const item = [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
          .find((element) => element.textContent === label);
        expect(item?.querySelector(`.${icon}`), label).not.toBeNull();
      }
      dropdown.querySelector<HTMLElement>(".dd-item:first-child")!.click();

      await vi.waitFor(() => expect(reveal).toHaveBeenCalledWith("C:\\work", true));
    } finally {
      reveal.mockRestore();
    }
  });

  // Given: `.html`用Chromeコマンドを登録済み
  // When: `index.html`の登録コマンドを開いて実行
  // Then: trailingが`⚙,×`、絶対パス入りコマンドを実行
  it("Scenario: 拡張子別の登録コマンドを表示して実行できる", async () => {
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

  // Given: `.html`用コマンド実行が`command failed`でreject
  // When: 登録コマンドをクリック
  // Then: `showError("登録コマンドを実行できませんでした", Error)`
  it("Scenario: 登録コマンドの実行失敗を表示する", async () => {
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

  // Given: promptが`Chrome`,``,`chrome {file}`を返す
  // When: `index.HTML`でコマンド登録
  // Then: 拡張子`.html`で登録、各promptラベルと空prefixを表示
  it("Scenario: 登録時は選択ファイルの拡張子をコマンドへ紐付ける", async () => {
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

  // Given: Chromeコマンドを登録済み
  // When: gearで更新後、再表示して×で削除
  // Then: Chrome Devの内容へ更新後、一覧が空になる
  it("Scenario: 登録コマンドを歯車から編集し、×から削除できる", async () => {
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

  // Given: Explorer起動spy、対象`memo.txt`
  // When: Explorer項目をクリック
  // Then: `revealInExplorer("C:\\work\\memo.txt",false)`
  it("Scenario: ファイルのExplorerメニューはその絶対パスを渡す", async () => {
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

  // Given: Explorer起動が`explorer failed`でreject
  // When: Explorer項目をクリック
  // Then: `showError("エクスプローラで開けませんでした", Error)`
  it("Scenario: Explorer起動失敗をフォルダ操作の文脈で表示する", async () => {
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

  // Given: 対象拡張子がPNG、webp、md
  // When: `isImagePath`を呼ぶ
  // Then: PNG/webpはtrue、mdはfalse
  it("Scenario: 画像ファイルの拡張子を大文字小文字に関係なく判定する", () => {
    expect(isImagePath("picture.PNG")).toBe(true);
    expect(isImagePath("picture.webp")).toBe(true);
    expect(isImagePath("memo.md")).toBe(false);
  });

  // Given: 対象が`memo.txt`、delete APIは成功
  // When: その他→削除をクリック
  // Then: `deleteEntry("memo.txt")`、確認文言表示、一覧更新
  it("Scenario: 削除はその他サブメニューを経由する", async () => {
    const { actions, dropdown, ports } = fixture();
    vi.spyOn(api, "deleteEntry").mockResolvedValueOnce({} as api.DocInfo);
    actions.showContextMenu(0, 0, { relPath: "memo.txt", isDir: false });

    const other = [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent?.includes("その他"));
    other!.click();
    expect(dropdown.querySelector<HTMLElement>(".dd-submenu .dd-item")?.textContent).toBe("削除");
    expect(dropdown.querySelector<HTMLElement>(`.dd-submenu .${MENU_ICON.delete}`)).not.toBeNull();
    dropdown.querySelector<HTMLElement>(".dd-submenu .dd-item")!.click();
    await vi.waitFor(() => expect(api.deleteEntry).toHaveBeenCalledWith("memo.txt"));

    expect(confirmMessage).toHaveBeenCalledWith(
      "削除",
      "「memo.txt」ファイルを削除します。元に戻せません。",
      "削除",
    );
    expect(ports.sidebar.refreshFolderEntries).toHaveBeenCalled();
  });

  // Given: createNoteは成功、一覧更新だけ`refresh failed`でreject
  // When: `createNote(null)`
  // Then: 作成APIは呼ばれ、作成失敗ではなく一覧更新失敗を通知
  it("Scenario: 作成成功後の一覧更新失敗を作成失敗として表示しない", async () => {
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

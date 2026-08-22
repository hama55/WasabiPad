// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sidebar, type SidebarPorts } from "./sidebar";
import { DEFAULT_SEARCH_OPTIONS } from "./workspace-search-options";
import type { FolderEntry } from "./api";

function mount(
  onSearch: SidebarPorts["onSearch"] = vi.fn(async () => ({
  results: [], scanned_files: 0, skipped_files: 0, hit_file_limit: false, hit_result_limit: false,
  pattern_error: null, file_name_match_mode: "strict" as const,
  })),
  onMoveEntry: SidebarPorts["onMoveEntry"] = vi.fn(async () => ""),
  onFileCommand: SidebarPorts["onFileCommand"] = undefined,
  onRenameEntry: SidebarPorts["onRenameEntry"] = undefined,
  onCopyEntry: SidebarPorts["onCopyEntry"] = undefined,
) {
  const host = document.createElement("div");
  document.body.replaceChildren(host);
  const ports = {
    onSelect: vi.fn(),
    onContextMenu: vi.fn(),
    onFileCommand,
    onRenameEntry,
    isCut: vi.fn((_relPath: string) => false),
    onExpandArchive: vi.fn(async (_relPath: string): Promise<string[]> => []),
    onExpandFolder: vi.fn(async (_relDir: string): Promise<FolderEntry[]> => []),
    onTreeError: vi.fn(async () => {}),
    onSearch,
    onCancel: vi.fn(),
    onError: vi.fn(async () => {}),
    onOpen: vi.fn(),
    onReplace: vi.fn(),
    onMoveEntry,
    onCopyEntry,
    onCreateFolder: vi.fn(),
    onCreateNote: vi.fn(),
    onOptionsChange: vi.fn(),
  } satisfies SidebarPorts;
  return { host, ports, sidebar: new Sidebar(host, ports, DEFAULT_SEARCH_OPTIONS) };
}

describe("Feature: Sidebar", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Reflect.deleteProperty(document, "elementFromPoint");
    document.body.replaceChildren();
  });

  // Feature: ファイルツリー下部の新規作成ボタン
  // Scenario: 選択中フォルダの配下へ新規フォルダを作成する
  // Given: `docs`フォルダを含む通常ツリーを表示している
  // When: `docs`を選択してツリー最下部の作成ボタンを押す
  // Then: 新規フォルダの作成先として`docs`を渡す
  it("Scenario: 通常ツリー下部の新規フォルダ作成先に選択フォルダを渡す", () => {
    const { host, ports, sidebar } = mount();
    sidebar.setEntries([
      { name: "docs", is_dir: true, is_archive: false },
      { name: "memo.txt", is_dir: false, is_archive: false },
    ]);
    host.querySelector<HTMLElement>(".fv-row")!.click();

    host.querySelector<HTMLButtonElement>(".fv-create-folder")!.click();
    host.querySelector<HTMLButtonElement>(".fv-create-note")!.click();

    expect(ports.onCreateFolder).toHaveBeenCalledWith("docs");
    expect(ports.onCreateNote).toHaveBeenCalledOnce();
    const tree = host.querySelector<HTMLElement>(".fv-tree");
    expect(tree?.lastElementChild?.classList.contains("fv-create-actions")).toBe(true);
    expect(tree?.querySelector<HTMLElement>(".fv-create-actions")?.hidden).toBe(false);
  });

  // Feature: 選択項目に応じた新規フォルダ作成先
  // Scenario: ファイル選択時はその親フォルダへ作成する
  // Given: `docs/memo.txt`を選択している
  // When: `＋フォルダ`を押す
  // Then: `docs`を作成先として渡す
  it("Scenario: ファイル選択時は親フォルダを新規フォルダ作成先にする", async () => {
    const { host, ports, sidebar } = mount();
    ports.onExpandFolder.mockResolvedValueOnce([
      { name: "memo.txt", is_dir: false, is_archive: false },
    ]);
    sidebar.setEntries([{ name: "docs", is_dir: true, is_archive: false }]);
    host.querySelector<HTMLElement>(".fv-row")!.click();
    await vi.waitFor(() => expect(host.querySelectorAll(".fv-row")).toHaveLength(2));
    host.querySelectorAll<HTMLElement>(".fv-row")[1].click();

    host.querySelector<HTMLButtonElement>(".fv-create-folder")!.click();

    expect(ports.onCreateFolder).toHaveBeenCalledWith("docs");
  });

  // Scenario: 未選択時はワークスペースのルートへ作成する
  // Given: ファイルツリーを表示しているが、どの行も選択していない
  // When: `＋フォルダ`を押す
  // Then: 空の相対パスを作成先として渡す
  it("Scenario: 未選択時はルートを新規フォルダ作成先にする", () => {
    const { host, ports, sidebar } = mount();
    sidebar.setEntries([{ name: "memo.txt", is_dir: false, is_archive: false }]);

    host.querySelector<HTMLButtonElement>(".fv-create-folder")!.click();

    expect(ports.onCreateFolder).toHaveBeenCalledWith("");
  });

  // Scenario: フォルダ検索中は新規作成ボタンを隠す
  // Given: フォルダ検索を利用できる通常ツリー
  // When: 検索語を入力して検索結果表示へ切り替える
  // Then: 新規フォルダと新規メモのボタン領域を非表示にする
  it("Scenario: フォルダ検索表示中は新規作成ボタンを隠す", async () => {
    vi.useFakeTimers();
    const { host, sidebar } = mount();
    sidebar.setWorkspaceSearch("C:\\workspace");
    sidebar.setEntries([{ name: "memo.txt", is_dir: false, is_archive: false }]);
    const input = host.querySelector<HTMLInputElement>(".ws-search-row > input")!;

    input.value = "needle";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(150);

    expect(host.querySelector<HTMLElement>(".fv-create-actions")?.hidden).toBe(true);
  });

  // Given: ワークスペース検索を表示している
  // When: 外部から検索条件を差し替える
  // Then: サイドバー内の検索トグルへ新しい条件が反映される
  it("Scenario: 外部から検索条件をサイドバーへ反映する", () => {
    const { host, sidebar } = mount();
    sidebar.setWorkspaceSearch("C:\\workspace");

    sidebar.setSearchOptions({ ...DEFAULT_SEARCH_OPTIONS, match_case: true });

    const toggles = host.querySelectorAll<HTMLButtonElement>(".ws-toggle");
    expect(toggles[2].classList.contains("on")).toBe(true);
  });

  // Given: `first.txt`と`second.txt`を設定し、tree要素にフォーカス
  // When: ArrowDown、ArrowDown、ArrowUpを順に送る
  // Then: 選択行と開く通知は`first.txt`→`second.txt`→`first.txt`
  it("Scenario: フォーカス中の上下キーでファイルを選択して開く", () => {
    const { host, ports, sidebar } = mount();
    sidebar.setEntries([
      { name: "first.txt", is_dir: false, is_archive: false },
      { name: "second.txt", is_dir: false, is_archive: false },
    ]);
    const tree = host.querySelector<HTMLElement>("[tabindex=\"0\"]")!;
    tree.focus();
    tree.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(host.querySelector(".fv-row.sel")?.textContent).toContain("first.txt");

    tree.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(host.querySelector(".fv-row.sel")?.textContent).toContain("second.txt");

    tree.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(host.querySelector(".fv-row.sel")?.textContent).toContain("first.txt");
    expect(ports.onSelect.mock.calls).toEqual([
      ["first.txt", false],
      ["second.txt", false],
      ["first.txt", false],
    ]);
  });

  // Feature: ファイルツリーの複数選択
  // Scenario: Ctrlクリックでファイルを開かず選択へ追加する
  // Given: first.txtを開いた後、second.txtが同じツリーに表示されている
  // When: second.txtをCtrlクリックする
  // Then: 2行が選択状態になり、second.txtのオープン通知は発生しない
  it("Scenario: Ctrlクリックはファイルを開かず複数選択へ追加する", () => {
    const { host, ports, sidebar } = mount();
    sidebar.setEntries([
      { name: "first.txt", is_dir: false, is_archive: false },
      { name: "second.txt", is_dir: false, is_archive: false },
    ]);
    const rows = [...host.querySelectorAll<HTMLElement>(".fv-row")];

    rows[0].click();
    rows[1].dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));

    expect(host.querySelectorAll(".fv-row.sel")).toHaveLength(2);
    expect(ports.onSelect).toHaveBeenCalledTimes(1);
    expect(ports.onSelect).toHaveBeenCalledWith("first.txt", false);
  });

  // Feature: ファイルツリーの複数選択
  // Scenario: Shiftクリックで選択範囲を広げる
  // Given: first.txtをCtrlクリックで選択している
  // When: third.txtをShiftクリックする
  // Then: first.txtからthird.txtまでが選択状態になり、ファイルは開かない
  it("Scenario: Shiftクリックはアンカーから範囲選択する", () => {
    const { host, ports, sidebar } = mount();
    sidebar.setEntries([
      { name: "first.txt", is_dir: false, is_archive: false },
      { name: "second.txt", is_dir: false, is_archive: false },
      { name: "third.txt", is_dir: false, is_archive: false },
    ]);
    const rows = [...host.querySelectorAll<HTMLElement>(".fv-row")];

    rows[0].dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    rows[2].dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));

    expect(host.querySelectorAll(".fv-row.sel")).toHaveLength(3);
    expect(ports.onSelect).not.toHaveBeenCalled();
  });

  // Feature: ファイルツリーの右クリック選択
  // Scenario: 未選択行の右クリックで対象を単独選択する
  // Given: first.txtが選択され、second.txtは未選択である
  // When: second.txtを右クリックする
  // Then: second.txtだけを選択した状態でコンテキストメニューへ渡す
  it("Scenario: 未選択行の右クリックは対象だけを選択する", () => {
    const { host, ports, sidebar } = mount();
    sidebar.setEntries([
      { name: "first.txt", is_dir: false, is_archive: false },
      { name: "second.txt", is_dir: false, is_archive: false },
    ]);
    const rows = [...host.querySelectorAll<HTMLElement>(".fv-row")];
    rows[0].dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    rows[1].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 20 }));

    expect([...host.querySelectorAll<HTMLElement>(".fv-row.sel")].map((row) => row.dataset.relPath))
      .toEqual(["second.txt"]);
    expect(ports.onContextMenu).toHaveBeenCalledWith(
      10,
      20,
      { relPath: "second.txt", isDir: false },
      [{ relPath: "second.txt", isDir: false }],
    );
  });

  // Feature: ファイルツリーのファイル操作ショートカット
  // Scenario: ツリーにフォーカスがあるときCtrl+Cをファイル操作へ渡す
  // Given: memo.txtを選択したツリーにフォーカスがある
  // When: Ctrl+Cを押す
  // Then: 本文操作ではなくmemo.txtのコピーを依頼する
  it("Scenario: ツリーのCtrl+Cは選択中のファイルコピーを依頼する", () => {
    const onFileCommand = vi.fn();
    const { host, sidebar } = mount(undefined, undefined, onFileCommand);
    sidebar.setEntries([{ name: "memo.txt", is_dir: false, is_archive: false }]);
    const row = host.querySelector<HTMLElement>(".fv-row")!;
    row.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    const tree = host.querySelector<HTMLElement>(".fv-tree")!;
    tree.focus();
    tree.dispatchEvent(new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true, cancelable: true }));

    expect(onFileCommand).toHaveBeenCalledWith(
      "copy",
      [{ relPath: "memo.txt", isDir: false }],
    );
  });

  // Feature: ファイルツリーの切り取り表示
  // Scenario: 切り取り対象を薄く表示する
  // Given: memo.txtが切り取り状態である
  // When: ファイル操作状態を再描画する
  // Then: memo.txtの行に切り取り表示クラスが付く
  it("Scenario: 切り取り対象を薄く表示する", () => {
    const { host, ports, sidebar } = mount();
    ports.isCut.mockImplementation((relPath: string) => relPath === "memo.txt");
    sidebar.setEntries([{ name: "memo.txt", is_dir: false, is_archive: false }]);
    sidebar.refreshFileOperationState();

    expect(host.querySelector(".fv-row.fv-cut")?.textContent).toContain("memo.txt");
  });

  // Feature: ファイルツリーのインライン名前変更
  // Scenario: F2で拡張子を除いた名前だけを選択して変更する
  // Given: `memo.txt`を選択したツリーにフォーカスがある
  // When: F2で`renamed.txt`を入力してEnterを押す
  // Then: 新しい名前を名前変更ポートへ渡す
  it("Scenario: F2は拡張子を選択せずインライン名前変更する", async () => {
    const onRenameEntry = vi.fn();
    const { host, sidebar } = mount(undefined, undefined, undefined, onRenameEntry);
    sidebar.setWorkspaceSearch("C:\\work");
    sidebar.setEntries([{ name: "memo.txt", is_dir: false, is_archive: false }]);
    host.querySelector<HTMLElement>(".fv-row")!.click();
    const tree = host.querySelector<HTMLElement>(".fv-tree")!;
    tree.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true, cancelable: true }));

    const input = host.querySelector<HTMLInputElement>(".fv-rename-input")!;
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(4);
    input.value = "renamed.txt";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(onRenameEntry).toHaveBeenCalledWith("memo.txt", "renamed.txt"));
    expect(host.querySelector(".fv-rename-input")).toBeNull();
  });

  // Scenario: インライン名前変更をEscで取り消す
  // Given: `memo.txt`の名前変更入力を表示している
  // When: Escを押す
  // Then: 名前変更ポートを呼ばず入力を閉じる
  it("Scenario: インライン名前変更はEscで取り消せる", () => {
    const onRenameEntry = vi.fn();
    const { host, sidebar } = mount(undefined, undefined, undefined, onRenameEntry);
    sidebar.setWorkspaceSearch("C:\\work");
    sidebar.setEntries([{ name: "memo.txt", is_dir: false, is_archive: false }]);
    host.querySelector<HTMLElement>(".fv-row")!.click();
    const tree = host.querySelector<HTMLElement>(".fv-tree")!;
    tree.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true, cancelable: true }));
    host.querySelector<HTMLInputElement>(".fv-rename-input")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));

    expect(onRenameEntry).not.toHaveBeenCalled();
    expect(host.querySelector(".fv-rename-input")).toBeNull();
  });

  // Feature: フォルダビューのD&D移動
  // Scenario: ファイル行をフォルダ行へドロップする
  // Given: memo.txt と sub フォルダを表示している
  // When: memo.txt を掴んで sub の上で離す
  // Then: 移動ポートへ元相対パスと移動先相対パスを渡す
  it("Scenario: ファイルをフォルダへD&Dして移動を依頼する", async () => {
    const { host, ports, sidebar } = mount();
    sidebar.setEntries([
      { name: "memo.txt", is_dir: false, is_archive: false },
      { name: "sub", is_dir: true, is_archive: false },
    ]);
    const rows = [...host.querySelectorAll<HTMLElement>(".fv-row")];
    const file = rows.find((row) => row.textContent?.includes("memo.txt"))!;

    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => host.querySelector<HTMLElement>('[data-rel-path="sub"]'),
    });
    file.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 4, clientY: 4 }));
    window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 12, clientY: 12 }));
    window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 12, clientY: 12 }));

    await vi.waitFor(() => expect(ports.onMoveEntry).toHaveBeenCalledWith("memo.txt", "sub"));
  });

  // Feature: フォルダビューのD&Dコピー
  // Scenario: Ctrlを押しながらファイル行をフォルダへドロップする
  // Given: memo.txt と sub フォルダを表示している
  // When: memo.txt をCtrl+D&Dする
  // Then: コピーポートへ元相対パスとコピー先相対パスを渡す
  it("Scenario: Ctrl+D&Dでファイルをコピーする", async () => {
    const onCopyEntry = vi.fn(async () => "sub/memo.txt");
    const { host, sidebar } = mount(undefined, undefined, undefined, undefined, onCopyEntry);
    sidebar.setEntries([
      { name: "memo.txt", is_dir: false, is_archive: false },
      { name: "sub", is_dir: true, is_archive: false },
    ]);
    const rows = [...host.querySelectorAll<HTMLElement>(".fv-row")];
    const file = rows.find((row) => row.textContent?.includes("memo.txt"))!;
    const dir = rows.find((row) => row.textContent?.includes("sub"))!;

    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => dir });
    file.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 4, clientY: 4 }));
    window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 12, clientY: 12 }));
    window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 12, clientY: 12, ctrlKey: true }));

    await vi.waitFor(() => expect(onCopyEntry).toHaveBeenCalledWith("memo.txt", "sub"));
  });

  // Feature: ファイルツリーの複数選択D&D
  // Scenario: 複数選択したファイルをフォルダへ移動する
  // Given: memo.txt と note.txt を選択している
  // When: memo.txt を sub フォルダへD&Dする
  // Then: 選択した2項目を同じ移動先へ依頼する
  it("Scenario: 複数選択したファイルをまとめてD&Dする", async () => {
    const { host, ports, sidebar } = mount();
    sidebar.setEntries([
      { name: "memo.txt", is_dir: false, is_archive: false },
      { name: "note.txt", is_dir: false, is_archive: false },
      { name: "sub", is_dir: true, is_archive: false },
    ]);
    const rows = [...host.querySelectorAll<HTMLElement>(".fv-row")];
    const memo = rows.find((row) => row.textContent?.includes("memo.txt"))!;
    const note = rows.find((row) => row.textContent?.includes("note.txt"))!;
    memo.click();
    note.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));

    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => host.querySelector<HTMLElement>('[data-rel-path="sub"]'),
    });
    memo.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 4, clientY: 4 }));
    window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 12, clientY: 12 }));
    window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 12, clientY: 12 }));

    await vi.waitFor(() => expect(ports.onMoveEntry).toHaveBeenCalledTimes(2));
    expect(ports.onMoveEntry).toHaveBeenNthCalledWith(1, "memo.txt", "sub");
    expect(ports.onMoveEntry).toHaveBeenNthCalledWith(2, "note.txt", "sub");
  });

  // Feature: フォルダビューD&Dの自動スクロール
  // Scenario: ドラッグ中にツリー下端へ到達すると表示範囲を送る
  // Given: スクロール可能なツリーでファイルをドラッグしている
  // When: ポインタを表示領域の下端40px以内に置く
  // Then: ドロップを待たずにツリーが下へスクロールする
  it("Scenario: D&D中にツリー上下端へ到達すると自動スクロールする", () => {
    vi.useFakeTimers();
    const { host, sidebar } = mount();
    sidebar.setEntries([
      { name: "memo.txt", is_dir: false, is_archive: false },
      { name: "sub", is_dir: true, is_archive: false },
    ]);
    const tree = host.querySelector<HTMLElement>(".fv-tree")!;
    Object.defineProperty(tree, "clientHeight", { configurable: true, value: 100 });
    Object.defineProperty(tree, "scrollHeight", { configurable: true, value: 500 });
    Object.defineProperty(tree, "scrollTop", { configurable: true, writable: true, value: 0 });
    vi.spyOn(tree, "getBoundingClientRect").mockReturnValue({
      top: 0, bottom: 100, left: 0, right: 200, width: 200, height: 100, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    const rows = [...host.querySelectorAll<HTMLElement>(".fv-row")];
    const file = rows.find((row) => row.textContent?.includes("memo.txt"))!;
    const dir = rows.find((row) => row.textContent?.includes("sub"))!;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => dir });

    file.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 4, clientY: 4 }));
    window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 12, clientY: 95 }));
    vi.advanceTimersByTime(48);

    expect(tree.scrollTop).toBeGreaterThan(0);
    window.dispatchEvent(new Event("pointercancel"));
  });

  // Scenario: フォルダ行を別のフォルダ行へドロップする
  // Given: source と target フォルダを表示している
  // When: source を target の上で離す
  // Then: 移動ポートへ元相対パスと移動先相対パスを渡す
  it("Scenario: フォルダを別フォルダへD&Dして移動を依頼する", async () => {
    const { host, ports, sidebar } = mount();
    sidebar.setEntries([
      { name: "source", is_dir: true, is_archive: false },
      { name: "target", is_dir: true, is_archive: false },
    ]);
    const rows = [...host.querySelectorAll<HTMLElement>(".fv-row")];
    const source = rows.find((row) => row.textContent?.includes("source"))!;
    const target = rows.find((row) => row.textContent?.includes("target"))!;

    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => target });
    source.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 4, clientY: 4 }));
    window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 12, clientY: 12 }));
    window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 12, clientY: 12 }));

    await vi.waitFor(() => expect(ports.onMoveEntry).toHaveBeenCalledWith("source", "target"));
  });

  // Scenario: 子ファイルをフォルダビューの空白へドロップする
  // Given: sub/memo.txt を表示している
  // When: memo.txt をフォルダビューの空白へD&Dする
  // Then: フォルダルートへの移動を依頼する
  it("Scenario: フォルダ内のファイルをD&Dでルートへ戻す", async () => {
    const { host, ports, sidebar } = mount();
    ports.onExpandFolder.mockImplementation(async (relDir: string) => relDir === "sub"
      ? [{ name: "memo.txt", is_dir: false, is_archive: false }]
      : []);
    sidebar.setEntries([{ name: "sub", is_dir: true, is_archive: false }]);
    host.querySelector<HTMLElement>(".fv-row")!.click();
    await vi.waitFor(() => expect(host.textContent).toContain("memo.txt"));
    const file = [...host.querySelectorAll<HTMLElement>(".fv-row")]
      .find((row) => row.textContent?.includes("memo.txt"))!;

    const rootDrop = host.querySelector<HTMLElement>(".fv-root-drop")!;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => rootDrop });
    file.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 4, clientY: 4 }));
    window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 12, clientY: 12 }));
    window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 12, clientY: 12 }));

    await vi.waitFor(() => expect(ports.onMoveEntry).toHaveBeenCalledWith("sub/memo.txt", ""));
  });

  // Scenario: 開いている文書とは別のファイルを移動する
  // Given: 移動処理が現在選択中の `open.txt` を返す
  // When: memo.txt を sub へD&Dする
  // Then: Sidebarは移動元を再計算せず、返された `open.txt` を選択する
  it("Scenario: D&D後は文書側が返した選択パスを使う", async () => {
    const onMoveEntry = vi.fn(async () => "open.txt");
    const { host, sidebar } = mount(undefined, onMoveEntry);
    const selectByRelPath = vi.spyOn(sidebar, "selectByRelPath").mockResolvedValue();
    sidebar.setEntries([
      { name: "memo.txt", is_dir: false, is_archive: false },
      { name: "sub", is_dir: true, is_archive: false },
    ]);
    const rows = [...host.querySelectorAll<HTMLElement>(".fv-row")];
    const file = rows.find((row) => row.textContent?.includes("memo.txt"))!;
    const dir = rows.find((row) => row.textContent?.includes("sub"))!;

    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => dir });
    file.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 4, clientY: 4 }));
    window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 12, clientY: 12 }));
    window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 12, clientY: 12 }));

    await vi.waitFor(() => expect(selectByRelPath).toHaveBeenCalledWith("open.txt"));
  });

  // Scenario: D&D中にアプリがフォーカスを失う
  // Given: memo.txt を sub へドラッグしている
  // When: windowのblurを受ける
  // Then: ドラッグ状態を破棄し、その後のpointerupでは移動しない
  it("Scenario: フォーカス喪失時はD&D状態を解除する", () => {
    const { host, ports, sidebar } = mount();
    sidebar.setEntries([
      { name: "memo.txt", is_dir: false, is_archive: false },
      { name: "sub", is_dir: true, is_archive: false },
    ]);
    const rows = [...host.querySelectorAll<HTMLElement>(".fv-row")];
    const file = rows.find((row) => row.textContent?.includes("memo.txt"))!;
    const dir = rows.find((row) => row.textContent?.includes("sub"))!;

    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => dir });
    file.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 4, clientY: 4 }));
    window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 12, clientY: 12 }));
    expect(host.classList.contains("fv-dragging")).toBe(true);

    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 12, clientY: 12 }));

    expect(host.classList.contains("fv-dragging")).toBe(false);
    expect(ports.onMoveEntry).not.toHaveBeenCalled();
  });

  // Feature: フォルダビューD&Dのアンドゥ
  // Scenario: Ctrl+Zで直前に移動した子ファイルを元のフォルダへ戻す
  // Given: from/memo.txt を to へD&D済み
  // When: ファイルツリーでCtrl+Zを押す
  // Then: to/memo.txt を from へ移動する依頼を出す
  it("Scenario: Ctrl+ZでD&D移動をアンドゥする", async () => {
    const { host, ports, sidebar } = mount();
    ports.onExpandFolder.mockImplementation(async (relDir: string) => relDir === "from"
      ? [{ name: "memo.txt", is_dir: false, is_archive: false }]
      : []);
    sidebar.setWorkspaceSearch("C:\\workspace");
    sidebar.setEntries([
      { name: "from", is_dir: true, is_archive: false },
      { name: "to", is_dir: true, is_archive: false },
    ]);
    host.querySelectorAll<HTMLElement>(".fv-row")[0].click();
    await vi.waitFor(() => expect(host.textContent).toContain("memo.txt"));
    const source = [...host.querySelectorAll<HTMLElement>(".fv-row")]
      .find((row) => row.textContent?.includes("memo.txt"))!;
    const target = [...host.querySelectorAll<HTMLElement>(".fv-row")]
      .find((row) => row.textContent?.includes("to"))!;

    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => target });
    source.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 4, clientY: 4 }));
    window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 12, clientY: 12 }));
    window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 12, clientY: 12 }));
    await vi.waitFor(() => expect(ports.onMoveEntry).toHaveBeenLastCalledWith("from/memo.txt", "to"));
    await vi.waitFor(() => expect(host.querySelector(".fv-row")).toBeNull());
    sidebar.setWorkspaceSearch("C:\\workspace");

    const event = new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true });
    host.lastElementChild!.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(ports.onMoveEntry).toHaveBeenLastCalledWith("to/memo.txt", "from"));
  });

  // Scenario: マウス戻るボタンで直前のD&D移動を戻す
  // Given: memo.txt を sub へD&D済みで、ポインタはフォルダビュー上にある
  // When: 戻るボタン(button=3)を押す
  // Then: sub/memo.txt をフォルダルートへ移動する依頼を出す
  it("Scenario: 戻るボタンでD&D移動をアンドゥする", async () => {
    const { host, ports, sidebar } = mount();
    sidebar.setEntries([
      { name: "memo.txt", is_dir: false, is_archive: false },
      { name: "sub", is_dir: true, is_archive: false },
    ]);
    const rows = [...host.querySelectorAll<HTMLElement>(".fv-row")];
    const file = rows.find((row) => row.textContent?.includes("memo.txt"))!;
    const dir = rows.find((row) => row.textContent?.includes("sub"))!;

    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => dir });
    file.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 4, clientY: 4 }));
    window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 12, clientY: 12 }));
    window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 12, clientY: 12 }));
    await vi.waitFor(() => expect(ports.onMoveEntry).toHaveBeenLastCalledWith("memo.txt", "sub"));
    await vi.waitFor(() => expect(host.querySelector(".fv-row")).toBeNull());

    const event = new MouseEvent("mousedown", { button: 3, bubbles: true, cancelable: true });
    host.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(ports.onMoveEntry).toHaveBeenLastCalledWith("sub/memo.txt", ""));
  });

  // Given: 上下キーで開いたファイルの処理中にエディタへフォーカスが移ろうとする
  // When: 自動オープンを開始する
  // Then: キー操作中はツリーがフォーカスを保持し、完了後もツリーへ戻る
  it("Scenario: 上下キーの自動オープン中もツリーがフォーカスを保持する", async () => {
    const { host, ports, sidebar } = mount();
    const editorInput = document.createElement("input");
    document.body.append(editorInput);
    ports.onSelect.mockImplementation(() => {
      editorInput.focus();
    });
    sidebar.setEntries([
      { name: "first.txt", is_dir: false, is_archive: false },
      { name: "second.txt", is_dir: false, is_archive: false },
    ]);

    const tree = host.querySelector<HTMLElement>("[tabindex=\"0\"]")!;
    tree.focus();
    tree.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(tree);

    await vi.waitFor(() => expect(document.activeElement).toBe(tree));
    tree.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(ports.onSelect).toHaveBeenNthCalledWith(2, "second.txt", false);
  });

  // Given: 1件目のオープン中に2件目へのオープンが終了し、1件目の完了処理でエディタへフォーカスが移る
  // When: 1件目の非同期オープンを完了する
  // Then: 古いオープンの完了後もツリーがフォーカスを保持する
  it("Scenario: 連続した上下キー操作で古いオープンが完了してもツリーへフォーカスを戻す", async () => {
    const { host, ports, sidebar } = mount();
    const editorInput = document.createElement("input");
    document.body.append(editorInput);
    let resolveFirst!: (opened: boolean) => void;
    const firstOpen = new Promise<boolean>((resolve) => { resolveFirst = resolve; });
    ports.onSelect
      .mockImplementationOnce(() => firstOpen.then((opened) => {
        editorInput.focus();
        return opened;
      }))
      .mockResolvedValueOnce(false);
    sidebar.setEntries([
      { name: "first.txt", is_dir: false, is_archive: false },
      { name: "second.txt", is_dir: false, is_archive: false },
    ]);

    const tree = host.querySelector<HTMLElement>("[tabindex=\"0\"]")!;
    tree.focus();
    tree.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    tree.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await vi.waitFor(() => expect(ports.onSelect).toHaveBeenCalledTimes(2));

    resolveFirst(true);
    await vi.waitFor(() => expect(document.activeElement).toBe(tree));
  });

  // Given: 上下キーでの非同期オープン中にエディタへ移動する
  // When: エディタ側へポインター操作してからファイルのオープンを完了する
  // Then: 完了処理でエディタのフォーカスをツリーへ奪い返さない
  it("Scenario: 非同期オープン中に移動した別UIのフォーカスを保持する", async () => {
    const { host, ports, sidebar } = mount();
    const editorInput = document.createElement("input");
    document.body.append(editorInput);
    let resolveOpen!: (opened: boolean) => void;
    const opening = new Promise<boolean>((resolve) => { resolveOpen = resolve; });
    ports.onSelect.mockReturnValueOnce(opening);
    sidebar.setEntries([{ name: "first.txt", is_dir: false, is_archive: false }]);

    const tree = host.querySelector<HTMLElement>("[tabindex=\"0\"]")!;
    tree.focus();
    tree.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    editorInput.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    editorInput.focus();

    resolveOpen(true);
    await vi.waitFor(() => expect(document.activeElement).toBe(editorInput));
  });

  // Given: ツリーのファイルをクリックするとエディタへフォーカスが移る
  // When: ファイルを開き終えてからArrowDownを送る
  // Then: ツリーがキー入力を受け取り、次のファイルを開く
  it("Scenario: ファイルクリック後も上下キーで次のファイルを開く", async () => {
    const { host, ports, sidebar } = mount();
    const editorInput = document.createElement("input");
    document.body.append(editorInput);
    ports.onSelect.mockImplementation(() => {
      editorInput.focus();
    });
    sidebar.setEntries([
      { name: "first.txt", is_dir: false, is_archive: false },
      { name: "second.txt", is_dir: false, is_archive: false },
    ]);

    const tree = host.querySelector<HTMLElement>("[tabindex=\"0\"]")!;
    host.querySelector<HTMLElement>(".fv-row")!.click();
    expect(document.activeElement).toBe(editorInput);
    await vi.waitFor(() => expect(document.activeElement).toBe(tree));

    tree.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(ports.onSelect).toHaveBeenNthCalledWith(2, "second.txt", false);
  });

  // Given: 2つのファイルを表示し、先頭/末尾を選択中
  // When: 一覧の端でさらに同じ方向へ移動する
  // Then: 既定動作は抑止するが、同じファイルを再オープンしない
  it("Scenario: 上下キーは一覧の端で再オープンしない", () => {
    const { host, ports, sidebar } = mount();
    sidebar.setEntries([
      { name: "first.txt", is_dir: false, is_archive: false },
      { name: "second.txt", is_dir: false, is_archive: false },
    ]);
    const tree = host.querySelector<HTMLElement>("[tabindex=\"0\"]")!;
    tree.focus();

    const down = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    tree.dispatchEvent(down);
    const up = new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true });
    tree.dispatchEvent(up);
    const downAgain = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    tree.dispatchEvent(downAgain);
    const downAtEnd = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    tree.dispatchEvent(downAtEnd);

    expect([down, up, downAgain, downAtEnd].every((event) => event.defaultPrevented)).toBe(true);
    expect(ports.onSelect.mock.calls).toEqual([
      ["first.txt", false],
      ["second.txt", false],
    ]);
  });

  // Given: first.txtを開いた状態で、second.txtのオープンがfalseを返す
  // When: ArrowDownでsecond.txtを開く
  // Then: 失敗した行ではなくfirst.txtを選択状態へ戻す
  it("Scenario: falseを返すファイルオープンを前の選択へ戻す", async () => {
    const { host, ports, sidebar } = mount();
    ports.onSelect.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    sidebar.setEntries([
      { name: "first.txt", is_dir: false, is_archive: false },
      { name: "second.txt", is_dir: false, is_archive: false },
    ]);
    const tree = host.querySelector<HTMLElement>("[tabindex=\"0\"]")!;
    host.querySelector<HTMLElement>(".fv-row")!.click();
    await vi.waitFor(() => expect(document.activeElement).toBe(tree));

    tree.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await vi.waitFor(() => expect(host.querySelector(".fv-row.sel")?.textContent).toContain("first.txt"));
    expect(ports.onTreeError).not.toHaveBeenCalled();
  });

  // Given: first.txtを開いた状態で、second.txtのオープンがrejectする
  // When: ArrowDownでsecond.txtを開く
  // Then: 選択を戻し、ツリーエラーへ通知する
  it("Scenario: rejectするファイルオープンを前の選択へ戻す", async () => {
    const { host, ports, sidebar } = mount();
    const error = new Error("open failed");
    ports.onSelect.mockResolvedValueOnce(true).mockRejectedValueOnce(error);
    sidebar.setEntries([
      { name: "first.txt", is_dir: false, is_archive: false },
      { name: "second.txt", is_dir: false, is_archive: false },
    ]);
    const tree = host.querySelector<HTMLElement>("[tabindex=\"0\"]")!;
    host.querySelector<HTMLElement>(".fv-row")!.click();
    await vi.waitFor(() => expect(document.activeElement).toBe(tree));

    tree.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await vi.waitFor(() => expect(ports.onTreeError).toHaveBeenCalledWith(error));
    expect(host.querySelector(".fv-row.sel")?.textContent).toContain("first.txt");
    expect(document.activeElement).toBe(tree);
  });

  // Given: first.txt/second.txtのオープンが完了待ち
  // When: first.txtの失敗がsecond.txtの開始後に届く
  // Then: 古い結果は新しい選択状態を上書きしない
  it("Scenario: 非同期オープンの古い結果を最新選択へ反映しない", async () => {
    const { host, ports, sidebar } = mount();
    const pending = new Map<string, (opened: boolean) => void>();
    ports.onSelect.mockImplementation((relPath: string) => new Promise<boolean>((resolve) => {
      pending.set(relPath, resolve);
    }));
    sidebar.setEntries([
      { name: "first.txt", is_dir: false, is_archive: false },
      { name: "second.txt", is_dir: false, is_archive: false },
    ]);
    const tree = host.querySelector<HTMLElement>("[tabindex=\"0\"]")!;
    tree.focus();
    tree.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    tree.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await vi.waitFor(() => expect(pending.has("second.txt")).toBe(true));

    pending.get("first.txt")!(false);
    await Promise.resolve();
    expect(host.querySelector(".fv-row.sel")?.textContent).toContain("second.txt");

    pending.get("second.txt")!(true);
    await vi.waitFor(() => expect(document.activeElement).toBe(tree));
  });

  // Given: ファイル選択ポートが同期例外を投げる
  // When: ツリーからファイルを開く
  // Then: 例外をイベント外へ漏らさずエラー通知し、ツリーへフォーカスを戻す
  it("Scenario: 同期throwするファイルオープンをエラー境界で処理する", async () => {
    const { host, ports, sidebar } = mount();
    const error = new Error("sync open failed");
    ports.onSelect.mockImplementation(() => { throw error; });
    sidebar.setEntries([{ name: "first.txt", is_dir: false, is_archive: false }]);
    const tree = host.querySelector<HTMLElement>("[tabindex=\"0\"]")!;
    tree.focus();
    tree.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));

    await vi.waitFor(() => expect(ports.onTreeError).toHaveBeenCalledWith(error));
    expect(host.querySelector(".fv-row.sel")).toBeNull();
    expect(document.activeElement).toBe(tree);
  });

  // Given: ファイル行を再描画する処理が同期例外を投げる
  // When: ファイル行をクリックする
  // Then: イベント外へ例外を漏らさずツリーエラーへ通知する
  it("Scenario: ファイル行の同期描画失敗をエラー境界で処理する", async () => {
    const { host, ports, sidebar } = mount();
    sidebar.setEntries([{ name: "first.txt", is_dir: false, is_archive: false }]);
    const error = new Error("row render failed");
    const render = vi.spyOn(sidebar as unknown as { render: () => void }, "render")
      .mockImplementation(() => { throw error; });

    try {
      host.querySelector<HTMLElement>(".fv-row")!.click();
      await vi.waitFor(() => expect(ports.onTreeError).toHaveBeenCalledWith(error));
    } finally {
      render.mockRestore();
    }
  });

  // Given: dir/a.txt を含むツリーで、dir の展開取得が保留中
  // When: a.txt の選択処理中に別の一覧を設定してから取得を解決する
  // Then: 古い選択処理は新しい一覧へ選択色や古い行を混入させない
  it("Scenario: 非同期な古い選択処理が新しい一覧を上書きしない", async () => {
    const { host, ports, sidebar } = mount();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    ports.onExpandFolder.mockImplementation(async () => {
      await gate;
      return [{ name: "a.txt", is_dir: false, is_archive: false }];
    });
    sidebar.setEntries([{ name: "dir", is_dir: true, is_archive: false }]);

    const selecting = sidebar.selectByRelPath("dir/a.txt");
    await Promise.resolve();
    sidebar.setEntries([{ name: "other.txt", is_dir: false, is_archive: false }]);
    release();
    await selecting;

    expect(host.querySelector(".fv-row.sel")).toBeNull();
    expect(host.querySelector(".fv-row")?.textContent).toContain("other.txt");
  });

  // Given: dir と、その配下に nested を持つファイルツリーを開いて表示する
  // When: 共通操作のボタンを押す
  // Then: ルート直下だけの表示へ戻り、閉じたフォルダの取得は開始しない
  it("Scenario: 共通の折りたたみボタンがファイルツリー全体を畳む", async () => {
    const { host, ports, sidebar } = mount();
    ports.onExpandFolder.mockImplementation(async (relDir) => relDir === "dir"
      ? [{ name: "nested", is_dir: true, is_archive: false }]
      : []);
    sidebar.setEntries([{ name: "dir", is_dir: true, is_archive: false }]);

    host.querySelector<HTMLElement>(".fv-row")!.click();
    await vi.waitFor(() => expect(host.querySelectorAll(".fv-row")).toHaveLength(2));
    expect(host.querySelectorAll(".fv-row")[1].textContent).toContain("nested");
    expect(host.querySelector(".fv-row .fv-arrow")?.textContent).toBe("🗂️");

    host.querySelector<HTMLButtonElement>(".fv-fold")!.click();
    expect(host.querySelectorAll(".fv-row")).toHaveLength(1);
    expect(host.querySelector(".fv-row .fv-arrow")?.textContent).toBe("📁");
  });

  // Given: data.zip の一覧に folder/file.txt があり、archive内のfolder行が作られる
  // When: アーカイブ行、続けてarchive内のfolder行を開く
  // Then: archive内の仮想フォルダはAPIへ渡さず、エラーなく子行を表示する
  it("Scenario: アーカイブ内の仮想フォルダを実フォルダとして展開しない", async () => {
    const { host, ports, sidebar } = mount();
    ports.onExpandArchive.mockResolvedValue(["folder/file.txt"]);
    sidebar.setEntries([{ name: "data.zip", is_dir: false, is_archive: true }]);

    host.querySelector<HTMLElement>(".fv-row")!.click();
    await vi.waitFor(() => expect(host.querySelectorAll(".fv-row")).toHaveLength(2));
    host.querySelectorAll<HTMLElement>(".fv-row")[1].click();

    expect(ports.onExpandFolder).not.toHaveBeenCalled();
    expect(ports.onTreeError).not.toHaveBeenCalled();
    expect(host.querySelectorAll(".fv-row")[1].textContent).toContain("folder");
    expect(host.querySelectorAll(".fv-row")[2].textContent).toContain("file.txt");
  });

  // Given: dir と、その配下に nested/deep.txt を持つファイルツリーを表示する
  // When: dir の全展開を依頼する
  // Then: dir 以下だけを再帰取得して全階層を表示する
  it("Scenario: 指定フォルダと配下を全展開する", async () => {
    const { host, ports, sidebar } = mount();
    ports.onExpandFolder.mockImplementation(async (relDir) => {
      if (relDir === "dir") return [{ name: "nested", is_dir: true, is_archive: false }];
      if (relDir === "dir/nested") return [{ name: "deep.txt", is_dir: false, is_archive: false }];
      return [{ name: "outside.txt", is_dir: false, is_archive: false }];
    });
    sidebar.setEntries([
      { name: "dir", is_dir: true, is_archive: false },
      { name: "other", is_dir: true, is_archive: false },
    ]);

    await sidebar.expandAllFolder("dir");

    expect(ports.onExpandFolder.mock.calls.map(([relDir]) => relDir)).toEqual(["dir", "dir/nested"]);
    expect([...host.querySelectorAll<HTMLElement>(".fv-row")].map((row) => row.textContent)).toEqual([
      "🗂️dir",
      "🗂️nested",
      "📄deep.txt",
      "📁other",
    ]);
  });

  // Feature: フォルダ一覧更新後の展開状態
  // Scenario: 削除などで一覧を更新しても既存の展開を閉じない
  // Given: `docs`を展開して子ファイルを表示している
  // When: フォルダ一覧を再取得する
  // Then: `docs`は開いたままで子ファイルを表示する
  it("Scenario: フォルダ一覧更新後も展開状態を保持する", async () => {
    const { host, ports, sidebar } = mount();
    ports.onExpandFolder.mockImplementation(async (relDir) => relDir === ""
      ? [{ name: "docs", is_dir: true, is_archive: false }]
      : [{ name: "memo.txt", is_dir: false, is_archive: false }]);
    sidebar.setEntries([{ name: "docs", is_dir: true, is_archive: false }]);
    host.querySelector<HTMLElement>(".fv-row")!.click();
    await vi.waitFor(() => expect(host.querySelectorAll(".fv-row")).toHaveLength(2));

    await sidebar.refreshFolderEntries();

    expect(host.querySelectorAll(".fv-row")).toHaveLength(2);
    expect(host.querySelector(".fv-row .fv-arrow")?.textContent).toBe("🗂️");
    expect(host.querySelectorAll<HTMLElement>(".fv-row")[1].textContent).toContain("memo.txt");
  });

  // Feature: ファイルツリー全体の展開
  // Scenario: 空白部メニューから全ルートを展開する
  // Given: `dir`と`other`の2つの閉じたフォルダがある
  // When: 空文字の相対パスで全展開を依頼する
  // Then: すべてのルート配下を再帰取得して表示する
  it("Scenario: 空白部の全展開でツリー全体を展開する", async () => {
    const { host, ports, sidebar } = mount();
    ports.onExpandFolder.mockImplementation(async (relDir) => {
      if (relDir === "dir") return [{ name: "memo.txt", is_dir: false, is_archive: false }];
      if (relDir === "other") return [{ name: "nested", is_dir: true, is_archive: false }];
      if (relDir === "other/nested") return [{ name: "deep.txt", is_dir: false, is_archive: false }];
      return [];
    });
    sidebar.setEntries([
      { name: "dir", is_dir: true, is_archive: false },
      { name: "other", is_dir: true, is_archive: false },
    ]);

    await sidebar.expandAllFolder("");

    expect(ports.onExpandFolder.mock.calls.map(([relDir]) => relDir)).toEqual([
      "dir", "other", "other/nested",
    ]);
    expect([...host.querySelectorAll<HTMLElement>(".fv-row")].map((row) => row.textContent)).toEqual([
      "🗂️dir",
      "📄memo.txt",
      "🗂️other",
      "🗂️nested",
      "📄deep.txt",
    ]);
  });

  // Given: dir の直下に data.zip があり、アーカイブ内に folder/file.txt がある
  // When: dir の全展開を依頼する
  // Then: 実フォルダAPIとアーカイブAPIだけを使い、アーカイブ内の仮想フォルダまで展開する
  it("Scenario: 全展開時もアーカイブ内の仮想フォルダを実フォルダとして扱わない", async () => {
    const { host, ports, sidebar } = mount();
    ports.onExpandFolder.mockResolvedValue([
      { name: "data.zip", is_dir: false, is_archive: true },
    ]);
    ports.onExpandArchive.mockResolvedValue(["folder/file.txt"]);
    sidebar.setEntries([{ name: "dir", is_dir: true, is_archive: false }]);

    await sidebar.expandAllFolder("dir");

    expect(ports.onExpandFolder.mock.calls.map(([relDir]) => relDir)).toEqual(["dir"]);
    expect(ports.onExpandArchive).toHaveBeenCalledWith("dir/data.zip");
    expect(ports.onExpandFolder).not.toHaveBeenCalledWith("dir/data.zip::folder");
    expect([...host.querySelectorAll<HTMLElement>(".fv-row")].map((row) => row.textContent)).toEqual([
      "🗂️dir",
      "⌄data.zip",
      "🗂️folder",
      "file.txt",
    ]);
  });

  // Given: dir が閉じた状態のファイルツリーを表示する
  // When: 上部の共通ボタンを押す
  // Then: ボタンは全展開せず、フォルダ一覧取得も開始しない
  it("Scenario: 共通ボタンは全折りたたみだけを実行する", () => {
    const { host, ports, sidebar } = mount();
    sidebar.setEntries([{ name: "dir", is_dir: true, is_archive: false }]);

    const fold = host.querySelector<HTMLButtonElement>(".fv-fold")!;
    expect(fold.getAttribute("aria-label")).toBe("すべて折りたたむ");
    fold.click();

    expect(ports.onExpandFolder).not.toHaveBeenCalled();
    expect(host.querySelectorAll(".fv-row")).toHaveLength(1);
  });

  // Given: 共通ボタンの再描画が`render failed`でthrowする
  // When: 上部の共通ボタンを押す
  // Then: 同期例外を画面イベントの外へ漏らさずツリーエラーへ通知する
  it("Scenario: 共通ボタンの同期失敗をツリーエラーとして通知する", async () => {
    const { host, ports, sidebar } = mount();
    sidebar.setEntries([{ name: "dir", is_dir: true, is_archive: false }]);
    const error = new Error("render failed");
    const render = vi.spyOn(sidebar as unknown as { render: () => void }, "render")
      .mockImplementation(() => { throw error; });

    try {
      host.querySelector<HTMLButtonElement>(".fv-fold")!.click();
      await vi.waitFor(() => expect(ports.onTreeError).toHaveBeenCalledWith(error));
    } finally {
      render.mockRestore();
    }
  });

  // Given: 検索結果ツリーを表示中に a.txt を開いたことを通常ツリーの状態へ記録する
  // When: 検索表示を閉じて通常ツリーへ戻る
  // Then: a.txt が通常ツリーでも選択済み色になる
  it("Scenario: 検索中に開いたファイルの選択を通常ツリーへ同期する", async () => {
    vi.useFakeTimers();
    const { host, sidebar } = mount();
    sidebar.setEntries([{ name: "a.txt", is_dir: false, is_archive: false }]);
    sidebar.setWorkspaceSearch("C:\\workspace");
    const input = host.querySelector<HTMLInputElement>(".ws-search-row > input")!;
    input.value = "needle";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(150);

    await sidebar.selectByRelPath("a.txt");
    sidebar.setWorkspaceSearch(null);

    expect(host.querySelector(".fv-row.sel")?.textContent).toContain("a.txt");
  });
});

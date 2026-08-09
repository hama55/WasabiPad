// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sidebar, type SidebarPorts } from "./sidebar";
import { DEFAULT_SEARCH_OPTIONS } from "./workspace-search-options";
import type { FolderEntry } from "./api";

function mount(onSearch: SidebarPorts["onSearch"] = vi.fn(async () => ({
  results: [], scanned_files: 0, hit_file_limit: false, hit_result_limit: false,
  pattern_error: null, file_name_match_mode: "strict" as const,
}))) {
  const host = document.createElement("div");
  document.body.replaceChildren(host);
  const ports = {
    onSelect: vi.fn(),
    onContextMenu: vi.fn(),
    onExpandArchive: vi.fn(async (_relPath: string): Promise<string[]> => []),
    onExpandFolder: vi.fn(async (_relDir: string): Promise<FolderEntry[]> => []),
    onTreeError: vi.fn(async () => {}),
    onSearch,
    onCancel: vi.fn(),
    onError: vi.fn(async () => {}),
    onOpen: vi.fn(),
    onOptionsChange: vi.fn(),
  } satisfies SidebarPorts;
  return { host, ports, sidebar: new Sidebar(host, ports, DEFAULT_SEARCH_OPTIONS) };
}

describe("Feature: Sidebar", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
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

  // Given: 上下キーで開いたファイルの処理中にエディタへフォーカスが移る
  // When: 自動オープンの完了を待つ
  // Then: 次の上下キーを受け取れるようツリーへフォーカスを戻す
  it("Scenario: 上下キーで自動オープンした後もツリーへフォーカスを戻す", async () => {
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
    expect(document.activeElement).toBe(editorInput);

    await vi.waitFor(() => expect(document.activeElement).toBe(tree));
    tree.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(ports.onSelect).toHaveBeenNthCalledWith(2, "second.txt", false);
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

  // Given: dir と、その配下に nested を持つフォルダツリーを開いて表示する
  // When: 共通操作のボタンを押す
  // Then: ルート直下だけの表示へ戻り、閉じたフォルダの取得は開始しない
  it("Scenario: 共通の折りたたみボタンがフォルダツリー全体を畳む", async () => {
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

  // Given: dir と、その配下に nested/deep.txt を持つフォルダツリーを表示する
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

  // Given: dir が閉じた状態のフォルダツリーを表示する
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

// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createAbcPreviewHost } from "./music-abc-preview";

describe("Feature: ABCプレビューアドインのホスト", () => {
  it("Scenario: 未導入なら追加案内を表示してモジュールを読み込まない", async () => {
    // Given: ABCアドインが未導入
    const container = document.createElement("div");
    const loadModule = vi.fn();
    const host = createAbcPreviewHost(container, {
      getStatus: async () => null,
      loadModule,
      reportError: vi.fn(),
    });

    // When: ABC文書を表示する
    await host.render("X:1\nT:Example\nK:C\nC|");

    // Then: 追加案内を表示し、アドインを読み込まない
    expect(container.textContent).toContain("ABCアドイン未導入");
    expect(loadModule).not.toHaveBeenCalled();
    host.dispose();
  });

  it("Scenario: 無効なら有効化案内を表示してモジュールを読み込まない", async () => {
    // Given: ABCアドインは導入済みだが無効
    const container = document.createElement("div");
    const loadModule = vi.fn();
    const host = createAbcPreviewHost(container, {
      getStatus: async () => ({ version: "1.0.0", enabled: false }),
      loadModule,
      reportError: vi.fn(),
    });

    // When: ABC文書を表示する
    await host.render("X:1\nT:Example\nK:C\nC|");

    // Then: 未導入と区別した有効化案内を表示し、アドインを読み込まない
    expect(container.textContent).toContain("ABCアドインは無効");
    expect(container.textContent).not.toContain("ABCアドイン未導入");
    expect(loadModule).not.toHaveBeenCalled();
    host.dispose();
  });

  it("Scenario: 安全でない版情報をアドインURLに使わない", async () => {
    // Given: パス区切りを含む版情報が返される
    const container = document.createElement("div");
    const loadModule = vi.fn();
    const reportError = vi.fn();
    const host = createAbcPreviewHost(container, {
      getStatus: async () => ({ version: "../latest", enabled: true }),
      loadModule,
      reportError,
    });

    // When: ABC文書を表示する
    await host.render("abc");

    // Then: 安全でないURLを読まず、状態エラーを表示する
    expect(loadModule).not.toHaveBeenCalled();
    expect(container.textContent).toContain("ABCプレビューを読み込めませんでした。");
    expect(reportError).toHaveBeenCalledOnce();
    host.dispose();
  });

  it("Scenario: 有効なアドインで曲を選び再生と停止ができる", async () => {
    // Given: 2曲を返す有効なABCアドイン
    const container = document.createElement("div");
    const preview = {
      tunes: [{ title: "第一曲" }, { title: "第二曲" }],
      play: vi.fn(async (_index: number) => {}),
      stop: vi.fn(),
      dispose: vi.fn(),
    };
    const createAbcPreview = vi.fn(() => preview);
    const loadModule = vi.fn(async () => ({ createAbcPreview }));
    const host = createAbcPreviewHost(container, {
      getStatus: async () => ({ version: "1.0.0", enabled: true }),
      loadModule,
      reportError: vi.fn(),
    });
    const abc = "X:1\nT:First\nK:C\nC|";

    // When: 表示して2曲目を選択し、再生後に停止する
    await host.render(abc);
    const select = container.querySelector("select")!;
    select.value = "1";
    select.dispatchEvent(new Event("change"));
    const buttons = [...container.querySelectorAll("button")];
    buttons.find((button) => button.textContent === "再生")!.click();

    // Then: ローカルのentry/soundfontを使い、選択曲をクリック中に再生APIへ渡す
    expect(loadModule).toHaveBeenCalledWith(
      "http://wasabi-addin.localhost/abc/1.0.0/dist/entry.js",
    );
    expect(createAbcPreview).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      abc,
      { soundFontUrl: "http://wasabi-addin.localhost/abc/1.0.0/soundfont/" },
    );
    expect(select.options[1]?.textContent).toBe("第二曲");
    expect(preview.play).toHaveBeenCalledOnce();
    expect(preview.play).toHaveBeenCalledWith(1);

    buttons.find((button) => button.textContent === "停止")!.click();
    expect(preview.stop).toHaveBeenCalledOnce();
    host.dispose();
  });

  it("Scenario: 文書を再表示すると前の再生を停止して破棄する", async () => {
    // Given: 再生可能なABCプレビューを表示済み
    const container = document.createElement("div");
    const previous = {
      tunes: [{ title: "Previous" }],
      play: vi.fn(async () => {}),
      stop: vi.fn(),
      dispose: vi.fn(),
    };
    const next = {
      tunes: [{ title: "Next" }],
      play: vi.fn(async () => {}),
      stop: vi.fn(),
      dispose: vi.fn(),
    };
    const createAbcPreview = vi.fn()
      .mockReturnValueOnce(previous)
      .mockReturnValueOnce(next);
    const host = createAbcPreviewHost(container, {
      getStatus: async () => ({ version: "1.0.0", enabled: true }),
      loadModule: async () => ({ createAbcPreview }),
      reportError: vi.fn(),
    });
    await host.render("first");

    // When: 別文書を表示する
    await host.render("second");

    // Then: 前の再生を停止して破棄し、新しい曲を表示する
    expect(previous.stop).toHaveBeenCalledOnce();
    expect(previous.dispose).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Next");
    host.dispose();
    expect(next.stop).toHaveBeenCalledOnce();
    expect(next.dispose).toHaveBeenCalledOnce();
  });

  it("Scenario: 古い動的importが遅れて完了してもプレビューを作らない", async () => {
    // Given: 先行文書のアドインimportが保留中
    const container = document.createElement("div");
    const oldCreate = vi.fn(() => ({
      tunes: [{ title: "Old" }],
      play: vi.fn(async () => {}),
      stop: vi.fn(),
      dispose: vi.fn(),
    }));
    const currentPreview = {
      tunes: [{ title: "Current" }],
      play: vi.fn(async () => {}),
      stop: vi.fn(),
      dispose: vi.fn(),
    };
    const currentCreate = vi.fn(() => currentPreview);
    let resolveOldImport!: (module: { createAbcPreview: typeof oldCreate }) => void;
    const oldImport = new Promise<{ createAbcPreview: typeof oldCreate }>((resolve) => {
      resolveOldImport = resolve;
    });
    const loadModule = vi.fn(async () => ({ createAbcPreview: currentCreate }));
    loadModule.mockImplementationOnce(() => oldImport);
    const host = createAbcPreviewHost(container, {
      getStatus: async () => ({ version: "1.0.0", enabled: true }),
      loadModule,
      reportError: vi.fn(),
    });

    // When: 先行importを待たずに新しい文書を表示し、その後で古いimportを完了する
    const oldRender = host.render("old source");
    await vi.waitFor(() => expect(loadModule).toHaveBeenCalledOnce());
    await host.render("current source");
    resolveOldImport({ createAbcPreview: oldCreate });
    await oldRender;

    // Then: 現在のプレビューだけを作成する
    expect(currentCreate).toHaveBeenCalledOnce();
    expect(currentCreate).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      "current source",
      expect.any(Object),
    );
    expect(oldCreate).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Current");
    host.dispose();
  });

  it("Scenario: 古い状態取得の結果を新しい文書に反映しない", async () => {
    // Given: 先行文書のアドイン状態取得が保留中
    const container = document.createElement("div");
    let resolveOldStatus!: (status: null) => void;
    const oldStatus = new Promise<null>((resolve) => {
      resolveOldStatus = resolve;
    });
    let statusCalls = 0;
    const getStatus = async () => {
      statusCalls += 1;
      return statusCalls === 1 ? oldStatus : { version: "1.0.0", enabled: true };
    };
    const preview = {
      tunes: [{ title: "Current" }],
      play: vi.fn(async () => {}),
      stop: vi.fn(),
      dispose: vi.fn(),
    };
    const loadModule = vi.fn(async () => ({
      createAbcPreview: () => preview,
    }));
    const host = createAbcPreviewHost(container, {
      getStatus,
      loadModule,
      reportError: vi.fn(),
    });

    // When: 新文書の状態取得を完了した後、古い状態取得を未導入で完了する
    const oldRender = host.render("old");
    expect(statusCalls).toBe(1);
    await host.render("current");
    expect(statusCalls).toBe(2);
    resolveOldStatus(null);
    await oldRender;

    // Then: 古い未導入状態で上書きせず、新しいプレビューを維持する
    expect(loadModule).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Current");
    expect(container.textContent).not.toContain("ABCアドイン未導入");
    host.dispose();
  });

  it("Scenario: 再生に失敗したら状態を表示してエラーを報告する", async () => {
    // Given: 再生が失敗するアドイン
    const container = document.createElement("div");
    const error = new Error("sound font unavailable");
    const preview = {
      tunes: [{ title: "First" }],
      play: vi.fn(async () => {
        throw error;
      }),
      stop: vi.fn(),
      dispose: vi.fn(),
    };
    const reportError = vi.fn();
    const host = createAbcPreviewHost(container, {
      getStatus: async () => ({ version: "1.0.0", enabled: true }),
      loadModule: async () => ({
        createAbcPreview: () => preview,
      }),
      reportError,
    });

    // When: 再生を操作する
    await host.render("abc");
    container.querySelector<HTMLButtonElement>("button")!.click();
    await vi.waitFor(() => expect(container.textContent).toContain("再生に失敗しました。"));

    // Then: 失敗状態を表示し、エラーを報告する
    expect(reportError).toHaveBeenCalledWith(error);
    host.dispose();
  });

  it("Scenario: 停止後に遅れて完了した再生準備で再生中表示へ戻らない", async () => {
    // Given: 再生準備の完了が保留中
    const container = document.createElement("div");
    let finishPlay!: () => void;
    const preview = {
      tunes: [{ title: "First" }],
      play: vi.fn(() => new Promise<void>((resolve) => {
        finishPlay = resolve;
      })),
      stop: vi.fn(),
      dispose: vi.fn(),
    };
    const host = createAbcPreviewHost(container, {
      getStatus: async () => ({ version: "1.0.0", enabled: true }),
      loadModule: async () => ({
        createAbcPreview: () => preview,
      }),
      reportError: vi.fn(),
    });

    // When: 再生準備中に停止し、後から準備処理が完了する
    await host.render("abc");
    const buttons = [...container.querySelectorAll("button")];
    buttons.find((button) => button.textContent === "再生")!.click();
    buttons.find((button) => button.textContent === "停止")!.click();
    finishPlay();
    await Promise.resolve();

    // Then: 停止状態のまま維持する
    expect(container.textContent).toContain("停止しました。");
    expect(container.textContent).not.toContain("再生中です。");
    host.dispose();
  });

  it.skip("Scenario: 実機Tauriのインライン/別窓プレビューで導入済みアドインが表示・再生できる", () => {
    // Given: 実機Tauriに導入済みABCアドインがある（jsdomでは未検証）
    // When: インラインと別窓でABC文書を表示して再生する
    // Then: 譜面を表示し、選択曲を再生・停止できる
  });
});

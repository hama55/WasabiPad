// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  createLilypondPreviewHost,
  type LilypondAddonStatus,
  type LilypondPreviewModule,
  type LilypondPreviewResult,
} from "./music-lilypond-preview";

describe("Feature: LilyPondプレビュー更新ホスト", () => {
  const status: LilypondAddonStatus = { version: "1.0.0", enabled: true };
  const source = "\\score { { c'4 } }";
  const firstResult: LilypondPreviewResult = {
    svgPages: [{ fileName: "score-page-1.svg", content: "<svg/>" }],
    midiFiles: [
      { displayName: "第一曲", bytes: [77, 84, 104, 100] },
      { displayName: "第二曲", bytes: [77, 84, 104, 100, 0] },
    ],
  };

  function setup(overrides: Partial<{
    getStatus: () => Promise<LilypondAddonStatus | null>;
    loadModule: (url: string) => Promise<LilypondPreviewModule>;
    generate: (text: string, sourcePath: string | null) => Promise<LilypondPreviewResult>;
    cancelGeneration: () => void | Promise<void>;
    confirmExecution: () => Promise<boolean>;
    reportError: (error: unknown) => void;
  }> = {}) {
    const container = document.createElement("div");
    const createPreviewPlayback = () => ({
      tunes: [{ title: "第一曲" }, { title: "第二曲" }],
      play: vi.fn(async (_index: number) => {}),
      stop: vi.fn(),
      dispose: vi.fn(),
    });
    const preview = createPreviewPlayback();
    let previewCount = 0;
    const createLilypondPreview = vi.fn((target: HTMLElement, result: LilypondPreviewResult) => {
      for (const page of result.svgPages) {
        const image = document.createElement("img");
        image.alt = page.fileName;
        target.append(image);
      }
      const playback = previewCount++ === 0 ? preview : createPreviewPlayback();
      return {
        ...playback,
        tunes: result.midiFiles.map((midiFile) => ({ title: midiFile.displayName })),
      };
    });
    const loadModule = vi.fn(async () => ({ createLilypondPreview }));
    const generate = vi.fn(async () => firstResult);
    const cancelGeneration = vi.fn();
    const confirmExecution = vi.fn(async () => true);
    const reportError = vi.fn();
    const host = createLilypondPreviewHost(container, {
      getStatus: async () => status,
      loadModule,
      generate,
      cancelGeneration,
      confirmExecution,
      reportError,
      ...overrides,
    });
    return {
      container, host, preview, createLilypondPreview, loadModule, generate,
      cancelGeneration, confirmExecution, reportError,
    };
  }

  it("Scenario: 文書を開いただけでは実行せず、明示更新後に選択曲を再生できる", async () => {
    // Given: 実行確認後に譜面と二曲分のMIDIを生成できる
    const harness = setup();
    await harness.host.setSource(source, "C:/Scores/example.ly");

    // When: 文書を開き、利用者が譜面を更新する
    expect(harness.generate).not.toHaveBeenCalled();
    expect(harness.confirmExecution).not.toHaveBeenCalled();
    const updateButton = [...harness.container.querySelectorAll("button")]
      .find((button) => button.textContent === "譜面を更新")!;
    updateButton.click();
    await vi.waitFor(() => expect(harness.createLilypondPreview).toHaveBeenCalledOnce());

    // Then: 確認してから生成し、選択曲の先頭から再生・停止できる
    expect(harness.confirmExecution).toHaveBeenCalledOnce();
    expect(harness.generate).toHaveBeenCalledWith(source, "C:/Scores/example.ly");
    expect(harness.loadModule).toHaveBeenCalledWith(
      "http://wasabi-addin.localhost/lilypond/1.0.0/dist/entry.js",
    );
    expect(harness.createLilypondPreview).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      firstResult,
      {
        soundFontUrl: "http://wasabi-addin.localhost/lilypond/1.0.0/soundfont/FluidR3Mono_GM.sf3",
        workletUrl: "http://wasabi-addin.localhost/lilypond/1.0.0/dist/spessasynth_processor.min.js",
      },
    );
    const select = harness.container.querySelector("select")!;
    expect(select.options[1]?.textContent).toBe("第二曲");
    select.value = "1";
    const buttons = [...harness.container.querySelectorAll("button")];
    buttons.find((button) => button.textContent === "再生")!.click();
    expect(harness.preview.play).toHaveBeenCalledWith(1);
    buttons.find((button) => button.textContent === "停止")!.click();
    expect(harness.preview.stop).toHaveBeenCalled();
    harness.host.dispose();
  });

  it("Scenario: 保存前の新規文書では相対参照のため先に保存するよう案内する", async () => {
    // Given: 保存先のない新規文書と、保存済み文書を用意する
    const harness = setup();

    // When: 保存先のない文書を開く
    await harness.host.setSource(source, null);

    // Then: 手動更新の案内に相対参照を使う場合の保存案内が含まれる
    expect(harness.container.textContent).toContain("相対参照を使う場合は先に保存");

    // When: 保存済み文書を開く
    await harness.host.setSource(source, "C:/Scores/example.ly");

    // Then: 保存案内は無名新規文書の場合だけ表示する
    expect(harness.container.textContent).not.toContain("相対参照を使う場合は先に保存");
    harness.host.dispose();
  });

  it("Scenario: 新しい内容は前回の譜面を保ち、未更新として再生を止める", async () => {
    // Given: 一度更新して譜面を表示済み
    const harness = setup();
    await harness.host.setSource(source, "C:/Scores/example.ly");
    [...harness.container.querySelectorAll("button")]
      .find((button) => button.textContent === "譜面を更新")!.click();
    await vi.waitFor(() => expect(harness.createLilypondPreview).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(harness.container.querySelector("img")).not.toBeNull());
    const oldImage = harness.container.querySelector("img")!;
    harness.preview.play.mockClear();

    // When: 編集内容が変わる
    await harness.host.setSource("\\score { { d'4 } }", "C:/Scores/example.ly");

    // Then: 前回ページを保持し、未更新を示して再生を停止・無効化する
    expect(harness.container.querySelector("img")).toBe(oldImage);
    expect(oldImage.parentElement).not.toBeNull();
    expect(harness.container.textContent).toContain("未更新");
    expect(harness.preview.stop).toHaveBeenCalled();
    expect(harness.container.querySelector<HTMLButtonElement>('button[data-action="play"]')!.disabled).toBe(true);
    expect(harness.cancelGeneration).toHaveBeenCalled();
    expect(harness.generate).toHaveBeenCalledOnce();
    harness.host.dispose();
  });

  it("Scenario: 同じ内容とパスの再通知では成功譜面を未更新にしない", async () => {
    // Given: 入力内容と保存先に対応する譜面を表示済み
    const harness = setup();
    await harness.host.setSource(source, "C:/Scores/example.ly");
    [...harness.container.querySelectorAll("button")]
      .find((button) => button.textContent === "譜面を更新")!.click();
    await vi.waitFor(() => expect(harness.createLilypondPreview).toHaveBeenCalledOnce());
    harness.cancelGeneration.mockClear();
    harness.preview.stop.mockClear();

    // When: 同じ入力内容と保存先を再通知する
    await harness.host.setSource(source, "C:/Scores/example.ly");

    // Then: 成功譜面を保持し、再生可能なまま未更新扱いにしない
    expect(harness.container.textContent).not.toContain("未更新");
    expect(harness.container.querySelector<HTMLButtonElement>('button[data-action="play"]')!.disabled).toBe(false);
    expect(harness.preview.stop).not.toHaveBeenCalled();
    expect(harness.cancelGeneration).not.toHaveBeenCalled();
    expect(harness.generate).toHaveBeenCalledOnce();
    harness.host.dispose();
  });

  it("Scenario: 譜面の置換とホスト破棄で各再生資源を一度破棄する", async () => {
    // Given: 一度目の更新で譜面と再生資源を作成する
    const harness = setup();
    await harness.host.setSource(source, "C:/Scores/example.ly");
    [...harness.container.querySelectorAll("button")]
      .find((button) => button.textContent === "譜面を更新")!.click();
    await vi.waitFor(() => expect(harness.createLilypondPreview).toHaveBeenCalledOnce());
    const firstPreview = harness.createLilypondPreview.mock.results[0]!.value;

    // When: 別の内容に更新し、続けてホストを破棄する
    await harness.host.setSource("\\score { { d'4 } }", "C:/Scores/example.ly");
    [...harness.container.querySelectorAll("button")]
      .find((button) => button.textContent === "譜面を更新")!.click();
    await vi.waitFor(() => expect(harness.createLilypondPreview).toHaveBeenCalledTimes(2));
    const secondPreview = harness.createLilypondPreview.mock.results[1]!.value;
    harness.host.dispose();

    // Then: 置換された譜面と現在の譜面の資源を各一度解放する
    expect(firstPreview.dispose).toHaveBeenCalledOnce();
    expect(secondPreview.dispose).toHaveBeenCalledOnce();
  });

  it("Scenario: 停止と破棄の両方が失敗してもエラー報告を重複させない", async () => {
    // Given: プレビューの停止と資源破棄がそれぞれ失敗する
    const harness = setup();
    await harness.host.setSource(source, "C:/Scores/example.ly");
    [...harness.container.querySelectorAll("button")]
      .find((button) => button.textContent === "譜面を更新")!.click();
    await vi.waitFor(() => expect(harness.createLilypondPreview).toHaveBeenCalledOnce());
    const stopError = new Error("stop failed");
    harness.preview.stop.mockImplementationOnce(() => { throw stopError; });
    harness.preview.dispose.mockImplementationOnce(() => { throw new Error("dispose failed"); });

    // When: ホストを破棄する
    harness.host.dispose();

    // Then: disposeを試し、失敗は一度だけ報告する
    expect(harness.preview.dispose).toHaveBeenCalledOnce();
    expect(harness.reportError).toHaveBeenCalledOnce();
    expect(harness.reportError).toHaveBeenCalledWith(stopError);
  });

  it("Scenario: 更新に失敗したら前回譜面を保持して実行エラーを示す", async () => {
    // Given: 初回更新は成功し、次回は外部ツールエラーになる
    const error = new Error("LilyPond executable was not found");
    const generate = vi.fn()
      .mockResolvedValueOnce(firstResult)
      .mockRejectedValueOnce(error);
    const harness = setup({ generate });
    await harness.host.setSource(source, "C:/Scores/example.ly");
    [...harness.container.querySelectorAll("button")]
      .find((button) => button.textContent === "譜面を更新")!.click();
    await vi.waitFor(() => expect(harness.createLilypondPreview).toHaveBeenCalledOnce());
    const oldImage = harness.container.querySelector("img")!;

    // When: ソースを変更して更新に失敗する
    await harness.host.setSource("changed", "C:/Scores/example.ly");
    [...harness.container.querySelectorAll("button")]
      .find((button) => button.textContent === "譜面を更新")!.click();
    await vi.waitFor(() => expect(harness.reportError).toHaveBeenCalledWith(error));

    // Then: 古い結果を前回結果として保ち、再生できない状態にする
    expect(harness.container.querySelector("img")).toBe(oldImage);
    expect(harness.container.textContent).toContain("更新失敗・前回結果");
    expect(harness.container.textContent).toContain("LilyPond executable was not found");
    expect(harness.container.querySelector<HTMLButtonElement>('button[data-action="play"]')!.disabled).toBe(true);
    harness.host.dispose();
  });

  it("Scenario: 遅れて完了した古い生成結果を採用しない", async () => {
    // Given: 最初の生成が保留中
    let finishOldGeneration!: (result: typeof firstResult) => void;
    const generate = vi.fn()
      .mockReturnValueOnce(new Promise<typeof firstResult>((resolve) => {
        finishOldGeneration = resolve;
      }))
      .mockResolvedValueOnce(firstResult);
    const harness = setup({ generate });
    await harness.host.setSource("old source", "C:/Scores/old.ly");
    [...harness.container.querySelectorAll("button")]
      .find((button) => button.textContent === "譜面を更新")!.click();
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());

    // When: 新しい文書を開き、古い生成を後から完了させる
    await harness.host.setSource("current source", "C:/Scores/current.ly");
    finishOldGeneration(firstResult);
    await Promise.resolve();
    await Promise.resolve();

    // Then: 古い生成物で譜面プレビューを作らない
    expect(harness.createLilypondPreview).not.toHaveBeenCalled();
    expect(harness.container.textContent).toContain("譜面を更新するには");
    expect(harness.cancelGeneration).toHaveBeenCalled();
    harness.host.dispose();
  });

  it("Scenario: MIDIがなければ譜面のみ表示して再生できない", async () => {
    // Given: 生成結果に譜面だけがある
    const result = { svgPages: firstResult.svgPages, midiFiles: [] };
    const harness = setup({ generate: async () => result });
    await harness.host.setSource(source, "C:/Scores/example.ly");
    [...harness.container.querySelectorAll("button")]
      .find((button) => button.textContent === "譜面を更新")!.click();
    await vi.waitFor(() => expect(harness.createLilypondPreview).toHaveBeenCalledOnce());

    // When: 譜面の表示が完了する
    const playButton = harness.container.querySelector<HTMLButtonElement>('button[data-action="play"]')!;

    // Then: MIDIなしを案内し、再生を無効にする
    expect(playButton.disabled).toBe(true);
    expect(harness.container.textContent).toContain("MIDIがありません");
    expect(harness.container.textContent).toContain("再生するには楽譜に \\midi {} を追加");
    expect(harness.createLilypondPreview.mock.results[0]?.value.tunes).toEqual([]);
    harness.host.dispose();
  });

  it("Scenario: 未導入と無効を別々に案内する", async () => {
    // Given: アドイン状態が未導入の後に無効へ変わる
    let currentStatus: LilypondAddonStatus | null = null;
    const harness = setup({ getStatus: async () => currentStatus });

    // When: 文書を開く
    await harness.host.setSource(source, "C:/Scores/example.ly");
    expect(harness.container.textContent).toContain("LilyPondアドイン未導入");

    // Then: 無効状態は未導入と区別して案内し、いずれも生成しない
    currentStatus = { version: "1.0.0", enabled: false };
    await harness.host.setSource(source, "C:/Scores/example.ly");
    expect(harness.container.textContent).toContain("LilyPondアドインは無効");
    expect(harness.container.textContent).not.toContain("アドイン未導入");
    expect(harness.generate).not.toHaveBeenCalled();
    harness.host.dispose();
  });

  it.skip("Scenario: 実機WebViewで更新後の全ページ表示とMIDI再生・停止を確認する", () => {
    // Given: 実機WebViewに更新済みLilyPondアドインがある（jsdomでは未検証）
    // When: 複数ページの譜面を更新してMIDIを再生・停止する
    // Then: 全ページを表示し、選択したMIDIを再生・停止できる
  });
});

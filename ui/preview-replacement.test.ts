// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { LiveViewers } from "./live-viewers";
import { InlinePreview, INLINE_PREVIEW_MESSAGES } from "./inline-preview";
import { createExternalPreviewOutputLifecycle, createPreviewReplacementLifecycle } from "./preview-replacement";
import { isCurrentPreviewDocument, type PreviewDocument } from "./preview-layout";

describe("Feature: preview replacement lifecycle", () => {
  // Given: 保存済み .aaa から生成したHTMLで、既存プレビューを置き換えた
  // When: 置換完了後に旧ビューの終了通知が遅れて届き、その後、新ビューを利用者が閉じる
  // Then: 旧通知は新しい生成物を壊さず、現在のビューの終了は通常どおり無効化と掃除を行う
  it("Scenario: ignores delayed old-view closure after finish but honors current-view cancellation", () => {
    const lifecycle = createPreviewReplacementLifecycle();
    let requestGeneration = 8;
    let output: { path: string; html: string } | null = null;
    const cleanedPaths: string[] = [];
    const invalidatePreview = () => {
      requestGeneration++;
      if (output) cleanedPaths.push(output.path);
      output = null;
    };

    lifecycle.onAvailable("old-view");
    lifecycle.begin(requestGeneration);
    output = {
      path: "C:\\Temp\\WasabiPad\\replacement\\preview.html",
      html: "<!doctype html><p>内容</p>",
    };
    lifecycle.onAvailable("replacement-view", requestGeneration, invalidatePreview);
    expect(requestGeneration).toBe(8);
    expect(lifecycle.handleOpenResult("replacement-view", () => {
      throw new Error("a normally opened view must keep its generated output");
    })).toBe(false);
    lifecycle.finish(requestGeneration);

    const oldViewWasCurrent = lifecycle.onUnavailable("old-view", requestGeneration, invalidatePreview);

    expect(oldViewWasCurrent).toBe(false);
    expect(requestGeneration).toBe(8);
    expect(output).toEqual({
      path: "C:\\Temp\\WasabiPad\\replacement\\preview.html",
      html: "<!doctype html><p>内容</p>",
    });
    expect(cleanedPaths).toEqual([]);

    const replacementViewWasCurrent = lifecycle.onUnavailable(
      "replacement-view",
      requestGeneration,
      invalidatePreview,
    );

    expect(replacementViewWasCurrent).toBe(true);
    expect(requestGeneration).toBe(9);
    expect(output).toBeNull();
    expect(cleanedPaths).toEqual(["C:\\Temp\\WasabiPad\\replacement\\preview.html"]);
  });

  // Feature: Markdownプレビューの連続切替
  // Scenario: 旧プレビューの終了通知が新しいMarkdownプレビューの表示前に届く
  // Given: Markdownプレビューが表示中で、次の文書への切替要求が始まっている
  // When: 旧ビューの終了通知が、ビューアーのオープン待ちの間に届く
  // Then: 新しい要求は失効せず、次のMarkdownプレビューが表示中になる
  it("Scenario: keeps a new Markdown preview when the old viewer closes during open cancellation", async () => {
    const lifecycle = createPreviewReplacementLifecycle();
    let requestGeneration = 40;
    let invalidationCount = 0;
    let resolveOldClose!: () => void;
    const oldCloseProcessed = new Promise<void>((resolve) => {
      resolveOldClose = resolve;
    });
    const oldCloseWasCurrent: boolean[] = [];
    let openedCount = 0;
    const invalidate = () => {
      invalidationCount++;
      requestGeneration++;
    };
    const selection = { start: { line: 0, col: 0 }, end: { line: 0, col: 0 } };
    const viewers = new LiveViewers({
      openViewer: async () => `markdown-${++openedCount}`,
      updateViewer: async () => true,
      closeViewer: async (label) => {
        oldCloseWasCurrent.push(lifecycle.onUnavailable(label, requestGeneration, invalidate));
        resolveOldClose();
      },
      wholeRange: async () => selection,
      textInRange: async () => "# Markdown",
    });

    const oldLabel = await viewers.open("markdown", null, selection);
    expect(oldLabel).toBe("markdown-1");
    lifecycle.onAvailable(oldLabel!);

    const nextGeneration = ++requestGeneration;
    const pendingOpenCancellation = lifecycle.begin(nextGeneration, () => {
      viewers.clear();
      return oldCloseProcessed;
    });
    await pendingOpenCancellation;

    expect(oldCloseWasCurrent).toEqual([true]);
    expect(invalidationCount).toBe(0);
    expect(requestGeneration).toBe(nextGeneration);

    const nextLabel = await viewers.open("markdown", null, selection);
    expect(nextLabel).toBe("markdown-2");
    lifecycle.onAvailable(nextLabel!, requestGeneration, invalidate);

    expect(viewers.has("markdown")).toBe(true);
    expect(lifecycle.isActive(nextLabel!)).toBe(true);
    expect(invalidationCount).toBe(0);
  });

  // Given: 外部アダプタの生成中で、まだ置換ビューを開いていない
  // When: エディタの形式選択メニューから別のプレビューを選び、現在のビューが閉じる
  // Then: アダプタ要求を無効化し、遅れて返る生成物は表示せず削除する
  it("Scenario: cancels pending adapter generation when the user chooses another preview", async () => {
    const lifecycle = createPreviewReplacementLifecycle();
    let requestGeneration = 12;
    const adapterRequestGeneration = requestGeneration;
    const generatedPath = "C:\\Temp\\WasabiPad\\pending\\preview.html";
    const cleanedPaths: string[] = [];
    const openedFormats: string[] = [];
    let resolveGeneratedOutput!: (path: string) => void;
    const generatedOutput = new Promise<string>((resolve) => {
      resolveGeneratedOutput = resolve;
    });

    lifecycle.onAvailable("initial-preview");
    const adapterReplacement = generatedOutput.then((path) => {
      if (adapterRequestGeneration !== requestGeneration) {
        cleanedPaths.push(path);
        return false;
      }
      lifecycle.begin(adapterRequestGeneration);
      openedFormats.push("html");
      lifecycle.onAvailable("adapter-preview");
      return true;
    });

    const oldViewWasCurrent = lifecycle.onUnavailable("initial-preview", requestGeneration, () => {
      requestGeneration++;
    });
    expect(oldViewWasCurrent).toBe(true);
    expect(requestGeneration).toBe(13);

    lifecycle.onAvailable("user-selected-preview");
    resolveGeneratedOutput(generatedPath);

    expect(await adapterReplacement).toBe(false);
    expect(openedFormats).toEqual([]);
    expect(cleanedPaths).toEqual([generatedPath]);

    const userViewWasCurrent = lifecycle.onUnavailable("user-selected-preview", requestGeneration, () => {
      requestGeneration++;
    });
    expect(userViewWasCurrent).toBe(true);
    expect(requestGeneration).toBe(14);
  });

  // Given: 外部アダプタの生成中で、インラインプレビューがまだ開いていない
  // When: エディタの形式選択メニューから別形式を開く
  // Then: 新規ビューの通知でアダプタ要求を無効化し、遅れて返る生成物は表示せず削除する
  it("Scenario: cancels pending adapter generation when another format opens without an existing preview", async () => {
    const lifecycle = createPreviewReplacementLifecycle();
    let requestGeneration = 20;
    const adapterRequestGeneration = requestGeneration;
    const generatedPath = "C:\\Temp\\WasabiPad\\empty-preview\\preview.html";
    const cleanedPaths: string[] = [];
    const openedFormats: string[] = [];
    let resolveGeneratedOutput!: (path: string) => void;
    const generatedOutput = new Promise<string>((resolve) => {
      resolveGeneratedOutput = resolve;
    });

    const adapterReplacement = generatedOutput.then((path) => {
      if (adapterRequestGeneration !== requestGeneration) {
        cleanedPaths.push(path);
        return false;
      }
      lifecycle.begin(adapterRequestGeneration);
      openedFormats.push("html");
      lifecycle.onAvailable("adapter-preview", adapterRequestGeneration, () => {
        requestGeneration++;
      });
      return true;
    });

    lifecycle.onAvailable("user-selected-preview", requestGeneration, () => {
      requestGeneration++;
    });
    expect(requestGeneration).toBe(21);

    resolveGeneratedOutput(generatedPath);
    expect(await adapterReplacement).toBe(false);
    expect(openedFormats).toEqual([]);
    expect(cleanedPaths).toEqual([generatedPath]);

    const userViewWasCurrent = lifecycle.onUnavailable("user-selected-preview", requestGeneration, () => {
      requestGeneration++;
    });
    expect(userViewWasCurrent).toBe(true);
    expect(requestGeneration).toBe(22);
  });

  // Given: プレビューがなく、生成済みHTMLを開く処理がビューの登録待ち
  // When: その待機中に利用者が別形式のビューを開く
  // Then: 生成物だけを掃除し、選択形式と状態を保って次の編集同期でもアダプタを再実行しない
  it("Scenario: cleans generated output when another format supersedes an adapter open", async () => {
    const lifecycle = createPreviewReplacementLifecycle();
    const requestGeneration = 30;
    let currentGeneration = requestGeneration;
    let outputPath: string | null = "C:\\Temp\\WasabiPad\\opening\\preview.html";
    let activeRequestId: string | null = "adapter-request";
    const previewDoc: PreviewDocument = { ownerTabId: "tab-1", path: "sample.aaa", format: "html" };
    let previewDocument: PreviewDocument | null = previewDoc;
    let previewFormatStatus: "html" | "markdown" | null = "html";
    const cleanedPaths: string[] = [];
    let inlinePreview!: InlinePreview;
    const host = document.createElement("div");
    const frame = document.createElement("iframe");
    host.appendChild(frame);
    document.body.appendChild(host);
    let signalAdapterOpening!: () => void;
    const adapterOpeningStarted = new Promise<void>((resolve) => {
      signalAdapterOpening = resolve;
    });
    const invalidate = (clearSelection = true) => {
      currentGeneration++;
      if (outputPath) cleanedPaths.push(outputPath);
      outputPath = null;
      activeRequestId = null;
      if (clearSelection) {
        previewDocument = null;
        previewFormatStatus = null;
      }
      inlinePreview.setExternalOutputPath(null);
    };
    inlinePreview = new InlinePreview(host, {
      onAvailabilityChange: (available, label) => {
        if (available) lifecycle.onAvailable(label, currentGeneration, invalidate);
        else lifecycle.onUnavailable(label, currentGeneration, invalidate);
      },
    });
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      origin: window.location.origin,
      data: { type: INLINE_PREVIEW_MESSAGES.READY_MESSAGE },
    }));
    inlinePreview.setExternalOutputPath(outputPath);
    const viewers = new LiveViewers({
      openViewer: async (format, text, selection, externalOutputPath) => {
        previewFormatStatus = format === "html" || format === "markdown" ? format : null;
        if (format === "html") signalAdapterOpening();
        const label = await inlinePreview.open(format, text, selection, externalOutputPath);
        if (isCurrentPreviewDocument(previewDocument, "tab-1", "sample.aaa")) {
          previewDocument.format = format as "html" | "markdown";
        }
        return label;
      },
      updateViewer: async () => true,
      closeViewer: async (label) => inlinePreview.close(label),
      wholeRange: async () => ({ start: { line: 0, col: 0 }, end: { line: 0, col: 0 } }),
      textInRange: async () => "generated html",
    });

    lifecycle.begin(requestGeneration);
    const adapterOpening = viewers.open("html", null, {
      start: { line: 0, col: 0 }, end: { line: 0, col: 0 },
    });
    await adapterOpeningStarted;

    viewers.clear();
    inlinePreview.setPendingExternalOutputPath(null);
    const cancellation = inlinePreview.cancelPendingExternalOpen();
    const clearMessage = postMessage.mock.calls
      .map(([message]) => message as { type?: string; render_id?: string })
      .filter((message) => message.type === INLINE_PREVIEW_MESSAGES.CLEAR_MESSAGE)
      .at(-1);
    expect(clearMessage?.render_id).toEqual(expect.any(String));
    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      origin: window.location.origin,
      data: { type: INLINE_PREVIEW_MESSAGES.CLEARED_MESSAGE, render_id: clearMessage!.render_id },
    }));
    await cancellation;
    const openedLabel = await adapterOpening;
    const wasSuperseded = lifecycle.handleOpenResult(openedLabel, () => {
      if (activeRequestId === "adapter-request") {
        activeRequestId = null;
        invalidate(previewDocument === previewDoc);
      }
    });

    lifecycle.begin(currentGeneration);
    const selectedLabel = await viewers.open("markdown", null, {
      start: { line: 0, col: 0 }, end: { line: 0, col: 0 },
    });
    if (selectedLabel !== null && lifecycle.isActive(selectedLabel)) {
      previewDocument = { ownerTabId: "tab-1", path: "sample.aaa", format: "markdown" };
      previewFormatStatus = "markdown";
    }
    expect(viewers.has("markdown")).toBe(true);
    const selectedPayload = () => {
      const payloadMessages = postMessage.mock.calls
        .map(([message]) => message as { type?: string; payload?: { format: string; external_output_path: string | null } })
        .filter((message) => message.type === INLINE_PREVIEW_MESSAGES.PAYLOAD_MESSAGE);
      return payloadMessages[payloadMessages.length - 1]?.payload;
    };
    expect(selectedPayload()).toMatchObject({
      format: "markdown",
      external_output_path: null,
    });

    expect(openedLabel).toBeNull();
    expect(wasSuperseded).toBe(true);
    expect(outputPath).toBeNull();
    expect(activeRequestId).toBeNull();
    expect(previewDocument).toEqual({ ownerTabId: "tab-1", path: "sample.aaa", format: "markdown" });
    expect(previewFormatStatus).toBe("markdown");
    expect(currentGeneration).toBe(31);
    expect(cleanedPaths).toEqual(["C:\\Temp\\WasabiPad\\opening\\preview.html"]);
    expect(viewers.has("markdown")).toBe(true);
    expect(selectedPayload()).toMatchObject({
      format: "markdown",
      external_output_path: null,
    });

    let adapterRuns = 1;
    // syncPreviewDocument uses this same predicate to skip an already-current preview.
    if (!isCurrentPreviewDocument(previewDocument, "tab-1", "sample.aaa")) adapterRuns++;
    expect(adapterRuns).toBe(1);

    lifecycle.finish(currentGeneration);
    viewers.clear();
    await vi.waitFor(() => expect(currentGeneration).toBe(32));
    expect(cleanedPaths).toEqual(["C:\\Temp\\WasabiPad\\opening\\preview.html"]);
    expect(viewers.has("markdown")).toBe(false);
    expect(previewDocument).toBeNull();
    expect(previewFormatStatus).toBeNull();
  });

  // Given: 外部HTMLの旧出力が表示中で、複数の置換要求が重なっている
  // When: 生成またはopenが失敗し、後から最新の置換だけが成功する
  // Then: 旧ビューと旧出力を保ち、最新ビューの成功後にだけ参照終了分を掃除する
  it("Scenario: retains displayed output across failed and overlapping replacements", async () => {
    const cleanedPaths: string[] = [];
    const outputLifecycle = createExternalPreviewOutputLifecycle((path) => cleanedPaths.push(path));
    const oldPath = "C:\\Temp\\WasabiPad\\active\\preview.html";
    const newPath = "C:\\Temp\\WasabiPad\\replacement\\preview.html";
    const obsoletePath = "C:\\Temp\\WasabiPad\\obsolete\\preview.html";
    const oldSourcePath = "C:\\Work\\score.aaa";
    const replacementSourcePath = "C:\\Work\\different-score.aaa";
    const host = document.createElement("div");
    const frame = document.createElement("iframe");
    host.appendChild(frame);
    document.body.appendChild(host);
    const inlinePreview = new InlinePreview(host);
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
    const latestRenderId = () => postMessage.mock.calls
      .map(([message]) => message as { type?: string; render_id?: string })
      .filter((message) => message.type === INLINE_PREVIEW_MESSAGES.PAYLOAD_MESSAGE)
      .at(-1)?.render_id;
    const notifyRendered = (renderId: string) => window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      origin: window.location.origin,
      data: { type: INLINE_PREVIEW_MESSAGES.DISPLAY_COMMITTED_MESSAGE, render_id: renderId },
    }));
    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      origin: window.location.origin,
      data: { type: INLINE_PREVIEW_MESSAGES.READY_MESSAGE },
    }));
    let failNextOpen = false;
    let delayedTextRead: Promise<string> | null = null;
    let signalDelayedTextRead!: () => void;
    const delayedTextReadStarted = new Promise<void>((resolve) => {
      signalDelayedTextRead = resolve;
    });
    const viewers = new LiveViewers({
      openViewer: async (format, text, selection, externalOutputPath) => {
        if (failNextOpen) {
          failNextOpen = false;
          throw new Error("replacement open failed");
        }
        return inlinePreview.open(format, text, selection, externalOutputPath);
      },
      updateViewer: async () => true,
      closeViewer: async (label) => inlinePreview.close(label),
      wholeRange: async () => ({ start: { line: 0, col: 0 }, end: { line: 0, col: 0 } }),
      textInRange: async () => {
        const pending = delayedTextRead;
        delayedTextRead = null;
        if (!pending) return "preview content";
        signalDelayedTextRead();
        return pending;
      },
    });
    const selection = { start: { line: 0, col: 0 }, end: { line: 0, col: 0 } };
    const lastPayload = () => postMessage.mock.calls
      .map(([message]) => message as {
        type?: string;
        payload?: { external_output_path: string | null; source_path: string | null };
      })
      .filter((message) => message.type === INLINE_PREVIEW_MESSAGES.PAYLOAD_MESSAGE)
      .at(-1)?.payload;

    inlinePreview.setSourcePath(oldSourcePath);
    inlinePreview.setExternalOutputPath(oldPath);
    const oldOpening = viewers.open("html", null, selection, selection.end, oldPath);
    await vi.waitFor(() => expect(latestRenderId()).toEqual(expect.any(String)));
    notifyRendered(latestRenderId()!);
    const oldLabel = await oldOpening;
    expect(oldLabel).not.toBeNull();
    outputLifecycle.replaceDisplayedOutput(oldPath);
    expect(lastPayload()?.external_output_path).toBe(oldPath);

    let finishGeneration!: (path: string) => void;
    const pendingGeneration = new Promise<string>((resolve) => {
      finishGeneration = resolve;
    });
    expect(outputLifecycle.displayedOutputPath()).toBe(oldPath);
    expect(cleanedPaths).toEqual([]);
    finishGeneration(newPath);
    expect(await pendingGeneration).toBe(newPath);
    expect(outputLifecycle.displayedOutputPath()).toBe(oldPath);
    expect(lastPayload()?.external_output_path).toBe(oldPath);
    inlinePreview.setSourcePath(replacementSourcePath);
    await inlinePreview.update(oldLabel!, "edited while replacement waits", null);
    expect(lastPayload()).toMatchObject({
      external_output_path: oldPath,
      source_path: oldSourcePath,
    });
    expect(cleanedPaths).toEqual([]);

    let failGeneration!: (error: Error) => void;
    const failedGeneration = new Promise<string>((_resolve, reject) => {
      failGeneration = reject;
    });
    expect(outputLifecycle.displayedOutputPath()).toBe(oldPath);
    failGeneration(new Error("replacement generation failed"));
    await expect(failedGeneration).rejects.toThrow("replacement generation failed");
    expect(lastPayload()?.external_output_path).toBe(oldPath);
    expect(outputLifecycle.displayedOutputPath()).toBe(oldPath);
    expect(cleanedPaths).toEqual([]);

    failNextOpen = true;
    await expect(viewers.replace("html", null, selection, selection.end, newPath))
      .rejects.toThrow("replacement open failed");
    expect(viewers.has("html")).toBe(true);
    expect(lastPayload()?.external_output_path).toBe(oldPath);
    expect(outputLifecycle.displayedOutputPath()).toBe(oldPath);
    expect(cleanedPaths).toEqual([]);

    let finishObsoleteOpen!: (text: string) => void;
    delayedTextRead = new Promise<string>((resolve) => {
      finishObsoleteOpen = resolve;
    });
    const obsoleteOpen = viewers.replace("html", null, selection, selection.end, obsoletePath);
    await delayedTextReadStarted;

    const currentReplacement = viewers.replace("html", null, selection, selection.end, newPath);
    await vi.waitFor(() => expect(latestRenderId()).toEqual(expect.any(String)));
    notifyRendered(latestRenderId()!);
    expect(await currentReplacement).not.toBeNull();
    outputLifecycle.replaceDisplayedOutput(newPath);
    finishObsoleteOpen("obsolete content");
    expect(await obsoleteOpen).toBeNull();
    outputLifecycle.discardGeneratedOutput(obsoletePath);

    expect(lastPayload()?.external_output_path).toBe(newPath);
    expect(outputLifecycle.displayedOutputPath()).toBe(newPath);
    expect(cleanedPaths).toEqual([oldPath, obsoletePath]);
  });

  // Feature: 外部プレビューの表示置換
  // Scenario: 新しいHTML iframeの描画確認後にだけ旧出力を掃除する
  // Given: 旧外部出力が現在表示され、新しい出力を開き始めた
  // When: viewerの描画確認がまだ返っていない
  // Then: openは保留され、旧出力を表示・保持し、確認後にだけ新出力へ切り替える
  it("Scenario: waits for rendered output before retiring the displayed output", async () => {
    const cleanedPaths: string[] = [];
    const outputLifecycle = createExternalPreviewOutputLifecycle((path) => cleanedPaths.push(path));
    const oldPath = "C:\\Temp\\WasabiPad\\render-ready\\old.html";
    const newPath = "C:\\Temp\\WasabiPad\\render-ready\\new.html";
    const host = document.createElement("div");
    const frame = document.createElement("iframe");
    host.appendChild(frame);
    document.body.appendChild(host);
    const inlinePreview = new InlinePreview(host);
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
    const notifyRendered = (renderId: string) => window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      origin: window.location.origin,
      data: { type: INLINE_PREVIEW_MESSAGES.DISPLAY_COMMITTED_MESSAGE, render_id: renderId },
    }));
    const renderIdOfLastPayload = () => {
      const payloadMessage = postMessage.mock.calls
        .map(([message]) => message as { type?: string; render_id?: string; payload?: { external_output_path: string | null } })
        .filter((message) => message.type === INLINE_PREVIEW_MESSAGES.PAYLOAD_MESSAGE)
        .at(-1);
      return payloadMessage?.render_id;
    };
    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      origin: window.location.origin,
      data: { type: INLINE_PREVIEW_MESSAGES.READY_MESSAGE },
    }));

    const oldOpening = inlinePreview.open("html", "old preview", null, oldPath);
    const oldRenderId = renderIdOfLastPayload();
    expect(oldRenderId).toEqual(expect.any(String));
    notifyRendered(oldRenderId!);
    expect(await oldOpening).not.toBeNull();
    outputLifecycle.replaceDisplayedOutput(oldPath);

    const newOpening = inlinePreview.open("html", "new preview", null, newPath);
    const newRenderId = renderIdOfLastPayload();
    expect(newRenderId).toEqual(expect.any(String));
    let openingResolved = false;
    void newOpening.then(() => { openingResolved = true; });
    await Promise.resolve();

    expect(openingResolved).toBe(false);
    expect(inlinePreview.mayReferenceExternalOutputPath(oldPath)).toBe(true);
    expect(outputLifecycle.displayedOutputPath()).toBe(oldPath);
    expect(cleanedPaths).toEqual([]);

    notifyRendered(newRenderId!);
    expect(await newOpening).not.toBeNull();
    outputLifecycle.replaceDisplayedOutput(newPath);

    expect(inlinePreview.mayReferenceExternalOutputPath(newPath)).toBe(true);
    expect(outputLifecycle.displayedOutputPath()).toBe(newPath);
    expect(cleanedPaths).toEqual([oldPath]);
  });

  // Feature: 外部プレビューの失敗時の置換
  // Scenario: 新しいiframeが読めなければ旧出力を維持する
  // Given: 旧外部出力が表示され、新しいHTML iframeを読み込んでいる
  // When: viewerが新しいiframeの読込失敗を通知する
  // Then: 旧出力を保持し、新しい生成物だけを破棄する
  it("Scenario: keeps the old output when the replacement iframe fails to load", async () => {
    const cleanedPaths: string[] = [];
    const outputLifecycle = createExternalPreviewOutputLifecycle((path) => cleanedPaths.push(path));
    const oldPath = "C:\\Temp\\WasabiPad\\load-failure\\old.html";
    const failedPath = "C:\\Temp\\WasabiPad\\load-failure\\failed.html";
    const host = document.createElement("div");
    const frame = document.createElement("iframe");
    host.appendChild(frame);
    document.body.appendChild(host);
    const inlinePreview = new InlinePreview(host);
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
    const latestRenderId = () => postMessage.mock.calls
      .map(([message]) => message as { type?: string; render_id?: string })
      .filter((message) => message.type === INLINE_PREVIEW_MESSAGES.PAYLOAD_MESSAGE)
      .at(-1)?.render_id;
    const notify = (type: string, renderId: string) => window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      origin: window.location.origin,
      data: { type, render_id: renderId },
    }));
    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      origin: window.location.origin,
      data: { type: INLINE_PREVIEW_MESSAGES.READY_MESSAGE },
    }));

    const oldOpening = inlinePreview.open("html", "old", null, oldPath);
    await vi.waitFor(() => expect(latestRenderId()).toEqual(expect.any(String)));
    const oldRenderId = latestRenderId()!;
    notify(INLINE_PREVIEW_MESSAGES.DISPLAY_COMMITTED_MESSAGE, oldRenderId);
    expect(await oldOpening).not.toBeNull();
    outputLifecycle.replaceDisplayedOutput(oldPath);

    const failedOpening = inlinePreview.open("html", "failed", null, failedPath);
    await vi.waitFor(() => expect(latestRenderId()).not.toBe(oldRenderId));
    notify(INLINE_PREVIEW_MESSAGES.DISPLAY_FAILED_MESSAGE, latestRenderId()!);
    expect(await failedOpening).toBeNull();
    outputLifecycle.discardGeneratedOutput(failedPath, inlinePreview.mayReferenceExternalOutputPath(failedPath));

    expect(inlinePreview.mayReferenceExternalOutputPath(oldPath)).toBe(true);
    expect(outputLifecycle.displayedOutputPath()).toBe(oldPath);
    expect(cleanedPaths).toEqual([failedPath]);
  });

  // Feature: 外部プレビュー要求の世代管理
  // Scenario: 古い出力の描画確認待ちに新要求が始まったら旧表示へ戻す
  // Given: Aのiframeが描画済みだが、親への確認応答は未処理である
  // When: Bが開始して失敗し、Aの遅延確認と取消後の旧表示確認が届く
  // Then: Aを確定せず、旧出力を表示・保持し、Aの生成物だけを削除する
  it("Scenario: restores the displayed output when a newer request supersedes a delayed render acknowledgement", async () => {
    const cleanedPaths: string[] = [];
    const outputLifecycle = createExternalPreviewOutputLifecycle((path) => cleanedPaths.push(path));
    const oldPath = "C:\\Temp\\WasabiPad\\generation\\old.html";
    const stalePath = "C:\\Temp\\WasabiPad\\generation\\stale-a.html";
    const host = document.createElement("div");
    const frame = document.createElement("iframe");
    host.appendChild(frame);
    document.body.appendChild(host);
    const inlinePreview = new InlinePreview(host);
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
    let requestGeneration = 1;
    let childDisplayedPath: string | null = null;
    const latestPayloadMessage = () => postMessage.mock.calls
      .map(([message]) => message as {
        type?: string;
        render_id?: string;
        payload?: { external_output_path: string | null };
      })
      .filter((message) => message.type === INLINE_PREVIEW_MESSAGES.PAYLOAD_MESSAGE)
      .at(-1);
    const notifyRendered = (renderId: string) => window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      origin: window.location.origin,
      data: { type: INLINE_PREVIEW_MESSAGES.DISPLAY_COMMITTED_MESSAGE, render_id: renderId },
    }));
    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      origin: window.location.origin,
      data: { type: INLINE_PREVIEW_MESSAGES.READY_MESSAGE },
    }));
    const viewers = new LiveViewers({
      openViewer: (format, text, selection, externalOutputPath, isCurrent) =>
        inlinePreview.open(format, text, selection, externalOutputPath, isCurrent),
      cancelPendingOpen: () => inlinePreview.cancelPendingExternalOpen(),
      updateViewer: async () => true,
      closeViewer: (label) => inlinePreview.close(label),
      wholeRange: async () => ({ start: { line: 0, col: 0 }, end: { line: 0, col: 0 } }),
      textInRange: async () => "preview content",
    });
    const selection = { start: { line: 0, col: 0 }, end: { line: 0, col: 0 } };
    const isCurrentRequest = () => requestGeneration === 1;

    const oldOpening = viewers.open("html", null, selection, selection.end, oldPath, isCurrentRequest);
    await vi.waitFor(() => expect(latestPayloadMessage()?.render_id).toEqual(expect.any(String)));
    const oldRenderId = latestPayloadMessage()!.render_id!;
    childDisplayedPath = oldPath;
    notifyRendered(oldRenderId);
    const oldLabel = await oldOpening;
    expect(oldLabel).not.toBeNull();
    outputLifecycle.replaceDisplayedOutput(oldPath);

    const staleOpening = viewers.replace("html", null, selection, selection.end, stalePath, isCurrentRequest);
    await vi.waitFor(() => expect(latestPayloadMessage()?.payload?.external_output_path).toBe(stalePath));
    const staleRenderId = latestPayloadMessage()!.render_id!;
    childDisplayedPath = stalePath;
    expect(outputLifecycle.displayedOutputPath()).toBe(oldPath);
    expect(cleanedPaths).toEqual([]);

    requestGeneration++;
    viewers.invalidatePendingOpens();
    const cancellation = viewers.cancelPendingOpen();
    const restoreMessage = latestPayloadMessage()!;
    expect(restoreMessage.render_id).not.toBe(staleRenderId);
    expect(restoreMessage.payload?.external_output_path).toBe(oldPath);

    notifyRendered(staleRenderId);
    expect(inlinePreview.mayReferenceExternalOutputPath(oldPath)).toBe(true);
    expect(outputLifecycle.displayedOutputPath()).toBe(oldPath);
    expect(cleanedPaths).toEqual([]);

    childDisplayedPath = oldPath;
    notifyRendered(restoreMessage.render_id!);
    await cancellation;
    expect(await staleOpening).toBeNull();
    outputLifecycle.discardGeneratedOutput(stalePath, inlinePreview.mayReferenceExternalOutputPath(stalePath));

    expect(childDisplayedPath).toBe(oldPath);
    expect(inlinePreview.mayReferenceExternalOutputPath(oldPath)).toBe(true);
    expect(outputLifecycle.displayedOutputPath()).toBe(oldPath);
    expect(cleanedPaths).toEqual([stalePath]);
    expect(viewers.has("html")).toBe(true);
  });

  // Feature: 外部プレビュー要求の世代管理
  // Scenario: 古いビューopenが後から完了しても表示出力へ昇格しない
  // Given: Aのビューopenが待機中で、旧出力が表示されている
  // When: B開始後にAのopenが完了する
  // Then: Aは世代確認で昇格を拒否され、旧出力を保ったままAだけ掃除する
  it("Scenario: does not promote an output when its viewer open completes after a newer request starts", async () => {
    const cleanedPaths: string[] = [];
    const outputLifecycle = createExternalPreviewOutputLifecycle((path) => cleanedPaths.push(path));
    const oldPath = "C:\\Temp\\WasabiPad\\late-open\\old.html";
    const stalePath = "C:\\Temp\\WasabiPad\\late-open\\stale-a.html";
    outputLifecycle.replaceDisplayedOutput(oldPath);

    let requestGeneration = 40;
    const adapterGeneration = requestGeneration;
    let finishViewerOpen!: (label: string) => void;
    const pendingViewerOpen = new Promise<string>((resolve) => {
      finishViewerOpen = resolve;
    });
    const adapterOpen = pendingViewerOpen.then(() => {
      const committed = outputLifecycle.replaceDisplayedOutput(
        stalePath,
        () => adapterGeneration === requestGeneration,
      );
      if (!committed) outputLifecycle.discardGeneratedOutput(stalePath);
      return committed;
    });

    requestGeneration++; // B starts while A is awaiting editor.openTextViewer().
    finishViewerOpen("inline-preview-a");

    expect(await adapterOpen).toBe(false);
    expect(outputLifecycle.displayedOutputPath()).toBe(oldPath);
    expect(cleanedPaths).toEqual([stalePath]);
  });

  // Feature: 外部プレビューの参照寿命
  // Scenario: 閉じたiframeが外部出力を解放した後に生成物を掃除する
  // Given: 外部HTMLのiframeと出力ファイルが表示中である
  // When: ビューを閉じ、viewerから消去確認が返る
  // Then: 確認前は出力を保持し、確認後の終了通知でだけ掃除する
  it("Scenario: retires external output only after the viewer confirms close", async () => {
    const cleanedPaths: string[] = [];
    const outputLifecycle = createExternalPreviewOutputLifecycle((path) => cleanedPaths.push(path));
    const outputPath = "C:\\Temp\\WasabiPad\\close\\preview.html";
    const host = document.createElement("div");
    const frame = document.createElement("iframe");
    host.appendChild(frame);
    document.body.appendChild(host);
    const inlinePreview = new InlinePreview(host, {
      onAvailabilityChange: (available) => {
        if (!available) outputLifecycle.replaceDisplayedOutput(null);
      },
    });
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
    const latestId = (type: string) => postMessage.mock.calls
      .map(([message]) => message as { type?: string; render_id?: string })
      .filter((message) => message.type === type)
      .at(-1)?.render_id;
    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      origin: window.location.origin,
      data: { type: INLINE_PREVIEW_MESSAGES.READY_MESSAGE },
    }));

    const opening = inlinePreview.open("html", "trusted output", null, outputPath);
    await vi.waitFor(() => expect(latestId(INLINE_PREVIEW_MESSAGES.PAYLOAD_MESSAGE)).toEqual(expect.any(String)));
    const openId = latestId(INLINE_PREVIEW_MESSAGES.PAYLOAD_MESSAGE)!;
    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      origin: window.location.origin,
      data: { type: INLINE_PREVIEW_MESSAGES.DISPLAY_COMMITTED_MESSAGE, render_id: openId },
    }));
    const label = await opening;
    expect(label).not.toBeNull();
    outputLifecycle.replaceDisplayedOutput(outputPath);

    const closing = inlinePreview.close(label!);
    await vi.waitFor(() => expect(latestId(INLINE_PREVIEW_MESSAGES.CLEAR_MESSAGE)).toEqual(expect.any(String)));
    expect(inlinePreview.mayReferenceExternalOutputPath(outputPath)).toBe(true);
    expect(outputLifecycle.displayedOutputPath()).toBe(outputPath);
    expect(cleanedPaths).toEqual([]);

    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      origin: window.location.origin,
      data: {
        type: INLINE_PREVIEW_MESSAGES.CLEARED_MESSAGE,
        render_id: latestId(INLINE_PREVIEW_MESSAGES.CLEAR_MESSAGE),
      },
    }));
    await closing;
    await vi.waitFor(() => expect(outputLifecycle.displayedOutputPath()).toBeNull());

    expect(inlinePreview.mayReferenceExternalOutputPath(outputPath)).toBe(false);
    expect(cleanedPaths).toEqual([outputPath]);
  });

});

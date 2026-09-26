// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { INLINE_PREVIEW_MESSAGES } from "./inline-preview-protocol";
import type { AbcPreviewHostOptions } from "./music-abc-preview";
import type { LilypondPreviewHostOptions } from "./music-lilypond-preview";
import type { LilyOutput } from "./generated/LilyOutput";

describe("Feature: 楽譜アドインのビューア接続", () => {
  it("Scenario: ABCは入力更新に追随し、LilyPondは手動生成を委ね、切替と終了でhostを破棄する", async () => {
    // Given: inline viewerと公式アドインのhost/APIを用意する
    const html = readFileSync("viewer.html", "utf8");
    const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1];
    expect(body).toBeDefined();
    document.body.innerHTML = body!.replace(/<script[\s\S]*?<\/script>/i, "");
    window.history.replaceState(null, "", "/?inline=1");

    const abcHost = { render: vi.fn(async (_text: string) => {}), dispose: vi.fn() };
    const lilypondHost = { setSource: vi.fn(async (_text: string, _path: string | null) => {}), dispose: vi.fn() };
    let abcOptions: AbcPreviewHostOptions | null = null;
    let lilypondOptions: LilypondPreviewHostOptions | null = null;
    const createAbcPreviewHost = vi.fn((_container: HTMLElement, options: AbcPreviewHostOptions) => {
      abcOptions = options;
      return abcHost;
    });
    const createLilypondPreviewHost = vi.fn((_container: HTMLElement, options: LilypondPreviewHostOptions) => {
      lilypondOptions = options;
      return lilypondHost;
    });
    const api = {
      EVENT_NAMES: { viewerUpdate: "viewer-update" },
      openExternalUrl: vi.fn(async () => {}),
      openInDefaultBrowser: vi.fn(async () => {}),
      readSqlitePreview: vi.fn(async () => ({ columns: [], rows: [], totalRows: 0 })),
      takeViewerPayload: vi.fn(async () => null),
      musicAddonStatus: vi.fn(async (id: string) => ({ id, version: "1.0.0", installed: true, enabled: true })),
      lilypondGenerate: vi.fn(async (_text: string, _path: string | null, _requestId: string): Promise<LilyOutput> => ({ svgPages: [], midiFiles: [] })),
      lilypondCancel: vi.fn(async () => {}),
    };

    vi.resetModules();
    vi.doMock("./api", () => api);
    vi.doMock("./music-abc-preview", () => ({ createAbcPreviewHost }));
    vi.doMock("./music-lilypond-preview", () => ({ createLilypondPreviewHost }));
    vi.doMock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
    vi.doMock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
    vi.doMock("@tauri-apps/api/core", () => ({
      convertFileSrc: vi.fn((path: string) => path),
      invoke: vi.fn(),
    }));
    vi.doMock("./settings", () => ({
      initSettings: vi.fn(async () => {}),
      getSetting: vi.fn((key: string) => ({
        fontFamily: "Consolas",
        previewFontSize: 14,
        markdownSoftBreaks: false,
        markdownLineHeight: 1.5,
        markdownHeadingUnderlines: true,
      })[key]),
      isValidMarkdownLineHeight: vi.fn(() => true),
      setSetting: vi.fn(),
    }));
    vi.doMock("./viewer-chart", () => ({
      ViewerChartController: class {
        clear = vi.fn();
        refresh = vi.fn();
        setRows = vi.fn();
      },
    }));
    vi.doMock("./window-layout-runtime", () => ({
      createWindowLayoutRuntime: vi.fn(() => ({
        coordinator: { refresh: vi.fn(), request: vi.fn() },
        dispose: vi.fn(),
      })),
    }));

    await import("./viewer");

    const sendPayload = (format: "abc" | "lilypond" | "csv", text: string, sourcePath: string) => {
      window.dispatchEvent(new MessageEvent("message", {
        data: {
          type: INLINE_PREVIEW_MESSAGES.PAYLOAD_MESSAGE,
          payload: {
            format,
            text,
            selection: null,
            source_path: sourcePath,
            effective_extension: format,
            archive_path: null,
            archive_entry: null,
          },
        },
        source: window,
        origin: window.location.origin,
      }));
    };

    // When: ABC文書を開き、同じ文書の編集内容を更新する
    sendPayload("abc", "X:1\nK:C\nC D E F|", "C:/Scores/song.abc");
    await vi.waitFor(() => expect(abcHost.render).toHaveBeenCalledOnce());
    sendPayload("abc", "X:1\nK:C\nG A B c|", "C:/Scores/song.abc");
    await vi.waitFor(() => expect(abcHost.render).toHaveBeenCalledTimes(2));

    // Then: ABC hostは再利用され、公式statusと許可外URLを拒否するloaderを受け取る
    expect(createAbcPreviewHost).toHaveBeenCalledOnce();
    expect(abcHost.render).toHaveBeenLastCalledWith("X:1\nK:C\nG A B c|");
    await abcOptions!.getStatus();
    expect(api.musicAddonStatus).toHaveBeenCalledWith("abc");
    await expect(abcOptions!.loadModule("https://example.invalid/entry.js")).rejects.toThrow();

    // When: LilyPond文書に切り替える
    sendPayload("lilypond", "\\score { { c'4 } }", "C:/Scores/song.ly");
    await vi.waitFor(() => expect(createLilypondPreviewHost).toHaveBeenCalledOnce());

    // Then: ABC hostを破棄し、LilyPond hostへ入力を渡すだけでCLI生成しない
    expect(abcHost.dispose).toHaveBeenCalledOnce();
    expect(lilypondHost.setSource).toHaveBeenCalledWith("\\score { { c'4 } }", "C:/Scores/song.ly");
    await lilypondOptions!.getStatus();
    expect(api.musicAddonStatus).toHaveBeenCalledWith("lilypond");
    expect(api.lilypondGenerate).not.toHaveBeenCalled();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    expect(await lilypondOptions!.confirmExecution()).toBe(false);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Scheme"));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("信頼できる文書"));
    confirm.mockRestore();

    // When: 更新要求をhostから受け、文書切替とビューア終了を行う
    const requestId = "123e4567-e89b-12d3-a456-426614174000";
    const uuid = vi.spyOn(window.crypto, "randomUUID").mockReturnValue(requestId);
    let finishGenerate!: (result: LilyOutput) => void;
    api.lilypondGenerate.mockImplementation((_text, _path, _requestId) => new Promise((resolve) => {
      finishGenerate = resolve;
    }));
    const generation = lilypondOptions!.generate("\\score { { d'4 } }", "C:/Scores/song.ly");
    expect(api.lilypondGenerate).toHaveBeenCalledWith("\\score { { d'4 } }", "C:/Scores/song.ly", requestId);
    await lilypondOptions!.cancelGeneration();
    expect(api.lilypondCancel).toHaveBeenCalledWith(requestId);
    finishGenerate({ svgPages: [], midiFiles: [] });
    await generation;
    uuid.mockRestore();

    sendPayload("csv", "a,b\n1,2", "C:/Scores/table.csv");
    await vi.waitFor(() => expect(lilypondHost.dispose).toHaveBeenCalledOnce());
    sendPayload("lilypond", "\\score { { e'4 } }", "C:/Scores/song.ly");
    await vi.waitFor(() => expect(createLilypondPreviewHost).toHaveBeenCalledTimes(2));
    window.dispatchEvent(new Event("beforeunload"));
    expect(lilypondHost.dispose).toHaveBeenCalledTimes(2);
  });

  it("Scenario: 現在の楽譜アドイン変更では再生を破棄して状態を再表示し、別形式の変更は無視する", async () => {
    // Given: ABC楽譜を表示中で、アプリイベントを受け取れる
    const html = readFileSync("viewer.html", "utf8");
    const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1];
    expect(body).toBeDefined();
    document.body.innerHTML = body!.replace(/<script[\s\S]*?<\/script>/i, "");
    window.history.replaceState(null, "", "/?inline=1");

    const abcHost = { render: vi.fn(async (_text: string) => {}), dispose: vi.fn() };
    const createAbcPreviewHost = vi.fn((_container: HTMLElement, options: AbcPreviewHostOptions) => {
      abcHost.render.mockImplementation(async () => { await options.getStatus(); });
      return abcHost;
    });
    let musicAddonChanged: ((event: { payload: string }) => void) | undefined;
    const listen = vi.fn(async (eventName: string, handler: (event: { payload: string }) => void) => {
      if (eventName === "music-addon-changed") musicAddonChanged = handler;
      return () => {};
    });
    const api = {
      EVENT_NAMES: { viewerUpdate: "viewer-update", musicAddonChanged: "music-addon-changed" },
      openExternalUrl: vi.fn(async () => {}),
      openInDefaultBrowser: vi.fn(async () => {}),
      readSqlitePreview: vi.fn(async () => ({ columns: [], rows: [], totalRows: 0 })),
      takeViewerPayload: vi.fn(async () => null),
      musicAddonStatus: vi.fn(async (id: string) => ({ id, version: "1.0.0", installed: true, enabled: false })),
      lilypondGenerate: vi.fn(async (_text: string, _path: string | null, _requestId: string): Promise<LilyOutput> => ({ svgPages: [], midiFiles: [] })),
      lilypondCancel: vi.fn(async () => {}),
    };

    vi.resetModules();
    vi.doMock("./api", () => api);
    vi.doMock("./music-abc-preview", () => ({ createAbcPreviewHost }));
    vi.doMock("./music-lilypond-preview", () => ({ createLilypondPreviewHost: vi.fn() }));
    vi.doMock("@tauri-apps/api/event", () => ({ listen }));
    vi.doMock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
    vi.doMock("@tauri-apps/api/core", () => ({ convertFileSrc: vi.fn((path: string) => path), invoke: vi.fn() }));
    vi.doMock("./settings", () => ({
      initSettings: vi.fn(async () => {}),
      getSetting: vi.fn((key: string) => ({ fontFamily: "Consolas", previewFontSize: 14, markdownSoftBreaks: false, markdownLineHeight: 1.5, markdownHeadingUnderlines: true })[key]),
      isValidMarkdownLineHeight: vi.fn(() => true),
      setSetting: vi.fn(),
    }));
    vi.doMock("./viewer-chart", () => ({ ViewerChartController: class { clear = vi.fn(); refresh = vi.fn(); setRows = vi.fn(); } }));
    vi.doMock("./window-layout-runtime", () => ({ createWindowLayoutRuntime: vi.fn(() => ({ coordinator: { refresh: vi.fn(), request: vi.fn() }, dispose: vi.fn() })) }));

    await import("./viewer");
    window.dispatchEvent(new MessageEvent("message", {
      data: {
        type: INLINE_PREVIEW_MESSAGES.PAYLOAD_MESSAGE,
        payload: { format: "abc", text: "X:1\nK:C\nC|", selection: null, source_path: "C:/Scores/song.abc", effective_extension: "abc", archive_path: null, archive_entry: null },
      },
      source: window,
      origin: window.location.origin,
    }));
    await vi.waitFor(() => expect(abcHost.render).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve));

    // When: 他形式と現在のABCアドインの変更通知を順に受け取る
    musicAddonChanged!({ payload: "lilypond" });
    musicAddonChanged!({ payload: "abc" });
    await vi.waitFor(() => expect(abcHost.render).toHaveBeenCalledTimes(2));

    // Then: 他形式は無視し、現在の再生を止めて無効状態を読むために再表示する
    expect(abcHost.dispose).toHaveBeenCalledOnce();
    expect(api.musicAddonStatus).toHaveBeenCalledWith("abc");
  });

  it("Scenario: 別ウィンドウの現在の楽譜アドイン変更も同じ再表示経路で再生を停止する", async () => {
    // Given: ABC楽譜を別ウィンドウで表示し、アプリイベントを受け取れる
    const html = readFileSync("viewer.html", "utf8");
    const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1];
    expect(body).toBeDefined();
    document.body.innerHTML = body!.replace(/<script[\s\S]*?<\/script>/i, "");
    window.history.replaceState(null, "", "/");

    const abcHost = { render: vi.fn(async () => {}), dispose: vi.fn() };
    const createAbcPreviewHost = vi.fn((_container: HTMLElement, options: AbcPreviewHostOptions) => {
      abcHost.render.mockImplementation(async () => { await options.getStatus(); });
      return abcHost;
    });
    let musicAddonChanged: ((event: { payload: string }) => void) | undefined;
    const api = {
      EVENT_NAMES: { viewerUpdate: "viewer-update", musicAddonChanged: "music-addon-changed" },
      openExternalUrl: vi.fn(async () => {}),
      openInDefaultBrowser: vi.fn(async () => {}),
      readSqlitePreview: vi.fn(async () => ({ columns: [], rows: [], totalRows: 0 })),
      takeViewerPayload: vi.fn(async () => ({ format: "abc", text: "X:1\nK:C\nC|", selection: null, source_path: "C:/Scores/song.abc", effective_extension: "abc", archive_path: null, archive_entry: null })),
      musicAddonStatus: vi.fn(async (id: string) => ({ id, version: "1.0.0", installed: false, enabled: false })),
      lilypondGenerate: vi.fn(async (_text: string, _path: string | null, _requestId: string): Promise<LilyOutput> => ({ svgPages: [], midiFiles: [] })),
      lilypondCancel: vi.fn(async () => {}),
    };
    const listen = vi.fn(async (eventName: string, handler: (event: { payload: string }) => void) => {
      if (eventName === "music-addon-changed") musicAddonChanged = handler;
      return () => {};
    });

    vi.resetModules();
    vi.doMock("./api", () => api);
    vi.doMock("./music-abc-preview", () => ({ createAbcPreviewHost }));
    vi.doMock("./music-lilypond-preview", () => ({ createLilypondPreviewHost: vi.fn() }));
    vi.doMock("@tauri-apps/api/event", () => ({ listen }));
    vi.doMock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn(() => ({ label: "viewer", show: vi.fn(async () => {}) })) }));
    vi.doMock("./window-controls", () => ({ WindowControls: class { dispose = vi.fn(); } }));
    vi.doMock("@tauri-apps/api/core", () => ({ convertFileSrc: vi.fn((path: string) => path), invoke: vi.fn() }));
    vi.doMock("./settings", () => ({
      initSettings: vi.fn(async () => {}),
      getSetting: vi.fn((key: string) => ({ fontFamily: "Consolas", previewFontSize: 14, markdownSoftBreaks: false, markdownLineHeight: 1.5, markdownHeadingUnderlines: true })[key]),
      isValidMarkdownLineHeight: vi.fn(() => true),
      setSetting: vi.fn(),
    }));
    vi.doMock("./viewer-chart", () => ({ ViewerChartController: class { clear = vi.fn(); refresh = vi.fn(); setRows = vi.fn(); } }));
    vi.doMock("./window-layout-runtime", () => ({ createWindowLayoutRuntime: vi.fn(() => ({ coordinator: { refresh: vi.fn(), request: vi.fn() }, dispose: vi.fn() })) }));

    await import("./viewer");
    await vi.waitFor(() => expect(abcHost.render).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve));

    // When: 現在のABCアドインが変更されたと通知される
    musicAddonChanged!({ payload: "abc" });
    await vi.waitFor(() => expect(abcHost.render).toHaveBeenCalledTimes(2));

    // Then: inline viewerと同じく再生を破棄し、状態を再取得して表示する
    expect(abcHost.dispose).toHaveBeenCalledOnce();
    expect(api.musicAddonStatus).toHaveBeenCalledWith("abc");
  });
});

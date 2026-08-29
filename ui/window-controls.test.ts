// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { Window } from "@tauri-apps/api/window";
import { WindowControls } from "./window-controls";

type CloseEvent = { preventDefault: () => void };

function mountControls(
  onCloseRequest?: () => Promise<boolean>,
  onStateChange?: (state: "minimized" | "maximized" | "restored") => void,
  onGeometryChange?: () => void,
) {
  const host = document.createElement("div");
  host.innerHTML = `
    <button id="win-min"></button>
    <button id="win-max"></button>
    <button id="win-close"></button>
    <span id="titletext"></span>
  `;
  let resizedHandler: (() => void) | undefined;
  let movedHandler: (() => void) | undefined;
  let scaleChangedHandler: (() => void) | undefined;
  let focusChangedHandler: (() => void) | undefined;
  let closeHandler: ((event: CloseEvent) => void | Promise<void>) | undefined;
  const unlistenResized = vi.fn();
  const unlistenMoved = vi.fn();
  const unlistenScaleChanged = vi.fn();
  const unlistenFocusChanged = vi.fn();
  const unlistenCloseRequested = vi.fn();
  const win = {
    minimize: vi.fn(),
    close: vi.fn(),
    toggleMaximize: vi.fn(),
    isMinimized: vi.fn(async () => false),
    isMaximized: vi.fn(async () => false),
    onResized: vi.fn(async (handler: () => void) => {
      resizedHandler = handler;
      return unlistenResized;
    }),
    onMoved: vi.fn(async (handler: () => void) => {
      movedHandler = handler;
      return unlistenMoved;
    }),
    onScaleChanged: vi.fn(async (handler: () => void) => {
      scaleChangedHandler = handler;
      return unlistenScaleChanged;
    }),
    onFocusChanged: vi.fn(async (handler: () => void) => {
      focusChangedHandler = handler;
      return unlistenFocusChanged;
    }),
    onCloseRequested: vi.fn(async (handler: (event: CloseEvent) => void | Promise<void>) => {
      closeHandler = handler;
      return unlistenCloseRequested;
    }),
  } as unknown as Window;
  const onError = vi.fn();
  const controls = new WindowControls(host, win, host.querySelector<HTMLElement>("#titletext")!, {
    onError,
    onCloseRequest,
    onGeometryChange,
    onStateChange,
  });
  return {
    host,
    win,
    onError,
    controls,
    resizedHandler,
    movedHandler: () => movedHandler,
    scaleChangedHandler: () => scaleChangedHandler,
    focusChangedHandler: () => focusChangedHandler,
    unlistenResized,
    unlistenMoved,
    unlistenScaleChanged,
    unlistenFocusChanged,
    unlistenCloseRequested,
    getCloseHandler: () => closeHandler,
  };
}

describe("Feature: WindowControls", () => {
  // Given: 最小化・最大化・閉じるボタンとタイトルを持つwindow controls
  // When: 各操作をクリックする
  // Then: 対応するnative window操作へ委譲する
  it("Scenario: window操作ボタンをnative APIへ委譲する", async () => {
    const { host, win } = mountControls();

    host.querySelector<HTMLButtonElement>("#win-min")!.click();
    host.querySelector<HTMLButtonElement>("#win-max")!.click();
    host.querySelector<HTMLButtonElement>("#win-close")!.click();
    host.querySelector<HTMLElement>("#titletext")!.dispatchEvent(new Event("dblclick"));

    await vi.waitFor(() => {
      expect(win.minimize).toHaveBeenCalledTimes(1);
      expect(win.toggleMaximize).toHaveBeenCalledTimes(2);
      expect(win.close).toHaveBeenCalledTimes(1);
    });
  });

  // Given: native windowが最大化状態を返す
  // When: 初期同期を完了する
  // Then: 最大化ボタンのアイコンとtitleを状態に合わせる
  it("Scenario: 最大化状態を操作ボタンへ同期する", async () => {
    const { host, win, controls } = mountControls();
    vi.mocked(win.isMaximized).mockResolvedValue(true);

    await controls.syncMaxIcon();

    const button = host.querySelector<HTMLButtonElement>("#win-max")!;
    expect(button.title).toBe("元に戻す");
    expect(button.textContent).toBe(String.fromCharCode(0xe923));
  });

  // Given: native windowが最小化・最大化の状態を返す
  // When: 現在のwindow状態を同期する
  // Then: 最小化を優先し、それ以外は最大化または復元として通知する
  it("Scenario: native window状態を最小化・最大化・復元へ分類する", async () => {
    const onStateChange = vi.fn();
    const { win, controls } = mountControls(undefined, onStateChange);

    vi.mocked(win.isMinimized).mockResolvedValueOnce(true);
    vi.mocked(win.isMaximized).mockResolvedValueOnce(true);
    await controls.syncWindowState();

    vi.mocked(win.isMinimized).mockResolvedValueOnce(false);
    vi.mocked(win.isMaximized).mockResolvedValueOnce(true);
    await controls.syncWindowState();

    vi.mocked(win.isMinimized).mockResolvedValueOnce(false);
    vi.mocked(win.isMaximized).mockResolvedValueOnce(false);
    await controls.syncWindowState();

    expect(onStateChange).toHaveBeenNthCalledWith(1, "minimized");
    expect(onStateChange).toHaveBeenNthCalledWith(2, "maximized");
    expect(onStateChange).toHaveBeenNthCalledWith(3, "restored");
  });

  // Given: native windowのフォーカス監視を登録したwindow controls
  // When: フォーカスが戻ったことを通知する
  // Then: 最小化・復元後の状態を再同期する
  it("Scenario: フォーカス復帰でnative window状態を再同期する", async () => {
    const onStateChange = vi.fn();
    const { controls, win, focusChangedHandler } = mountControls(undefined, onStateChange);

    await vi.waitFor(() => expect(focusChangedHandler()).toBeDefined());
    vi.mocked(win.isMinimized).mockResolvedValue(false);
    vi.mocked(win.isMaximized).mockResolvedValue(true);
    focusChangedHandler()!();

    await vi.waitFor(() => expect(onStateChange).toHaveBeenCalledWith("maximized"));
    controls.dispose();
  });

  // Given: native windowの移動・表示倍率監視を登録したwindow controls
  // When: 移動またはDPI変更を受け取る
  // Then: レイアウト同期へ変更を通知する
  it("Scenario: 移動・DPI変更をgeometry同期へ渡す", async () => {
    const onGeometryChange = vi.fn();
    const { controls, movedHandler, scaleChangedHandler } = mountControls(undefined, undefined, onGeometryChange);
    expect(movedHandler()).toBeDefined();
    expect(scaleChangedHandler()).toBeDefined();
    movedHandler()!();
    scaleChangedHandler()!();
    expect(onGeometryChange).toHaveBeenCalledTimes(2);
    controls.dispose();
  });

  // Given: geometry同期処理が同期例外を返すwindow controls
  // When: nativeの移動通知を受け取る
  // Then: 例外をwindow operationのエラー境界へ渡す
  it("Scenario: geometry同期の同期例外をエラー境界へ渡す", async () => {
    const error = new Error("layout failed");
    const onGeometryChange = () => { throw error; };
    const { controls, onError, movedHandler } = mountControls(undefined, undefined, onGeometryChange);

    await vi.waitFor(() => expect(movedHandler()).toBeDefined());
    movedHandler()!();

    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledWith("ウィンドウ形状を同期できませんでした", error);
    });
    controls.dispose();
  });

  // Given: native close確認を拒否するwindow controls
  // When: close requestを受け取る
  // Then: native closeをpreventDefaultする
  it("Scenario: 終了確認がfalseならnative closeを取り消す", async () => {
    const { onError, getCloseHandler } = mountControls(async () => false);
    const preventDefault = vi.fn();

    await vi.waitFor(() => expect(getCloseHandler()).toBeDefined());
    await getCloseHandler()!({ preventDefault });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  // Given: 1回目の終了確認が未完了
  // When: native close requestを続けて2回受ける
  // Then: 確認処理は1回だけ実行し、両方のcloseを同じ結果で止める
  it("Scenario: 同時の終了確認を1つにまとめる", async () => {
    let resolveClose!: (allowed: boolean) => void;
    const onCloseRequest = vi.fn(() => new Promise<boolean>((resolve) => { resolveClose = resolve; }));
    const { getCloseHandler } = mountControls(onCloseRequest);
    const firstPreventDefault = vi.fn();
    const secondPreventDefault = vi.fn();

    await vi.waitFor(() => expect(getCloseHandler()).toBeDefined());
    const first = getCloseHandler()!({ preventDefault: firstPreventDefault });
    const second = getCloseHandler()!({ preventDefault: secondPreventDefault });
    expect(onCloseRequest).toHaveBeenCalledOnce();

    resolveClose(false);
    await Promise.all([first, second]);

    expect(firstPreventDefault).toHaveBeenCalledOnce();
    expect(secondPreventDefault).toHaveBeenCalledOnce();
  });

  // Given: 終了確認が例外を返すwindow controls
  // When: close requestを受け取る
  // Then: closeを取り消し、エラー表示へ渡す
  it("Scenario: 終了確認の例外をclose継続とエラー通知へ分岐する", async () => {
    const error = new Error("close check failed");
    const { onError, getCloseHandler } = mountControls(async () => { throw error; });
    const preventDefault = vi.fn();

    await vi.waitFor(() => expect(getCloseHandler()).toBeDefined());
    await getCloseHandler()!({ preventDefault });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith("終了処理に失敗しました", error);
  });

  // Given: native listenerを登録したwindow controls
  // When: controlsを破棄する
  // Then: 登録済みlistenerを解除する
  it("Scenario: dispose unregisters native listeners", async () => {
    const {
      controls,
      unlistenResized,
      unlistenMoved,
      unlistenScaleChanged,
      unlistenFocusChanged,
      unlistenCloseRequested,
    } = mountControls(async () => true);

    controls.dispose();
    await vi.waitFor(() => {
      expect(unlistenResized).toHaveBeenCalledOnce();
      expect(unlistenMoved).toHaveBeenCalledOnce();
      expect(unlistenScaleChanged).toHaveBeenCalledOnce();
      expect(unlistenFocusChanged).toHaveBeenCalledOnce();
      expect(unlistenCloseRequested).toHaveBeenCalledOnce();
    });
  });

  // Given: DOMイベントとnative listenerを登録したwindow controls
  // When: controlsを破棄してからボタンとタイトルを操作する
  // Then: 破棄後の遅延クリックはnative window操作へ到達しない
  it("Scenario: dispose unregisters DOM controls", async () => {
    const { controls, host, win } = mountControls();

    controls.dispose();
    host.querySelector<HTMLButtonElement>("#win-min")!.click();
    host.querySelector<HTMLButtonElement>("#win-max")!.click();
    host.querySelector<HTMLButtonElement>("#win-close")!.click();
    host.querySelector<HTMLElement>("#titletext")!.dispatchEvent(new Event("dblclick"));
    await Promise.resolve();

    expect(win.minimize).not.toHaveBeenCalled();
    expect(win.toggleMaximize).not.toHaveBeenCalled();
    expect(win.close).not.toHaveBeenCalled();
  });
});

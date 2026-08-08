// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { Window } from "@tauri-apps/api/window";
import { WindowControls } from "./window-controls";

type CloseEvent = { preventDefault: () => void };

function mountControls(onCloseRequest?: () => Promise<boolean>) {
  const host = document.createElement("div");
  host.innerHTML = `
    <button id="win-min"></button>
    <button id="win-max"></button>
    <button id="win-close"></button>
    <span id="titletext"></span>
  `;
  let resizedHandler: (() => void) | undefined;
  let closeHandler: ((event: CloseEvent) => void | Promise<void>) | undefined;
  const win = {
    minimize: vi.fn(),
    close: vi.fn(),
    toggleMaximize: vi.fn(),
    isMaximized: vi.fn(async () => false),
    onResized: vi.fn(async (handler: () => void) => {
      resizedHandler = handler;
      return () => {};
    }),
    onCloseRequested: vi.fn(async (handler: (event: CloseEvent) => void | Promise<void>) => {
      closeHandler = handler;
      return () => {};
    }),
  } as unknown as Window;
  const onError = vi.fn();
  const controls = new WindowControls(host, win, host.querySelector<HTMLElement>("#titletext")!, {
    onError,
    onCloseRequest,
  });
  return { host, win, onError, controls, resizedHandler, getCloseHandler: () => closeHandler };
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
});

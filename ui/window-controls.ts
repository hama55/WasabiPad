import type { Window } from "@tauri-apps/api/window";
import { reportWindowOperationError, runWindowOperation, type WindowErrorHandler } from "./window-operation";
import { createAsyncUnlisten, type AsyncUnlisten } from "./async-unlisten";

export interface WindowControlsPorts {
  onError: WindowErrorHandler;
  // 閉じてよければ true。false ならクローズを取り消す。
  onCloseRequest?: () => Promise<boolean>;
  onGeometryChange?: () => void;
  onStateChange?: (state: WindowState) => void;
}

export type WindowState = "minimized" | "maximized" | "restored";

export class WindowControls {
  private unlistenResized: AsyncUnlisten = createAsyncUnlisten();
  private unlistenMoved: AsyncUnlisten = createAsyncUnlisten();
  private unlistenScaleChanged: AsyncUnlisten = createAsyncUnlisten();
  private unlistenFocusChanged: AsyncUnlisten = createAsyncUnlisten();
  private unlistenCloseRequested: AsyncUnlisten = createAsyncUnlisten();
  private closeRequest: Promise<boolean> | null = null;
  private stateSyncGeneration = 0;
  private disposed = false;
  private domCleanup: (() => void) | null = null;

  constructor(
    private host: HTMLElement,
    private win: Window,
    private titleElement: HTMLElement,
    private ports: WindowControlsPorts,
  ) {
    const minButton = this.pick("win-min");
    const maxButton = this.pick("win-max");
    const closeButton = this.pick("win-close");
    const onMinimize = () => this.run("ウィンドウを最小化できませんでした", () => this.win.minimize());
    const onMaximize = () => this.run("ウィンドウを最大化できませんでした", () => this.toggleMaximize());
    const onClose = () => this.run("ウィンドウを閉じられませんでした", () => this.win.close());
    const onTitleDoubleClick = () => this.run("ウィンドウを最大化できませんでした", () => this.toggleMaximize());
    minButton.addEventListener("click", onMinimize);
    maxButton.addEventListener("click", onMaximize);
    closeButton.addEventListener("click", onClose);
    this.titleElement.addEventListener("dblclick", onTitleDoubleClick);
    this.domCleanup = () => {
      minButton.removeEventListener("click", onMinimize);
      maxButton.removeEventListener("click", onMaximize);
      closeButton.removeEventListener("click", onClose);
      this.titleElement.removeEventListener("dblclick", onTitleDoubleClick);
    };
    void this.win.onResized(() => {
      this.notifyGeometryChange();
      void this.syncWindowState().catch((error) => reportWindowOperationError(this.ports.onError, "ウィンドウ状態を取得できませんでした", error));
    }).then((unlisten) => {
      this.unlistenResized.set(unlisten);
    }).catch((error) => reportWindowOperationError(this.ports.onError, "ウィンドウサイズ監視を開始できませんでした", error));
    void this.win.onMoved(() => {
      this.notifyGeometryChange();
    }).then((unlisten) => {
      this.unlistenMoved.set(unlisten);
    }).catch((error) => reportWindowOperationError(this.ports.onError, "ウィンドウ位置監視を開始できませんでした", error));
    void this.win.onScaleChanged(() => {
      this.notifyGeometryChange();
    }).then((unlisten) => {
      this.unlistenScaleChanged.set(unlisten);
    }).catch((error) => reportWindowOperationError(this.ports.onError, "表示倍率監視を開始できませんでした", error));
    void this.win.onFocusChanged(() => {
      this.notifyGeometryChange();
      void this.syncWindowState().catch((error) => reportWindowOperationError(this.ports.onError, "ウィンドウ状態を取得できませんでした", error));
    }).then((unlisten) => {
      this.unlistenFocusChanged.set(unlisten);
    }).catch((error) => reportWindowOperationError(this.ports.onError, "ウィンドウ復元監視を開始できませんでした", error));
    if (this.ports.onCloseRequest) {
      void this.win.onCloseRequested(async (event) => {
        if (!(await this.requestClose())) event.preventDefault();
      }).then((unlisten) => {
        this.unlistenCloseRequested.set(unlisten);
      }).catch((error) => reportWindowOperationError(this.ports.onError, "終了確認を開始できませんでした", error));
    }
    void this.syncWindowState().catch((error) => reportWindowOperationError(this.ports.onError, "ウィンドウ状態を取得できませんでした", error));
  }

  private requestClose(): Promise<boolean> {
    if (this.closeRequest) return this.closeRequest;
    const request = this.evaluateCloseRequest();
    this.closeRequest = request;
    void request.finally(() => {
      if (this.closeRequest === request) this.closeRequest = null;
    });
    return request;
  }

  private async evaluateCloseRequest(): Promise<boolean> {
    try {
      return await this.ports.onCloseRequest!();
    } catch (error) {
      // 保存確認に失敗したなら、破棄して閉じるより開いたままにする。
      await reportWindowOperationError(this.ports.onError, "終了処理に失敗しました", error);
      return false;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.stateSyncGeneration++;
    this.domCleanup?.();
    this.domCleanup = null;
    this.unlistenResized.dispose();
    this.unlistenMoved.dispose();
    this.unlistenScaleChanged.dispose();
    this.unlistenFocusChanged.dispose();
    this.unlistenCloseRequested.dispose();
  }

  private pick<T extends HTMLElement>(id: string): T {
    return this.host.querySelector<T>(`#${id}`)!;
  }

  private async toggleMaximize() {
    if (this.disposed) return;
    await this.win.toggleMaximize();
    await this.syncWindowState();
    this.notifyGeometryChange();
  }

  // 最大化状態はウィンドウ側にしかないため、アイコンは都度問い合わせて合わせる。
  async syncMaxIcon() {
    if (this.disposed) return;
    const generation = ++this.stateSyncGeneration;
    const maximized = await this.win.isMaximized();
    if (generation !== this.stateSyncGeneration) return;
    this.applyMaxIcon(maximized);
  }

  async syncWindowState() {
    if (this.disposed) return;
    const generation = ++this.stateSyncGeneration;
    const [minimized, maximized] = await Promise.all([
      this.win.isMinimized(),
      this.win.isMaximized(),
    ]);
    if (generation !== this.stateSyncGeneration) return;
    const state: WindowState = minimized ? "minimized" : maximized ? "maximized" : "restored";
    this.ports.onStateChange?.(state);
    this.applyMaxIcon(maximized);
  }

  private applyMaxIcon(maximized: boolean) {
    const button = this.pick("win-max");
    button.textContent = String.fromCharCode(maximized ? 0xe923 : 0xe922); // Segoe MDL2: ChromeRestore / ChromeMaximize
    button.title = maximized ? "元に戻す" : "最大化";
  }

  private notifyGeometryChange() {
    if (this.disposed) return;
    runWindowOperation(this.ports.onError, "ウィンドウ形状を同期できませんでした", () => this.ports.onGeometryChange?.());
  }

  private run(title: string, operation: () => void | Promise<unknown>) {
    if (this.disposed) return;
    runWindowOperation(this.ports.onError, title, operation);
  }
}

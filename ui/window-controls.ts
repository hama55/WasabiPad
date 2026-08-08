import type { Window } from "@tauri-apps/api/window";
import { reportWindowOperationError, runWindowOperation, type WindowErrorHandler } from "./window-operation";
import { createAsyncUnlisten, type AsyncUnlisten } from "./async-unlisten";

export interface WindowControlsPorts {
  onError: WindowErrorHandler;
  // 閉じてよければ true。false ならクローズを取り消す。
  onCloseRequest?: () => Promise<boolean>;
}

export class WindowControls {
  private unlistenResized: AsyncUnlisten = createAsyncUnlisten();
  private unlistenCloseRequested: AsyncUnlisten = createAsyncUnlisten();

  constructor(
    private host: HTMLElement,
    private win: Window,
    private titleElement: HTMLElement,
    private ports: WindowControlsPorts,
  ) {
    this.pick("win-min").addEventListener("click", () => this.run("ウィンドウを最小化できませんでした", () => this.win.minimize()));
    this.pick("win-max").addEventListener("click", () => this.run("ウィンドウを最大化できませんでした", () => this.toggleMaximize()));
    this.pick("win-close").addEventListener("click", () => this.run("ウィンドウを閉じられませんでした", () => this.win.close()));
    this.titleElement.addEventListener("dblclick", () => this.run("ウィンドウを最大化できませんでした", () => this.toggleMaximize()));
    void this.win.onResized(() => {
      void this.syncMaxIcon().catch((error) => reportWindowOperationError(this.ports.onError, "最大化状態を取得できませんでした", error));
    }).then((unlisten) => {
      this.unlistenResized.set(unlisten);
    }).catch((error) => reportWindowOperationError(this.ports.onError, "ウィンドウサイズ監視を開始できませんでした", error));
    if (this.ports.onCloseRequest) {
      void this.win.onCloseRequested(async (event) => {
        try {
          if (!(await this.ports.onCloseRequest!())) event.preventDefault();
        } catch (error) {
          // 保存確認に失敗したなら、破棄して閉じるより開いたままにする。
          event.preventDefault();
          await reportWindowOperationError(this.ports.onError, "終了処理に失敗しました", error);
        }
      }).then((unlisten) => {
        this.unlistenCloseRequested.set(unlisten);
      }).catch((error) => reportWindowOperationError(this.ports.onError, "終了確認を開始できませんでした", error));
    }
    void this.syncMaxIcon().catch((error) => reportWindowOperationError(this.ports.onError, "最大化状態を取得できませんでした", error));
  }

  dispose() {
    this.unlistenResized.dispose();
    this.unlistenCloseRequested.dispose();
  }

  private pick<T extends HTMLElement>(id: string): T {
    return this.host.querySelector<T>(`#${id}`)!;
  }

  private async toggleMaximize() {
    await this.win.toggleMaximize();
    await this.syncMaxIcon();
  }

  // 最大化状態はウィンドウ側にしかないため、アイコンは都度問い合わせて合わせる
  async syncMaxIcon() {
    const maximized = await this.win.isMaximized();
    const button = this.pick("win-max");
    button.textContent = String.fromCharCode(maximized ? 0xe923 : 0xe922); // Segoe MDL2: ChromeRestore / ChromeMaximize
    button.title = maximized ? "元に戻す" : "最大化";
  }

  private run(title: string, operation: () => void | Promise<unknown>) {
    runWindowOperation(this.ports.onError, title, operation);
  }
}

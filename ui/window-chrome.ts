import type { Window } from "@tauri-apps/api/window";
import { runAsyncBoundary } from "./async-boundary";

export interface WindowChromePorts {
  // 閉じてよければ true。false ならクローズを取り消す。
  onCloseRequest: () => Promise<boolean>;
  onGeometryChange: () => void;
  onError: (title: string, error: unknown) => Promise<void>;
}

// タイトルバー (#titlebar) の最小化/最大化/閉じると、タイトル・通知の表示。
export class WindowChrome {
  private noticeTimer: number | undefined;

  constructor(
    private host: HTMLElement,
    private win: Window,
    private ports: WindowChromePorts,
    private notice: HTMLElement,
  ) {
    this.pick("win-min").addEventListener("click", () => this.run("ウィンドウを最小化できませんでした", () => this.win.minimize()));
    this.pick("win-max").addEventListener("click", () => this.run("ウィンドウを最大化できませんでした", () => this.toggleMaximize()));
    this.pick("win-close").addEventListener("click", () => this.run("ウィンドウを閉じられませんでした", () => this.win.close()));
    this.pick("titletext").addEventListener("dblclick", () => this.run("ウィンドウを最大化できませんでした", () => this.toggleMaximize()));
    void this.win.onResized(() => {
      void this.syncMaxIcon().catch((error) => this.reportError("最大化状態を取得できませんでした", error));
      this.run("ウィンドウ形状を同期できませんでした", ports.onGeometryChange);
    }).catch((error) => this.reportError("ウィンドウサイズ監視を開始できませんでした", error));
    void this.win.onMoved(() => this.run("ウィンドウ形状を同期できませんでした", ports.onGeometryChange))
      .catch((error) => this.reportError("ウィンドウ位置監視を開始できませんでした", error));
    void this.win.onScaleChanged(() => this.run("ウィンドウ形状を同期できませんでした", ports.onGeometryChange))
      .catch((error) => this.reportError("表示倍率監視を開始できませんでした", error));
    void this.win.onCloseRequested(async (e) => {
      try {
        if (!(await ports.onCloseRequest())) e.preventDefault();
      } catch (error) {
        // 保存確認に失敗したなら、破棄して閉じるより開いたままにする。
        e.preventDefault();
        await this.reportError("終了処理に失敗しました", error);
      }
    }).catch((error) => this.reportError("終了確認を開始できませんでした", error));
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

  setTitle(title: string) {
    this.run("タイトルを更新できませんでした", () => this.win.setTitle(title));
  }

  private run(title: string, operation: () => void | Promise<unknown>) {
    runAsyncBoundary(operation, (error) => this.reportError(title, error));
  }

  private async reportError(title: string, error: unknown) {
    try {
      await this.ports.onError(title, error);
    } catch (reportError) {
      console.error(`${title}のエラーを表示できませんでした`, reportError);
    }
  }

  notify(text: string) {
    this.notice.textContent = text;
    window.clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => { this.notice.textContent = ""; }, 2000);
  }
}

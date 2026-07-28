import type { Window } from "@tauri-apps/api/window";

export interface WindowChromePorts {
  // 閉じてよければ true。false ならクローズを取り消す。
  onCloseRequest: () => Promise<boolean>;
  onGeometryChange: () => void;
}

// タイトルバー (#titlebar) の最小化/最大化/閉じると、タイトル・通知の表示。
export class WindowChrome {
  private noticeTimer: number | undefined;

  constructor(private host: HTMLElement, private win: Window, ports: WindowChromePorts) {
    this.pick("win-min").addEventListener("click", () => void this.win.minimize());
    this.pick("win-max").addEventListener("click", () => void this.toggleMaximize());
    this.pick("win-close").addEventListener("click", () => void this.win.close());
    this.pick("titletext").addEventListener("dblclick", () => void this.toggleMaximize());
    void this.win.onResized(() => {
      void this.syncMaxIcon();
      ports.onGeometryChange();
    });
    void this.win.onMoved(() => ports.onGeometryChange());
    void this.win.onScaleChanged(() => ports.onGeometryChange());
    void this.win.onCloseRequested(async (e) => {
      if (!(await ports.onCloseRequest())) e.preventDefault();
    });
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
    this.pick("titletext").textContent = title;
    void this.win.setTitle(title);
  }

  notify(text: string) {
    const notice = this.pick("save-notice");
    notice.textContent = text;
    window.clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => { notice.textContent = ""; }, 2000);
  }
}

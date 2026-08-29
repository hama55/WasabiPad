import type { Window } from "@tauri-apps/api/window";
import { WindowControls, type WindowState } from "./window-controls";
import { runWindowOperation } from "./window-operation";

export interface WindowChromePorts {
  // 閉じてよければ true。false ならクローズを取り消す。
  onCloseRequest: () => Promise<boolean>;
  onGeometryChange: () => void;
  onStateChange?: (state: WindowState) => void;
  onError: (title: string, error: unknown) => Promise<void>;
}

// タイトルバー (#titlebar) の最小化/最大化/閉じると、タイトル・通知の表示。
export class WindowChrome {
  private noticeTimer: number | undefined;
  private controls: WindowControls;

  constructor(
    host: HTMLElement,
    private win: Window,
    private ports: WindowChromePorts,
    private notice: HTMLElement,
  ) {
    this.controls = new WindowControls(host, this.win, host.querySelector<HTMLElement>("#titletext")!, {
      onError: this.ports.onError,
      onCloseRequest: this.ports.onCloseRequest,
      onGeometryChange: this.ports.onGeometryChange,
      onStateChange: this.ports.onStateChange,
    });
  }

  dispose() {
    this.controls.dispose();
    window.clearTimeout(this.noticeTimer);
  }

  async syncWindowState() {
    return this.controls.syncWindowState();
  }

  setTitle(title: string) {
    runWindowOperation(this.ports.onError, "タイトルを更新できませんでした", () => this.win.setTitle(title));
  }

  notify(text: string) {
    this.notice.textContent = text;
    window.clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => { this.notice.textContent = ""; }, 2000);
  }
}

import type { Window } from "@tauri-apps/api/window";
import { WindowControls } from "./window-controls";
import { reportWindowOperationError, runWindowOperation } from "./window-operation";
import { createAsyncUnlisten, type AsyncUnlisten } from "./async-unlisten";

export interface WindowChromePorts {
  // 閉じてよければ true。false ならクローズを取り消す。
  onCloseRequest: () => Promise<boolean>;
  onGeometryChange: () => void;
  onError: (title: string, error: unknown) => Promise<void>;
}

// タイトルバー (#titlebar) の最小化/最大化/閉じると、タイトル・通知の表示。
export class WindowChrome {
  private noticeTimer: number | undefined;
  private controls: WindowControls;
  private unlistenResized: AsyncUnlisten = createAsyncUnlisten();
  private unlistenMoved: AsyncUnlisten = createAsyncUnlisten();
  private unlistenScaleChanged: AsyncUnlisten = createAsyncUnlisten();

  constructor(
    host: HTMLElement,
    private win: Window,
    private ports: WindowChromePorts,
    private notice: HTMLElement,
  ) {
    this.controls = new WindowControls(host, this.win, host.querySelector<HTMLElement>("#titletext")!, {
      onError: this.ports.onError,
      onCloseRequest: this.ports.onCloseRequest,
    });
    void this.win.onResized(() => {
      runWindowOperation(this.ports.onError, "ウィンドウ形状を同期できませんでした", ports.onGeometryChange);
    }).then((unlisten) => {
      this.unlistenResized.set(unlisten);
    }).catch((error) => reportWindowOperationError(this.ports.onError, "ウィンドウサイズ監視を開始できませんでした", error));
    void this.win.onMoved(() => runWindowOperation(this.ports.onError, "ウィンドウ形状を同期できませんでした", ports.onGeometryChange))
      .then((unlisten) => {
        this.unlistenMoved.set(unlisten);
      })
      .catch((error) => reportWindowOperationError(this.ports.onError, "ウィンドウ位置監視を開始できませんでした", error));
    void this.win.onScaleChanged(() => runWindowOperation(this.ports.onError, "ウィンドウ形状を同期できませんでした", ports.onGeometryChange))
      .then((unlisten) => {
        this.unlistenScaleChanged.set(unlisten);
      })
      .catch((error) => reportWindowOperationError(this.ports.onError, "表示倍率監視を開始できませんでした", error));
  }

  dispose() {
    this.controls.dispose();
    this.unlistenResized.dispose();
    this.unlistenMoved.dispose();
    this.unlistenScaleChanged.dispose();
    window.clearTimeout(this.noticeTimer);
  }

  async syncMaxIcon() {
    return this.controls.syncMaxIcon();
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

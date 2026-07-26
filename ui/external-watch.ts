import * as api from "./api";

const POLL_INTERVAL_MS = 3000;

export interface ExternalWatchPorts {
  // 監視してよい状態か (対象文書があり、他の読み書きが走っていない)
  canPoll: () => boolean;
  isDirty: () => boolean;
  // 再読込後の文書を反映する (キャレット位置の復元も呼び出し側の責務)
  onReload: (info: api.DocInfo) => void;
  onNotice: (text: string) => void;
  onError: (title: string, error: unknown) => Promise<void>;
  onIgnore: () => void;
}

// 対象文書かどうか (小ファイル=ハンドル非保持) の判定は backend が持つ。
// 未編集なら backend が自動再読込し、dirty なら競合バナーで再読込/無視を選ばせる。
export class ExternalWatch {
  private polling = false;

  constructor(private banner: HTMLElement, private ports: ExternalWatchPorts) {
    this.pick("external-reload").addEventListener("click", () => void this.reloadFromDisk());
    this.pick("external-ignore").addEventListener("click", () => void this.ignore());
    window.setInterval(() => void this.poll(), POLL_INTERVAL_MS);
  }

  private pick<T extends HTMLElement>(id: string): T {
    return this.banner.querySelector<T>(`#${id}`)!;
  }

  // 文書が切り替わったら競合バナーは無効
  hide() {
    this.banner.hidden = true;
  }

  private async poll() {
    if (this.polling || !this.banner.hidden || !this.ports.canPoll()) return;
    this.polling = true;
    try {
      const check = await api.pollExternal(this.ports.isDirty());
      if (check.kind === "reloaded") {
        this.ports.onReload(check.info);
        this.ports.onNotice("外部の変更を再読込しました");
      } else if (check.kind === "conflict") {
        this.banner.hidden = false;
      }
    } catch {
      // 一時的に確認できなくても、次の周期で再試行する。
    } finally {
      this.polling = false;
    }
  }

  private async reloadFromDisk() {
    this.hide();
    try {
      this.ports.onReload(await api.reloadFromDisk());
    } catch (e) {
      await this.ports.onError("再読込できませんでした", e);
    }
  }

  private async ignore() {
    this.hide();
    await api.ackExternal();
    this.ports.onIgnore();
  }
}

import type * as api from "./api";

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
  // 差分確認画面を閉じるまで待ち、trueなら競合が解決された扱いにする。
  onConflict?: (preview: api.ExternalMergePreview) => Promise<boolean>;
}

export type ExternalWatchApi = Pick<
  typeof api,
  "pollExternal" | "reloadFromDisk" | "ackExternal" | "externalMergePreview"
>;

// 対象文書かどうか (小ファイル=ハンドル非保持) の判定は backend が持つ。
// 未編集なら backend が自動再読込し、dirty なら競合バナーで再読込/無視を選ばせる。
export class ExternalWatch {
  private busy = false;
  private generation = 0;
  private pollErrorReported = false;
  private pollTimer: number;
  private reloadButton: HTMLButtonElement;
  private ignoreButton: HTMLButtonElement;

  constructor(
    private banner: HTMLElement,
    private ports: ExternalWatchPorts,
    private api: ExternalWatchApi,
  ) {
    this.reloadButton = this.pick("external-reload");
    this.ignoreButton = this.pick("external-ignore");
    this.reloadButton.addEventListener("click", this.onReloadClick);
    this.ignoreButton.addEventListener("click", this.onIgnoreClick);
    this.pollTimer = window.setInterval(() => void this.poll(), POLL_INTERVAL_MS);
  }

  private onReloadClick = () => {
    void this.reloadFromDisk().catch((error) => this.reportError("再読込できませんでした", error));
  };

  private onIgnoreClick = () => {
    void this.ignore().catch((error) => this.reportError("外部変更を無視できませんでした", error));
  };

  dispose() {
    this.generation++;
    window.clearInterval(this.pollTimer);
    this.reloadButton.removeEventListener("click", this.onReloadClick);
    this.ignoreButton.removeEventListener("click", this.onIgnoreClick);
  }

  private pick<T extends HTMLElement>(id: string): T {
    return this.banner.querySelector<T>(`#${id}`)!;
  }

  // 文書が切り替わったら競合バナーは無効
  hide() {
    this.generation++;
    this.banner.hidden = true;
  }

  private begin(): number | null {
    if (this.busy) return null;
    this.busy = true;
    return ++this.generation;
  }

  private async poll() {
    if (this.busy || !this.banner.hidden) return;
    let canPoll: boolean;
    try {
      canPoll = this.ports.canPoll();
    } catch (error) {
      await this.reportPollError(error);
      return;
    }
    if (!canPoll) return;
    const generation = this.begin();
    if (generation === null) return;
    try {
      const check = await this.api.pollExternal(this.ports.isDirty());
      if (generation !== this.generation) return;
      if (check.kind === "reloaded") {
        this.ports.onReload(check.info);
        this.ports.onNotice("外部の変更を再読込しました");
      } else if (check.kind === "conflict") {
        if (this.ports.onConflict) {
          const preview = await this.api.externalMergePreview();
          if (generation !== this.generation) return;
          this.banner.hidden = true;
          const resolved = await this.ports.onConflict(preview);
          if (generation !== this.generation) return;
          this.banner.hidden = resolved;
        } else {
          this.banner.hidden = false;
        }
      }
      this.pollErrorReported = false;
    } catch (error) {
      if (generation === this.generation) {
        this.banner.hidden = false;
        await this.reportPollError(error);
      }
    } finally {
      this.busy = false;
    }
  }

  private async reloadFromDisk() {
    const generation = this.begin();
    if (generation === null) return;
    this.banner.hidden = true;
    try {
      const info = await this.api.reloadFromDisk();
      if (generation !== this.generation) return;
      this.ports.onReload(info);
    } catch (e) {
      if (generation === this.generation) this.banner.hidden = false;
      await this.reportError("再読込できませんでした", e);
    } finally {
      this.busy = false;
    }
  }

  private async ignore() {
    const generation = this.begin();
    if (generation === null) return;
    this.banner.hidden = true;
    try {
      await this.api.ackExternal();
      if (generation !== this.generation) return;
      this.ports.onIgnore();
    } catch (error) {
      if (generation === this.generation) this.banner.hidden = false; // 無視できていない競合を隠したままにしない。
      await this.reportError("外部変更を無視できませんでした", error);
    } finally {
      this.busy = false;
    }
  }

  private async reportPollError(error: unknown) {
    if (this.pollErrorReported) return;
    this.pollErrorReported = true;
    await this.reportError("外部変更を確認できませんでした", error);
  }

  private async reportError(title: string, error: unknown) {
    try {
      await this.ports.onError(title, error);
    } catch (reportError) {
      console.error("外部変更エラーを表示できませんでした", reportError);
    }
  }
}

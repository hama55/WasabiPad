import type * as api from "./api";
import { documentPathOf, type DocumentSession } from "./session";
import { isAssetViewerFormat, viewerFormatForPath } from "./viewer-formats";

const POLL_INTERVAL_MS = 3000;

export type ExternalMergePreviewListener = (preview: api.ExternalMergePreview) => void;
export type ExternalMergePreviewSubscription = (
  listener: ExternalMergePreviewListener,
) => () => void;

export interface ExternalWatchPorts {
  // 監視してよい状態か (対象文書があり、他の読み書きが走っていない)
  canPoll: () => boolean;
  isDirty: () => boolean;
  // 再読込後の文書を反映する (キャレット位置の復元も呼び出し側の責務)
  onReload: (info: api.DocInfo) => void;
  onNotice: (text: string) => void;
  onError: (title: string, error: unknown) => Promise<void>;
  onIgnore: (info: api.DocInfo) => void;
  // 差分確認画面を閉じるまで待ち、trueなら競合が解決された扱いにする。
  onConflict?: (
    preview: api.ExternalMergePreview,
    subscribe: ExternalMergePreviewSubscription,
  ) => Promise<boolean | "retry">;
}

export type ExternalWatchApi = Pick<
  typeof api,
  "pollExternal" | "reloadFromDisk" | "ackExternal" | "externalMergePreview"
>;

export function canPollExternalDocument(
  session: Pick<DocumentSession, "archivePath" | "displayPath" | "savePath" | "selectedRelPath">,
): boolean {
  return session.savePath !== null || (
    session.archivePath === null
    && isAssetViewerFormat(viewerFormatForPath(documentPathOf(session)))
  );
}

// 対象文書かどうか (小ファイル=ハンドル非保持) の判定は backend が持つ。
// 未編集なら backend が自動再読込し、dirty なら競合バナーで再読込/無視を選ばせる。
export class ExternalWatch {
  private busy = false;
  private generation = 0;
  private pollErrorReported = false;
  private pollTimer: number;
  private reloadButton: HTMLButtonElement;
  private ignoreButton: HTMLButtonElement;
  private reviewButton: HTMLButtonElement;
  private conflictMonitorStop?: () => void;

  constructor(
    private banner: HTMLElement,
    private ports: ExternalWatchPorts,
    private api: ExternalWatchApi,
  ) {
    this.reloadButton = this.pick("external-reload");
    this.ignoreButton = this.pick("external-ignore");
    this.reviewButton = this.pick("external-review");
    this.reloadButton.addEventListener("click", this.onReloadClick);
    this.ignoreButton.addEventListener("click", this.onIgnoreClick);
    this.reviewButton.addEventListener("click", this.onReviewClick);
    this.pollTimer = window.setInterval(() => void this.poll(), POLL_INTERVAL_MS);
  }

  private onReloadClick = () => {
    void this.reloadFromDisk();
  };

  private onIgnoreClick = () => {
    void this.ignore();
  };

  private onReviewClick = () => {
    void this.review();
  };

  dispose() {
    this.generation++;
    this.conflictMonitorStop?.();
    window.clearInterval(this.pollTimer);
    this.reloadButton.removeEventListener("click", this.onReloadClick);
    this.ignoreButton.removeEventListener("click", this.onIgnoreClick);
    this.reviewButton.removeEventListener("click", this.onReviewClick);
  }

  private pick<T extends HTMLElement>(id: string): T {
    return this.banner.querySelector<T>(`#${id}`)!;
  }

  // 文書が切り替わったら競合バナーは無効
  hide() {
    this.generation++;
    this.conflictMonitorStop?.();
    this.banner.hidden = true;
  }

  refresh(): Promise<void> {
    return this.poll(true);
  }

  private begin(): number | null {
    if (this.busy) return null;
    this.busy = true;
    return ++this.generation;
  }

  private async poll(force = false) {
    if (this.busy || (!force && !this.banner.hidden)) return;
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
        if (!this.ports.onConflict) {
          this.banner.hidden = false;
        } else {
          const preview = await this.api.externalMergePreview();
          if (!(await this.resolveConflict(preview, generation))) return;
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

  private async review() {
    let canPoll: boolean;
    try {
      canPoll = this.ports.canPoll();
    } catch (error) {
      await this.reportError("差分を確認できませんでした", error);
      return;
    }
    if (!canPoll) return;
    const generation = this.begin();
    if (generation === null) return;
    this.banner.hidden = true;
    try {
      const preview = await this.api.externalMergePreview();
      if (!(await this.resolveConflict(preview, generation))) return;
      this.pollErrorReported = false;
    } catch (error) {
      if (generation === this.generation) {
        this.banner.hidden = false;
        await this.reportError("差分を確認できませんでした", error);
      }
    } finally {
      this.busy = false;
    }
  }

  private async resolveConflict(
    initialPreview: api.ExternalMergePreview,
    generation: number,
  ): Promise<boolean> {
    let preview = initialPreview;
    while (true) {
      if (generation !== this.generation) return false;
      this.banner.hidden = true;
      const resolved = await this.runConflict(preview, generation);
      if (generation !== this.generation) return false;
      if (resolved !== "retry") {
        this.banner.hidden = resolved;
        return true;
      }
      preview = await this.api.externalMergePreview();
    }
  }

  private async runConflict(
    preview: api.ExternalMergePreview,
    generation: number,
  ): Promise<boolean | "retry"> {
    if (!this.ports.onConflict) {
      this.banner.hidden = false;
      return false;
    }
    const listeners = new Set<ExternalMergePreviewListener>();
    const monitorState = { active: true, busy: false };
    const monitorTimer = window.setInterval(() => {
      void this.pollConflict(generation, listeners, monitorState);
    }, POLL_INTERVAL_MS);
    const stop = () => {
      if (!monitorState.active) return;
      monitorState.active = false;
      window.clearInterval(monitorTimer);
      listeners.clear();
      if (this.conflictMonitorStop === stop) this.conflictMonitorStop = undefined;
    };
    this.conflictMonitorStop = stop;
    const subscribe: ExternalMergePreviewSubscription = (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    try {
      return await this.ports.onConflict(preview, subscribe);
    } finally {
      stop();
    }
  }

  private async pollConflict(
    generation: number,
    listeners: Set<ExternalMergePreviewListener>,
    monitorState: { active: boolean; busy: boolean },
  ) {
    if (!monitorState.active || generation !== this.generation || monitorState.busy) return;
    monitorState.busy = true;
    try {
      const check = await this.api.pollExternal(this.ports.isDirty());
      if (!monitorState.active || generation !== this.generation || check.kind !== "conflict") return;
      const preview = await this.api.externalMergePreview();
      if (!monitorState.active || generation !== this.generation) return;
      for (const listener of listeners) listener(preview);
      this.pollErrorReported = false;
    } catch (error) {
      if (monitorState.active && generation === this.generation) {
        await this.reportPollError(error);
      }
    } finally {
      monitorState.busy = false;
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
      if (generation === this.generation) {
        this.banner.hidden = false;
        await this.reportError("再読込できませんでした", e);
      }
    } finally {
      this.busy = false;
    }
  }

  private async ignore() {
    const generation = this.begin();
    if (generation === null) return;
    this.banner.hidden = true;
    try {
      const info = await this.api.ackExternal();
      if (generation !== this.generation) return;
      this.ports.onIgnore(info);
    } catch (error) {
      if (generation === this.generation) {
        this.banner.hidden = false; // 無視できていない競合を隠したままにしない。
        await this.reportError("外部変更を無視できませんでした", error);
      }
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

import { setInlinePreviewFocus } from "./api";
import type { ViewerFormat, ViewerPayload, ViewerSelection } from "./api";
import { runAsyncBoundary } from "./async-boundary";
import { isViewerFormat } from "./viewer-formats";
import { isViewerSelection } from "./viewer-payload";
import { INLINE_PREVIEW_MESSAGES } from "./inline-preview-protocol";
import type { ExternalPreviewStatus } from "./inline-preview-protocol";
import { DEFAULT_CSV_DELIMITER } from "./viewer-delimiter";

const {
  READY_MESSAGE,
  PAYLOAD_MESSAGE,
  DISPLAY_COMMITTED_MESSAGE,
  DISPLAY_FAILED_MESSAGE,
  CLEAR_MESSAGE,
  CLEARED_MESSAGE,
  FORMAT_CHANGE_MESSAGE,
  DELIMITER_MESSAGE,
  FONT_MESSAGE,
  FONT_SIZE_MESSAGE,
  MARKDOWN_SOFT_BREAKS_MESSAGE,
  MARKDOWN_LINE_HEIGHT_MESSAGE,
  MARKDOWN_HEADING_UNDERLINES_MESSAGE,
  FONT_CHANGE_MESSAGE,
  FULLSCREEN_CHANGE_MESSAGE,
  FULLSCREEN_STATE_MESSAGE,
  MARKDOWN_FRAGMENT_MESSAGE,
} = INLINE_PREVIEW_MESSAGES;

interface PendingExternalOpen {
  renderId: string;
  label: string;
  payload: ViewerPayload;
  isCurrentRequest: () => boolean;
  resolve: (label: string | null) => void;
  rollbackRenderId?: string;
  resolveCancellation?: () => void;
  rejectCancellation?: (error: Error) => void;
  cancellation?: Promise<void>;
}

export interface InlinePreviewPorts {
  onAvailabilityChange?: (available: boolean, label: string) => void;
  onFormatChange?: (format: ViewerFormat) => void;
  onDelimiterChange?: (delimiter: string) => void;
  onFontFamilyChange?: (family: string) => void;
  onFullscreenChange?: () => void | Promise<void>;
  onClose?: (returnFocus: boolean) => void | Promise<void>;
  onRefresh?: () => void | Promise<void>;
  onSelectionChange?: (selection: ViewerSelection) => void | Promise<void>;
  onMarkdownLink?: (href: string, newTab: boolean) => void | Promise<void>;
  onExternalOutputReleased?: (path: string) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
}

export class InlinePreview {
  private readonly frame: HTMLIFrameElement;
  private payload: ViewerPayload | null = null;
  private label = "";
  private nextLabel = 0;
  private nextRenderId = 0;
  private ready = false;
  private externalStatus: ExternalPreviewStatus | null = null;
  private pendingCloseFocus = false;
  private pendingExternalOpen: PendingExternalOpen | null = null;
  private pendingClearAcks = new Map<string, () => void>();
  private clearing: Promise<void> | null = null;
  private sourcePath: string | null = null;
  private effectiveExtension: string | null = null;
  private archivePath: string | null = null;
  private archiveEntry: string | null = null;
  private externalOutputPath: string | null = null;
  private delimiter = DEFAULT_CSV_DELIMITER;
  private fontFamily: string | null = null;
  private fontSize: number | null = null;
  private markdownSoftBreaks = true;
  private markdownLineHeight: number | null = null;
  private markdownHeadingUnderlines: boolean | null = null;
  private fullscreen = false;
  private visible = true;
  private pendingMarkdownFragment: string | null = null;
  private previewFocused = false;

  constructor(
    private host: HTMLElement,
    private ports: InlinePreviewPorts = {},
  ) {
    this.frame = host.querySelector<HTMLIFrameElement>("iframe") ?? document.createElement("iframe");
    if (!this.frame.parentElement) host.appendChild(this.frame);
    this.frame.title = "プレビュー";
    this.frame.src = new URL("/viewer.html?inline=1", window.location.href).toString();
    this.frame.addEventListener("pointerdown", () => this.setPreviewFocused(true));
    this.frame.addEventListener("focus", () => this.setPreviewFocused(true));
    this.frame.addEventListener("blur", () => this.setPreviewFocused(false));
    window.addEventListener("message", (event) => {
      if (event.source !== this.frame.contentWindow || event.origin !== window.location.origin) return;
      if (event.data?.type === READY_MESSAGE) {
        this.ready = true;
        if (this.pendingExternalOpen) this.sendPendingExternalOpen();
        else this.send();
        this.sendExternalStatus();
        if (this.pendingCloseFocus) this.focusCloseButton();
        return;
      }
      if (event.data?.type === DISPLAY_COMMITTED_MESSAGE || event.data?.type === DISPLAY_FAILED_MESSAGE) {
        if (typeof event.data.render_id !== "string") return;
        this.handleExternalRenderResult(
          event.data.render_id,
          event.data.type === DISPLAY_COMMITTED_MESSAGE,
        );
        return;
      }
      if (event.data?.type === CLEARED_MESSAGE) {
        if (typeof event.data.render_id !== "string") return;
        if (this.pendingExternalOpen?.rollbackRenderId === event.data.render_id) {
          this.handleExternalRenderResult(event.data.render_id, true);
          return;
        }
        this.pendingClearAcks.get(event.data.render_id)?.();
        this.pendingClearAcks.delete(event.data.render_id);
        return;
      }
      if (event.data?.type === FORMAT_CHANGE_MESSAGE) {
        if (isViewerFormat(event.data.format)) {
          this.notifyPort(() => this.ports.onFormatChange?.(event.data.format));
        }
        return;
      }
      if (event.data?.type === INLINE_PREVIEW_MESSAGES.DELIMITER_CHANGE_MESSAGE) {
        if (typeof event.data.delimiter === "string" && event.data.delimiter) {
          this.notifyPort(() => this.ports.onDelimiterChange?.(event.data.delimiter));
        }
        return;
      }
      if (event.data?.type === FONT_CHANGE_MESSAGE) {
        if (typeof event.data.family === "string" && event.data.family.trim()) {
          this.notifyPort(() => this.ports.onFontFamilyChange?.(event.data.family));
        }
        return;
      }
      if (event.data?.type === FULLSCREEN_CHANGE_MESSAGE) {
        this.notifyPort(() => this.ports.onFullscreenChange?.());
        return;
      }
      if (event.data?.type === INLINE_PREVIEW_MESSAGES.CLOSE_MESSAGE) {
        if (typeof event.data.return_focus === "boolean") {
          this.notifyPort(() => this.ports.onClose?.(event.data.return_focus));
        }
        return;
      }
      if (event.data?.type === INLINE_PREVIEW_MESSAGES.REFRESH_MESSAGE) {
        this.notifyPort(() => this.ports.onRefresh?.());
        return;
      }
      if (event.data?.type === INLINE_PREVIEW_MESSAGES.SELECTION_CHANGE_MESSAGE) {
        if (!isViewerSelection(event.data.selection)) return;
        this.notifyPort(() => this.ports.onSelectionChange?.(event.data.selection));
        return;
      }
      if (event.data?.type === INLINE_PREVIEW_MESSAGES.MARKDOWN_LINK_MESSAGE) {
        if (typeof event.data.href !== "string" || typeof event.data.newTab !== "boolean") return;
        this.notifyPort(() => this.ports.onMarkdownLink?.(event.data.href, event.data.newTab));
        return;
      }
    });
  }

  setSourcePath(
    path: string | null,
    archivePath: string | null = null,
    archiveEntry: string | null = null,
    effectiveExtension: string | null = null,
  ) {
    this.sourcePath = path;
    this.archivePath = archivePath;
    this.archiveEntry = archiveEntry;
    this.effectiveExtension = effectiveExtension;
  }

  setExternalStatus(status: ExternalPreviewStatus | null) {
    this.externalStatus = status;
    if (status && !this.label) {
      this.label = `inline-preview-${++this.nextLabel}`;
      this.host.hidden = false;
      this.notifyPort(() => this.ports.onAvailabilityChange?.(true, this.label));
    }
    this.sendExternalStatus();
  }

  private sendExternalStatus() {
    if (!this.ready) return;
    this.frame.contentWindow?.postMessage({
      type: INLINE_PREVIEW_MESSAGES.EXTERNAL_STATUS_MESSAGE,
      status: this.externalStatus,
    }, window.location.origin);
  }

  focusCloseButton() {
    this.pendingCloseFocus = !this.ready;
    if (this.ready) this.frame.contentWindow?.postMessage({ type: INLINE_PREVIEW_MESSAGES.FOCUS_CLOSE_MESSAGE }, window.location.origin);
  }

  setExternalOutputPath(path: string | null) {
    this.externalOutputPath = path;
    if (path !== null || !this.payload || this.payload.external_output_path === null) return;
    this.payload = { ...this.payload, external_output_path: null };
    this.send();
  }

  setPendingExternalOutputPath(path: string | null) {
    this.externalOutputPath = path;
  }

  mayReferenceExternalOutputPath(path: string) {
    return this.payload?.external_output_path === path
      || this.pendingExternalOpen?.payload.external_output_path === path;
  }

  setDelimiter(delimiter: string) {
    this.delimiter = delimiter;
    this.send();
  }

  setFontFamily(family: string) {
    this.fontFamily = family;
    this.sendFontFamily();
  }

  setFontSize(size: number) {
    this.fontSize = size;
    this.sendFontSize();
  }

  setMarkdownSoftBreaks(enabled: boolean) {
    this.markdownSoftBreaks = enabled;
    this.sendMarkdownSoftBreaks();
  }

  setMarkdownLineHeight(value: number) {
    this.markdownLineHeight = value;
    this.sendMarkdownLineHeight();
  }

  setMarkdownHeadingUnderlines(enabled: boolean) {
    this.markdownHeadingUnderlines = enabled;
    this.sendMarkdownHeadingUnderlines();
  }

  setFullscreen(fullscreen: boolean) {
    if (this.fullscreen === fullscreen) return;
    this.fullscreen = fullscreen;
    this.sendFullscreenState();
  }

  setVisibility(visible: boolean, reset = false) {
    if (this.visible === visible && !reset) return;
    this.visible = visible;
    this.sendVisibility(reset);
  }

  private sendVisibility(reset = false) {
    if (!this.ready || this.payload?.format !== "video") return;
    this.frame.contentWindow?.postMessage({
      type: INLINE_PREVIEW_MESSAGES.VISIBILITY_MESSAGE,
      visible: this.visible,
      reset,
    }, window.location.origin);
  }

  setMarkdownFragment(fragment: string) {
    this.pendingMarkdownFragment = fragment;
    this.send();
  }

  async open(
    format: ViewerFormat,
    text: string,
    selection: ViewerSelection | null,
    externalOutputPath?: string | null,
    isCurrentRequest: () => boolean = () => true,
  ): Promise<string | null> {
    const label = `inline-preview-${++this.nextLabel}`;
    const payload = this.createPayload(format, text, selection, externalOutputPath);
    if (payload.external_output_path !== null || (this.payload?.external_output_path ?? null) !== null) {
      return new Promise((resolve) => {
        const pending: PendingExternalOpen = {
          renderId: `inline-preview-render-${++this.nextRenderId}`,
          label,
          payload,
          isCurrentRequest,
          resolve,
        };
        this.pendingExternalOpen = pending;
        if (this.ready) this.sendPendingExternalOpen();
      });
    }
    this.label = label;
    this.payload = payload;
    this.host.hidden = false;
    this.notifyPort(() => this.ports.onAvailabilityChange?.(true, label));
    this.send();
    return label;
  }

  async update(label: string, text: string, selection: ViewerSelection | null): Promise<boolean> {
    if (!this.payload || label !== this.label) return false;
    const currentPayload = this.payload;
    this.payload = {
      ...this.createPayload(currentPayload.format, text, selection),
      source_path: currentPayload.source_path,
      effective_extension: currentPayload.effective_extension,
      archive_path: currentPayload.archive_path,
      archive_entry: currentPayload.archive_entry,
      external_output_path: currentPayload.external_output_path,
    };
    this.send();
    return true;
  }

  async close(label: string, viewerAlreadyCleared = false): Promise<void> {
    if (label !== this.label) return;
    if (this.pendingExternalOpen) {
      await this.cancelPendingExternalOpen(false);
      viewerAlreadyCleared = true;
    } else if (!viewerAlreadyCleared && this.payload?.external_output_path) {
      await this.clearViewerAndWait();
    }
    if (label !== this.label) return;
    this.setPreviewFocused(false);
    this.setVisibility(false, true);
    this.payload = null;
    this.setExternalStatus(null);
    this.label = "";
    this.pendingMarkdownFragment = null;
    this.host.hidden = true;
    this.notifyPort(() => this.ports.onAvailabilityChange?.(false, label));
  }

  clear(): Promise<void> {
    if (this.clearing) return this.clearing;
    const label = this.label;
    if (!label && !this.pendingExternalOpen) return Promise.resolve();
    const clearing = (async () => {
      let viewerAlreadyCleared = false;
      if (this.pendingExternalOpen) {
        await this.cancelPendingExternalOpen(false);
        viewerAlreadyCleared = true;
      }
      if (label && label === this.label) await this.close(label, viewerAlreadyCleared);
    })().catch((error) => this.reportPortError(error)).finally(() => {
      if (this.clearing === clearing) this.clearing = null;
    });
    this.clearing = clearing;
    return clearing;
  }

  cancelPendingExternalOpen(restoreCurrent = true): Promise<void> {
    const pending = this.pendingExternalOpen;
    if (!pending) return Promise.resolve();
    if (pending.cancellation) return pending.cancellation;
    if (!this.ready) {
      this.pendingExternalOpen = null;
      pending.resolve(null);
      this.releasePendingExternalOutput(pending);
      return Promise.resolve();
    }

    pending.rollbackRenderId = `inline-preview-render-${++this.nextRenderId}`;
    pending.cancellation = new Promise<void>((resolve, reject) => {
      pending.resolveCancellation = resolve;
      pending.rejectCancellation = reject;
    });
    if (restoreCurrent && this.payload) {
      this.sendPayload(this.payload, pending.rollbackRenderId);
    } else {
      this.frame.contentWindow?.postMessage({
        type: CLEAR_MESSAGE,
        render_id: pending.rollbackRenderId,
      }, window.location.origin);
    }
    return pending.cancellation;
  }

  resend() {
    this.send();
  }

  private setPreviewFocused(focused: boolean) {
    if (this.previewFocused === focused) return;
    this.previewFocused = focused;
    this.notifyPort(() => setInlinePreviewFocus(focused));
  }

  private createPayload(
    format: ViewerFormat,
    text: string,
    selection: ViewerSelection | null,
    externalOutputPath = this.externalOutputPath,
  ): ViewerPayload {
    return {
      format,
      text,
      selection,
      source_path: this.sourcePath,
      effective_extension: this.effectiveExtension,
      archive_path: this.archivePath,
      archive_entry: this.archiveEntry,
      external_output_path: externalOutputPath,
    };
  }

  private send() {
    if (!this.ready) return;
    this.sendFullscreenState();
    this.sendMarkdownSoftBreaks();
    this.sendMarkdownLineHeight();
    this.sendMarkdownHeadingUnderlines();
    const pending = this.pendingExternalOpen;
    const payload = pending
      ? pending.rollbackRenderId ? this.payload : pending.payload
      : this.payload;
    if (!payload) return;
    // 区切り文字の変更は、現在のビューがCSVなら再描画を開始する。
    // 本文を先に送ると、その再描画が非同期の本文描画を中断するため、
    // 付随設定を先に同期してから本文を送る。
    this.frame.contentWindow?.postMessage({
      type: DELIMITER_MESSAGE,
      delimiter: this.delimiter,
    }, window.location.origin);
    this.frame.contentWindow?.postMessage({
      type: PAYLOAD_MESSAGE,
      payload,
      ...(pending ? { render_id: pending.rollbackRenderId ?? pending.renderId } : {}),
    }, window.location.origin);
    if (this.pendingMarkdownFragment !== null) {
      this.frame.contentWindow?.postMessage({
        type: MARKDOWN_FRAGMENT_MESSAGE,
        fragment: this.pendingMarkdownFragment,
      }, window.location.origin);
      this.pendingMarkdownFragment = null;
    }
    this.sendFontFamily();
    this.sendFontSize();
    this.sendVisibility();
  }

  private sendPendingExternalOpen() {
    const pending = this.pendingExternalOpen;
    if (!pending || pending.rollbackRenderId) return;
    this.sendPayload(pending.payload, pending.renderId);
  }

  private sendPayload(payload: ViewerPayload, renderId: string) {
    if (!this.ready) return;
    this.frame.contentWindow?.postMessage({
      type: DELIMITER_MESSAGE,
      delimiter: this.delimiter,
    }, window.location.origin);
    this.frame.contentWindow?.postMessage({
      type: PAYLOAD_MESSAGE,
      payload,
      render_id: renderId,
    }, window.location.origin);
    this.sendFontFamily();
    this.sendFontSize();
  }

  private handleExternalRenderResult(renderId: string, displayCommitted: boolean) {
    const pending = this.pendingExternalOpen;
    if (!pending) return;
    if (pending.rollbackRenderId === renderId) {
      if (!displayCommitted) {
        pending.cancellation = undefined;
        pending.resolveCancellation = undefined;
        const rejectCancellation = pending.rejectCancellation;
        pending.rejectCancellation = undefined;
        pending.resolve(null);
        rejectCancellation?.(new Error("External preview rollback was not confirmed"));
        return;
      }
      this.pendingExternalOpen = null;
      pending.resolve(null);
      pending.resolveCancellation?.();
      this.releasePendingExternalOutput(pending);
      return;
    }
    if (pending.renderId !== renderId || pending.rollbackRenderId) return;
    if (!displayCommitted) {
      this.pendingExternalOpen = null;
      pending.resolve(null);
      return;
    }
    if (!pending.isCurrentRequest()) {
      void this.cancelPendingExternalOpen();
      return;
    }
    this.payload = pending.payload;
    this.label = pending.label;
    this.externalOutputPath = pending.payload.external_output_path;
    this.host.hidden = false;
    this.pendingExternalOpen = null;
    this.notifyPort(() => this.ports.onAvailabilityChange?.(true, pending.label));
    pending.resolve(pending.label);
  }

  private releasePendingExternalOutput(pending: PendingExternalOpen) {
    const path = pending.payload.external_output_path;
    if (path && path !== this.payload?.external_output_path) {
      this.notifyPort(() => this.ports.onExternalOutputReleased?.(path));
    }
  }

  private clearViewerAndWait(): Promise<void> {
    if (!this.ready) return Promise.resolve();
    const renderId = `inline-preview-render-${++this.nextRenderId}`;
    return new Promise((resolve) => {
      this.pendingClearAcks.set(renderId, resolve);
      this.frame.contentWindow?.postMessage({
        type: CLEAR_MESSAGE,
        render_id: renderId,
      }, window.location.origin);
    });
  }

  private sendFullscreenState() {
    if (!this.ready) return;
    this.frame.contentWindow?.postMessage({
      type: FULLSCREEN_STATE_MESSAGE,
      fullscreen: this.fullscreen,
    }, window.location.origin);
  }

  private sendFontFamily() {
    if (!this.ready || !this.fontFamily) return;
    this.frame.contentWindow?.postMessage({
      type: FONT_MESSAGE,
      family: this.fontFamily,
    }, window.location.origin);
  }

  private sendFontSize() {
    if (!this.ready || this.fontSize === null) return;
    this.frame.contentWindow?.postMessage({
      type: FONT_SIZE_MESSAGE,
      size: this.fontSize,
    }, window.location.origin);
  }

  private sendMarkdownSoftBreaks() {
    if (!this.ready) return;
    this.frame.contentWindow?.postMessage({
      type: MARKDOWN_SOFT_BREAKS_MESSAGE,
      enabled: this.markdownSoftBreaks,
    }, window.location.origin);
  }

  private sendMarkdownLineHeight() {
    if (!this.ready || this.markdownLineHeight === null) return;
    this.frame.contentWindow?.postMessage({
      type: MARKDOWN_LINE_HEIGHT_MESSAGE,
      lineHeight: this.markdownLineHeight,
    }, window.location.origin);
  }

  private sendMarkdownHeadingUnderlines() {
    if (!this.ready || this.markdownHeadingUnderlines === null) return;
    this.frame.contentWindow?.postMessage({
      type: MARKDOWN_HEADING_UNDERLINES_MESSAGE,
      enabled: this.markdownHeadingUnderlines,
    }, window.location.origin);
  }

  private notifyPort(operation: () => void | Promise<unknown>) {
    runAsyncBoundary(operation, (error) => this.reportPortError(error));
  }

  private reportPortError(error: unknown) {
    if (!this.ports.onError) {
      console.error("プレビュー通知の処理に失敗しました", error);
      return;
    }
    try {
      void Promise.resolve(this.ports.onError(error)).catch((reportError) => {
        console.error("プレビュー通知のエラー表示に失敗しました", reportError);
      });
    } catch (reportError) {
      console.error("プレビュー通知のエラー表示に失敗しました", reportError);
    }
  }
}

export { INLINE_PREVIEW_MESSAGES } from "./inline-preview-protocol";

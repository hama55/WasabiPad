import type { ViewerFormat, ViewerPayload, ViewerSelection } from "./api";
import { runAsyncBoundary } from "./async-boundary";
import { isViewerFormat } from "./viewer-formats";

const READY_MESSAGE = "wasabipad-viewer-ready";
const PAYLOAD_MESSAGE = "wasabipad-viewer-payload";
const FORMAT_CHANGE_MESSAGE = "wasabipad-viewer-format-change";
const DELIMITER_MESSAGE = "wasabipad-viewer-delimiter";
const FONT_MESSAGE = "wasabipad-viewer-font";
const FONT_CHANGE_MESSAGE = "wasabipad-viewer-font-change";
const FULLSCREEN_CHANGE_MESSAGE = "wasabipad-viewer-fullscreen-change";
const FULLSCREEN_STATE_MESSAGE = "wasabipad-viewer-fullscreen-state";

export interface InlinePreviewPorts {
  onAvailabilityChange?: (available: boolean) => void;
  onFormatChange?: (format: ViewerFormat) => void;
  onFontFamilyChange?: (family: string) => void;
  onFullscreenChange?: () => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
}

export class InlinePreview {
  private readonly frame: HTMLIFrameElement;
  private payload: ViewerPayload | null = null;
  private label = "";
  private nextLabel = 0;
  private ready = false;
  private sourcePath: string | null = null;
  private archivePath: string | null = null;
  private archiveEntry: string | null = null;
  private delimiter = ",";
  private fontFamily: string | null = null;
  private fullscreen = false;

  constructor(
    private host: HTMLElement,
    private ports: InlinePreviewPorts = {},
  ) {
    this.frame = host.querySelector<HTMLIFrameElement>("iframe") ?? document.createElement("iframe");
    if (!this.frame.parentElement) host.appendChild(this.frame);
    this.frame.title = "プレビュー";
    this.frame.src = new URL("/viewer.html?inline=1", window.location.href).toString();
    window.addEventListener("message", (event) => {
      if (event.source !== this.frame.contentWindow || event.origin !== window.location.origin) return;
      if (event.data?.type === READY_MESSAGE) {
        this.ready = true;
        this.send();
        return;
      }
      if (event.data?.type === FORMAT_CHANGE_MESSAGE) {
        if (isViewerFormat(event.data.format)) {
          this.notifyPort(() => this.ports.onFormatChange?.(event.data.format));
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
      }
    });
  }

  setSourcePath(path: string | null, archivePath: string | null = null, archiveEntry: string | null = null) {
    this.sourcePath = path;
    this.archivePath = archivePath;
    this.archiveEntry = archiveEntry;
  }

  setDelimiter(delimiter: string) {
    this.delimiter = delimiter;
    this.send();
  }

  setFontFamily(family: string) {
    this.fontFamily = family;
    this.sendFontFamily();
  }

  setFullscreen(fullscreen: boolean) {
    this.fullscreen = fullscreen;
    this.send();
  }

  async open(format: ViewerFormat, text: string, selection: ViewerSelection | null): Promise<string> {
    this.label = `inline-preview-${++this.nextLabel}`;
    this.payload = this.createPayload(format, text, selection);
    this.host.hidden = false;
    this.notifyPort(() => this.ports.onAvailabilityChange?.(true));
    this.send();
    return this.label;
  }

  async update(label: string, text: string, selection: ViewerSelection | null): Promise<boolean> {
    if (!this.payload || label !== this.label) return false;
    this.payload = this.createPayload(this.payload.format, text, selection);
    this.send();
    return true;
  }

  async close(label: string): Promise<void> {
    if (label !== this.label) return;
    this.payload = null;
    this.label = "";
    this.host.hidden = true;
    this.notifyPort(() => this.ports.onAvailabilityChange?.(false));
  }

  clear() {
    if (!this.label) return;
    void this.close(this.label).catch((error) => this.reportPortError(error));
  }

  resend() {
    this.send();
  }

  private createPayload(
    format: ViewerFormat,
    text: string,
    selection: ViewerSelection | null,
  ): ViewerPayload {
    return {
      format,
      text,
      selection,
      source_path: this.sourcePath,
      archive_path: this.archivePath,
      archive_entry: this.archiveEntry,
    };
  }

  private send() {
    if (!this.ready) return;
    this.frame.contentWindow?.postMessage({
      type: FULLSCREEN_STATE_MESSAGE,
      fullscreen: this.fullscreen,
    }, window.location.origin);
    if (!this.payload) return;
    this.frame.contentWindow?.postMessage({ type: PAYLOAD_MESSAGE, payload: this.payload }, window.location.origin);
    this.frame.contentWindow?.postMessage({
      type: DELIMITER_MESSAGE,
      delimiter: this.delimiter,
    }, window.location.origin);
    this.sendFontFamily();
  }

  private sendFontFamily() {
    if (!this.ready || !this.fontFamily) return;
    this.frame.contentWindow?.postMessage({
      type: FONT_MESSAGE,
      family: this.fontFamily,
    }, window.location.origin);
  }

  private notifyPort(operation: () => void | Promise<unknown>) {
    runAsyncBoundary(operation, (error) => this.reportPortError(error));
  }

  private reportPortError(error: unknown) {
    if (this.ports.onError) {
      return this.ports.onError(error);
    }
    console.error("プレビュー通知の処理に失敗しました", error);
  }
}

export const INLINE_PREVIEW_MESSAGES = {
  READY_MESSAGE,
  PAYLOAD_MESSAGE,
  FORMAT_CHANGE_MESSAGE,
  DELIMITER_MESSAGE,
  FONT_MESSAGE,
  FONT_CHANGE_MESSAGE,
  FULLSCREEN_CHANGE_MESSAGE,
  FULLSCREEN_STATE_MESSAGE,
} as const;

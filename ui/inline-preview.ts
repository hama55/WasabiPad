import type { ViewerFormat, ViewerPayload, ViewerSelection } from "./api";

const READY_MESSAGE = "wasabipad-viewer-ready";
const PAYLOAD_MESSAGE = "wasabipad-viewer-payload";
const FORMAT_CHANGE_MESSAGE = "wasabipad-viewer-format-change";
const DELIMITER_MESSAGE = "wasabipad-viewer-delimiter";
const FONT_MESSAGE = "wasabipad-viewer-font";

export interface InlinePreviewPorts {
  onAvailabilityChange?: (available: boolean) => void;
  onFormatChange?: (format: ViewerFormat) => void;
}

export class InlinePreview {
  private readonly frame: HTMLIFrameElement;
  private payload: ViewerPayload | null = null;
  private label = "";
  private nextLabel = 0;
  private ready = false;
  private sourcePath: string | null = null;
  private delimiter = ",";

  constructor(
    private host: HTMLElement,
    private ports: InlinePreviewPorts = {},
  ) {
    this.frame = host.querySelector<HTMLIFrameElement>("iframe") ?? document.createElement("iframe");
    if (!this.frame.parentElement) host.appendChild(this.frame);
    this.frame.title = "プレビュー";
    this.frame.src = new URL("/viewer.html?inline=1", window.location.href).toString();
    window.addEventListener("message", (event) => {
      if (event.source !== this.frame.contentWindow) return;
      if (event.data?.type === READY_MESSAGE) {
        this.ready = true;
        this.send();
        return;
      }
      if (event.data?.type !== FORMAT_CHANGE_MESSAGE) return;
      const format = event.data.format;
      if (format === "markdown" || format === "csv") this.ports.onFormatChange?.(format);
    });
  }

  setSourcePath(path: string | null) {
    this.sourcePath = path;
  }

  setDelimiter(delimiter: string) {
    this.delimiter = delimiter;
    this.send();
  }

  setFontFamily(family: string) {
    if (!this.ready) return;
    this.frame.contentWindow?.postMessage({
      type: FONT_MESSAGE,
      family,
    }, "*");
  }

  async open(format: ViewerFormat, text: string, selection: ViewerSelection | null): Promise<string> {
    this.label = `inline-preview-${++this.nextLabel}`;
    this.payload = this.createPayload(format, text, selection);
    this.host.hidden = false;
    this.ports.onAvailabilityChange?.(true);
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
    this.ports.onAvailabilityChange?.(false);
  }

  clear() {
    if (!this.label) return;
    void this.close(this.label);
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
      archive_path: null,
      archive_entry: null,
    };
  }

  private send() {
    if (!this.ready || !this.payload) return;
    this.frame.contentWindow?.postMessage({ type: PAYLOAD_MESSAGE, payload: this.payload }, "*");
    this.frame.contentWindow?.postMessage({
      type: DELIMITER_MESSAGE,
      delimiter: this.delimiter,
    }, "*");
  }
}

export const INLINE_PREVIEW_MESSAGES = {
  READY_MESSAGE,
  PAYLOAD_MESSAGE,
  FORMAT_CHANGE_MESSAGE,
  DELIMITER_MESSAGE,
  FONT_MESSAGE,
} as const;

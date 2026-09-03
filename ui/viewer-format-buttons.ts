import type { ViewerFormat } from "./api";
import { canRenderViewerFormat, VIEWER_FORMATS, viewerFormatSpec } from "./viewer-formats";

export type ViewerFormatCallback = (format: ViewerFormat) => void;

export interface ViewerFormatHandlers {
  /** 候補を移動した時点での一時プレビューを通知する。 */
  readonly onPreview?: ViewerFormatCallback;
  /** changeで確定した表示形式を通知する。 */
  readonly onSelect?: ViewerFormatCallback;
  /** onSelectの別名。changeの責務を明示したい呼び出し側向け。 */
  readonly onChange?: ViewerFormatCallback;
}

export function createViewerFormatButtons(
  host: HTMLElement,
  handlers: ViewerFormatHandlers,
): void;
/** @deprecated 既存呼び出しとの互換性のため、単一関数はchange通知として扱う。 */
export function createViewerFormatButtons(
  host: HTMLElement,
  onSelect: ViewerFormatCallback,
): void;
/** @deprecated 既存呼び出しとの互換性のため、2関数形式も受け付ける。 */
export function createViewerFormatButtons(
  host: HTMLElement,
  onPreview: ViewerFormatCallback,
  onSelect: ViewerFormatCallback,
): void;
export function createViewerFormatButtons(
  host: HTMLElement,
  handlersOrOnSelect: ViewerFormatHandlers | ViewerFormatCallback,
  legacyOnSelect?: ViewerFormatCallback,
): void {
  const handlers: ViewerFormatHandlers = typeof handlersOrOnSelect === "function"
    ? {
      onPreview: legacyOnSelect ? handlersOrOnSelect : undefined,
      onSelect: legacyOnSelect ?? handlersOrOnSelect,
    }
    : handlersOrOnSelect;
  const select = host instanceof HTMLSelectElement ? host : document.createElement("select");
  const specs = Object.values(VIEWER_FORMATS).sort((left, right) => left.previewOrder - right.previewOrder);
  select.replaceChildren(...specs.map((spec) => {
    const format = spec.id;
    const option = document.createElement("option");
    option.value = format;
    option.dataset.viewerFormat = format;
    option.textContent = spec.title.toLowerCase();
    option.setAttribute("aria-selected", "false");
    option.setAttribute("aria-disabled", "false");
    return option;
  }));
  if (select !== host) host.replaceChildren(select);
  const notifyValue = (value: string, callback: ViewerFormatCallback | undefined) => {
    const format = Object.prototype.hasOwnProperty.call(VIEWER_FORMATS, value)
      ? value as ViewerFormat
      : null;
    if (format !== null) callback?.(format);
  };
  const notifySelected = (callback: ViewerFormatCallback | undefined) => notifyValue(select.value, callback);
  select.addEventListener("input", () => notifySelected(handlers.onPreview));
  select.addEventListener("pointerover", (event) => {
    const option = (event.target as Element | null)?.closest<HTMLOptionElement>("option");
    if (!option || option.parentElement !== select || option.disabled) return;
    notifyValue(option.value, handlers.onPreview);
  });
  select.addEventListener("change", () => {
    notifySelected(handlers.onSelect ?? handlers.onChange);
  });
}

export function syncViewerFormatButtons(host: HTMLElement, current: ViewerFormat, sourcePath: string | null = null) {
  const select = host instanceof HTMLSelectElement
    ? host
    : host.querySelector<HTMLSelectElement>("select");
  if (!select) return;
  select.querySelectorAll<HTMLOptionElement>("[data-viewer-format]").forEach((option) => {
    const selected = option.dataset.viewerFormat === current;
    const available = canRenderViewerFormat(option.dataset.viewerFormat as ViewerFormat, sourcePath);
    option.disabled = !available;
    option.setAttribute("aria-disabled", String(!available));
    option.setAttribute("aria-selected", String(selected));
  });
  select.value = current;
}

export function syncViewerActionButtons(host: HTMLElement, current: ViewerFormat) {
  const spec = viewerFormatSpec(current);
  const available = {
    delimiter: spec.supportsDelimiter,
    chart: spec.supportsChart,
  };
  host.querySelectorAll<HTMLButtonElement>("[data-viewer-action]").forEach((button) => {
    button.hidden = !available[button.dataset.viewerAction as keyof typeof available];
  });
  host.hidden = !Object.values(available).some(Boolean);
}

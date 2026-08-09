import type { ViewerFormat } from "./api";
import { VIEWER_FORMATS } from "./viewer-formats";

export const VIEWER_FORMAT_BUTTON_ORDER = ["markdown", "csv", "image"] as const satisfies readonly ViewerFormat[];

export function createViewerFormatButtons(
  host: HTMLElement,
  onSelect: (format: ViewerFormat) => void,
) {
  host.replaceChildren(...VIEWER_FORMAT_BUTTON_ORDER.map((format) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.viewerFormat = format;
    button.textContent = VIEWER_FORMATS[format].title;
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => onSelect(format));
    return button;
  }));
}

export function syncViewerFormatButtons(host: HTMLElement, current: ViewerFormat) {
  host.querySelectorAll<HTMLButtonElement>("[data-viewer-format]").forEach((button) => {
    const selected = button.dataset.viewerFormat === current;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

import type { ViewerFormat } from "./api";
import { VIEWER_FORMATS } from "./viewer-formats";

export function createViewerFormatButtons(
  host: HTMLElement,
  onSelect: (format: ViewerFormat) => void,
) {
  const specs = [...Object.values(VIEWER_FORMATS)].sort((left, right) => left.previewOrder - right.previewOrder);
  host.replaceChildren(...specs.map((spec) => {
    const format = spec.id;
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.viewerFormat = format;
    button.textContent = spec.title;
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

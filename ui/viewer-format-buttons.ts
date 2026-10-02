import type { ViewerFormat } from "./api";
import { canRenderViewerFormat, isSqliteCandidatePath, VIEWER_FORMATS, viewerFormatSpec } from "./viewer-formats";

export type ViewerFormatCallback = (format: ViewerFormat) => void;

export function createViewerFormatButtons(host: HTMLElement, onSelect: ViewerFormatCallback, signal?: AbortSignal): void {
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "viewer-format-trigger";
  trigger.setAttribute("aria-label", "プレビュー形式を選択");
  trigger.setAttribute("aria-expanded", "false");
  const panel = document.createElement("div");
  panel.id = `${host.id || "viewer-format"}-panel`;
  panel.className = "viewer-format-panel";
  panel.setAttribute("popover", "auto");
  panel.setAttribute("role", "group");
  panel.setAttribute("aria-label", "プレビュー形式");
  trigger.setAttribute("popovertarget", panel.id);
  trigger.setAttribute("aria-controls", panel.id);
  const specs = Object.values(VIEWER_FORMATS).sort((left, right) => left.previewOrder - right.previewOrder);
  for (const spec of specs) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.viewerFormat = spec.id;
    button.textContent = spec.title;
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => {
      panel.hidePopover();
      trigger.focus();
      onSelect(spec.id);
    }, { signal });
    panel.appendChild(button);
  }
  panel.addEventListener("toggle", (event) => {
    const open = (event as ToggleEvent).newState === "open";
    trigger.setAttribute("aria-expanded", String(open));
    if (open) {
      (panel.querySelector<HTMLButtonElement>("[aria-pressed='true']:not(:disabled)")
        ?? panel.querySelector<HTMLButtonElement>("button:not(:disabled)"))?.focus();
    } else {
      trigger.focus();
    }
  }, { signal });
  host.replaceChildren(trigger, panel);
  syncViewerFormatButtons(host, "markdown");
}

export function syncViewerFormatButtons(host: HTMLElement, current: ViewerFormat, sourcePath: string | null = null) {
  host.querySelector<HTMLButtonElement>(".viewer-format-trigger")?.replaceChildren(document.createTextNode(`${viewerFormatSpec(current).title} ▾`));
  host.querySelectorAll<HTMLButtonElement>("[data-viewer-format]").forEach((button) => {
    const format = button.dataset.viewerFormat as ViewerFormat;
    const available = sourcePath && isSqliteCandidatePath(sourcePath)
      ? (current === "sqlite" ? format === "sqlite" : format === current || format === "sqlite")
      : canRenderViewerFormat(format, sourcePath);
    button.disabled = !available;
    button.setAttribute("aria-disabled", String(!available));
    button.setAttribute("aria-pressed", String(format === current));
  });
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

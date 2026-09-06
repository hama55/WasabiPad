import { isFindShortcut } from "./commands";

export function createPdfPreview(name: string): { wrapper: HTMLElement; frame: HTMLIFrameElement } {
  const wrapper = document.createElement("div");
  wrapper.className = "viewer-pdf-wrap";
  const frame = document.createElement("iframe");
  frame.className = "viewer-pdf";
  frame.title = name;
  const suppressFindShortcut = (event: KeyboardEvent) => {
    if (isFindShortcut(event)) event.preventDefault();
  };
  frame.addEventListener("keydown", suppressFindShortcut);
  frame.addEventListener("load", () => {
    frame.contentDocument?.addEventListener("keydown", suppressFindShortcut, { capture: true });
  });
  wrapper.appendChild(frame);
  return { wrapper, frame };
}

export function markPdfLoadFailure(frame: HTMLIFrameElement, name: string) {
  frame.removeAttribute("src");
  frame.title = `${name} (load failed)`;
}

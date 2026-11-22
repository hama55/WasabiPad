import { isFindShortcut } from "./commands";

function staticHtmlCsp(baseUrl: string | null): string {
  return [
    "default-src 'none'",
    `base-uri ${baseUrl ? "asset: http://asset.localhost" : "'none'"}`,
    "connect-src 'none'",
    "font-src asset: http://asset.localhost data:",
    "form-action 'none'",
    "frame-src 'none'",
    "img-src asset: http://asset.localhost data: blob:",
    "media-src asset: http://asset.localhost blob:",
    "object-src 'none'",
    "script-src 'none'",
    "style-src asset: http://asset.localhost 'unsafe-inline'",
  ].join("; ");
}

export interface HtmlPreviewOptions {
  name: string;
  html: string;
  baseUrl: string | null;
  dynamicUrl?: string;
  onContextMenu: (x: number, y: number) => void;
}

export function staticHtmlDocument(html: string, baseUrl: string | null): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const meta of [...doc.querySelectorAll("meta[http-equiv]")]) {
    if ((meta.getAttribute("http-equiv") ?? "").trim().toLowerCase() === "refresh") {
      meta.remove();
    }
  }
  for (const base of [...doc.querySelectorAll("base")]) {
    base.remove();
  }
  const head = doc.head ?? doc.documentElement.insertBefore(doc.createElement("head"), doc.documentElement.firstChild);
  const cspMeta = doc.createElement("meta");
  cspMeta.setAttribute("http-equiv", "Content-Security-Policy");
  cspMeta.setAttribute("content", staticHtmlCsp(baseUrl));
  if (baseUrl) {
    const base = doc.createElement("base");
    base.setAttribute("href", baseUrl);
    head.prepend(cspMeta, base);
  } else {
    head.prepend(cspMeta);
  }
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

function bindStaticDocument(frame: HTMLIFrameElement, onContextMenu: HtmlPreviewOptions["onContextMenu"]) {
  const child = frame.contentDocument;
  if (!child || child.documentElement.dataset.wasabiStaticHtml === "true") return;
  child.documentElement.dataset.wasabiStaticHtml = "true";
  child.addEventListener("keydown", (event) => {
    if (isFindShortcut(event)) event.preventDefault();
  });
  child.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const rect = frame.getBoundingClientRect();
    onContextMenu(rect.left + event.clientX, rect.top + event.clientY);
  });
  child.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    const anchor = target?.closest?.("a, area");
    const href = anchor?.getAttribute("href");
    if (href === null || href === undefined || href.startsWith("#")) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);
  child.addEventListener("submit", (event) => {
    event.preventDefault();
    event.stopPropagation();
  }, true);
}

export function createHtmlPreview(options: HtmlPreviewOptions): { wrapper: HTMLElement; frame: HTMLIFrameElement } {
  const wrapper = document.createElement("div");
  wrapper.className = "viewer-html-wrap";
  const frame = document.createElement("iframe");
  frame.className = "viewer-html";
  frame.title = options.name;
  frame.setAttribute("sandbox", options.dynamicUrl ? "allow-scripts" : "allow-same-origin");
  frame.referrerPolicy = "no-referrer";
  if (options.dynamicUrl) {
    frame.src = options.dynamicUrl;
  } else {
    frame.srcdoc = staticHtmlDocument(options.html, options.baseUrl);
    frame.addEventListener("load", () => bindStaticDocument(frame, options.onContextMenu));
  }
  frame.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    options.onContextMenu(event.clientX, event.clientY);
  });
  wrapper.appendChild(frame);
  return { wrapper, frame };
}

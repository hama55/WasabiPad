const STATIC_HTML_CSP = [
  "default-src 'none'",
  "base-uri asset: http://asset.localhost",
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

export interface HtmlPreviewOptions {
  name: string;
  html: string;
  baseUrl: string | null;
  onContextMenu: (x: number, y: number) => void;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function staticHead(baseUrl: string | null): string {
  const base = baseUrl ? `<base href="${escapeAttribute(baseUrl)}">` : "";
  return `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(STATIC_HTML_CSP)}">${base}`;
}

export function staticHtmlDocument(html: string, baseUrl: string | null): string {
  const safeHtml = html.replace(
    /<meta\b(?=[^>]*\bhttp-equiv\s*=\s*(?:"refresh"|'refresh'|refresh))[^>]*>/gi,
    "",
  );
  const head = staticHead(baseUrl);
  const existingHead = /<head\b[^>]*>/i;
  if (existingHead.test(safeHtml)) {
    return safeHtml.replace(existingHead, (tag) => `${tag}${head}`);
  }
  const existingHtml = /<html\b[^>]*>/i;
  if (existingHtml.test(safeHtml)) {
    return safeHtml.replace(existingHtml, (tag) => `${tag}<head>${head}</head>`);
  }
  return `<!doctype html><html><head>${head}</head><body>${safeHtml}</body></html>`;
}

function isLocalUrl(url: URL): boolean {
  return url.protocol === "asset:"
    || (url.protocol === "http:" && url.hostname === "asset.localhost")
    || url.protocol === "blob:"
    || url.protocol === "data:";
}

function bindStaticDocument(frame: HTMLIFrameElement, onContextMenu: HtmlPreviewOptions["onContextMenu"]) {
  const child = frame.contentDocument;
  if (!child || child.documentElement.dataset.wasabiStaticHtml === "true") return;
  child.documentElement.dataset.wasabiStaticHtml = "true";
  child.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const rect = frame.getBoundingClientRect();
    onContextMenu(rect.left + event.clientX, rect.top + event.clientY);
  });
  child.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    const anchor = target?.closest?.("a, area");
    const href = anchor?.getAttribute("href");
    if (!href || href.startsWith("#")) return;
    try {
      if (isLocalUrl(new URL(href, child.baseURI))) return;
    } catch {
      // Invalid or unsupported URLs stay inside the static preview.
    }
    event.preventDefault();
    event.stopPropagation();
  });
}

export function createHtmlPreview(options: HtmlPreviewOptions): { wrapper: HTMLElement; frame: HTMLIFrameElement } {
  const wrapper = document.createElement("div");
  wrapper.className = "viewer-html-wrap";
  const frame = document.createElement("iframe");
  frame.className = "viewer-html";
  frame.title = options.name;
  frame.setAttribute("sandbox", "allow-same-origin");
  frame.referrerPolicy = "no-referrer";
  frame.srcdoc = staticHtmlDocument(options.html, options.baseUrl);
  frame.addEventListener("load", () => bindStaticDocument(frame, options.onContextMenu));
  frame.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    options.onContextMenu(event.clientX, event.clientY);
  });
  wrapper.appendChild(frame);
  return { wrapper, frame };
}

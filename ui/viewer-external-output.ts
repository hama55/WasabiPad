export type ExternalOutputFormat = "html" | "svg";

export interface ExternalOutputSource {
  format: ExternalOutputFormat;
  mimeType: "text/html" | "image/svg+xml";
  url: string;
}

function encodePath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment).replaceAll("%3A", ":"))
    .join("/");
}

function fileUrlFromAbsolutePath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  if (normalized.startsWith("//")) {
    const [host, ...segments] = normalized.slice(2).split("/");
    if (!host || !segments[0]) throw new Error("外部プレビュー生成物の絶対パスではありません");
    return `file://${host}/${encodePath(segments.join("/"))}`;
  }
  if (/^[A-Za-z]:\//.test(normalized)) return `file://${encodePath(`/${normalized}`)}`;
  if (normalized.startsWith("/")) return `file://${encodePath(normalized)}`;
  throw new Error("外部プレビュー生成物の絶対パスではありません");
}

function outputFormatOf(path: string): ExternalOutputFormat {
  const extension = path.match(/\.([^.\\/]+)$/)?.[1].toLowerCase();
  if (extension === "html" || extension === "htm") return "html";
  if (extension === "svg") return "svg";
  throw new Error("外部プレビュー生成物はHTMLまたはSVGではありません");
}

export function resolveExternalOutputSource(absolutePath: string): ExternalOutputSource {
  if (typeof absolutePath !== "string" || !absolutePath) {
    throw new Error("外部プレビュー生成物の絶対パスが空です");
  }
  const url = fileUrlFromAbsolutePath(absolutePath);
  const format = outputFormatOf(absolutePath);
  return {
    format,
    mimeType: format === "html" ? "text/html" : "image/svg+xml",
    url,
  };
}

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).at(-1) || path;
}

export function createTrustedExternalHtmlPreview(
  absolutePath: string,
): { wrapper: HTMLDivElement; frame: HTMLIFrameElement } {
  const source = resolveExternalOutputSource(absolutePath);
  if (source.format !== "html") throw new Error("外部プレビュー生成物はHTML出力ではありません");

  const wrapper = document.createElement("div");
  wrapper.className = "viewer-html-wrap";
  const frame = document.createElement("iframe");
  frame.className = "viewer-html";
  frame.title = fileNameOf(absolutePath);
  frame.setAttribute(
    "sandbox",
    "allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads",
  );
  frame.allow = "autoplay; midi";
  frame.src = source.url;
  wrapper.appendChild(frame);
  return { wrapper, frame };
}

/**
 * Commits the iframe wrapper after its load event, not after semantic HTML validation.
 * The runner checks that the entry output is a regular file inside its job before returning it;
 * browsers may still fire iframe load when navigation fails.
 */
export async function commitTrustedExternalHtmlPreview(
  content: HTMLElement,
  wrapper: HTMLElement,
  frame: HTMLIFrameElement,
  isCurrent: () => boolean,
  signal: AbortSignal = new AbortController().signal,
): Promise<boolean> {
  if (signal.aborted) return false;
  wrapper.classList.add("viewer-pending");
  const ready = await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (loaded: boolean) => {
      if (settled) return;
      settled = true;
      frame.removeEventListener("load", onLoad);
      frame.removeEventListener("error", onError);
      signal.removeEventListener("abort", onAbort);
      resolve(loaded);
    };
    const onLoad = () => finish(true);
    const onError = () => finish(false);
    const onAbort = () => finish(false);
    frame.addEventListener("load", onLoad, { once: true });
    frame.addEventListener("error", onError, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    else content.appendChild(wrapper);
  });
  if (!ready || !isCurrent()) {
    wrapper.remove();
    return false;
  }
  wrapper.classList.remove("viewer-pending");
  content.replaceChildren(wrapper);
  return true;
}

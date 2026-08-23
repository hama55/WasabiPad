// Markdown 内の画像は元ファイルからの相対パスで書かれるため、
// 表示前に元ファイルの位置を起点とした絶対パスへ直す必要がある。
// 解決できないもの (http:, data:, 元ファイル不明) は null を返し、呼び出し側は src を触らない。

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const ABSOLUTE = /^(?:[a-z]:[\\/]|[\\/])/i;

export function isExternalMarkdownLink(href: string): boolean {
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function isLocalMarkdownLinkCandidate(href: string): boolean {
  const path = href.split(/[?#]/, 1)[0];
  return !!path && (!SCHEME.test(path) || ABSOLUTE.test(path));
}

export function markdownFragmentOf(href: string): string | null {
  const hash = href.indexOf("#");
  if (hash < 0) return null;
  const fragment = href.slice(hash + 1);
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

export function resolveAssetPath(sourcePath: string | null, src: string): string | null {
  if (!src) return null;
  const decoded = decodeSrc(src).replace(/\//g, "\\");
  // ドライブレター (D:\) はスキーム判定より先に見る
  if (ABSOLUTE.test(decoded)) return decoded;
  if (SCHEME.test(src) || src.startsWith("//")) return null;
  if (!sourcePath) return null;
  const dir = sourcePath.replace(/\//g, "\\").replace(/\\[^\\]*$/, "");
  return normalize(`${dir}\\${decoded}`);
}

export function resolveMarkdownLinkPath(sourcePath: string | null, href: string): string | null {
  const path = href.split(/[?#]/, 1)[0];
  if (!path) return null;
  if (path.startsWith("//") || (SCHEME.test(path) && !ABSOLUTE.test(path))) return null;
  return resolveAssetPath(sourcePath, path);
}

export function isSameDocumentMarkdownLink(sourcePath: string | null, href: string): boolean {
  if (markdownFragmentOf(href) === null || isExternalMarkdownLink(href)) return false;
  const path = href.split(/[?#]/, 1)[0];
  if (!path) return true;
  if (!sourcePath) return false;
  const resolved = resolveMarkdownLinkPath(sourcePath, href);
  return !!resolved && comparableWindowsPath(resolved) === comparableWindowsPath(sourcePath);
}

export function resolveArchiveAssetEntry(sourceEntry: string | null, src: string): string | null {
  if (!sourceEntry || !src) return null;
  const decoded = decodeSrc(src).replace(/\\/g, "/");
  if (SCHEME.test(src) || src.startsWith("//") || decoded.startsWith("/")) return null;
  const base = sourceEntry.replace(/\\/g, "/").split("/");
  base.pop();
  for (const segment of decoded.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!base.length) return null;
      base.pop();
      continue;
    }
    base.push(segment);
  }
  return base.length ? base.join("/") : null;
}

// markdown-it は出力時に src をパーセントエンコードするため、実パスへ戻す
function decodeSrc(src: string): string {
  try {
    return decodeURIComponent(src);
  } catch {
    return src;
  }
}

function normalize(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split("\\")) {
    if (segment === "." || (segment === "" && segments.length)) continue;
    if (segment === ".." && segments.length > 1) segments.pop();
    else segments.push(segment);
  }
  return segments.join("\\");
}

function comparableWindowsPath(path: string): string {
  return path.replace(/\//g, "\\").replace(/\\+$/, "").toLocaleLowerCase("en-US");
}

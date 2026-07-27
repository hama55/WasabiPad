// Markdown 内の画像は元ファイルからの相対パスで書かれるため、
// 表示前に元ファイルの位置を起点とした絶対パスへ直す必要がある。
// 解決できないもの (http:, data:, 元ファイル不明) は null を返し、呼び出し側は src を触らない。

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const ABSOLUTE = /^(?:[a-z]:[\\/]|[\\/])/i;

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

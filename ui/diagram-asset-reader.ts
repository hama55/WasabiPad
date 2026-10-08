import { basename } from "./path";
import { resolveAssetPath, resolveArchiveAssetEntry } from "./viewer-assets";

export function diagramAssetPrefix(path: string): string {
  const name = basename(path), dot = name.lastIndexOf(".");
  return `image_markdown/${dot > 0 ? name.slice(0, dot) : name}`;
}
export interface DiagramAssetContext {
  sourcePath: string;
  archivePath: string | null;
  archiveEntry: string | null;
}
export function createDiagramAssetReader(context: DiagramAssetContext, ports: {
  readLocal: (path: string, sourcePath: string) => Promise<ArrayBuffer>;
  readArchive: (archive: string, entry: string) => Promise<ArrayBuffer>;
}): (src: string, base?: string) => Promise<ArrayBuffer> {
  return async (src, base) => {
    if (context.archivePath && context.archiveEntry) {
      const source = base ? resolveArchiveAssetEntry(context.archiveEntry, base) : context.archiveEntry;
      const entry = source ? resolveArchiveAssetEntry(source, src) : null;
      if (!entry) throw new Error("ローカル画像以外は図の背景に使えません");
      try { return await ports.readArchive(context.archivePath, entry); }
      catch (error) {
        if (!base && !/\bdiagram-[\d-]+\.svg$/i.test(src) || base && !/\bdiagram-[\d-]+\.svg$/i.test(base)) throw error;
        const fallback = resolveArchiveAssetEntry(context.archiveEntry, `${diagramAssetPrefix(context.archiveEntry)}/${basename(src)}`);
        if (!fallback || fallback === entry) throw error;
        return ports.readArchive(context.archivePath, fallback);
      }
    }
    const source = base ? resolveAssetPath(context.sourcePath, base) : context.sourcePath;
    const path = source ? resolveAssetPath(source, src) : null;
    if (!path) throw new Error("ローカル画像以外は図の背景に使えません");
    return ports.readLocal(path, context.sourcePath);
  };
}

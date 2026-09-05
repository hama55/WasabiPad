import { convertFileSrc } from "@tauri-apps/api/core";
import { readArchiveAsset, readFileAsset } from "./api";
import { getSetting } from "./settings";

export interface ImageAssetSourcePorts {
  convertFileSrc: (path: string) => string;
  readArchiveAsset: (
    archivePath: string,
    entry: string,
    cacheDirectory?: string | null,
  ) => Promise<ArrayBuffer>;
  readFileAsset: (path: string, cacheDirectory?: string | null) => Promise<ArrayBuffer>;
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
}

const defaultPorts: ImageAssetSourcePorts = {
  convertFileSrc,
  readArchiveAsset: (archivePath, entry) =>
    readArchiveAsset(archivePath, entry, getSetting("previewCacheDirectory")),
  readFileAsset: (path) => readFileAsset(path, getSetting("previewCacheDirectory")),
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
};

export interface ArchiveAssetSession {
  imageUrlFromArchive: (archivePath: string, entry: string, mimeType: string) => Promise<string>;
  clearCachedAssets: () => void;
  dispose: () => void;
}

const MAX_ARCHIVE_SESSION_BYTES = 64 * 1024 * 1024;

interface ArchiveBytesEntry {
  promise: Promise<ArrayBuffer>;
  size: number | null;
}

export function createArchiveAssetSession(
  ports: ImageAssetSourcePorts = defaultPorts,
): ArchiveAssetSession {
  const bytesByArchive = new Map<string, Map<string, ArchiveBytesEntry>>();
  const sizeByArchive = new Map<string, number>();
  let disposed = false;

  const readArchiveBytes = (archivePath: string, entry: string): Promise<ArrayBuffer> => {
    let entries = bytesByArchive.get(archivePath);
    if (!entries) {
      entries = new Map();
      bytesByArchive.set(archivePath, entries);
    }
    const cached = entries.get(entry);
    if (cached) {
      entries.delete(entry);
      entries.set(entry, cached);
      return cached.promise;
    }

    const record = {} as ArchiveBytesEntry;
    const pending = Promise.resolve()
      .then(() => ports.readArchiveAsset(archivePath, entry))
      .then((bytes) => {
        if (bytesByArchive.get(archivePath) !== entries || entries.get(entry) !== record) {
          return bytes;
        }
        record.size = bytes.byteLength;
        sizeByArchive.set(archivePath, (sizeByArchive.get(archivePath) ?? 0) + record.size);
        while ((sizeByArchive.get(archivePath) ?? 0) > MAX_ARCHIVE_SESSION_BYTES) {
          const oldest = [...entries.entries()].find(([, candidate]) => candidate.size !== null);
          if (!oldest) break;
          const [oldestEntry, oldestRecord] = oldest;
          entries.delete(oldestEntry);
          sizeByArchive.set(
            archivePath,
            Math.max(0, (sizeByArchive.get(archivePath) ?? 0) - (oldestRecord.size ?? 0)),
          );
        }
        if (entries.size === 0) {
          bytesByArchive.delete(archivePath);
          sizeByArchive.delete(archivePath);
        }
        return bytes;
      })
      .catch((error) => {
        if (bytesByArchive.get(archivePath) === entries && entries.get(entry) === record) {
          entries.delete(entry);
          sizeByArchive.set(
            archivePath,
            Math.max(0, (sizeByArchive.get(archivePath) ?? 0) - (record.size ?? 0)),
          );
        }
        throw error;
      });
    record.promise = pending;
    record.size = null;
    entries.set(entry, record);
    return pending;
  };

  const clearCachedAssets = () => {
    bytesByArchive.clear();
    sizeByArchive.clear();
  };

  return {
    imageUrlFromArchive: async (archivePath, entry, mimeType) => {
      if (disposed) throw new Error("アーカイブ資産セッションは破棄されています");
      const bytes = await readArchiveBytes(archivePath, entry);
      if (disposed) throw new Error("アーカイブ資産セッションは破棄されています");
      return imageUrlFromBytes(bytes, mimeType, ports);
    },
    clearCachedAssets,
    dispose: () => {
      disposed = true;
      clearCachedAssets();
    },
  };
}

export function imageUrlFromPath(path: string, ports: ImageAssetSourcePorts = defaultPorts): string {
  return ports.convertFileSrc(path);
}

export function imageUrlFromPathWithCacheBust(
  path: string,
  cacheKey: string | number,
  ports: ImageAssetSourcePorts = defaultPorts,
): string {
  const url = imageUrlFromPath(path, ports);
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}wasabipad=${encodeURIComponent(String(cacheKey))}`;
}

export function imageUrlFromText(
  text: string,
  mimeType: string,
  ports: ImageAssetSourcePorts = defaultPorts,
): string {
  return imageUrlFromBytes(text, mimeType, ports);
}

function imageUrlFromBytes(
  bytes: BlobPart,
  mimeType: string,
  ports: ImageAssetSourcePorts,
): string {
  return ports.createObjectURL(new Blob([bytes], { type: mimeType }));
}

export async function imageUrlFromArchive(
  archivePath: string,
  entry: string,
  mimeType: string,
  ports: ImageAssetSourcePorts = defaultPorts,
): Promise<string> {
  const bytes = await ports.readArchiveAsset(archivePath, entry);
  return imageUrlFromBytes(bytes, mimeType, ports);
}

export async function imageUrlFromFile(
  path: string,
  mimeType: string,
  ports: ImageAssetSourcePorts = defaultPorts,
): Promise<string> {
  const bytes = await ports.readFileAsset(path);
  return imageUrlFromBytes(bytes, mimeType, ports);
}

export function revokeImageUrl(url: string, ports: ImageAssetSourcePorts = defaultPorts) {
  ports.revokeObjectURL(url);
}

import { convertFileSrc } from "@tauri-apps/api/core";
import { readArchiveAsset } from "./api";

export interface ImageAssetSourcePorts {
  convertFileSrc: (path: string) => string;
  readArchiveAsset: (archivePath: string, entry: string) => Promise<number[]>;
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
}

const defaultPorts: ImageAssetSourcePorts = {
  convertFileSrc,
  readArchiveAsset,
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
};

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
  return ports.createObjectURL(new Blob([text], { type: mimeType }));
}

export async function imageUrlFromArchive(
  archivePath: string,
  entry: string,
  mimeType: string,
  ports: ImageAssetSourcePorts = defaultPorts,
): Promise<string> {
  const bytes = await ports.readArchiveAsset(archivePath, entry);
  return ports.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mimeType }));
}

export function revokeImageUrl(url: string, ports: ImageAssetSourcePorts = defaultPorts) {
  ports.revokeObjectURL(url);
}

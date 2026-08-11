import { IMAGE_MIME_TYPES } from "./generated/Protocol";

export { IMAGE_MIME_TYPES } from "./generated/Protocol";

export type ImageExtension = keyof typeof IMAGE_MIME_TYPES;

export function imageExtensionOf(path: string): ImageExtension | null {
  const cleanPath = path.split(/[?#]/, 1)[0];
  const dot = cleanPath.lastIndexOf(".");
  const separator = Math.max(cleanPath.lastIndexOf("/"), cleanPath.lastIndexOf("\\"));
  if (dot <= separator) return null;
  const extension = cleanPath.slice(dot + 1).toLowerCase();
  return Object.prototype.hasOwnProperty.call(IMAGE_MIME_TYPES, extension)
    ? extension as ImageExtension
    : null;
}

export function isImagePath(path: string): boolean {
  return imageExtensionOf(path) !== null;
}

export function imageMimeType(path: string): string {
  const extension = imageExtensionOf(path);
  return extension ? IMAGE_MIME_TYPES[extension] : "application/octet-stream";
}

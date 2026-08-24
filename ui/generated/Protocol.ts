// This file was generated from shared/protocol.json by scripts/sync-protocol.mjs.
export const ARCHIVE_ENTRY_SEPARATOR = "::" as const;
export const PASSWORD_ERROR_MARKER = "7z-password" as const;
export const IMAGE_MIME_TYPES = {
  "apng": "image/apng",
  "avif": "image/avif",
  "bmp": "image/bmp",
  "gif": "image/gif",
  "ico": "image/x-icon",
  "jpeg": "image/jpeg",
  "jpg": "image/jpeg",
  "png": "image/png",
  "svg": "image/svg+xml",
  "webp": "image/webp"
} as const;
export const ENCODING_LABELS = {
  "utf8": "UTF-8",
  "utf8bom": "UTF-8 (BOM)",
  "sjis": "Shift-JIS",
  "utf16le": "UTF-16LE"
} as const;
export const EOL_LABELS = {
  "crlf": "CRLF",
  "lf": "LF"
} as const;

export const BYTE_SIZE_BASE = 1024 as const;
export const BYTE_SIZE_FRACTION_DIGITS = 1 as const;
export const BYTE_SIZE_UNITS = ["B","kB","MB","GB","TB"] as const;

export function formatByteSize(bytes: number): string {
  if (bytes < BYTE_SIZE_BASE) return `${bytes} ${BYTE_SIZE_UNITS[0]}`;
  let unitIndex = 1;
  let value = bytes / BYTE_SIZE_BASE;
  while (value >= BYTE_SIZE_BASE && unitIndex < 4) {
    value /= BYTE_SIZE_BASE;
    unitIndex += 1;
  }
  return `${value.toFixed(BYTE_SIZE_FRACTION_DIGITS)} ${BYTE_SIZE_UNITS[unitIndex]}`;
}

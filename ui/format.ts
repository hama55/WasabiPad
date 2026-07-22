import type { DocumentSession } from "./session";
import { displayName } from "./session";

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  for (const unit of units) {
    if (value < 1024 || unit === units[units.length - 1]) return `${value.toFixed(1)} ${unit}`;
    value /= 1024;
  }
  return `${value.toFixed(1)} TB`;
}

export const formatLineCount = (count: number) => `${count.toLocaleString("ja-JP")} 行`;
export const formatCursor = (line: number, column: number) => `${line}行 ${column}列`;
export const formatFontFamily = (family: string) => family.split(",")[0].replaceAll("\"", "").trim();
export const formatWindowTitle = (session: DocumentSession) =>
  `${session.dirty ? "● " : ""}${displayName(session)} — WasabiPad`;

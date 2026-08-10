import type { ViewerFormat } from "./api";
import type { DocumentSession } from "./session";
import { displayName } from "./session";
import { APP_NAME } from "./app-config";
import { viewerFormatSpec, viewerFormatSpecs } from "./viewer-formats";
export { APP_NAME };

// ウィンドウタイトルの体裁はここだけで決める (メモ本体・ビューで共通)。
// ビュー形式の表示名。エディタの右クリックメニューとビュー側タイトルで共有する。
export const VIEWER_FORMAT_LABELS: Record<ViewerFormat, string> = Object.fromEntries(
  viewerFormatSpecs().map((spec) => [spec.id, spec.label]),
) as Record<ViewerFormat, string>;

export const viewerFormatIcon = (format: ViewerFormat) => viewerFormatSpec(format).iconClass;

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
export const formatTitleBar = (subject: string) => `${subject} — ${APP_NAME}`;
export const formatWindowTitle = (session: Readonly<DocumentSession>) =>
  formatTitleBar(`${session.dirty ? "● " : ""}${displayName(session)}`);

import type { ViewerFormat } from "./api";
import type { DocumentSession } from "./session";
import { displayName } from "./session";

// アプリ名とウィンドウタイトルの体裁はここだけで決める (メモ本体・ビューで共通)
export const APP_NAME = "WasabiPad";

// ビュー形式の表示名。エディタの右クリックメニューとビュー側タイトルで共有する。
export const VIEWER_FORMAT_LABELS: Record<ViewerFormat, string> = {
  csv: "CSVビュー",
  tsv: "TSVビュー",
  markdown: "Markdownビュー",
};

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
export const formatWindowTitle = (session: DocumentSession) =>
  formatTitleBar(`${session.dirty ? "● " : ""}${displayName(session)}`);

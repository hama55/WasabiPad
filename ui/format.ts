import type { DocumentSession } from "./session";
import { displayName } from "./session";
import { APP_NAME } from "./app-config";
import { formatByteSize as formatByteSizeFromProtocol } from "./generated/Protocol";
export { APP_NAME };

// ウィンドウタイトルの体裁はここだけで決める (メモ本体・ビューで共通)。

export const formatByteSize = formatByteSizeFromProtocol;

export const formatLineCount = (count: number) => `${count.toLocaleString("ja-JP")} 行`;
export const formatCursor = (line: number, column: number) => `${line}行 ${column}列`;
export function formatModifiedAt(timestamp: number | null, now = Date.now()): string {
  if (timestamp === null) return "";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const elapsed = Math.max(0, now - timestamp);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const relative = elapsed < minute
    ? "たった今"
    : elapsed < hour
      ? `${Math.floor(elapsed / minute)}分前`
      : elapsed < day
        ? `${Math.floor(elapsed / hour)}時間前`
        : elapsed < 30 * day
          ? `${Math.floor(elapsed / day)}日前`
          : elapsed < 365 * day
            ? `${Math.floor(elapsed / (30 * day))}ヶ月前`
            : `${Math.floor(elapsed / (365 * day))}年前`;
  return `保存: ${relative}`;
}
export const formatFontFamily = (family: string) => family.split(",")[0].replaceAll("\"", "").trim();
export const formatTitleBar = (subject: string) => `${subject} — ${APP_NAME}`;
export const formatWindowTitle = (session: Readonly<DocumentSession>) =>
  formatTitleBar(`${session.dirty ? "● " : ""}${displayName(session)}`);

// パスワード付き 7z/zip の再試行フロー。バックエンドはパスワード起因の失敗を
// "7z-password:required" / "7z-password:wrong" マーカーで返すため、ここで拾って
// 入力ダイアログ → set_archive_password → 元の操作をやり直す、を合うまで繰り返す。
import * as api from "./api";
import { promptFields } from "./prompt";
import { PASSWORD_ERROR_MARKER } from "./generated/Protocol";

export { PASSWORD_ERROR_MARKER } from "./generated/Protocol";

// 入力ダイアログをキャンセルした印。呼び出し側はエラー表示せず静かに中断する。
export class PasswordCancelled extends Error {}

export function isPasswordCancelled(error: unknown): boolean {
  return error instanceof PasswordCancelled;
}

// archiveRelPath: パスワードを要求した書庫。"" = 直接開いている書庫、
// それ以外はフォルダルートからの相対パス ("sub/data.7z")。
export async function withArchivePassword<T>(
  archiveRelPath: string,
  op: () => Promise<T>
): Promise<T> {
  for (;;) {
    try {
      return await op();
    } catch (error) {
      const message = String(error);
      if (!message.includes(PASSWORD_ERROR_MARKER)) throw error;
      const title = message.includes(`${PASSWORD_ERROR_MARKER}:wrong`)
        ? "パスワードが違います"
        : "パスワード付きアーカイブです";
      const values = await promptFields(title, [
        { label: "パスワード", value: "", type: "password" },
      ]);
      if (!values) throw new PasswordCancelled();
      await api.setArchivePassword(archiveRelPath, values[0]);
    }
  }
}

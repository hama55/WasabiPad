import type { Encoding, Eol } from "./api";
import { promptFields } from "./prompt";

// 保存形式の決定点は別名保存だけ。上書き保存は前回決めた形式をそのまま使う。
// value は api.ts の Encoding/Eol と一致していなければならない (scripts/check-ipc-contract.mjs が検証)。
export const SAVE_ENCODING_OPTIONS = [
  { label: "UTF-8", value: "utf8" },
  { label: "UTF-8 (BOM)", value: "utf8bom" },
  { label: "Shift-JIS", value: "sjis" },
  { label: "UTF-16LE", value: "utf16le" },
];

export const SAVE_EOL_OPTIONS = [
  { label: "CRLF", value: "crlf" },
  { label: "LF", value: "lf" },
];

export async function promptSaveFormat(
  encoding: Encoding,
  eol: Eol
): Promise<{ encoding: Encoding; eol: Eol } | null> {
  const result = await promptFields("保存形式", [
    { label: "文字コード", value: encoding, options: SAVE_ENCODING_OPTIONS },
    { label: "改行コード", value: eol, options: SAVE_EOL_OPTIONS },
  ]);
  return result ? { encoding: result[0] as Encoding, eol: result[1] as Eol } : null;
}

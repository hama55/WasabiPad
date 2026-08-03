import type { Encoding, Eol } from "./api";
import { promptFields } from "./prompt";

// 保存形式の決定点は別名保存だけ。上書き保存は前回決めた形式をそのまま使う。
// Record のキーを型そのものにすることで、api.ts の union に増減があれば
// 選択肢の追従漏れが tsc で落ちる (実行時の検証を持ち込まずに二重定義を塞ぐ)。
const ENCODING_LABELS: Record<Encoding, string> = {
  utf8: "UTF-8",
  utf8bom: "UTF-8 (BOM)",
  sjis: "Shift-JIS",
  utf16le: "UTF-16LE",
};

const EOL_LABELS: Record<Eol, string> = {
  crlf: "CRLF",
  lf: "LF",
};

const options = (labels: Record<string, string>) =>
  Object.entries(labels).map(([value, label]) => ({ label, value }));

export interface SaveFormat {
  encoding: Encoding;
  eol: Eol;
}

export function saveFormatFields(current: SaveFormat) {
  return [
    { label: "文字コード", value: current.encoding, options: options(ENCODING_LABELS) },
    { label: "改行コード", value: current.eol, options: options(EOL_LABELS) },
  ];
}

export function saveFormatFromValues(values: string[], offset = 0): SaveFormat {
  return { encoding: values[offset] as Encoding, eol: values[offset + 1] as Eol };
}

export async function promptSaveFormat(current: SaveFormat): Promise<SaveFormat | null> {
  const result = await promptFields("保存形式", saveFormatFields(current));
  return result ? saveFormatFromValues(result) : null;
}

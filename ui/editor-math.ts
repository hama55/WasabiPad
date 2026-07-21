import type { FindCursor, Pos } from "./api";

export function charToU16(text: string, charIndex: number): number {
  let offset = 0;
  let index = 0;
  for (const char of text) {
    if (index === charIndex) return offset;
    offset += char.length;
    index++;
  }
  return text.length;
}

export function charLen(text: string): number {
  return [...text].length;
}

export function u16ToChar(text: string, offset: number): number {
  let utf16 = 0;
  let chars = 0;
  for (const char of text) {
    if (utf16 >= offset) break;
    utf16 += char.length;
    chars++;
  }
  return chars;
}

export function unescapePattern(value: string): string {
  let output = "";
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "\\" && i + 1 < value.length) {
      const next = value[i + 1];
      if (next === "n") { output += "\n"; i++; continue; }
      if (next === "t") { output += "\t"; i++; continue; }
      if (next === "\\") { output += "\\"; i++; continue; }
    }
    output += value[i];
  }
  return output;
}

export function findProgressPercent(cursor: FindCursor, fromLine: number, totalLines: number): number {
  if (totalLines <= 0) return 100;
  const scanned = cursor.wrapped ? totalLines - fromLine + cursor.line : cursor.line - fromLine;
  return Math.min(99, Math.max(0, Math.round((scanned / totalLines) * 100)));
}

export function comparePos(a: Pos, b: Pos): number {
  return a.line !== b.line ? a.line - b.line : a.col - b.col;
}

export function charClass(char: string): number {
  if (char === " " || char === "\t") return 0;
  const code = char.codePointAt(0)!;
  const isWord =
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95 ||
    code > 127;
  return isWord ? 1 : 2;
}

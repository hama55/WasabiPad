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

export class WrapHeightMap {
  private heights = new Map<number, number>();

  constructor(private lineCount: number, private lineHeight: number) {}

  reset(lineCount: number, lineHeight: number) {
    this.lineCount = lineCount;
    this.lineHeight = lineHeight;
    this.heights.clear();
  }

  set(line: number, height: number): boolean {
    const next = Math.max(this.lineHeight, height);
    if (next === this.lineHeight) return this.heights.delete(line);
    if (this.heights.get(line) === next) return false;
    this.heights.set(line, next);
    return true;
  }

  heightAt(line: number): number {
    return this.heights.get(line) ?? this.lineHeight;
  }

  totalHeight(): number {
    let total = this.lineCount * this.lineHeight;
    for (const height of this.heights.values()) total += height - this.lineHeight;
    return total;
  }

  offsetOf(line: number, intraLinePx = 0): number {
    let offset = Math.max(0, Math.min(this.lineCount, line)) * this.lineHeight;
    for (const [measuredLine, height] of this.heights) {
      if (measuredLine < line) offset += height - this.lineHeight;
    }
    return offset + Math.max(0, Math.min(intraLinePx, this.heightAt(line)));
  }

  anchorAt(offset: number): { line: number; intraLinePx: number } {
    let rest = Math.max(0, Math.min(offset, this.totalHeight()));
    let cursor = 0;
    const measured = [...this.heights].sort(([a], [b]) => a - b);
    for (const [line, height] of measured) {
      const baseHeight = (line - cursor) * this.lineHeight;
      if (rest < baseHeight) {
        return {
          line: cursor + Math.floor(rest / this.lineHeight),
          intraLinePx: rest % this.lineHeight,
        };
      }
      rest -= baseHeight;
      if (rest < height) return { line, intraLinePx: rest };
      rest -= height;
      cursor = line + 1;
    }
    const line = Math.min(this.lineCount - 1, cursor + Math.floor(rest / this.lineHeight));
    return { line: Math.max(0, line), intraLinePx: rest % this.lineHeight };
  }
}

export function clampImeAnchor(
  x: number,
  y: number,
  viewportWidth: number,
  viewportHeight: number,
  paddingLeft: number,
  lineHeight: number,
): { x: number; y: number } {
  const minX = Math.max(0, paddingLeft);
  const maxX = Math.max(minX, viewportWidth - 4);
  const maxY = Math.max(0, viewportHeight - lineHeight);
  return {
    x: Math.max(minX, Math.min(Number.isFinite(x) ? x : minX, maxX)),
    y: Math.max(0, Math.min(Number.isFinite(y) ? y : 0, maxY)),
  };
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

export function positionAfterDeletion(start: Pos, end: Pos, target: Pos): Pos {
  if (target.line !== end.line) return { line: target.line - (end.line - start.line), col: target.col };
  return { line: start.line, col: start.col + target.col - end.col };
}

export function charClass(char: string): number {
  if (char === " " || char === "\t") return 0;
  const code = char.codePointAt(0)!;
  const isAsciiWord =
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95;
  if (isAsciiWord) return 1;
  if ((code >= 0x3040 && code <= 0x309f)) return 3;
  if (
    (code >= 0x30a0 && code <= 0x30ff) ||
    (code >= 0x31f0 && code <= 0x31ff) ||
    (code >= 0xff66 && code <= 0xff9d)
  ) return 4;
  if (
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x20000 && code <= 0x2ebef)
  ) return 5;
  return code > 127 ? 6 : 2;
}

export function wordBounds(text: string, col: number): { start: number; end: number } | null {
  const chars = [...text];
  if (chars.length === 0) return null;
  let index = Math.max(0, Math.min(col, chars.length - 1));
  const cls = charClass(chars[index]);
  while (index > 0 && charClass(chars[index - 1]) === cls) index--;
  let end = Math.max(0, Math.min(col, chars.length - 1)) + 1;
  while (end < chars.length && charClass(chars[end]) === cls) end++;
  return { start: index, end };
}

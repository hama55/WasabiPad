import { decodeString } from "micromark-util-decode-string";

export const MARKDOWN_SOURCE_OFFSET_START = "data-source-offset-start";
export const MARKDOWN_SOURCE_OFFSET_END = "data-source-offset-end";

function lineBreakAt(source: string, start: number): { index: number; length: number } | null {
  const carriageReturn = source.indexOf("\r", start);
  const lineFeed = source.indexOf("\n", start);
  const index = carriageReturn < 0 ? lineFeed
    : lineFeed < 0 ? carriageReturn
      : Math.min(carriageReturn, lineFeed);
  if (index < 0) return null;
  return { index, length: source[index] === "\r" && source[index + 1] === "\n" ? 2 : 1 };
}

function sourceLineStartAtOffset(source: string, offset: number): number {
  return Math.max(source.lastIndexOf("\n", offset - 1), source.lastIndexOf("\r", offset - 1)) + 1;
}

export interface MarkdownSourceSegment {
  text: string;
  start: number;
  end: number;
}

export function markdownSourceOffsetAtPosition(
  source: string,
  position: { line: number; col: number },
): number {
  let line = 0;
  let lineStart = 0;
  while (line < position.line) {
    const lineBreak = lineBreakAt(source, lineStart);
    if (!lineBreak) return source.length;
    lineStart = lineBreak.index + lineBreak.length;
    line++;
  }
  const contentEnd = lineBreakAt(source, lineStart)?.index ?? source.length;
  const chars = [...source.slice(lineStart, contentEnd)];
  return lineStart + chars.slice(0, Math.max(0, Math.min(chars.length, position.col))).join("").length;
}

export function markdownSourcePositionAtOffset(source: string, offset: number): { line: number; col: number } {
  const safeOffset = Math.max(0, Math.min(source.length, offset));
  let line = 0;
  let lineStart = 0;
  while (lineStart < safeOffset) {
    const lineBreak = lineBreakAt(source, lineStart);
    if (!lineBreak || lineBreak.index >= safeOffset) break;
    lineStart = lineBreak.index + lineBreak.length;
    line++;
  }
  return { line, col: [...source.slice(lineStart, safeOffset)].length };
}

export function markdownDisplayOffsetForSourceOffset(
  start: number,
  end: number,
  displayLength: number,
  sourceOffset: number,
): number {
  if (sourceOffset <= start) return 0;
  if (sourceOffset >= end) return displayLength;
  if (end - start === displayLength) return sourceOffset - start;
  return sourceOffset - start <= end - sourceOffset ? 0 : displayLength;
}

export function markdownSourceOffsetForDisplayOffset(
  start: number,
  end: number,
  displayLength: number,
  displayOffset: number,
): number {
  const offset = Math.max(0, Math.min(displayLength, displayOffset));
  if (offset === 0 || displayLength === 0) return start;
  if (offset === displayLength) return end;
  if (end - start === displayLength) return start + offset;
  return offset <= displayLength / 2 ? start : end;
}

function appendSegment(segments: MarkdownSourceSegment[], text: string, start: number, end: number): void {
  if (!text) return;
  const previous = segments.at(-1);
  if (previous
    && previous.end === start
    && previous.end - previous.start === previous.text.length
    && end - start === text.length) {
    previous.text += text;
    previous.end = end;
  } else {
    segments.push({ text, start, end });
  }
}

function decodedSourceUnit(raw: string, offset: number, value: string, valueOffset: number): { text: string; length: number } | null {
  if (raw[offset] === "\\" || raw[offset] === "&") {
    const endLimit = Math.min(raw.length, offset + 64);
    for (let end = offset + 2; end <= endLimit; end++) {
      const candidate = raw.slice(offset, end);
      const decoded = decodeString(candidate);
      if (decoded !== candidate && value.startsWith(decoded, valueOffset)) {
        return { text: decoded, length: candidate.length };
      }
      if (raw[offset] === "\\" && end > offset + 2) break;
      if (raw[offset] === "&" && raw[end - 1] === ";") break;
    }
  }

  if (raw[offset] === "\r") {
    const length = raw[offset + 1] === "\n" ? 2 : 1;
    const lineEnding = raw.slice(offset, offset + length);
    if (value.startsWith(lineEnding, valueOffset)) return { text: lineEnding, length };
    if (value.startsWith("\n", valueOffset)) return { text: "\n", length };
    return null;
  }

  const codePoint = raw.codePointAt(offset);
  if (codePoint === undefined) return null;
  const text = String.fromCodePoint(codePoint);
  return value.startsWith(text, valueOffset) ? { text, length: text.length } : null;
}

/** Map parser-decoded text by consuming its exact source range from left to right. */
export function markdownTextSourceSegments(
  source: string,
  start: number,
  end: number,
  value: string,
): MarkdownSourceSegment[] | null {
  if (start < 0 || end < start || end > source.length) return null;
  const raw = source.slice(start, end);
  const segments: MarkdownSourceSegment[] = [];
  let rawOffset = 0;
  let valueOffset = 0;

  while (rawOffset < raw.length && valueOffset < value.length) {
    const unit = decodedSourceUnit(raw, rawOffset, value, valueOffset);
    if (!unit || unit.length <= 0) return null;
    appendSegment(segments, unit.text, start + rawOffset, start + rawOffset + unit.length);
    rawOffset += unit.length;
    valueOffset += unit.text.length;
  }

  if (rawOffset !== raw.length || valueOffset !== value.length) return null;
  return segments;
}

/** Inline-code positions include the backtick delimiters, while their value does not. */
export function markdownInlineCodeSourceSegments(
  source: string,
  start: number,
  end: number,
  value: string,
): MarkdownSourceSegment[] | null {
  const raw = source.slice(start, end);
  let delimiterLength = 0;
  while (raw[delimiterLength] === "`") delimiterLength++;
  if (!delimiterLength || raw.slice(-delimiterLength) !== "`".repeat(delimiterLength)) return null;

  const bodyStart = start + delimiterLength;
  const bodyEnd = end - delimiterLength;
  const content = source.slice(bodyStart, bodyEnd);
  const units: MarkdownSourceSegment[] = [];
  for (let offset = bodyStart; offset < bodyEnd;) {
    const isNewline = source[offset] === "\r" || source[offset] === "\n";
    const length = source[offset] === "\r" && source[offset + 1] === "\n" ? 2 : 1;
    const text = isNewline ? " " : String.fromCodePoint(source.codePointAt(offset)!);
    units.push({ text, start: offset, end: offset + length });
    offset += isNewline ? length : text.length;
  }

  let visible = content.replace(/\r\n|\r|\n/g, " ");
  let first = 0;
  let last = units.length;
  if (visible.startsWith(" ") && visible.endsWith(" ") && /[^ ]/.test(visible)) {
    visible = visible.slice(1, -1);
    first++;
    last--;
  }
  if (visible !== value) return null;

  const segments: MarkdownSourceSegment[] = [];
  for (const unit of units.slice(first, last)) {
    appendSegment(segments, unit.text, unit.start, unit.end);
  }
  return segments;
}

function sourceLines(source: string, start: number, end: number) {
  const lines: { start: number; end: number; nextStart: number }[] = [];
  for (let lineStart = start; lineStart < end;) {
    const lineBreak = lineBreakAt(source, lineStart);
    const hasLineBreak = lineBreak !== null && lineBreak.index < end;
    const lineEnd = hasLineBreak ? lineBreak.index : end;
    const nextStart = hasLineBreak ? lineBreak.index + lineBreak.length : end;
    lines.push({ start: lineStart, end: lineEnd, nextStart });
    lineStart = nextStart;
  }
  return lines;
}

/** Map parser-normalized fenced and indented code by source line, not by searching rendered text. */
export function markdownCodeBlockSourceSegments(
  source: string,
  start: number,
  end: number,
  value: string,
): MarkdownSourceSegment[] | null {
  if (start < 0 || end < start || end > source.length) return null;
  const firstLineStart = sourceLineStartAtOffset(source, start);
  const lines = sourceLines(source, firstLineStart, end);
  const firstLine = lines[0];
  if (!firstLine) return null;
  const containerPrefixLength = start - firstLineStart;
  const opening = source.slice(start, firstLine.end).match(/^ {0,3}(`{3,}|~{3,})/);
  const fenced = opening !== null;
  const contentLines = fenced ? lines.slice(1) : lines;

  if (fenced) {
    const lastLine = contentLines.at(-1);
    const closing = lastLine
      ? source.slice(Math.min(lastLine.start + containerPrefixLength, lastLine.end), lastLine.end)
        .match(/^ {0,3}(`+|~+)\s*$/)
      : null;
    const isClosingFence = !!closing
      && closing[1][0] === opening[1][0]
      && closing[1].length >= opening[1].length;
    if (isClosingFence) contentLines.pop();
  }

  const valueLines = value.split("\n");
  while (contentLines.length > valueLines.length
    && contentLines.at(-1)?.start === contentLines.at(-1)?.end) contentLines.pop();
  if (contentLines.length !== valueLines.length) return null;

  const segments: MarkdownSourceSegment[] = [];
  for (let index = 0; index < contentLines.length; index++) {
    const line = contentLines[index];
    const contentStart = line.end - valueLines[index].length;
    if (contentStart < line.start || source.slice(contentStart, line.end) !== valueLines[index]) return null;
    const mapped = markdownTextSourceSegments(source, contentStart, line.end, valueLines[index]);
    if (!mapped) return null;
    mapped.forEach((segment) => appendSegment(segments, segment.text, segment.start, segment.end));

    if (index + 1 < valueLines.length && line.nextStart > line.end) {
      appendSegment(segments, "\n", line.end, line.nextStart);
    }
  }
  return segments;
}

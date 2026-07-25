// テスト専用の偽 backend。DocumentClient の口だけを満たし、文書は文字列配列で持つ。
import type { DocumentClient, EditResult, Pos } from "./api";

export interface FakeDocument {
  client: DocumentClient;
  text: () => string;
  calls: string[];
}

export function fakeDocument(initial = ""): FakeDocument {
  let lines = initial.split("\n");
  const calls: string[] = [];
  const charsOf = (line: number) => [...(lines[line] ?? "")];
  const text = () => lines.join("\n");

  const result = (caret: Pos): EditResult => ({ caret, line_count: lines.length });

  const splice = (start: Pos, end: Pos, inserted: string): Pos => {
    const head = charsOf(start.line).slice(0, start.col).join("");
    const tail = charsOf(end.line).slice(end.col).join("");
    const merged = `${head}${inserted}${tail}`.split("\n");
    lines.splice(start.line, end.line - start.line + 1, ...merged);
    const insertedLines = inserted.split("\n");
    return insertedLines.length === 1
      ? { line: start.line, col: start.col + [...inserted].length }
      : { line: start.line + insertedLines.length - 1, col: [...insertedLines[insertedLines.length - 1]].length };
  };

  const client: DocumentClient = {
    lines: async (start, count) => {
      calls.push(`lines(${start},${count})`);
      return lines.slice(start, start + count);
    },
    lineCharLen: async (line) => charsOf(line).length,
    edit: async (start, end, _caretBefore, inserted) => {
      calls.push(`edit(${start.line}:${start.col},${end.line}:${end.col},${JSON.stringify(inserted)})`);
      return result(splice(start, end, inserted));
    },
    editMany: async (edits, caretBefore) => {
      calls.push(`editMany(${edits.length})`);
      const carets = edits.map((item) => splice(item.start, item.end, item.text));
      return { carets: carets.length ? carets : [caretBefore], line_count: lines.length };
    },
    undo: async () => null,
    redo: async () => null,
    find: async () => null,
    findStep: async () => ({ kind: "NotFound" }),
    replaceAllChunk: async () => ({ done: true, count: 0, caret: { line: 0, col: 0 }, line_count: lines.length }),
    replaceAllCancel: async () => result({ line: 0, col: 0 }),
  };

  return { client, text, calls };
}

// jsdom に無いレイアウト系APIを埋める。寸法は常に0 (描画結果ではなく制御フローを検証する)。
export function installDomStubs() {
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  const zeroRect = () => ({
    x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0,
    toJSON: () => ({}),
  }) as DOMRect;
  if (typeof Range !== "undefined" && !Range.prototype.getBoundingClientRect) {
    Range.prototype.getBoundingClientRect = zeroRect;
    Range.prototype.getClientRects = (() => Object.assign([], { item: () => null })) as never;
  }
}

// マイクロタスク/rAF に積まれた描画と IPC チェーンを待つ。
export async function settle(times = 4) {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

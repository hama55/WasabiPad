// テスト専用の偽 backend。DocumentClient の口だけを満たし、文書は文字列配列で持つ。
import type { DocumentClient, EditManyItem, EditResult, Pos } from "./api";

export interface FakeDocument {
  client: DocumentClient;
  text: () => string;
  calls: string[];
}

export function fakeDocument(initial = ""): FakeDocument {
  let lines = initial.split("\n");
  const calls: string[] = [];
  const undoStack: {
    before: string[];
    after: string[];
    caretBefore: Pos;
    caretAfter: Pos;
  }[] = [];
  const redoStack: typeof undoStack = [];
  const charsOf = (line: number) => [...(lines[line] ?? "")];
  const text = () => lines.join("\n");
  const compare = (a: Pos, b: Pos) => a.line - b.line || a.col - b.col;
  const record = (before: string[], caretBefore: Pos, caretAfter: Pos) => {
    const after = lines.slice();
    if (before.join("\n") === after.join("\n")) return;
    undoStack.push({ before, after, caretBefore: { ...caretBefore }, caretAfter: { ...caretAfter } });
    redoStack.length = 0;
  };

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
    edit: async (start, end, caretBefore, inserted) => {
      calls.push(`edit(${start.line}:${start.col},${end.line}:${end.col},${JSON.stringify(inserted)})`);
      const before = lines.slice();
      const caretAfter = splice(start, end, inserted);
      record(before, caretBefore, caretAfter);
      return result(caretAfter);
    },
    editMany: async (edits: EditManyItem[], caretBefore, primaryIndex) => {
      calls.push(`editMany(${edits.length})`);
      const before = lines.slice();
      const indexed = edits
        .map((item, index) => ({ item, index }))
        .sort((a, b) => compare(b.item.start, a.item.start));
      const carets: (Pos | undefined)[] = Array(edits.length).fill(undefined);
      for (const { item, index } of indexed) {
        const caretAfter = splice(item.start, item.end, item.text);
        for (const caret of carets) {
          if (!caret) continue;
          if (caret.line > item.end.line) {
            caret.line = caretAfter.line + (caret.line - item.end.line);
          } else if (caret.line === item.end.line && compare(caret, item.end) >= 0) {
            caret.line = caretAfter.line;
            caret.col = caretAfter.col + (caret.col - item.end.col);
          }
        }
        carets[index] = caretAfter;
      }
      const resolvedCarets = carets.map((caret) => caret ?? { ...caretBefore });
      record(before, caretBefore, resolvedCarets[primaryIndex] ?? caretBefore);
      return { carets: resolvedCarets, line_count: lines.length };
    },
    undo: async () => {
      calls.push("undo()");
      const entry = undoStack.pop();
      if (!entry) return null;
      redoStack.push(entry);
      lines = entry.before.slice();
      return result(entry.caretBefore);
    },
    redo: async () => {
      calls.push("redo()");
      const entry = redoStack.pop();
      if (!entry) return null;
      undoStack.push(entry);
      lines = entry.after.slice();
      return result(entry.caretAfter);
    },
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
  if (typeof HTMLCanvasElement !== "undefined") {
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: (type: string) => type === "2d"
        ? {
            font: "",
            measureText: (text: string) => ({ width: text.length * 8 }),
          }
        : null,
    });
  }
}

// マイクロタスク/rAF に積まれた描画と IPC チェーンを待つ。
export async function settle(times = 4) {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

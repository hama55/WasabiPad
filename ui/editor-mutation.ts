import * as api from "./api";
import type { Pos } from "./api";
import { comparePos as cmp } from "./editor-math";
import {
  autoCloseMarkdownFence,
  markdownEmptyListPrefix,
  markdownFenceState,
  markdownLineHasStructure,
  newlineWithMarkdownContinuation,
  newlineWithLeadingTabs,
  planLineIndent,
  planLineUnindent,
  selectedLineRangeForUnindent,
} from "./editor-edit-plan";
import { LineCache } from "./line-cache";
import { blockRangeForLine, Selection } from "./selection";

export interface EditorMutationPorts {
  doc: api.DocumentClient;
  selection: Selection;
  lineCache: LineCache;
  lineCount: () => number;
  isReadOnly: () => boolean;
  isMarkdown?: () => boolean;
  applyResult: (result: api.EditResult, fromLine: number, edits?: api.EditManyItem[]) => void;
  renderAfterEdit: () => Promise<void>;
}

// 文書編集の直列化とUndo単位を担当する。DOM・IME・メニューには依存しない。
export class EditorMutationController {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private ports: EditorMutationPorts) {}

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const promise = this.chain.then(operation);
    this.chain = promise.catch(() => {});
    return promise;
  }

  private markdownEnabled(): boolean {
    return this.ports.isMarkdown?.() ?? true;
  }

  private async markdownFenceStateBefore(line: number) {
    const lines: string[] = [];
    for (let index = 0; index < line; index += 1) {
      lines.push(await this.ports.lineCache.line(index));
    }
    return markdownFenceState(lines);
  }

  private async blockEdits(text: string): Promise<api.EditManyItem[]> {
    const block = this.ports.selection.blockBounds();
    if (!block) return [];
    const edits: api.EditManyItem[] = [];
    for (let line = block.first; line <= block.last; line += 1) {
      const value = await this.ports.lineCache.line(line);
      const range = blockRangeForLine(value, block);
      if (text || range.start < range.end) {
        edits.push({
          start: { line, col: range.start },
          end: { line, col: range.end },
          text,
        });
      }
    }
    return edits;
  }

  private async blockPasteEdits(rows: string[]): Promise<api.EditManyItem[]> {
    const selection = this.ports.selection;
    const block = selection.blockBounds();
    const firstLine = block?.first ?? selection.caret.line;
    const left = block?.left ?? selection.caret.col;
    const edits: api.EditManyItem[] = [];
    for (let index = 0; index < rows.length; index += 1) {
      const line = firstLine + index;
      if (line >= this.ports.lineCount()) break;
      const value = await this.ports.lineCache.line(line);
      const range = blockRangeForLine(value, {
        left,
        right: block && index <= block.last - block.first ? block.right : left,
      });
      if (rows[index] || range.start < range.end) {
        edits.push({
          start: { line, col: range.start },
          end: { line, col: range.end },
          text: rows[index],
        });
      }
    }
    return edits;
  }

  private async applyBlockEdits(
    edits: api.EditManyItem[],
    fromLine: number,
    preferredPrimaryIndex?: number,
  ): Promise<void> {
    const selection = this.ports.selection;
    if (!edits.length) {
      selection.block = null;
      selection.anchor = selection.caret;
      await this.ports.renderAfterEdit();
      return;
    }
    const primaryIndex = preferredPrimaryIndex ?? Math.max(
      0,
      edits.findIndex((edit) => edit.start.line === selection.caret.line),
    );
    const result = await this.ports.doc.editMany(edits, selection.caret, primaryIndex);
    const caret = result.carets[primaryIndex] ?? selection.caret;
    this.ports.applyResult({ caret, line_count: result.line_count }, fromLine, edits);
    selection.block = null;
    selection.secondary = [];
    selection.anchor = caret;
    selection.caret = caret;
    await this.ports.renderAfterEdit();
  }

  insertText(text: string): Promise<void> {
    if (this.ports.isReadOnly()) return Promise.resolve();
    const selection = this.ports.selection;
    if (selection.blockBounds()) {
      return this.run(async () => {
        const edits = await this.blockEdits(text);
        await this.applyBlockEdits(edits, edits[0]?.start.line ?? selection.caret.line);
      });
    }
    if (selection.secondary.length) {
      return this.run(async () => {
        selection.multiCaretX = null;
        const carets = selection.all();
        const edits = carets.map((pos) => ({ start: pos, end: pos, text }));
        const fromLine = Math.min(...carets.map((pos) => pos.line));
        const result = await this.ports.doc.editMany(edits, selection.caret, 0);
        this.ports.applyResult(
          { caret: result.carets[0], line_count: result.line_count },
          fromLine,
          edits,
        );
        selection.caret = result.carets[0];
        selection.anchor = selection.caret;
        selection.secondary = result.carets.slice(1);
        await this.ports.renderAfterEdit();
      });
    }
    return this.run(async () => {
      const [start, end] = selection.norm();
      let inserted = text;
      let caret: Pos | null = null;
      if (this.markdownEnabled()) {
        const line = await this.ports.lineCache.line(start.line);
        const candidate = autoCloseMarkdownFence(line, start.col, end.col, text, null);
        if (candidate) {
          const fenceState = await this.markdownFenceStateBefore(start.line);
          const fence = autoCloseMarkdownFence(line, start.col, end.col, text, fenceState);
          if (fence) {
            inserted = fence.text;
            caret = { line: start.line + fence.caretLineOffset, col: fence.caretCol };
          }
        }
      }
      const coalesce = !selection.hasSel() && inserted.length === 1 && inserted !== "\n";
      const result = await this.ports.doc.edit(start, end, selection.caret, inserted, coalesce);
      this.ports.applyResult(
        { caret: caret ?? result.caret, line_count: result.line_count },
        start.line,
        [{ start, end, text: inserted }],
      );
      await this.ports.renderAfterEdit();
    });
  }

  pasteBlock(rows: string[]): Promise<void> {
    if (this.ports.isReadOnly() || !rows.length) return Promise.resolve();
    const selection = this.ports.selection;
    if (!selection.blockBounds() && (selection.secondary.length || selection.hasSel())) {
      return this.insertText(rows.join("\n"));
    }
    return this.run(async () => {
      const edits = await this.blockPasteEdits(rows);
      const block = selection.blockBounds();
      await this.applyBlockEdits(
        edits,
        edits[0]?.start.line ?? selection.caret.line,
        block ? undefined : Math.max(0, edits.length - 1),
      );
    });
  }

  insertNewlineWithIndent(): Promise<void> {
    if (this.ports.isReadOnly()) return Promise.resolve();
    if (this.ports.selection.secondary.length) return this.insertText("\n");
    return this.run(async () => {
      const [start, end] = this.ports.selection.norm();
      const line = await this.ports.lineCache.line(start.line);
      const markdown = this.markdownEnabled();
      const fenceState = markdown && (line.startsWith(" ") || markdownLineHasStructure(line))
        ? await this.markdownFenceStateBefore(start.line)
        : null;
      const emptyListPrefix = markdown && !fenceState ? markdownEmptyListPrefix(line) : null;
      const atLineEnd = start.line === end.line
        && start.col === end.col
        && start.col === [...line].length;
      const editStart = emptyListPrefix !== null && atLineEnd
        ? { line: start.line, col: [...emptyListPrefix].length }
        : start;
      const editEnd = emptyListPrefix !== null && atLineEnd
        ? { line: start.line, col: [...line].length }
        : end;
      const text = emptyListPrefix !== null && atLineEnd
        ? ""
        : markdown
          ? newlineWithMarkdownContinuation(line, fenceState)
          : newlineWithLeadingTabs(line);
      const result = await this.ports.doc.edit(
        editStart,
        editEnd,
        this.ports.selection.caret,
        text,
        false,
      );
      this.ports.applyResult(result, start.line, [{ start: editStart, end: editEnd, text }]);
      await this.ports.renderAfterEdit();
    });
  }

  indentSelection(): Promise<void> {
    const selection = this.ports.selection;
    const plan = planLineIndent(selection.anchor, selection.caret);
    if (!plan) return this.insertText("\t");
    if (this.ports.isReadOnly()) return Promise.resolve();
    return this.run(async () => {
      const caret = { ...selection.caret };
      const result = await this.ports.doc.editMany(plan.edits, caret, plan.primaryIndex);
      this.ports.applyResult(
        { caret: plan.nextCaret, line_count: result.line_count },
        plan.fromLine,
        plan.edits,
      );
      selection.anchor = plan.nextAnchor;
      selection.caret = plan.nextCaret;
      await this.ports.renderAfterEdit();
    });
  }

  unindentSelection(): Promise<void> {
    if (this.ports.isReadOnly()) return Promise.resolve();
    const selection = this.ports.selection;
    const block = selection.blockBounds();
    const range = block
      ? { first: block.first, last: block.last }
      : selectedLineRangeForUnindent(selection.anchor, selection.caret);
    return this.run(async () => {
      const lines: string[] = [];
      for (let line = range.first; line <= range.last; line += 1) {
        lines.push(await this.ports.lineCache.line(line));
      }
      const plan = planLineUnindent(selection.anchor, selection.caret, lines, range);
      if (!plan) return;
      const result = await this.ports.doc.editMany(plan.edits, selection.caret, plan.primaryIndex);
      this.ports.applyResult(
        { caret: plan.nextCaret, line_count: result.line_count },
        plan.fromLine,
        plan.edits,
      );
      selection.anchor = plan.nextAnchor;
      selection.caret = plan.nextCaret;
      await this.ports.renderAfterEdit();
    });
  }

  deleteSel(): Promise<void> {
    if (this.ports.isReadOnly()) return Promise.resolve();
    if (this.ports.selection.blockBounds()) {
      return this.run(async () => {
        const edits = await this.blockEdits("");
        await this.applyBlockEdits(edits, edits[0]?.start.line ?? this.ports.selection.caret.line);
      });
    }
    return this.run(async () => {
      const [start, end] = this.ports.selection.norm();
      const result = await this.ports.doc.edit(
        start,
        end,
        this.ports.selection.caret,
        "",
        false,
      );
      this.ports.applyResult(result, start.line, [{ start, end, text: "" }]);
      await this.ports.renderAfterEdit();
    });
  }

  backspace(): Promise<void> {
    if (this.ports.isReadOnly()) return Promise.resolve();
    if (this.ports.selection.hasSel()) return this.deleteSel();
    return this.run(async () => {
      const caret = this.ports.selection.caret;
      let start: Pos;
      if (caret.col > 0) start = { line: caret.line, col: caret.col - 1 };
      else if (caret.line > 0) {
        start = {
          line: caret.line - 1,
          col: await this.ports.lineCache.lineLength(caret.line - 1),
        };
      } else {
        return;
      }
      const result = await this.ports.doc.edit(start, caret, caret, "", false);
      this.ports.applyResult(result, start.line, [{ start, end: caret, text: "" }]);
      await this.ports.renderAfterEdit();
    });
  }

  deleteForward(): Promise<void> {
    if (this.ports.isReadOnly()) return Promise.resolve();
    if (this.ports.selection.hasSel()) return this.deleteSel();
    return this.run(async () => {
      const caret = this.ports.selection.caret;
      const length = await this.ports.lineCache.lineLength(caret.line);
      let end: Pos;
      if (caret.col < length) end = { line: caret.line, col: caret.col + 1 };
      else if (caret.line + 1 < this.ports.lineCount()) end = { line: caret.line + 1, col: 0 };
      else return;
      const result = await this.ports.doc.edit(caret, end, caret, "", false);
      this.ports.applyResult(result, caret.line, [{ start: caret, end, text: "" }]);
      await this.ports.renderAfterEdit();
    });
  }

  undo(redo: boolean): Promise<void> {
    if (this.ports.isReadOnly()) return Promise.resolve();
    return this.run(async () => {
      const result = redo ? await this.ports.doc.redo() : await this.ports.doc.undo();
      if (!result) return;
      this.ports.applyResult(result, 0);
      this.ports.selection.secondary = [];
      this.ports.selection.block = null;
      this.ports.selection.multiCaretX = null;
      await this.ports.renderAfterEdit();
    });
  }

  moveSelection(start: Pos, end: Pos, target: Pos, copy: boolean): Promise<void> {
    if (this.ports.isReadOnly()) return Promise.resolve();
    if (cmp(target, start) >= 0 && cmp(target, end) <= 0) return Promise.resolve();
    return this.run(async () => {
      const text = await this.ports.lineCache.textInRange(start, end);
      let result: api.EditResult;
      let edits: api.EditManyItem[];
      let fromLine: number;
      if (copy) {
        edits = [{ start: target, end: target, text }];
        result = await this.ports.doc.edit(target, target, target, text, false);
        fromLine = target.line;
      } else {
        // editManyは開始位置の降順で適用されるため、targetは削除前の座標。
        edits = [
          { start, end, text: "" },
          { start: target, end: target, text },
        ];
        const many = await this.ports.doc.editMany(edits, target, 1);
        result = { caret: many.carets[1] ?? target, line_count: many.line_count };
        fromLine = Math.min(start.line, target.line);
      }
      this.ports.applyResult(result, fromLine, edits);
      await this.ports.renderAfterEdit();
    });
  }
}

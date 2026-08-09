// TextBuffer と UndoStack の編集不変条件だけを担当する。
// ファイル・アーカイブ・IPC DTOはここへ持ち込まず、Docは座標変換と公開APIに専念する。
use crate::buffer::{Pos, TextBuffer};
use crate::undo::{Edit, UndoEntry, UndoStack};

pub(crate) struct ByteEdit {
    pub index: usize,
    pub start: Pos,
    pub end: Pos,
    pub text: String,
}

pub(crate) struct EditManyResult {
    pub carets: Vec<Pos>,
    pub line_count: usize,
}

pub(crate) fn apply_edit(
    buf: &mut TextBuffer,
    undo: &mut UndoStack,
    start: Pos,
    end: Pos,
    caret_before: Pos,
    text: &str,
    coalesce: bool,
) -> Pos {
    let mut edits = Vec::new();
    let mut pos = start;
    if start < end {
        let removed = buf.delete(start, end);
        edits.push(Edit::Delete {
            start,
            text: removed,
        });
        pos = start;
    }
    let after = if !text.is_empty() {
        let end = buf.insert(pos, text);
        edits.push(Edit::Insert {
            pos,
            text: text.to_string(),
        });
        end
    } else {
        pos
    };
    if !edits.is_empty() {
        // 連続1文字入力のみ coalesce (選択削除を伴わないとき)
        undo.push(
            UndoEntry {
                edits,
                caret_before,
                caret_after: after,
            },
            coalesce && start == end,
        );
    }
    after
}

pub(crate) fn apply_edit_many(
    buf: &mut TextBuffer,
    undo: &mut UndoStack,
    items: Vec<ByteEdit>,
    caret_before: Pos,
    primary_index: usize,
) -> EditManyResult {
    if items.is_empty() {
        return EditManyResult {
            carets: Vec::new(),
            line_count: buf.line_count(),
        };
    }
    let mut indexed = items;
    indexed.sort_by(|a, b| {
        b.start
            .line
            .cmp(&a.start.line)
            .then_with(|| b.start.col.cmp(&a.start.col))
    });
    let mut edits = Vec::new();
    let mut carets: Vec<Option<Pos>> = vec![None; indexed.len()];
    for item in indexed {
        let start = item.start;
        let end = item.end;
        if start < end {
            let removed = buf.delete(start, end);
            edits.push(Edit::Delete {
                start,
                text: removed,
            });
        }
        let after = if item.text.is_empty() {
            start
        } else {
            let after = buf.insert(start, &item.text);
            edits.push(Edit::Insert {
                pos: start,
                text: item.text,
            });
            after
        };
        for caret in carets.iter_mut().flatten() {
            if caret.line > end.line {
                caret.line = after.line + (caret.line - end.line);
            } else if caret.line == end.line && *caret >= end {
                caret.line = after.line;
                caret.col = after.col + (caret.col - end.col);
            }
        }
        carets[item.index] = Some(after);
    }
    let carets: Vec<Pos> = carets
        .into_iter()
        .map(|caret| caret.unwrap_or(caret_before))
        .collect();
    if !edits.is_empty() {
        let caret_after = carets.get(primary_index).copied().unwrap_or(caret_before);
        undo.push(
            UndoEntry {
                edits,
                caret_before,
                caret_after,
            },
            false,
        );
    }
    EditManyResult {
        carets,
        line_count: buf.line_count(),
    }
}

pub(crate) fn undo(buf: &mut TextBuffer, stack: &mut UndoStack) -> Option<Pos> {
    stack.undo(buf).map(|(caret, _)| caret)
}

pub(crate) fn redo(buf: &mut TextBuffer, stack: &mut UndoStack) -> Option<Pos> {
    stack.redo(buf).map(|(caret, _)| caret)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Feature: 編集エンジン
    // Scenario: 単一編集をUndo/Redoできる
    // Given: 空のTextBufferと空のUndoStack
    // When: 文字列を挿入し、UndoとRedoを順に実行する
    // Then: 本文とキャレットが編集前後へ正しく戻る
    #[test]
    fn single_edit_round_trips_through_undo_and_redo() {
        let mut buf = TextBuffer::new();
        let mut stack = UndoStack::new();
        let start = Pos::default();
        let after = apply_edit(&mut buf, &mut stack, start, start, start, "日本", false);

        assert_eq!(buf.line(0).as_ref(), "日本");
        assert_eq!(after, Pos { line: 0, col: "日本".len() });
        assert_eq!(undo(&mut buf, &mut stack), Some(start));
        assert_eq!(buf.line(0).as_ref(), "");
        assert_eq!(redo(&mut buf, &mut stack), Some(after));
        assert_eq!(buf.line(0).as_ref(), "日本");
    }

    // Feature: 複数編集
    // Scenario: 前後方向の移動を1つのUndoエントリへまとめる
    // Given: `abcDEFghi`と、削除・挿入を含む2件のpre-edit座標
    // When: 開始位置の降順で複数編集を適用する
    // Then: 入力順のcaretを返し、Undo一回で元本文へ戻り、二回目は何もしない
    #[test]
    fn multiple_edits_keep_input_order_and_are_atomic() {
        let mut buf = TextBuffer::from_text("abcDEFghi");
        let mut stack = UndoStack::new();
        let result = apply_edit_many(
            &mut buf,
            &mut stack,
            vec![
                ByteEdit {
                    index: 0,
                    start: Pos { line: 0, col: 3 },
                    end: Pos { line: 0, col: 6 },
                    text: String::new(),
                },
                ByteEdit {
                    index: 1,
                    start: Pos::default(),
                    end: Pos::default(),
                    text: "DEF".to_string(),
                },
            ],
            Pos { line: 0, col: 6 },
            1,
        );

        assert_eq!(buf.line(0).as_ref(), "DEFabcghi");
        assert_eq!(result.carets.len(), 2);
        assert_eq!(undo(&mut buf, &mut stack), Some(Pos { line: 0, col: 6 }));
        assert_eq!(buf.line(0).as_ref(), "abcDEFghi");
        assert!(undo(&mut buf, &mut stack).is_none());
        assert_eq!(redo(&mut buf, &mut stack), Some(Pos { line: 0, col: 3 }));
        assert_eq!(buf.line(0).as_ref(), "DEFabcghi");
    }
}

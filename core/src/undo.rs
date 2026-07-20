use crate::buffer::{Pos, TextBuffer};

pub enum Edit {
    Insert { pos: Pos, text: String },
    Delete { start: Pos, text: String },
}

pub struct UndoEntry {
    pub edits: Vec<Edit>,
    pub caret_before: Pos,
    pub caret_after: Pos,
}

pub struct UndoStack {
    undo: Vec<UndoEntry>,
    redo: Vec<UndoEntry>,
    // 直前エントリが連続1文字挿入なら coalesce 可
    coalescing: bool,
}

impl UndoStack {
    pub fn new() -> Self {
        UndoStack { undo: Vec::new(), redo: Vec::new(), coalescing: false }
    }

    pub fn clear(&mut self) {
        self.undo.clear();
        self.redo.clear();
        self.coalescing = false;
    }

    pub fn push(&mut self, entry: UndoEntry, coalesce: bool) {
        self.redo.clear();
        if coalesce && self.coalescing {
            if let (Some(last), [Edit::Insert { pos, text }]) =
                (self.undo.last_mut(), &entry.edits[..])
            {
                if let [Edit::Insert { pos: lpos, text: ltext }] = &mut last.edits[..] {
                    // 直前挿入の直後への1文字挿入のみ結合
                    if TextBuffer::end_of_insert(*lpos, ltext) == *pos && !text.contains('\n') {
                        ltext.push_str(text);
                        last.caret_after = entry.caret_after;
                        return;
                    }
                }
            }
        }
        self.undo.push(entry);
        self.coalescing = coalesce;
    }

    pub fn break_coalescing(&mut self) {
        self.coalescing = false;
    }

    pub fn undo(&mut self, buf: &mut TextBuffer) -> Option<(Pos, Vec<usize>)> {
        let entry = self.undo.pop()?;
        let mut touched = Vec::new();
        for e in entry.edits.iter().rev() {
            match e {
                Edit::Insert { pos, text } => {
                    buf.delete(*pos, TextBuffer::end_of_insert(*pos, text));
                    touched.push(pos.line);
                }
                Edit::Delete { start, text } => {
                    buf.insert(*start, text);
                    touched.push(start.line);
                }
            }
        }
        let caret = entry.caret_before;
        self.redo.push(entry);
        self.coalescing = false;
        Some((caret, touched))
    }

    pub fn redo(&mut self, buf: &mut TextBuffer) -> Option<(Pos, Vec<usize>)> {
        let entry = self.redo.pop()?;
        let mut touched = Vec::new();
        for e in entry.edits.iter() {
            match e {
                Edit::Insert { pos, text } => {
                    buf.insert(*pos, text);
                    touched.push(pos.line);
                }
                Edit::Delete { start, text } => {
                    buf.delete(*start, TextBuffer::end_of_insert(*start, text));
                    touched.push(start.line);
                }
            }
        }
        let caret = entry.caret_after;
        self.undo.push(entry);
        self.coalescing = false;
        Some((caret, touched))
    }
}

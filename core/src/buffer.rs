// テキストバッファ: 通常は行単位 Vec<String>、巨大ファイルは mmap ベース (hugebuf)。
// 内部 UTF-8、\r は持たない。
use crate::hugebuf::HugeBuf;
use std::borrow::Cow;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug, Default)]
pub struct Pos {
    pub line: usize,
    pub col: usize, // 行内 UTF-8 バイトオフセット (char 境界)
}

pub enum Store {
    Small(Vec<String>),
    Huge(Box<HugeBuf>),
}

pub struct TextBuffer {
    pub store: Store,
}

impl TextBuffer {
    pub fn new() -> Self {
        TextBuffer { store: Store::Small(vec![String::new()]) }
    }

    pub fn from_text(text: &str) -> Self {
        let mut lines: Vec<String> = text
            .split('\n')
            .map(|l| l.strip_suffix('\r').unwrap_or(l).to_string())
            .collect();
        if lines.is_empty() {
            lines.push(String::new());
        }
        TextBuffer { store: Store::Small(lines) }
    }

    pub fn from_huge(h: HugeBuf) -> Self {
        TextBuffer { store: Store::Huge(Box::new(h)) }
    }

    #[cfg(test)]
    pub fn is_huge(&self) -> bool {
        matches!(self.store, Store::Huge(_))
    }

    pub fn line_count(&self) -> usize {
        match &self.store {
            Store::Small(lines) => lines.len(),
            Store::Huge(h) => h.line_count(),
        }
    }

    pub fn line(&self, i: usize) -> Cow<'_, str> {
        match &self.store {
            Store::Small(lines) => Cow::Borrowed(&lines[i]),
            Store::Huge(h) => Cow::Owned(h.line(i)),
        }
    }

    pub fn line_len(&self, i: usize) -> usize {
        match &self.store {
            Store::Small(lines) => lines[i].len(),
            Store::Huge(h) => h.line(i).len(),
        }
    }

    // テスト用
    #[cfg(test)]
    pub fn small_lines(&self) -> Option<&Vec<String>> {
        match &self.store {
            Store::Small(lines) => Some(lines),
            Store::Huge(_) => None,
        }
    }

    // text は '\n' 区切り可。挿入後の終端位置を返す
    pub fn insert(&mut self, pos: Pos, text: &str) -> Pos {
        match &mut self.store {
            Store::Small(lines) => {
                if !text.contains('\n') {
                    lines[pos.line].insert_str(pos.col, text);
                    return Pos { line: pos.line, col: pos.col + text.len() };
                }
                let tail = lines[pos.line].split_off(pos.col);
                let mut it = text.split('\n');
                let first = it.next().unwrap();
                lines[pos.line].push_str(first);
                let mut cur = pos.line;
                for seg in it {
                    cur += 1;
                    lines.insert(cur, seg.to_string());
                }
                let end = Pos { line: cur, col: lines[cur].len() };
                lines[cur].push_str(&tail);
                end
            }
            Store::Huge(h) => h.insert(pos, text),
        }
    }

    // 削除したテキストを返す ('\n' 区切り)
    pub fn delete(&mut self, start: Pos, end: Pos) -> String {
        match &mut self.store {
            Store::Small(lines) => {
                if start.line == end.line {
                    return lines[start.line].drain(start.col..end.col).collect();
                }
                let mut removed = String::new();
                removed.push_str(&lines[start.line][start.col..]);
                removed.push('\n');
                for l in &lines[start.line + 1..end.line] {
                    removed.push_str(l);
                    removed.push('\n');
                }
                removed.push_str(&lines[end.line][..end.col]);
                let tail = lines[end.line][end.col..].to_string();
                lines[start.line].truncate(start.col);
                lines[start.line].push_str(&tail);
                lines.drain(start.line + 1..=end.line);
                removed
            }
            Store::Huge(h) => h.delete(start, end),
        }
    }

    #[cfg(test)]
    pub fn range_text(&self, start: Pos, end: Pos) -> String {
        match &self.store {
            Store::Small(lines) => {
                if start.line == end.line {
                    return lines[start.line][start.col..end.col].to_string();
                }
                let mut s = String::new();
                s.push_str(&lines[start.line][start.col..]);
                s.push('\n');
                for l in &lines[start.line + 1..end.line] {
                    s.push_str(l);
                    s.push('\n');
                }
                s.push_str(&lines[end.line][..end.col]);
                s
            }
            Store::Huge(h) => h.range_text(start, end),
        }
    }

    // pos に text を挿入した場合の終端位置 (undo 用、変更なし)
    pub fn end_of_insert(pos: Pos, text: &str) -> Pos {
        match text.rfind('\n') {
            None => Pos { line: pos.line, col: pos.col + text.len() },
            Some(i) => Pos {
                line: pos.line + text.matches('\n').count(),
                col: text.len() - i - 1,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(b: &TextBuffer) -> &Vec<String> {
        b.small_lines().unwrap()
    }

    #[test]
    fn insert_delete_roundtrip() {
        let mut b = TextBuffer::from_text("あいう\nabc");
        let end = b.insert(Pos { line: 0, col: 3 }, "X\nY");
        assert_eq!(lines(&b), &vec!["あX", "Yいう", "abc"]);
        assert_eq!(end, Pos { line: 1, col: 1 });
        let removed = b.delete(Pos { line: 0, col: 3 }, end);
        assert_eq!(removed, "X\nY");
        assert_eq!(lines(&b), &vec!["あいう", "abc"]);
    }

    #[test]
    fn end_of_insert_matches() {
        let mut b = TextBuffer::from_text("hello");
        let p = Pos { line: 0, col: 2 };
        let t = "aa\nbb\ncc";
        let end = b.insert(p, t);
        assert_eq!(end, TextBuffer::end_of_insert(p, t));
    }
}

use crate::buffer::{Pos, TextBuffer};
use crate::document_types::FindCursor;
use crate::search::{find_backward, find_chunk, ChunkStep};
use crate::undo::{Edit, UndoEntry, UndoStack};

pub(crate) enum FindStep {
    Found(Pos, Pos),
    More(FindCursor),
    NotFound,
}

#[derive(Default)]
pub(crate) struct ReplaceProgress {
    edits: Vec<Edit>,
    pos: Pos,
    find_cursor: Option<FindCursor>,
    count: usize,
    matches: Option<Vec<(Pos, Pos)>>,
    collected_lines: usize,
    collected: bool,
}

pub(crate) fn find(
    buf: &TextBuffer,
    pat: &str,
    from: Pos,
    forward: bool,
    match_case: bool,
    use_regex: bool,
    whole_word: bool,
) -> Option<(Pos, Pos)> {
    if pat.is_empty() {
        return None;
    }
    if forward {
        return match find_step(buf, pat, from, match_case, use_regex, whole_word, None, usize::MAX) {
            FindStep::Found(start, end) => Some((start, end)),
            _ => None,
        };
    }
    find_backward(buf, pat, from, match_case, use_regex, whole_word, true)
}

pub(crate) fn find_step(
    buf: &TextBuffer,
    pat: &str,
    from: Pos,
    match_case: bool,
    use_regex: bool,
    whole_word: bool,
    cursor: Option<FindCursor>,
    budget: usize,
) -> FindStep {
    if pat.is_empty() {
        return FindStep::NotFound;
    }
    let cur = cursor.unwrap_or(FindCursor {
        wrapped: false,
        line: from.line,
    });
    match find_chunk(buf, pat, from, match_case, use_regex, whole_word, cur, budget, true) {
        ChunkStep::Found(start, end) => FindStep::Found(start, end),
        ChunkStep::More(cursor) => FindStep::More(cursor),
        ChunkStep::NotFound => FindStep::NotFound,
    }
}

pub(crate) struct ReplaceResult {
    pub done: bool,
    pub count: usize,
    pub caret: Pos,
}

pub(crate) fn replace_all_chunk(
    buf: &mut TextBuffer,
    undo: &mut UndoStack,
    progress: &mut Option<ReplaceProgress>,
    pat: &str,
    rep: &str,
    match_case: bool,
    use_regex: bool,
    whole_word: bool,
    budget: usize,
) -> ReplaceResult {
    const SCAN_BUDGET: usize = 20_000;
    let mut state = progress.take().unwrap_or_default();
    if (use_regex || whole_word) && !state.collected {
        // Fix the matches before editing; reverse order preserves positions and zero-width matches.
        let last = (state.collected_lines + SCAN_BUDGET).min(buf.line_count());
        if state.collected_lines < last {
            let matches = crate::search::find_all_in_range(
                buf, pat, state.collected_lines, last, match_case, use_regex, whole_word, 0,
            ).expect("search pattern validated by Doc");
            state.matches.get_or_insert_with(Vec::new).extend(matches);
            state.collected_lines = last;
        }
        if last < buf.line_count() {
            let result = ReplaceResult { done: false, count: state.count, caret: state.pos };
            *progress = Some(state);
            return result;
        }
        state.collected = true;
    }
    let mut replaced = 0;
    loop {
        if replaced >= budget.max(1) {
            let result = ReplaceResult {
                done: false,
                count: state.count,
                caret: state.pos,
            };
            *progress = Some(state);
            return result;
        }
        let cursor = state.find_cursor.unwrap_or(FindCursor {
            wrapped: false,
            line: state.pos.line,
        });
        let step = if let Some(matches) = &mut state.matches {
            matches.pop().map(|(start, end)| ChunkStep::Found(start, end)).unwrap_or(ChunkStep::NotFound)
        } else {
            find_chunk(buf, pat, state.pos, match_case, false, false, cursor, SCAN_BUDGET, false)
        };
        match step {
            ChunkStep::Found(start, end) => {
                state.find_cursor = None;
                let removed = buf.delete(start, end);
                state.edits.push(Edit::Delete { start, text: removed });
                let after = buf.insert(start, rep);
                state.edits.push(Edit::Insert {
                    pos: start,
                    text: rep.to_string(),
                });
                state.pos = after;
                state.count += 1;
                replaced += 1;
            }
            ChunkStep::More(cursor) => {
                state.find_cursor = Some(cursor);
                let result = ReplaceResult {
                    done: false,
                    count: state.count,
                    caret: state.pos,
                };
                *progress = Some(state);
                return result;
            }
            ChunkStep::NotFound => {
                let count = state.count;
                if count > 0 {
                    undo.push(
                        UndoEntry {
                            edits: state.edits,
                            caret_before: Pos::default(),
                            caret_after: state.pos,
                        },
                        false,
                    );
                }
                *progress = None;
                return ReplaceResult {
                    done: true,
                    count,
                    caret: state.pos,
                };
            }
        }
    }
}

pub(crate) fn replace_all_cancel(
    undo: &mut UndoStack,
    progress: &mut Option<ReplaceProgress>,
) -> Pos {
    let Some(state) = progress.take() else {
        return Pos::default();
    };
    if state.count > 0 {
        undo.push(
            UndoEntry {
                edits: state.edits,
                caret_before: Pos::default(),
                caret_after: state.pos,
            },
            false,
        );
    }
    state.pos
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(line: usize, col: usize) -> Pos {
        Pos { line, col }
    }

    #[test]
    fn find_and_replace_are_independent_of_doc_facade() {
        // Feature: 検索・置換エンジン
        // Scenario: Doc を経由せず、検索結果とチャンク置換を同じ契約で処理する
        // Given: "foo foo" を入力したバッファ
        let mut buf = TextBuffer::from_text("foo foo");
        let mut undo = UndoStack::new();
        // When: 前方検索してから、1件ずつ置換する
        assert_eq!(find(&buf, "foo", p(0, 0), true, true, false, false), Some((p(0, 0), p(0, 3))));
        let mut progress = None;
        let first = replace_all_chunk(
            &mut buf,
            &mut undo,
            &mut progress,
            "foo",
            "bar",
            true,
            false,
            false,
            1,
        );
        let second = replace_all_chunk(
            &mut buf,
            &mut undo,
            &mut progress,
            "foo",
            "bar",
            true,
            false,
            false,
            1,
        );
        let third = replace_all_chunk(
            &mut buf,
            &mut undo,
            &mut progress,
            "foo",
            "bar",
            true,
            false,
            false,
            1,
        );
        // Then: 置換は全件完了し、Undo は一つのエントリで元に戻る
        assert!(!first.done);
        assert_eq!(first.count, 1);
        assert!(!second.done);
        assert_eq!(second.count, 2);
        assert!(third.done);
        assert_eq!(third.count, 2);
        assert_eq!(buf.line(0), "bar bar");
        assert_eq!(undo.undo(&mut buf).map(|result| result.0), Some(p(0, 0)));
        assert_eq!(buf.line(0), "foo foo");
    }
}

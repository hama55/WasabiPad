use crate::buffer::{Pos, TextBuffer};
use crate::document_types::FindCursor;
use crate::search::{build_matcher, find_backward, find_chunk, find_chunk_with_matcher, ChunkStep};
use crate::undo::{Edit, UndoEntry, UndoStack};
use crate::document_assets::image_references_in_lines;
use grep_regex::RegexMatcher;

pub(crate) enum FindStep {
    Found(Pos, Pos),
    More(FindCursor),
    NotFound,
}

#[derive(Default)]
pub(crate) struct ReplaceProgress {
    pat: String,
    rep: String,
    match_case: bool,
    use_regex: bool,
    whole_word: bool,
    edits: Vec<Edit>,
    pos: Pos,
    find_cursor: Option<FindCursor>,
    matcher: Option<RegexMatcher>,
    count: usize,
    matches: Option<Vec<(Pos, Pos)>>,
    collected_lines: usize,
    collected: bool,
    pub(crate) image_references: std::collections::HashSet<String>,
}

impl ReplaceProgress {
    fn new(pat: &str, rep: &str, match_case: bool, use_regex: bool, whole_word: bool) -> Self {
        Self {
            pat: pat.to_string(),
            rep: rep.to_string(),
            match_case,
            use_regex,
            whole_word,
            ..Self::default()
        }
    }

    fn matches_query(
        &self,
        pat: &str,
        rep: &str,
        match_case: bool,
        use_regex: bool,
        whole_word: bool,
    ) -> bool {
        self.pat == pat
            && self.rep == rep
            && self.match_case == match_case
            && self.use_regex == use_regex
            && self.whole_word == whole_word
    }
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

#[allow(clippy::too_many_arguments)]
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

#[allow(clippy::too_many_arguments)]
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
    let mut state = match progress.take() {
        Some(existing) if existing.matches_query(pat, rep, match_case, use_regex, whole_word) => {
            existing
        }
        Some(stale) => {
            if stale.count > 0 {
                undo.push(
                    UndoEntry {
                        edits: stale.edits,
                        caret_before: Pos::default(),
                        caret_after: stale.pos,
                        image_references: stale.image_references,
                    },
                    false,
                );
            }
            ReplaceProgress::new(pat, rep, match_case, use_regex, whole_word)
        }
        None => ReplaceProgress::new(pat, rep, match_case, use_regex, whole_word),
    };
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
    if !use_regex && !whole_word && !pat.contains('\n') && state.matcher.is_none() {
        state.matcher = build_matcher(pat, match_case, false, false).ok();
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
            find_chunk_with_matcher(
                buf,
                pat,
                state.pos,
                match_case,
                false,
                false,
                cursor,
                SCAN_BUDGET,
                false,
                state.matcher.as_ref(),
            )
        };
        match step {
            ChunkStep::Found(start, end) => {
                state.find_cursor = None;
                state.image_references.extend(image_references_in_lines(buf, start.line.saturating_sub(1), end.line.saturating_add(1)));
                let removed = buf.delete(start, end);
                state.edits.push(Edit::Delete { start, text: removed });
                let after = buf.insert(start, rep);
                state.edits.push(Edit::Insert {
                    pos: start,
                    text: rep.to_string(),
                });
                state.pos = after;
                state.image_references.extend(image_references_in_lines(buf, start.line.saturating_sub(1), after.line.saturating_add(1)));
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
                            image_references: state.image_references,
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
                image_references: state.image_references,
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

    // Feature: リテラル全置換の正規表現マッチャ再利用
    // Scenario: 複数チャンクのリテラル全置換でマッチャを再コンパイルせず再利用する
    // Given: 大文字小文字無視の単一行リテラル置換を複数チャンクに分けて実行する
    // When: budget=1 で replace_all_chunk を繰り返す
    // Then: 進行中にコンパイル済み matcher が保持・再利用され、全置換と単一 Undo が正しく完了する
    #[test]
    fn literal_replace_all_reuses_compiled_matcher_across_chunks() {
        let mut buf = TextBuffer::from_text("Foo foo FOO");
        let mut undo = UndoStack::new();
        let mut progress = None;

        let first = replace_all_chunk(&mut buf, &mut undo, &mut progress, "foo", "bar", false, false, false, 1);
        assert!(!first.done);
        assert_eq!(first.count, 1);
        assert!(progress.as_ref().and_then(|s| s.matcher.as_ref()).is_some());

        let second = replace_all_chunk(&mut buf, &mut undo, &mut progress, "foo", "bar", false, false, false, 1);
        assert!(!second.done);
        assert_eq!(second.count, 2);

        let third = replace_all_chunk(&mut buf, &mut undo, &mut progress, "foo", "bar", false, false, false, 2);
        assert!(third.done);
        assert_eq!(third.count, 3);
        assert_eq!(buf.line(0), "bar bar bar");
        assert!(undo.undo(&mut buf).is_some());
        assert_eq!(buf.line(0), "Foo foo FOO");
    }
}

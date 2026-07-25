// 前方/後方検索のスキャンエンジン。文書モデル (Doc) からは独立し、
// TextBuffer と位置だけを扱う。チャンク分割 (budget) の制御もここが持つ。
use crate::buffer::{Pos, TextBuffer};
use crate::doc::FindCursor;
fn line_match(buf: &TextBuffer, pat: &str, line: usize, col_from: usize, match_case: bool) -> Option<(Pos, Pos)> {
    find_in_line(&buf.line(line), pat, col_from, match_case)
        .map(|i| (Pos { line, col: i }, Pos { line, col: i + pat.len() }))
}

fn bytes_eq(a: &[u8], b: &[u8], case: bool) -> bool {
    a.len() == b.len()
        && if case {
            a == b
        } else {
            a.iter().zip(b).all(|(x, y)| x.eq_ignore_ascii_case(y))
        }
}

// 改行を含むパターンについて、行 l を開始行とする一致があるかどうか (位置フィルタなし)。
// segs[0] は行 l の末尾に一致する必要がある(\n の直前で終わるため)。
fn multiline_match_at(buf: &TextBuffer, segs: &[&str], l: usize, match_case: bool) -> Option<(Pos, Pos)> {
    let n = buf.line_count();
    let m = segs.len();
    if l + m > n {
        return None;
    }
    let first = buf.line(l);
    let s0 = segs[0];
    if first.len() < s0.len() {
        return None;
    }
    let col0 = first.len() - s0.len();
    if !first.is_char_boundary(col0) || !bytes_eq(&first.as_bytes()[col0..], s0.as_bytes(), match_case) {
        return None;
    }
    for (k, segment) in segs.iter().enumerate().take(m - 1).skip(1) {
        if !bytes_eq(buf.line(l + k).as_bytes(), segment.as_bytes(), match_case) {
            return None;
        }
    }
    let last = buf.line(l + m - 1);
    let sl = segs[m - 1];
    if last.len() < sl.len() || !bytes_eq(&last.as_bytes()[..sl.len()], sl.as_bytes(), match_case) {
        return None;
    }
    Some((Pos { line: l, col: col0 }, Pos { line: l + m - 1, col: sl.len() }))
}

// ---- 後方検索 (前へ / Shift+Enter): 対話的な利用頻度が低いため従来通り単発フルスキャン ----
pub(crate) fn find_backward(
    buf: &TextBuffer,
    pat: &str,
    start: Pos,
    match_case: bool,
    wrap_around: bool,
) -> Option<(Pos, Pos)> {
    if pat.contains('\n') {
        let segs: Vec<&str> = pat.split('\n').collect();
        return multiline_backward(buf, &segs, start, match_case, wrap_around);
    }
    let n = buf.line_count();
    let scan = |line: usize, limit: usize| -> Option<usize> {
        let text = buf.line(line);
        let mut last = None;
        let mut from = 0;
        while let Some(i) = find_in_line(&text, pat, from, match_case) {
            if i + pat.len() > limit {
                break;
            }
            last = Some(i);
            from = i + 1;
            while from < text.len() && !text.is_char_boundary(from) {
                from += 1;
            }
        }
        last
    };
    for line in (0..=start.line).rev() {
        let limit = if line == start.line { start.col } else { buf.line_len(line) };
        if let Some(i) = scan(line, limit) {
            return Some((Pos { line, col: i }, Pos { line, col: i + pat.len() }));
        }
    }
    if wrap_around {
        for line in (start.line..n).rev() {
            let limit = buf.line_len(line);
            if let Some(i) = scan(line, limit) {
                return Some((Pos { line, col: i }, Pos { line, col: i + pat.len() }));
            }
        }
    }
    None
}

fn multiline_backward(
    buf: &TextBuffer,
    segs: &[&str],
    start: Pos,
    match_case: bool,
    wrap_around: bool,
) -> Option<(Pos, Pos)> {
    let n = buf.line_count();
    for l in (0..=start.line).rev() {
        if let Some(r) = multiline_match_at(buf, segs, l, match_case) {
            if r.1.line < start.line || (r.1.line == start.line && r.1.col <= start.col) {
                return Some(r);
            }
        }
    }
    if wrap_around {
        for l in (0..n).rev() {
            if let Some(r) = multiline_match_at(buf, segs, l, match_case) {
                return Some(r);
            }
        }
    }
    None
}

// ---- 前方検索のチャンク分割エンジン (次へ / 全置換で共用) ----
// 1回で最大 budget 行だけ走査し、続きがあれば Continue(次回に渡すカーソル) を返す。
pub(crate) enum ChunkStep {
    Found(Pos, Pos),
    More(FindCursor),
    NotFound,
}

pub(crate) fn find_chunk(
    buf: &TextBuffer,
    pat: &str,
    start: Pos,
    match_case: bool,
    cur: FindCursor,
    budget: usize,
    wrap_around: bool,
) -> ChunkStep {
    let n = buf.line_count();
    if n == 0 {
        return ChunkStep::NotFound;
    }
    let multiline = pat.contains('\n');
    let segs: Vec<&str> = if multiline { pat.split('\n').collect() } else { Vec::new() };

    let hi = if !cur.wrapped { n } else { (start.line + 1).min(n) };
    if cur.line >= hi {
        return if !cur.wrapped && wrap_around {
            find_chunk(buf, pat, start, match_case, FindCursor { wrapped: true, line: 0 }, budget, wrap_around)
        } else {
            ChunkStep::NotFound
        };
    }
    let end_line = cur.line.saturating_add(budget.max(1)).min(hi);

    for line in cur.line..end_line {
        let hit = if multiline {
            multiline_match_at(buf, &segs, line, match_case)
        } else {
            let col_from = if !cur.wrapped && line == start.line { start.col } else { 0 };
            line_match(buf, pat, line, col_from, match_case)
        };
        let Some((s, e)) = hit else { continue };
        // 前方フェーズでは、カーソル位置より前で終わる一致(まだ primary で除外していないもの)は対象外
        if !cur.wrapped && multiline && !(s.line > start.line || s.col >= start.col) {
            continue;
        }
        return ChunkStep::Found(s, e);
    }

    if end_line < hi {
        return ChunkStep::More(FindCursor { wrapped: cur.wrapped, line: end_line });
    }
    if !cur.wrapped && wrap_around {
        find_chunk(buf, pat, start, match_case, FindCursor { wrapped: true, line: 0 }, budget, wrap_around)
    } else {
        ChunkStep::NotFound
    }
}

pub(crate) fn find_in_line(line: &str, pat: &str, from: usize, match_case: bool) -> Option<usize> {
    if from > line.len() {
        return None;
    }
    if match_case {
        return line[from..].find(pat).map(|i| from + i);
    }
    find_ascii_case_insensitive(line, pat, from)
}

// ASCII 大小文字を無視する検索は、末尾不一致時に次の候補へ大きく進める。
// 既存仕様どおり、非 ASCII 文字は大小文字変換しない。
fn find_ascii_case_insensitive(line: &str, pat: &str, from: usize) -> Option<usize> {
    let haystack = line.as_bytes();
    let needle = pat.as_bytes();
    if from > haystack.len()
        || needle.is_empty()
        || haystack.len().saturating_sub(from) < needle.len()
    {
        return None;
    }

    let mut shift = [needle.len(); 256];
    for (i, &byte) in needle[..needle.len() - 1].iter().enumerate() {
        shift[byte.to_ascii_lowercase() as usize] = needle.len() - 1 - i;
    }

    let mut pos = from;
    while pos <= haystack.len() - needle.len() {
        let mut j = needle.len();
        while j > 0
            && haystack[pos + j - 1].eq_ignore_ascii_case(&needle[j - 1])
        {
            j -= 1;
        }
        if j == 0 {
            if line.is_char_boundary(pos) {
                return Some(pos);
            }
            pos += 1;
        } else {
            pos += shift[haystack[pos + needle.len() - 1].to_ascii_lowercase() as usize];
        }
    }
    None
}


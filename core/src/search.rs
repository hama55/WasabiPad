// 前方/後方検索のスキャンエンジン。文書モデル (Doc) からは独立し、
// TextBuffer と位置だけを扱う。チャンク分割 (budget) の制御もここが持つ。
//
// 「何に当たるか」の定義 (build_matcher) はここが単一の持ち主で、フォルダ検索
// (workspace_search) も同じものを使う。両者が別々に当て方を持つと、同じ語を
// 探したのに片方でしか出ない、という説明できない差になる。
use crate::buffer::{Pos, TextBuffer};
use crate::doc::FindCursor;
use grep_matcher::Matcher;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};

pub(crate) const MAX_FIND_HIGHLIGHTS: usize = 2_000;

// use_regex=false でも grep-regex を通すのは、大小文字無視を ASCII だけに
// 閉じないため。素の文字列比較だと Ａ と ａ のような全角/合成文字が当たらない。
pub(crate) fn build_matcher(
    pat: &str,
    match_case: bool,
    use_regex: bool,
    whole_word: bool,
) -> Result<RegexMatcher, String> {
    RegexMatcherBuilder::new()
        .case_insensitive(!match_case)
        .word(whole_word)
        .fixed_strings(!use_regex)
        .line_terminator(Some(b'\n'))
        .build(pat)
        .map_err(|error| format!("検索パターンが不正: {error}"))
}

// 1行の中で from 以降の最初の一致 (バイト位置の [開始, 終了))。
// 終端を pat.len() で決めないのは、大小文字を畳んだ一致では
// 一致した実文字列の長さがパターンと変わりうるため。
fn find_from(matcher: &RegexMatcher, line: &str, from: usize) -> Option<(usize, usize)> {
    if from > line.len() {
        return None;
    }
    let found = matcher.find_at(line.as_bytes(), from).ok().flatten()?;
    Some((found.start(), found.end()))
}

fn line_match(buf: &TextBuffer, matcher: &RegexMatcher, line: usize, col_from: usize) -> Option<(Pos, Pos)> {
    find_from(matcher, &buf.line(line), col_from)
        .map(|(s, e)| (Pos { line, col: s }, Pos { line, col: e }))
}

pub(crate) fn find_all_in_range(
    buf: &TextBuffer,
    pat: &str,
    first_line: usize,
    last_line: usize,
    match_case: bool,
    use_regex: bool,
    whole_word: bool,
) -> Result<Vec<(Pos, Pos)>, String> {
    if pat.is_empty() || pat.contains('\n') {
        return Ok(Vec::new());
    }
    let matcher = build_matcher(pat, match_case, use_regex, whole_word)?;
    let last = last_line.min(buf.line_count());
    let mut matches = Vec::new();
    for line in first_line.min(last)..last {
        let text = buf.line(line);
        let _ = matcher.find_iter(text.as_bytes(), |found| {
            matches.push((
                Pos { line, col: found.start() },
                Pos { line, col: found.end() },
            ));
            matches.len() < MAX_FIND_HIGHLIGHTS
        });
        if matches.len() == MAX_FIND_HIGHLIGHTS {
            return Ok(matches);
        }
    }
    Ok(matches)
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
    let matcher = build_matcher(pat, match_case, false, false).ok()?;
    let scan = |line: usize, limit: usize| -> Option<(usize, usize)> {
        let text = buf.line(line);
        let mut last = None;
        let mut from = 0;
        while let Some((s, e)) = find_from(&matcher, &text, from) {
            if e > limit {
                break;
            }
            last = Some((s, e));
            from = s + 1;
            while from < text.len() && !text.is_char_boundary(from) {
                from += 1;
            }
        }
        last
    };
    for line in (0..=start.line).rev() {
        let limit = if line == start.line { start.col } else { buf.line_len(line) };
        if let Some((s, e)) = scan(line, limit) {
            return Some((Pos { line, col: s }, Pos { line, col: e }));
        }
    }
    if wrap_around {
        for line in (start.line..n).rev() {
            let limit = buf.line_len(line);
            if let Some((s, e)) = scan(line, limit) {
                return Some((Pos { line, col: s }, Pos { line, col: e }));
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
    // 複数行パターンは検索欄から入力できない (input に改行は打てない) ため、
    // matcher を通さず従来のバイト比較のまま残す
    let matcher = if multiline {
        None
    } else {
        match build_matcher(pat, match_case, false, false) {
            Ok(matcher) => Some(matcher),
            Err(_) => return ChunkStep::NotFound,
        }
    };

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
        let hit = match &matcher {
            Some(matcher) => {
                let col_from = if !cur.wrapped && line == start.line { start.col } else { 0 };
                line_match(buf, matcher, line, col_from)
            }
            None => multiline_match_at(buf, &segs, line, match_case),
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



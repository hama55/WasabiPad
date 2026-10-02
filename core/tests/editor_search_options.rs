use wasabipad_core::{Doc, FindOutcome, PosC};

fn p(line: usize, col: usize) -> PosC { PosC { line, col } }

#[test]
fn next_skips_empty_match_adjacent_to_nonempty_match_like_listing() {
    // Given: 非空一致と隣接する空一致を持つ本文
    let mut doc = Doc::empty();
    doc.edit(p(0, 0), p(0, 0), p(0, 0), "ab", false).unwrap();
    // When: 一覧と次へを同じ条件で検索する
    let all = doc.find_all_in_range("a*", 0, 1, true, true, false, 0).unwrap();
    let next = doc.find_with_options("a*", p(0, 1), true, true, true, false).unwrap().unwrap();
    // Then: 次へも一覧の2件目を選ぶ
    assert_eq!(all.len(), 2);
    assert_eq!(next.start.col, all[1].start.col);
}

#[test]
fn regex_replacement_collection_yields_before_editing_large_document() {
    // Given: 走査予算を超える行数の本文
    let mut doc = Doc::empty();
    doc.edit(p(0, 0), p(0, 0), p(0, 0), &"a\n".repeat(20_001), false).unwrap();
    // When: 全置換の最初のチャンクを実行する
    let first = doc.replace_all_chunk_with_options("a", "b", true, true, false, 1).unwrap();
    // Then: 編集前に戻り、取消しても本文を維持する
    assert!(!first.done);
    assert_eq!(first.count, 0);
    doc.replace_all_cancel();
    assert_eq!(doc.lines(0, 1), vec!["a"]);
}

#[test]
fn editor_navigation_and_listing_share_regex_and_word_conditions() {
    // Feature: エディタ検索条件の統一
    // Scenario: 次・前・一覧が正規表現と単語単位で同じ範囲に一致する
    // Given: 未保存の日本語と英単語の本文
    let mut doc = Doc::empty();
    doc.edit(p(0, 0), p(0, 0), p(0, 0), "猫 foo12 foobar foo34", false).unwrap();
    // When: fooと数字を単語単位で検索する
    let all = doc.find_all_in_range(r"foo\d+", 0, 1, true, true, true, 0).unwrap();
    let next = doc.find_step_with_options(r"foo\d+", p(0, 0), true, true, true, None, 1).unwrap();
    let previous = doc.find_with_options(r"foo\d+", p(0, 20), false, true, true, true).unwrap().unwrap();
    // Then: 一覧の先頭と末尾が次・前の結果に一致する
    assert_eq!(all.len(), 2);
    assert!(matches!(next, FindOutcome::Found { start, end } if (start.line, start.col, end.line, end.col) == (0, 2, 0, 7)));
    assert_eq!((previous.start.line, previous.start.col), (0, 15));
    assert_eq!((previous.end.line, previous.end.col), (0, 20));
}

#[test]
fn regex_replacement_uses_original_matches_and_undoes_in_one_step() {
    // Feature: 正規表現での全置換
    // Scenario: ゼロ幅一致を含む全置換が完了し、キャプチャ参照は文字として挿入する
    // Given: 未保存の2行の本文
    let mut doc = Doc::empty();
    doc.edit(p(0, 0), p(0, 0), p(0, 0), "ab\n猫", false).unwrap();
    // When: 各行の末尾を1件ずつ置換する
    let mut count = 0;
    for _ in 0..4 {
        let result = doc.replace_all_chunk_with_options("$", "$1", true, true, false, 1).unwrap();
        count = result.count;
        if result.done { break; }
    }
    // Then: 2件で完了し、1回のUndoで元に戻る
    assert_eq!(count, 2);
    assert_eq!(doc.lines(0, 2), vec!["ab$1", "猫$1"]);
    doc.undo().unwrap();
    assert_eq!(doc.lines(0, 2), vec!["ab", "猫"]);
}

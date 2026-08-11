// 開いた時点の本文を基準にした行単位の3-wayマージ。
// 競合時はWasabiPad側を採用し、外部側の変更はプレビューに残す。
use crate::document_types::{ExternalMergeChange, ExternalMergePreview};

#[derive(Clone, Debug, PartialEq, Eq)]
struct Change {
    start: usize,
    end: usize,
    replacement: Vec<String>,
}

pub(crate) struct MergeResult {
    pub(crate) merged: Vec<String>,
    pub(crate) preview: ExternalMergePreview,
}

const MAX_LCS_CELLS: usize = 2_000_000;

fn diff_changes(base: &[String], variant: &[String]) -> Vec<Change> {
    let Some(cells) = (base.len() + 1).checked_mul(variant.len() + 1) else {
        return vec![whole_change(base, variant)];
    };
    if cells > MAX_LCS_CELLS {
        return vec![whole_change(base, variant)];
    }

    let mut lcs = vec![vec![0usize; variant.len() + 1]; base.len() + 1];
    for i in (0..base.len()).rev() {
        for j in (0..variant.len()).rev() {
            lcs[i][j] = if base[i] == variant[j] {
                lcs[i + 1][j + 1] + 1
            } else {
                lcs[i + 1][j].max(lcs[i][j + 1])
            };
        }
    }

    let mut changes = Vec::new();
    let mut active: Option<Change> = None;
    let mut i = 0;
    let mut j = 0;
    while i < base.len() || j < variant.len() {
        if i < base.len() && j < variant.len() && base[i] == variant[j] {
            if let Some(change) = active.take() {
                changes.push(change);
            }
            i += 1;
            j += 1;
        } else if j == variant.len()
            || (i < base.len() && lcs[i + 1][j] >= lcs[i][j + 1])
        {
            let change = active.get_or_insert_with(|| Change {
                start: i,
                end: i,
                replacement: Vec::new(),
            });
            change.end = i + 1;
            i += 1;
        } else {
            let change = active.get_or_insert_with(|| Change {
                start: i,
                end: i,
                replacement: Vec::new(),
            });
            change.replacement.push(variant[j].clone());
            j += 1;
        }
    }
    if let Some(change) = active {
        changes.push(change);
    }
    changes
}

fn whole_change(base: &[String], variant: &[String]) -> Change {
    Change {
        start: 0,
        end: base.len(),
        replacement: variant.to_vec(),
    }
}

fn changes_overlap(a: &Change, b: &Change) -> bool {
    if a.start == a.end && b.start == b.end {
        return a.start == b.start;
    }
    if a.start == a.end {
        return a.start > b.start && a.start < b.end;
    }
    if b.start == b.end {
        return b.start > a.start && b.start < a.end;
    }
    a.start < b.end && b.start < a.end
}

fn touches_group(change: &Change, start: usize, end: usize) -> bool {
    if change.start == change.end {
        return change.start >= start && change.start <= end;
    }
    change.start < end && start < change.end
}

fn value_for_range(
    base: &[String],
    changes: &[Change],
    start: usize,
    end: usize,
) -> Vec<String> {
    let mut value = Vec::new();
    let mut base_pos = start;
    for change in changes {
        if change.start > base_pos {
            value.extend_from_slice(&base[base_pos..change.start.min(end)]);
        }
        value.extend(change.replacement.iter().cloned());
        base_pos = base_pos.max(change.end);
    }
    if base_pos < end {
        value.extend_from_slice(&base[base_pos..end]);
    }
    value
}

fn append_base(merged: &mut Vec<String>, base: &[String], from: usize, to: usize) {
    if from < to {
        merged.extend_from_slice(&base[from..to]);
    }
}

fn add_preview(
    preview: &mut ExternalMergePreview,
    base: &[String],
    start: usize,
    end: usize,
    mine: Vec<String>,
    theirs: Vec<String>,
    conflict: bool,
) {
    let original = &base[start..end];
    if !conflict && theirs == original {
        return;
    }
    if mine == theirs {
        return;
    }
    if conflict {
        preview.conflict_count += 1;
    }
    preview.changes.push(ExternalMergeChange {
        start_line: start + 1,
        mine,
        theirs,
        conflict,
    });
}

pub(crate) fn three_way(base: &[String], mine: &[String], theirs: &[String]) -> MergeResult {
    let mine_changes = diff_changes(base, mine);
    let theirs_changes = diff_changes(base, theirs);
    let mut merged = Vec::new();
    let mut preview = ExternalMergePreview {
        changes: Vec::new(),
        conflict_count: 0,
        modified_at: None,
    };
    let mut mine_index = 0;
    let mut theirs_index = 0;
    let mut base_pos = 0;

    while mine_index < mine_changes.len() || theirs_index < theirs_changes.len() {
        let Some(mine_change) = mine_changes.get(mine_index) else {
            let theirs_change = &theirs_changes[theirs_index];
            append_base(&mut merged, base, base_pos, theirs_change.start);
            merged.extend(theirs_change.replacement.iter().cloned());
            add_preview(
                &mut preview,
                base,
                theirs_change.start,
                theirs_change.end,
                base[theirs_change.start..theirs_change.end].to_vec(),
                theirs_change.replacement.clone(),
                false,
            );
            base_pos = theirs_change.end;
            theirs_index += 1;
            continue;
        };
        let Some(theirs_change) = theirs_changes.get(theirs_index) else {
            append_base(&mut merged, base, base_pos, mine_change.start);
            merged.extend(mine_change.replacement.iter().cloned());
            base_pos = mine_change.end;
            mine_index += 1;
            continue;
        };

        if !changes_overlap(mine_change, theirs_change) {
            if mine_change.start < theirs_change.start
                || (mine_change.start == theirs_change.start && mine_change.start == mine_change.end)
            {
                append_base(&mut merged, base, base_pos, mine_change.start);
                merged.extend(mine_change.replacement.iter().cloned());
                base_pos = mine_change.end;
                mine_index += 1;
            } else {
                append_base(&mut merged, base, base_pos, theirs_change.start);
                merged.extend(theirs_change.replacement.iter().cloned());
                add_preview(
                    &mut preview,
                    base,
                    theirs_change.start,
                    theirs_change.end,
                    base[theirs_change.start..theirs_change.end].to_vec(),
                    theirs_change.replacement.clone(),
                    false,
                );
                base_pos = theirs_change.end;
                theirs_index += 1;
            }
            continue;
        }

        let group_start = mine_change.start.min(theirs_change.start);
        let mut group_end = mine_change.end.max(theirs_change.end);
        let mine_start = mine_index;
        let theirs_start = theirs_index;
        loop {
            let mut expanded = false;
            while let Some(change) = mine_changes.get(mine_index) {
                if !touches_group(change, group_start, group_end) {
                    break;
                }
                group_end = group_end.max(change.end);
                mine_index += 1;
                expanded = true;
            }
            while let Some(change) = theirs_changes.get(theirs_index) {
                if !touches_group(change, group_start, group_end) {
                    break;
                }
                group_end = group_end.max(change.end);
                theirs_index += 1;
                expanded = true;
            }
            if !expanded {
                break;
            }
        }

        let mine_value = value_for_range(
            base,
            &mine_changes[mine_start..mine_index],
            group_start,
            group_end,
        );
        let theirs_value = value_for_range(
            base,
            &theirs_changes[theirs_start..theirs_index],
            group_start,
            group_end,
        );
        append_base(&mut merged, base, base_pos, group_start);
        merged.extend(mine_value.iter().cloned());
        add_preview(
            &mut preview,
            base,
            group_start,
            group_end,
            mine_value,
            theirs_value,
            true,
        );
        base_pos = group_end;
    }
    append_base(&mut merged, base, base_pos, base.len());

    MergeResult { merged, preview }
}

#[cfg(test)]
mod tests {
    use super::three_way;

    fn lines(text: &str) -> Vec<String> {
        text.lines().map(str::to_string).collect()
    }

    // Feature: 外部変更の3-wayマージ
    // Scenario: 自分と外部が別の行を変更する
    // Given: 開いた時点の本文と、自分側/外部側の別行変更
    // When: three_wayを呼ぶ
    // Then: 両方の変更を取り込む
    #[test]
    fn merges_non_overlapping_changes() {
        let result = three_way(
            &lines("a\nb\nc"),
            &lines("a\n私のb\nc"),
            &lines("a\nb\n外部のc"),
        );

        assert_eq!(result.merged, lines("a\n私のb\n外部のc"));
        assert_eq!(result.preview.changes.len(), 1);
        assert_eq!(result.preview.conflict_count, 0);
    }

    // Feature: 外部変更の3-wayマージ
    // Scenario: 同じ行を双方が変更する
    // Given: 開いた時点の本文と、同じ行への異なる変更
    // When: three_wayを呼ぶ
    // Then: 自分側を残し、競合を1件返す
    #[test]
    fn keeps_mine_on_conflict() {
        let result = three_way(
            &lines("a\nb\nc"),
            &lines("a\n私のb\nc"),
            &lines("a\n外部のb\nc"),
        );

        assert_eq!(result.merged, lines("a\n私のb\nc"));
        assert_eq!(result.preview.conflict_count, 1);
        assert!(result.preview.changes[0].conflict);
    }

    // Feature: 外部変更のプレビュー
    // Scenario: 自分だけが変更した行がある
    // Given: 外部側は基準本文のまま、自分側だけが変更
    // When: three_wayを呼ぶ
    // Then: 外部変更としては表示しない
    #[test]
    fn hides_mine_only_changes_from_external_preview() {
        let result = three_way(
            &lines("a\nb"),
            &lines("私のa\nb"),
            &lines("a\nb"),
        );

        assert_eq!(result.merged, lines("私のa\nb"));
        assert!(result.preview.changes.is_empty());
    }

    // Feature: 外部変更の3-wayマージ
    // Scenario: 自分が行を挿入し、外部が直後の元行を変更する
    // Given: 同じ基準行の境界にある独立した変更
    // When: three_wayを呼ぶ
    // Then: 挿入と外部変更の両方を残す
    #[test]
    fn keeps_boundary_insert_and_external_edit_separate() {
        let result = three_way(
            &lines("a\nb\nc"),
            &lines("a\n自分の追加\nb\nc"),
            &lines("a\n外部のb\nc"),
        );

        assert_eq!(result.merged, lines("a\n自分の追加\n外部のb\nc"));
        assert_eq!(result.preview.conflict_count, 0);
    }
}

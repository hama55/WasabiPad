// ファイル名のファジー一致。VSCode の fuzzyScore と同じ狙い
// (DP + 先頭優先 + 区切り/camelCase 境界の加点) を整数スコアで実装する。
//
// なぜ DP か: 「wsopt」が "workspace-search-options.ts" に当たってほしい一方、
// どこで当てるかによって良し悪しが変わる。貪欲に前から取ると
// 区切り直後の頭文字を拾い損ねるため、全配置を評価して最良を選ぶ。

const SCORE_MIN: i32 = i32::MIN / 2;
// 飛ばした文字の減点。先頭側を軽くしすぎると後方の一致が勝ってしまう
const SCORE_GAP_LEADING: i32 = -5;
const SCORE_GAP_TRAILING: i32 = -5;
const SCORE_GAP_INNER: i32 = -10;
// 直前の文字が何かで「単語の頭らしさ」を測る
const SCORE_MATCH_CONSECUTIVE: i32 = 100;
const SCORE_MATCH_SLASH: i32 = 90;
const SCORE_MATCH_WORD: i32 = 80;
const SCORE_MATCH_CAPITAL: i32 = 70;
const SCORE_MATCH_DOT: i32 = 60;
// ファイル名で当たったほうを常に優先する (VSCode がラベルをパスより重く見るのと同じ)
const SCORE_IN_FILE_NAME: i32 = 10_000;
// 長すぎるパスで DP が膨らまないようにする。Windows の MAX_PATH に余裕を足した値
const MAX_WORD_CHARS: usize = 512;
const MAX_PATTERN_CHARS: usize = 64;

pub struct FuzzyMatch {
    pub score: i32,
    pub positions: Vec<usize>, // 対象文字列の char index (昇順)
}

fn fold(c: char) -> char {
    c.to_lowercase().next().unwrap_or(c)
}

// 直前の文字から決まる、その位置で一致したときの加点
fn boundary_bonus(prev: char, current: char) -> i32 {
    match prev {
        '/' | '\\' => SCORE_MATCH_SLASH,
        '_' | '-' | ' ' => SCORE_MATCH_WORD,
        '.' => SCORE_MATCH_DOT,
        _ if prev.is_lowercase() && current.is_uppercase() => SCORE_MATCH_CAPITAL,
        _ => 0,
    }
}

fn bonuses(word: &[char]) -> Vec<i32> {
    let mut prev = '/'; // 先頭は区切りの直後とみなす
    word.iter()
        .map(|&c| {
            let bonus = boundary_bonus(prev, c);
            prev = c;
            bonus
        })
        .collect()
}

// 順序を保って全文字が現れるか。ここで落ちる候補が大半なので DP の前に済ませる
fn is_subsequence(pattern: &[char], word: &[char]) -> bool {
    let mut chars = word.iter();
    pattern.iter().all(|&p| chars.any(|&w| fold(w) == fold(p)))
}

/// pattern が word に順序を保って含まれるなら、最良の配置とそのスコアを返す。
pub fn fuzzy_match(pattern: &str, word: &str) -> Option<FuzzyMatch> {
    let pat: Vec<char> = pattern.chars().filter(|c| !c.is_whitespace()).collect();
    let target: Vec<char> = word.chars().collect();
    if pat.is_empty()
        || pat.len() > target.len()
        || pat.len() > MAX_PATTERN_CHARS
        || target.len() > MAX_WORD_CHARS
        || !is_subsequence(&pat, &target)
    {
        return None;
    }

    let (rows, cols) = (pat.len(), target.len());
    let bonus = bonuses(&target);
    // ends: その位置で一致して終わる最良スコア / best: その位置までの最良スコア
    let mut ends = vec![SCORE_MIN; rows * cols];
    let mut best = vec![SCORE_MIN; rows * cols];

    for i in 0..rows {
        let gap = if i == rows - 1 { SCORE_GAP_TRAILING } else { SCORE_GAP_INNER };
        let mut carried = SCORE_MIN;
        for j in 0..cols {
            let at = i * cols + j;
            if fold(pat[i]) == fold(target[j]) {
                let score = if i == 0 {
                    (j as i32) * SCORE_GAP_LEADING + bonus[j]
                } else if j == 0 {
                    SCORE_MIN
                } else {
                    let prev = (i - 1) * cols + (j - 1);
                    (best[prev].saturating_add(bonus[j]))
                        .max(ends[prev].saturating_add(SCORE_MATCH_CONSECUTIVE))
                };
                ends[at] = score;
                carried = score.max(carried.saturating_add(gap));
            } else {
                carried = carried.saturating_add(gap);
            }
            best[at] = carried;
        }
    }

    Some(FuzzyMatch {
        score: best[rows * cols - 1],
        positions: backtrack(&ends, &best, rows, cols),
    })
}

// 末尾から、そのマスで一致を使ったかどうかを辿って配置を復元する
fn backtrack(ends: &[i32], best: &[i32], rows: usize, cols: usize) -> Vec<usize> {
    let mut positions = vec![0; rows];
    let mut j = cols;
    let mut must_match = false;
    for i in (0..rows).rev() {
        while j > 0 {
            j -= 1;
            let at = i * cols + j;
            if ends[at] == SCORE_MIN || !(must_match || ends[at] == best[at]) {
                continue;
            }
            // 直前の文字と連続していたなら、そこも一致でなければ辻褄が合わない
            must_match = i > 0
                && j > 0
                && ends[at] == ends[(i - 1) * cols + (j - 1)].saturating_add(SCORE_MATCH_CONSECUTIVE);
            positions[i] = j;
            break;
        }
    }
    positions
}

/// 相対パスに対する一致。ファイル名だけで当たるならそちらを優先し、
/// 位置は常に rel_path 上の char index で返す。
pub fn match_path(pattern: &str, rel_path: &str) -> Option<FuzzyMatch> {
    let name_start = rel_path.chars().count() - rel_path.rsplit('/').next().unwrap_or("").chars().count();
    if let Some(found) = fuzzy_match(pattern, &rel_path.chars().skip(name_start).collect::<String>()) {
        return Some(FuzzyMatch {
            score: found.score.saturating_add(SCORE_IN_FILE_NAME),
            positions: found.positions.iter().map(|at| at + name_start).collect(),
        });
    }
    // 長いパスは、順序さえ合えば文字が散らばっていてもいつかは当たってしまう
    // ("@rtk" が ".../openxr@ef0033a586bf/Runtime/MockRuntime.meta" に当たる)。
    // 飛ばした分の減点が加点を上回ったもの = 当たったより飛ばしたほうが多い
    // 一致なので、偶然として捨てる。フォルダを跨ぐ意図的な指定 ("ui/sidebar",
    // "srcmain") は隙間が小さく、実測でも正の側に十分な差で残る。
    fuzzy_match(pattern, rel_path).filter(|found| found.score >= 0)
}

/// 隣接する位置をまとめて [開始, 長さ] の並びにする (強調表示用)。
pub fn to_ranges(positions: &[usize]) -> Vec<[usize; 2]> {
    let mut ranges: Vec<[usize; 2]> = Vec::new();
    for &at in positions {
        match ranges.last_mut() {
            Some(last) if last[0] + last[1] == at => last[1] += 1,
            _ => ranges.push([at, 1]),
        }
    }
    ranges
}

#[cfg(test)]
mod tests {
    use super::{fuzzy_match, match_path, to_ranges};

    fn positions(pattern: &str, word: &str) -> Vec<usize> {
        fuzzy_match(pattern, word).expect("一致するはず").positions
    }

    #[test]
    fn picks_word_heads_over_the_earliest_placement() {
        // 貪欲に前から取ると "w-o-r-k" の o を拾ってしまう
        assert_eq!(positions("wso", "workspace-search-options.ts"), vec![0, 10, 17]);
        assert_eq!(positions("wsopt", "workspace-search-options.ts"), vec![0, 10, 17, 18, 19]);
    }

    #[test]
    fn matches_camel_case_initials() {
        assert_eq!(positions("dc", "DocumentController.ts"), vec![0, 8]);
    }

    #[test]
    fn order_must_be_kept_and_missing_chars_fail() {
        assert!(fuzzy_match("cba", "abc").is_none());
        assert!(fuzzy_match("abcd", "abc").is_none());
        assert!(fuzzy_match("", "abc").is_none());
    }

    #[test]
    fn contiguous_and_leading_matches_score_higher() {
        let exact = fuzzy_match("main", "main.ts").unwrap().score;
        let scattered = fuzzy_match("main", "my-application-inner.ts").unwrap().score;
        let late = fuzzy_match("main", "src/deep/main.ts").unwrap().score;
        assert!(exact > scattered, "連続かつ先頭の一致が強い");
        assert!(exact > late, "先頭に近いほうが強い");
    }

    #[test]
    fn file_name_matches_beat_path_matches() {
        let in_name = match_path("side", "ui/sidebar.ts").unwrap();
        let in_path = match_path("uisi", "ui/sidebar.ts").unwrap();
        assert!(in_name.score > in_path.score);
        assert_eq!(in_name.positions, vec![3, 4, 5, 6], "位置は rel_path 基準");
    }

    // 長いパスほど「順序さえ合えば当たる」ので、偶然の散らばりを落とす必要がある。
    // 落とす境目は連続性ではない (連続を求めると wsopt が当たらなくなる)。
    #[test]
    fn scattered_path_matches_are_dropped_but_deliberate_ones_survive() {
        let noise = "Library/PackageCache/com.unity.xr.openxr@ef0033a586bf/Runtime/MockRuntime.meta";
        assert!(match_path("@rtk", noise).is_none(), "@,r,t,k が順に出るだけの偶然");
        assert!(match_path("main", noise).is_none());
        assert!(match_path("mockruntime", noise).is_some(), "ファイル名そのものは当たる");
        assert!(match_path("xropenxr", noise).is_some(), "フォルダ名を跨ぐ指定は残る");

        assert!(match_path("ui/sidebar", "ui/sidebar.ts").is_some());
        assert!(match_path("srcmain", "src-tauri/src/main.rs").is_some());
        // ファイル名の中で散らばる分は落とさない (ファジー一致の本来の使い道)
        assert!(match_path("wsopt", "ui/workspace-search-options.ts").is_some());
    }

    #[test]
    fn adjacent_positions_merge_into_one_range() {
        assert_eq!(to_ranges(&[0, 1, 2, 5, 7, 8]), vec![[0, 3], [5, 1], [7, 2]]);
        assert_eq!(to_ranges(&[]), Vec::<[usize; 2]>::new());
    }
}

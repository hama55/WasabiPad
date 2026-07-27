// フォルダ全体の検索。本文は ripgrep のエンジン (ignore + grep-*) を
// ライブラリとして使い、ファイル名は fuzzy の DP スコアで当てる。
//
// 外部 rg.exe を同梱せずクレートを組み込むのは、配布物を1つに保ちたいのと、
// 検索条件を JSON へ組み立て直さずそのまま渡せるため。
use crate::doc::WorkspaceSearchResult;
use crate::fuzzy::{match_path, to_ranges};
use grep_matcher::Matcher;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder, Sink, SinkMatch};
use ignore::overrides::OverrideBuilder;
use ignore::{WalkBuilder, WalkState};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;

// 検索の打ち切り条件はすべて利用者が決める。ここに既定値は持たない
// (既定値は UI 側の設定ダイアログが単一の定義を持つ)。
// 各上限の 0 は「無制限」。利用者が明示的に上限を入れない限り勝手に省略しない。
#[derive(Clone, serde::Deserialize)]
pub struct SearchOptions {
    pub match_case: bool,
    pub use_regex: bool,
    pub whole_word: bool,
    pub max_file_bytes: u64,
    pub max_files: usize,
    pub max_results: usize,
    pub exclude_dirs: Vec<String>,
    pub exclude_globs: Vec<String>,
    pub exclude_binary: bool,
    pub respect_gitignore: bool,
    pub search_file_names: bool,
    pub search_contents: bool,
    // 0 は「CPUに任せる」。実際の並列数は clamp_workers が決める
    pub workers: usize,
}

// 打ち切りや条件エラーを結果と一緒に返す。件数だけ見せて理由を隠すと
// 「あるはずのものが出ない」検索になり、利用者が原因を追えなくなる。
#[derive(Default, serde::Serialize)]
pub struct WorkspaceSearchOutcome {
    pub results: Vec<WorkspaceSearchResult>,
    pub scanned_files: usize,
    pub hit_file_limit: bool,
    pub hit_result_limit: bool,
    pub pattern_error: Option<String>,
}

// 一致が行頭から遠いと preview から外れてしまうため、手前に残す文字数
const PREVIEW_LEAD_CHARS: usize = 40;
const PREVIEW_CHARS: usize = 180;
// バイナリ判定と文字コード判定に読む先頭バイト数
const PROBE_BYTES: usize = 8 * 1024;
const NAME_PREFIX: &str = "ファイル名: ";

// 並び順のグループ。同じファイル内ではファイル名一致を先に置く
const KIND_NAME: u8 = 0;
const KIND_CONTENT: u8 = 1;

type ScoredHit = (u8, i32, WorkspaceSearchResult);

// 0 は無制限。以降の比較をすべて飽和値で書けるようにする
fn limit(value: usize) -> usize {
    if value == 0 { usize::MAX } else { value }
}

// 0=自動。上限は論理コア数で、それを超える指定は意味がないので切り詰める
fn clamp_workers(requested: usize) -> usize {
    let cores = std::thread::available_parallelism().map_or(1, |count| count.get());
    if requested == 0 {
        cores.min(8)
    } else {
        requested.min(cores).max(1)
    }
}

pub fn search_workspace(
    root: &Path,
    pattern: &str,
    options: &SearchOptions,
    cancel: &AtomicBool,
) -> WorkspaceSearchOutcome {
    if pattern.is_empty() || (!options.search_file_names && !options.search_contents) {
        return WorkspaceSearchOutcome::default();
    }
    let matcher = match build_matcher(pattern, options) {
        Ok(matcher) => matcher,
        Err(message) => {
            return WorkspaceSearchOutcome { pattern_error: Some(message), ..Default::default() }
        }
    };
    let walk = match build_walk(root, options) {
        Ok(walk) => walk,
        Err(message) => {
            return WorkspaceSearchOutcome { pattern_error: Some(message), ..Default::default() }
        }
    };

    let max_files = limit(options.max_files);
    let max_results = limit(options.max_results);
    let shared_results: Mutex<Vec<ScoredHit>> = Mutex::new(Vec::new());
    let shared_scanned = AtomicUsize::new(0);
    let shared_file_limit = AtomicBool::new(false);
    let shared_result_limit = AtomicBool::new(false);
    // 走査スレッドへ配るのは参照だけ。&T は Copy なので move クロージャへ渡せる
    let (results, scanned) = (&shared_results, &shared_scanned);
    let (hit_file_limit, hit_result_limit) = (&shared_file_limit, &shared_result_limit);

    walk.build_parallel().run(|| {
        let mut engine = Engine::new(matcher.as_ref());
        Box::new(move |entry| {
            if cancel.load(Ordering::Relaxed) {
                return WalkState::Quit;
            }
            let Ok(entry) = entry else { return WalkState::Continue };
            if !entry.file_type().is_some_and(|kind| kind.is_file()) {
                return WalkState::Continue;
            }
            if scanned.fetch_add(1, Ordering::Relaxed) >= max_files {
                hit_file_limit.store(true, Ordering::Relaxed);
                return WalkState::Quit;
            }
            let relative = relative_path(root, entry.path());
            let found = engine.search_file(entry.path(), &relative, pattern, options, max_results);
            if found.limited {
                hit_result_limit.store(true, Ordering::Relaxed);
            }
            if found.hits.is_empty() {
                return WalkState::Continue;
            }
            let mut output = results.lock().unwrap();
            if output.len() >= max_results {
                hit_result_limit.store(true, Ordering::Relaxed);
                return WalkState::Quit;
            }
            output.extend(found.hits);
            WalkState::Continue
        })
    });

    let mut output = shared_results.into_inner().unwrap();
    sort_hits(&mut output, options);
    let truncated = shared_result_limit.load(Ordering::Relaxed) || output.len() > max_results;
    output.truncate(max_results);
    WorkspaceSearchOutcome {
        results: output.into_iter().map(|(_, _, result)| result).collect(),
        scanned_files: shared_scanned.load(Ordering::Relaxed).min(max_files),
        hit_file_limit: shared_file_limit.load(Ordering::Relaxed),
        hit_result_limit: truncated,
        pattern_error: None,
    }
}

// ファイル名だけを探しているときは、パス順よりスコア順のほうが役に立つ
// (VSCode の Quick Open と同じ狙い)。本文も混ざるならツリーの並びを優先する。
fn sort_hits(hits: &mut [ScoredHit], options: &SearchOptions) {
    if options.search_file_names && !options.search_contents {
        hits.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.2.rel_path.cmp(&b.2.rel_path)));
        return;
    }
    hits.sort_by(|a, b| {
        (&a.2.rel_path, a.0, a.2.line, a.2.col).cmp(&(&b.2.rel_path, b.0, b.2.line, b.2.col))
    });
}

fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

// 本文検索を使わないなら matcher は要らない (正規表現の誤りも問わない)
fn build_matcher(pattern: &str, options: &SearchOptions) -> Result<Option<RegexMatcher>, String> {
    if !options.search_contents {
        return Ok(None);
    }
    RegexMatcherBuilder::new()
        .case_insensitive(!options.match_case)
        .word(options.whole_word)
        .fixed_strings(!options.use_regex)
        .line_terminator(Some(b'\n'))
        .build(pattern)
        .map(Some)
        .map_err(|error| format!("検索パターンが不正: {error}"))
}

fn build_walk(root: &Path, options: &SearchOptions) -> Result<WalkBuilder, String> {
    let mut builder = WalkBuilder::new(root);
    builder
        // 隠しファイルを既定で飛ばすのは「勝手な省略」なので必ず見る
        .hidden(false)
        .parents(options.respect_gitignore)
        .git_ignore(options.respect_gitignore)
        .git_global(options.respect_gitignore)
        .git_exclude(options.respect_gitignore)
        .ignore(options.respect_gitignore)
        .require_git(false)
        .follow_links(false)
        .threads(clamp_workers(options.workers));
    if options.max_file_bytes > 0 {
        builder.max_filesize(Some(options.max_file_bytes));
    }
    if !options.exclude_globs.is_empty() {
        let mut overrides = OverrideBuilder::new(root);
        overrides.case_insensitive(true).map_err(|e| e.to_string())?;
        for glob in &options.exclude_globs {
            // overrides では先頭の "!" が「除外」を意味する (gitignore と逆)
            overrides.add(&format!("!{glob}")).map_err(|e| format!("除外パターンが不正: {e}"))?;
        }
        builder.overrides(overrides.build().map_err(|e| e.to_string())?);
    }
    let excluded: Vec<String> = options.exclude_dirs.iter().map(|dir| dir.to_lowercase()).collect();
    builder.filter_entry(move |entry| {
        // ルート自身は、名前がたまたま除外リストに載っていても対象から外さない
        entry.depth() == 0
            || !entry.file_type().is_some_and(|kind| kind.is_dir())
            || !excluded.contains(&entry.file_name().to_string_lossy().to_lowercase())
    });
    Ok(builder)
}

// 走査スレッドごとの状態。Searcher は行バッファを使い回すので毎回作らない。
struct Engine<'a> {
    matcher: Option<&'a RegexMatcher>,
    utf8: Searcher,
    sjis: Option<Searcher>,
}

impl<'a> Engine<'a> {
    fn new(matcher: Option<&'a RegexMatcher>) -> Self {
        Engine {
            matcher,
            utf8: searcher(None),
            sjis: grep_searcher::Encoding::new("sjis").ok().map(|enc| searcher(Some(enc))),
        }
    }

    fn search_file(
        &mut self,
        path: &Path,
        relative: &str,
        pattern: &str,
        options: &SearchOptions,
        max_results: usize,
    ) -> FileHits {
        let probe = probe_head(path);
        if options.exclude_binary && probe.binary {
            return FileHits::default();
        }
        let mut hits = Vec::new();
        if options.search_file_names {
            if let Some(found) = match_path(pattern, relative) {
                let prefix = NAME_PREFIX.chars().count();
                hits.push((KIND_NAME, found.score, WorkspaceSearchResult {
                    rel_path: relative.to_owned(),
                    line: 0,
                    col: 0,
                    preview: format!("{NAME_PREFIX}{relative}"),
                    highlights: to_ranges(&found.positions)
                        .into_iter()
                        .map(|[at, len]| [at + prefix, len])
                        .collect(),
                    is_filename: true,
                }));
            }
        }
        let Some(matcher) = self.matcher else { return FileHits { hits, limited: false } };
        let searcher = match (probe.sjis, self.sjis.as_mut()) {
            (true, Some(sjis)) => sjis,
            _ => &mut self.utf8,
        };
        let mut collector = Collector { matcher, relative, hits: &mut hits, max_results, limited: false };
        // 読めないファイルは黙って飛ばす (権限や排他はこちらでは直せない)
        let _ = searcher.search_path(matcher, path, &mut collector);
        let limited = collector.limited;
        FileHits { hits, limited }
    }
}

// limited は「このファイルの一致を上限で切った」印。
// 切ったことを持ち帰らないと、件数だけ減って理由が消える。
#[derive(Default)]
struct FileHits {
    hits: Vec<ScoredHit>,
    limited: bool,
}

fn searcher(encoding: Option<grep_searcher::Encoding>) -> Searcher {
    SearcherBuilder::new()
        // NUL が出た時点で本文検索を止める (ripgrep の再帰検索と同じ既定)
        .binary_detection(BinaryDetection::quit(0))
        .line_number(true)
        .encoding(encoding)
        .build()
}

struct Collector<'a> {
    matcher: &'a RegexMatcher,
    relative: &'a str,
    hits: &'a mut Vec<ScoredHit>,
    max_results: usize,
    limited: bool,
}

impl Sink for Collector<'_> {
    type Error = std::io::Error;

    fn matched(&mut self, _searcher: &Searcher, found: &SinkMatch<'_>) -> Result<bool, Self::Error> {
        let line = found.line_number().unwrap_or(1).saturating_sub(1) as usize;
        let text = String::from_utf8_lossy(found.bytes());
        let text = text.trim_end_matches(['\n', '\r']);
        let (matcher, relative, max_results) = (self.matcher, self.relative, self.max_results);
        let hits = &mut *self.hits;
        // 1行に複数一致があれば全部拾う。1件目だけ返すと「あるのに出ない」検索になる
        let _ = matcher.find_iter(text.as_bytes(), |at| {
            let (preview, preview_col) = preview_around(text, at.start());
            let matched_chars = text[at.start()..at.end()].chars().count();
            let shown = matched_chars.min(preview.chars().count().saturating_sub(preview_col));
            hits.push((KIND_CONTENT, 0, WorkspaceSearchResult {
                rel_path: relative.to_owned(),
                line,
                col: text[..at.start()].chars().count(),
                preview,
                highlights: if shown > 0 { vec![[preview_col, shown]] } else { Vec::new() },
                is_filename: false,
            }));
            hits.len() < max_results
        });
        self.limited |= self.hits.len() >= max_results;
        Ok(!self.limited)
    }
}

// インデントを落とし、一致が見える位置から切り出す。
// 返り値の2つめは preview 上での一致開始位置 (char index)。
fn preview_around(text: &str, byte_col: usize) -> (String, usize) {
    let indent = text.len() - text.trim_start().len();
    let body = &text[indent.min(byte_col)..];
    let offset = byte_col - indent.min(byte_col);
    let before = body[..offset.min(body.len())].chars().count();
    let skip = before.saturating_sub(PREVIEW_LEAD_CHARS);
    let head = if skip > 0 { "…" } else { "" };
    let shown: String = body.chars().skip(skip).take(PREVIEW_CHARS).collect();
    (format!("{head}{shown}"), before - skip + head.chars().count())
}

struct Probe {
    binary: bool,
    sjis: bool,
}

// 先頭だけを覗いて、バイナリかどうかと Shift-JIS 扱いが要るかを決める。
// grep-searcher は BOM 付き (UTF-8 / UTF-16) を自前で解くので、そこは触らない。
fn probe_head(path: &Path) -> Probe {
    use std::io::Read;
    let mut head = [0u8; PROBE_BYTES];
    let read = std::fs::File::open(path)
        .and_then(|mut file| file.read(&mut head))
        .unwrap_or(0);
    let head = &head[..read];
    if head.starts_with(&[0xFF, 0xFE]) || head.starts_with(&[0xFE, 0xFF]) {
        return Probe { binary: false, sjis: false };
    }
    Probe {
        binary: head.contains(&0),
        // 末尾で多バイト文字が切れただけなら UTF-8 のまま扱う
        sjis: std::str::from_utf8(head).is_err_and(|error| error.error_len().is_some()),
    }
}

#[cfg(test)]
mod tests {
    use super::{search_workspace, SearchOptions};
    use std::sync::atomic::AtomicBool;

    fn options() -> SearchOptions {
        SearchOptions {
            match_case: false,
            use_regex: false,
            whole_word: false,
            max_file_bytes: 0,
            max_files: 0,
            max_results: 0,
            exclude_dirs: vec!["skip".into()],
            exclude_globs: Vec::new(),
            exclude_binary: true,
            respect_gitignore: false,
            search_file_names: false,
            search_contents: true,
            workers: 1,
        }
    }

    fn workspace(tag: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("wasabipad_ws_{}_{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("skip")).unwrap();
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("needle.txt"), "one needle\nno match\nneedle and needle\n").unwrap();
        std::fs::write(root.join("sub/plain.txt"), "nothing here\n").unwrap();
        std::fs::write(root.join("skip/hidden.txt"), "needle\n").unwrap();
        std::fs::write(root.join("blob.pyc"), b"\x00\x01needle\x00").unwrap();
        root
    }

    fn places(found: &super::WorkspaceSearchOutcome) -> Vec<(String, usize, usize)> {
        found.results.iter().map(|r| (r.rel_path.clone(), r.line, r.col)).collect()
    }

    #[test]
    fn collects_every_match_on_a_line_and_skips_excluded_dirs() {
        let root = workspace("all");
        let found = search_workspace(&root, "needle", &options(), &AtomicBool::new(false));
        assert_eq!(places(&found), vec![
            ("needle.txt".into(), 0, 4),
            ("needle.txt".into(), 2, 0),
            ("needle.txt".into(), 2, 11),
        ]);
        assert_eq!(found.scanned_files, 3, "skip/ 配下は列挙しない");
        assert!(!found.hit_file_limit && !found.hit_result_limit);
        assert_eq!(found.results[0].preview, "one needle");
        assert_eq!(found.results[0].highlights, vec![[4, 6]]);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn binary_files_are_excluded_only_when_asked() {
        let root = workspace("binary");
        let mut opts = options();
        opts.search_contents = false;
        opts.search_file_names = true;
        assert!(search_workspace(&root, "blob", &opts, &AtomicBool::new(false)).results.is_empty());

        opts.exclude_binary = false;
        let found = search_workspace(&root, "blob", &opts, &AtomicBool::new(false));
        assert_eq!(found.results.len(), 1, "名前一致だけは残る");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn limits_are_reported_instead_of_silently_trimming() {
        let root = workspace("limit");
        let mut opts = options();
        opts.max_results = 2;
        let found = search_workspace(&root, "needle", &opts, &AtomicBool::new(false));
        assert_eq!(found.results.len(), 2);
        assert!(found.hit_result_limit);

        opts.max_results = 0;
        opts.max_files = 1;
        let found = search_workspace(&root, "needle", &opts, &AtomicBool::new(false));
        assert!(found.hit_file_limit);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn regex_and_whole_word_come_from_the_same_engine() {
        let root = workspace("regex");
        let mut opts = options();
        opts.use_regex = true;
        let found = search_workspace(&root, "need(le)+", &opts, &AtomicBool::new(false));
        assert_eq!(found.results.len(), 3);

        // 正規表現が壊れていても落とさず、理由を返す
        let broken = search_workspace(&root, "need(", &opts, &AtomicBool::new(false));
        assert!(broken.pattern_error.is_some() && broken.results.is_empty());

        opts.use_regex = false;
        opts.whole_word = true;
        let found = search_workspace(&root, "needl", &opts, &AtomicBool::new(false));
        assert!(found.results.is_empty(), "単語の一部には当たらない");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn glob_excludes_and_shift_jis_contents_are_handled() {
        let root = workspace("glob");
        std::fs::write(root.join("sjis.txt"), encoding_rs::SHIFT_JIS.encode("日本語のかんじ").0).unwrap();
        let found = search_workspace(&root, "かんじ", &options(), &AtomicBool::new(false));
        assert_eq!(found.results.len(), 1, "Shift-JIS の本文も当たる");

        let mut opts = options();
        opts.exclude_globs = vec!["*.txt".into()];
        let found = search_workspace(&root, "needle", &opts, &AtomicBool::new(false));
        assert!(found.results.is_empty(), "glob 除外が効く");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn file_names_are_matched_fuzzily_and_ranked_by_score() {
        let root = workspace("fuzzy");
        std::fs::write(root.join("sub/needless-extra.txt"), "").unwrap();
        let mut opts = options();
        opts.search_contents = false;
        opts.search_file_names = true;
        let found = search_workspace(&root, "ndl", &opts, &AtomicBool::new(false));
        let paths: Vec<&str> = found.results.iter().map(|r| r.rel_path.as_str()).collect();
        assert_eq!(paths, vec!["needle.txt", "sub/needless-extra.txt"], "スコア順");
        assert!(!found.results[0].highlights.is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
}

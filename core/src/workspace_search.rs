// フォルダ全体の検索。本文は ripgrep のエンジン (ignore + grep-*) を
// ライブラリとして使い、ファイル名は fuzzy の DP スコアで候補を出した後、
// 連続一致を再確認する。
//
// 外部 rg.exe を同梱せずクレートを組み込むのは、配布物を1つに保ちたいのと、
// 検索条件を JSON へ組み立て直さずそのまま渡せるため。
use crate::doc::WorkspaceSearchResult;
use crate::fuzzy::{has_contiguous_match, match_path, to_ranges};
use grep_matcher::Matcher;
use grep_regex::RegexMatcher;
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder, Sink, SinkMatch};
use ignore::overrides::OverrideBuilder;
use ignore::{WalkBuilder, WalkState};
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;

// 検索の打ち切り条件はすべて利用者が決める。ここに既定値は持たない
// (既定値は UI 側の設定ダイアログが単一の定義を持つ)。
// 各上限の 0 は「無制限」。利用者が明示的に上限を入れない限り勝手に省略しない。
#[derive(Clone, serde::Deserialize, ts_rs::TS)]
#[ts(export, rename = "WorkspaceSearchOptions")]
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
#[derive(Default, serde::Serialize, ts_rs::TS)]
#[ts(export)]
pub struct WorkspaceSearchOutcome {
    // 並びは走査順 (同じファイルの一致は連続する)。見せる順を決めるのは
    // ui/search-results.ts の sortResults 一箇所。途中経過は走査順で届く以上
    // UI 側の並べ替えは避けられず、ここでも並べると同じ規則が2実装になる。
    pub results: Vec<WorkspaceSearchResult>,
    pub scanned_files: usize,
    // walk/open/read に失敗して、検索対象から完全には確認できなかったファイル数。
    pub skipped_files: usize,
    pub hit_file_limit: bool,
    pub hit_result_limit: bool,
    pub pattern_error: Option<String>,
    // ファイル名の当て方は検索エンジンだけが決める。UI は説明にこの値を使い、
    // 同じ条件式を再実装しない。
    pub file_name_match_mode: FileNameMatchMode,
}

#[derive(Clone, Copy, Default, serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum FileNameMatchMode {
    #[default]
    Disabled,
    Fuzzy,
    Strict,
}

// 一致が行頭から遠いと preview から外れてしまうため、手前に残す文字数
const PREVIEW_LEAD_CHARS: usize = 40;
const PREVIEW_CHARS: usize = 180;
// バイナリ判定と文字コード判定に読む先頭バイト数
const PROBE_BYTES: usize = 8 * 1024;
// 途中経過を送り出す間隔。1件ごとに送らないのは、1回の送出が
// JSON 化 + webview へのメッセージ 1往復になるため。UI 側は 100ms ごとにしか
// 描き直さないので、それより細かく送っても表示は 1mm も早くならない。
const PROGRESS_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);
// 途中経過を送るのはここまで。画面に出せる行数を超えて送っても表示は増えず、
// 複製と IPC の費用だけが増える (確定結果は打ち切らずに全件返す)。
// 上限は ui/sidebar.ts の MAX_RENDERED_ROWS を超えてはならない (check:ipc が検証する)。
const PROGRESS_MAX: usize = 3_000;
const NAME_PREFIX: &str = "ファイル名: ";

// 0 は無制限。以降の比較をすべて飽和値で書けるようにする
fn limit(value: usize) -> usize {
    if value == 0 {
        usize::MAX
    } else {
        value
    }
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

// on_batch は見つかった端から呼ばれる (順序は走査順で、最終結果の並びとは別)。
// 全部そろうまで黙っていると、大きなフォルダでは待っているのか止まっているのか
// 利用者に区別がつかないため、確定を待たずに出せるものを出す。
pub fn search_workspace(
    root: &Path,
    pattern: &str,
    options: &SearchOptions,
    cancel: &AtomicBool,
    on_batch: &(dyn Fn(Vec<WorkspaceSearchResult>) + Sync),
) -> WorkspaceSearchOutcome {
    let file_name_match_mode = file_name_match_mode(options);
    if pattern.is_empty() || (!options.search_file_names && !options.search_contents) {
        return WorkspaceSearchOutcome {
            file_name_match_mode,
            ..Default::default()
        };
    }
    let strict_names = matches!(file_name_match_mode, FileNameMatchMode::Strict);
    let matcher = match build_matcher(pattern, options, strict_names) {
        Ok(matcher) => matcher,
        Err(message) => {
            return WorkspaceSearchOutcome {
                pattern_error: Some(message),
                file_name_match_mode,
                ..Default::default()
            }
        }
    };
    let walk = match build_walk(root, options) {
        Ok(walk) => walk,
        Err(message) => {
            return WorkspaceSearchOutcome {
                pattern_error: Some(message),
                file_name_match_mode,
                ..Default::default()
            }
        }
    };

    let max_files = limit(options.max_files);
    let max_results = limit(options.max_results);
    let shared_results = Mutex::new(Collected::default());
    let shared_scanned = AtomicUsize::new(0);
    let shared_skipped = AtomicUsize::new(0);
    let shared_file_limit = AtomicBool::new(false);
    let shared_result_limit = AtomicBool::new(false);
    // 走査スレッドへ配るのは参照だけ。&T は Copy なので move クロージャへ渡せる
    let (results, scanned) = (&shared_results, &shared_scanned);
    let (hit_file_limit, hit_result_limit, skipped) =
        (&shared_file_limit, &shared_result_limit, &shared_skipped);

    walk.build_parallel().run(|| {
        let mut engine = Engine::new(matcher.as_ref(), options, strict_names);
        Box::new(move |entry| {
            if cancel.load(Ordering::Relaxed) {
                return WalkState::Quit;
            }
            let Ok(entry) = entry else {
                skipped.fetch_add(1, Ordering::Relaxed);
                return WalkState::Continue;
            };
            let Some(file_type) = entry.file_type() else {
                skipped.fetch_add(1, Ordering::Relaxed);
                return WalkState::Continue;
            };
            if !file_type.is_file() {
                return WalkState::Continue;
            }
            if scanned.fetch_add(1, Ordering::Relaxed) >= max_files {
                hit_file_limit.store(true, Ordering::Relaxed);
                return WalkState::Quit;
            }
            let relative = relative_path(root, entry.path());
            let mut found = engine.search_file(entry.path(), &relative, pattern, max_results);
            if found.skipped {
                skipped.fetch_add(1, Ordering::Relaxed);
            }
            if found.limited {
                hit_result_limit.store(true, Ordering::Relaxed);
            }
            if found.hits.is_empty() {
                return WalkState::Continue;
            }
            let mut output = results
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let remaining = max_results.saturating_sub(output.hits.len());
            if remaining == 0 {
                hit_result_limit.store(true, Ordering::Relaxed);
                return WalkState::Quit;
            }
            let exceeded = found.hits.len() > remaining;
            if exceeded {
                found.hits.truncate(remaining);
                hit_result_limit.store(true, Ordering::Relaxed);
            }
            output.hits.extend(found.hits);
            let batch = output.take_batch();
            drop(output); // 送信中も他スレッドを止めない
            if let Some(batch) = batch {
                on_batch(batch);
            }
            if exceeded { WalkState::Quit } else { WalkState::Continue }
        })
    });

    let mut output = shared_results
        .into_inner()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .hits;
    let truncated = shared_result_limit.load(Ordering::Relaxed) || output.len() > max_results;
    output.truncate(max_results);
    WorkspaceSearchOutcome {
        results: output,
        scanned_files: shared_scanned.load(Ordering::Relaxed).min(max_files),
        skipped_files: shared_skipped.load(Ordering::Relaxed),
        hit_file_limit: shared_file_limit.load(Ordering::Relaxed),
        hit_result_limit: truncated,
        pattern_error: None,
        file_name_match_mode,
    }
}

// 走査中の共有バッファ。sent は途中経過として送り出し済みの件数
#[derive(Default)]
struct Collected {
    hits: Vec<WorkspaceSearchResult>,
    sent: usize,
    last_sent_at: Option<std::time::Instant>, // None = まだ一度も送っていない
}

impl Collected {
    // 1件目は待たずに送る (最初の1件が出るまでの時間が体感を決める)。
    // 以降は時間で区切る。件数で区切ると、一致がまばらなフォルダでは
    // 2件目以降が最後まで出てこない (数がたまらないので送出が起きない)。
    fn take_batch(&mut self) -> Option<Vec<WorkspaceSearchResult>> {
        let budget = PROGRESS_MAX.saturating_sub(self.sent);
        if budget == 0 || self.hits.len() == self.sent {
            return None;
        }
        let now = std::time::Instant::now();
        if self
            .last_sent_at
            .is_some_and(|last| now.duration_since(last) < PROGRESS_INTERVAL)
        {
            return None;
        }
        self.last_sent_at = Some(now);
        let from = self.sent;
        self.sent = self.hits.len().min(from + budget);
        Some(self.hits[from..self.sent].to_vec())
    }
}

fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

// 正規表現や単語単位を指定したなら、それは「厳密に当てたい」という意思表示。
// ファイル名もファジーをやめ、本文と同じ当て方に揃える。
// (ファジーは「順序さえ合えば当たる」ので、厳密指定とは両立しない)
fn file_name_match_mode(options: &SearchOptions) -> FileNameMatchMode {
    if !options.search_file_names {
        FileNameMatchMode::Disabled
    } else if options.use_regex || options.whole_word {
        FileNameMatchMode::Strict
    } else {
        FileNameMatchMode::Fuzzy
    }
}

// 本文にもファイル名にも matcher を使わないなら要らない (正規表現の誤りも問わない)。
// 当て方そのものは search.rs が単一の定義を持つ (ファイル内検索と揃えるため)。
fn build_matcher(
    pattern: &str,
    options: &SearchOptions,
    strict_names: bool,
) -> Result<Option<RegexMatcher>, String> {
    if !options.search_contents && !strict_names {
        return Ok(None);
    }
    crate::search::build_matcher(
        pattern,
        options.match_case,
        options.use_regex,
        options.whole_word,
    )
    .map(Some)
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
        overrides
            .case_insensitive(true)
            .map_err(|e| e.to_string())?;
        for glob in &options.exclude_globs {
            // overrides では先頭の "!" が「除外」を意味する (gitignore と逆)
            overrides
                .add(&format!("!{glob}"))
                .map_err(|e| format!("除外パターンが不正: {e}"))?;
        }
        builder.overrides(overrides.build().map_err(|e| e.to_string())?);
    }
    let excluded: Vec<String> = options
        .exclude_dirs
        .iter()
        .map(|dir| dir.to_lowercase())
        .collect();
    builder.filter_entry(move |entry| {
        // ルート自身は、名前がたまたま除外リストに載っていても対象から外さない
        entry.depth() == 0
            || !entry.file_type().is_some_and(|kind| kind.is_dir())
            || !excluded.contains(&entry.file_name().to_string_lossy().to_lowercase())
    });
    Ok(builder)
}

// 走査スレッドごとの状態。Searcher は行バッファを使い回すので毎回作らない。
// content と name は同じ matcher を指すこともある (どちらに使うかだけが違う)。
// 「何をするか」は走り出す前にここで決め切る。ファイルごとに options を読み直すと、
// 同じ判断が走査回数だけ散らばる。
struct Engine<'a> {
    content: Option<&'a RegexMatcher>,
    name: Option<&'a RegexMatcher>, // None = ファイル名はファジーで当てる
    match_names: bool,
    match_case: bool,
    exclude_binary: bool,
    utf8: Searcher,
    sjis: Option<Searcher>,
}

impl<'a> Engine<'a> {
    fn new(matcher: Option<&'a RegexMatcher>, options: &SearchOptions, strict_names: bool) -> Self {
        Engine {
            content: if options.search_contents {
                matcher
            } else {
                None
            },
            name: if strict_names { matcher } else { None },
            match_names: options.search_file_names,
            match_case: options.match_case,
            exclude_binary: options.exclude_binary,
            utf8: searcher(None, options.exclude_binary),
            sjis: grep_searcher::Encoding::new("sjis")
                .ok()
                .map(|enc| searcher(Some(enc), options.exclude_binary)),
        }
    }

    fn search_file(
        &mut self,
        path: &Path,
        relative: &str,
        pattern: &str,
        max_results: usize,
    ) -> FileHits {
        let mut hits = Vec::new();
        if self.match_names {
            hits.extend(name_hit(self.name, pattern, relative, self.match_case));
        }
        if self.content.is_none() && !self.exclude_binary {
            return FileHits {
                hits,
                limited: false,
                skipped: false,
            };
        }
        // exclude_binary が有効な場合は、名前検索だけでもバイナリ判定が必要。
        // 本文検索で開けないファイルは名前一致を残したまま、検索不完全として返す。
        // 成功した空結果と混同させない。
        let mut file = match File::open(path) {
            Ok(file) => file,
            Err(_) => {
                return FileHits {
                    hits,
                    limited: false,
                    skipped: true,
                };
            }
        };
        let probe = match probe_head(&mut file) {
            Ok(probe) => probe,
            Err(_) => {
                return FileHits {
                    hits,
                    limited: false,
                    skipped: true,
                };
            }
        };
        if self.exclude_binary && probe.binary {
            return FileHits {
                hits: Vec::new(),
                limited: false,
                skipped: false,
            };
        }
        let Some(matcher) = self.content else {
            return FileHits {
                hits,
                limited: false,
                skipped: false,
            };
        };
        let searcher = match (probe.sjis, self.sjis.as_mut()) {
            (true, Some(sjis)) => sjis,
            _ => &mut self.utf8,
        };
        let mut collector = Collector {
            matcher,
            relative,
            hits: &mut hits,
            max_results,
            limited: false,
        };
        // 途中で読めなくなったファイルは黙って飛ばす (ここまでの一致は残す)
        let skipped = searcher.search_file(matcher, &file, &mut collector).is_err();
        let limited = collector.limited;
        FileHits { hits, limited, skipped }
    }
}

// ファイル名の一致。matcher があれば厳密に、無ければファジーで候補を出して
// 連続一致を再確認する。行は 1つのファイルにつき 1つで、複数当たった分は
// 強調範囲として並べる。
fn name_hit(
    matcher: Option<&RegexMatcher>,
    pattern: &str,
    relative: &str,
    match_case: bool,
) -> Option<WorkspaceSearchResult> {
    let prefix = NAME_PREFIX.chars().count();
    let (highlights, score) = match matcher {
        Some(matcher) => {
            let mut spans = Vec::new();
            let _ = matcher.find_iter(relative.as_bytes(), |at| {
                let start = relative[..at.start()].chars().count();
                spans.push([
                    prefix + start,
                    relative[at.start()..at.end()].chars().count(),
                ]);
                true
            });
            // 厳密に当てたときは当てはまりの良さに差が無い (並びはパス順に任せる)
            (spans, 0)
        }
        None => {
            let found = match_path(pattern, relative, match_case)?;
            let filename_pattern = pattern
                .rsplit(|character| character == '/' || character == '\\')
                .next()
                .unwrap_or(pattern);
            let filename = relative.rsplit('/').next().unwrap_or(relative);
            if !has_contiguous_match(filename_pattern, filename, match_case) {
                return None;
            }
            let spans = to_ranges(&found.positions)
                .into_iter()
                .map(|[at, len]| [at + prefix, len])
                .collect();
            (spans, found.score)
        }
    };
    if highlights.is_empty() {
        return None;
    }
    Some(WorkspaceSearchResult {
        rel_path: relative.to_owned(),
        line: 0,
        col: 0,
        preview: format!("{NAME_PREFIX}{relative}"),
        highlights,
        is_filename: true,
        score,
    })
}

// limited は「このファイルの一致を上限で切った」印。
// 切ったことを持ち帰らないと、件数だけ減って理由が消える。
#[derive(Default)]
struct FileHits {
    hits: Vec<WorkspaceSearchResult>,
    limited: bool,
    skipped: bool,
}

// mmap は使わない (grep-searcher の既定のまま)。ripgrep が再帰検索で使わないのと
// 同じ理由で、Windows では 4MB 級のファイルでも実測でバッファ読みのほうが速かった。
fn searcher(encoding: Option<grep_searcher::Encoding>, exclude_binary: bool) -> Searcher {
    SearcherBuilder::new()
        .binary_detection(if exclude_binary {
            // NUL が出た時点で本文検索を止める (ripgrep の再帰検索と同じ既定)
            BinaryDetection::quit(0)
        } else {
            BinaryDetection::none()
        })
        .line_number(true)
        .encoding(encoding)
        .build()
}

struct Collector<'a> {
    matcher: &'a RegexMatcher,
    relative: &'a str,
    hits: &'a mut Vec<WorkspaceSearchResult>,
    max_results: usize,
    limited: bool,
}

impl Sink for Collector<'_> {
    type Error = std::io::Error;

    fn matched(
        &mut self,
        _searcher: &Searcher,
        found: &SinkMatch<'_>,
    ) -> Result<bool, Self::Error> {
        let line = found.line_number().unwrap_or(1).saturating_sub(1) as usize;
        let text = String::from_utf8_lossy(found.bytes());
        let text = text.trim_end_matches(['\n', '\r']);
        let (matcher, relative, max_results) = (self.matcher, self.relative, self.max_results);
        let hits = &mut *self.hits;
        // 1行に複数一致があれば全部拾う。1件目だけ返すと「あるのに出ない」検索になる
        let _ = matcher.find_iter(text.as_bytes(), |at| {
            if hits.len() >= max_results {
                return false;
            }
            let (preview, preview_col) = preview_around(text, at.start());
            let matched_chars = text[at.start()..at.end()].chars().count();
            let shown = matched_chars.min(preview.chars().count().saturating_sub(preview_col));
            hits.push(WorkspaceSearchResult {
                rel_path: relative.to_owned(),
                line,
                col: text[..at.start()].chars().count(),
                preview,
                highlights: if shown > 0 {
                    vec![[preview_col, shown]]
                } else {
                    Vec::new()
                },
                is_filename: false,
                score: 0,
            });
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
    (
        format!("{head}{shown}"),
        before - skip + head.chars().count(),
    )
}

struct Probe {
    binary: bool,
    sjis: bool,
}

// 先頭だけを覗いて、バイナリかどうかと Shift-JIS 扱いが要るかを決める。
// grep-searcher は BOM 付き (UTF-8 / UTF-16) を自前で解くので、そこは触らない。
// 読み終えたら位置を戻す (同じ File をそのまま本文検索へ渡すため)。
fn probe_head(file: &mut File) -> io::Result<Probe> {
    let mut head = [0u8; PROBE_BYTES];
    let read = file.read(&mut head)?;
    file.seek(SeekFrom::Start(0))?;
    let head = &head[..read];
    if head.starts_with(&[0xFF, 0xFE]) || head.starts_with(&[0xFE, 0xFF]) {
        return Ok(Probe {
            binary: false,
            sjis: false,
        });
    }
    Ok(Probe {
        binary: head.contains(&0),
        // 末尾で多バイト文字が切れただけなら UTF-8 のまま扱う
        sjis: std::str::from_utf8(head).is_err_and(|error| error.error_len().is_some()),
    })
}

#[cfg(test)]
mod tests {
    use super::{search_workspace, SearchOptions};
    use std::path::{Path, PathBuf};
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

    fn filename_options() -> SearchOptions {
        let mut search_options = options();
        search_options.search_contents = false;
        search_options.search_file_names = true;
        search_options
    }

    struct FilenameWorkspace {
        root: PathBuf,
    }

    impl FilenameWorkspace {
        fn new(tag: &str, files: &[(&str, &str)]) -> Self {
            let root = std::env::temp_dir().join(format!(
                "wasabipad_ws_{}_filename_fixture_{tag}",
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&root);
            for (relative, contents) in files {
                let path = root.join(relative);
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent).unwrap();
                }
                std::fs::write(path, contents).unwrap();
            }
            Self { root }
        }

        fn path(&self) -> &Path {
            &self.root
        }
    }

    impl Drop for FilenameWorkspace {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn workspace(tag: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("wasabipad_ws_{}_{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("skip")).unwrap();
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(
            root.join("needle.txt"),
            "one needle\nno match\nneedle and needle\n",
        )
        .unwrap();
        std::fs::write(root.join("sub/plain.txt"), "nothing here\n").unwrap();
        std::fs::write(root.join("skip/hidden.txt"), "needle\n").unwrap();
        std::fs::write(root.join("blob.pyc"), b"\x00\x01needle\x00").unwrap();
        root
    }

    fn run(
        root: &std::path::Path,
        pattern: &str,
        options: &SearchOptions,
    ) -> super::WorkspaceSearchOutcome {
        search_workspace(root, pattern, options, &AtomicBool::new(false), &|_| {})
    }

    fn places(found: &super::WorkspaceSearchOutcome) -> Vec<(String, usize, usize)> {
        found
            .results
            .iter()
            .map(|r| (r.rel_path.clone(), r.line, r.col))
            .collect()
    }

    #[test]
    fn collects_every_match_on_a_line_and_skips_excluded_dirs() {
        let root = workspace("all");
        let found = run(&root, "needle", &options());
        assert_eq!(
            places(&found),
            vec![
                ("needle.txt".into(), 0, 4),
                ("needle.txt".into(), 2, 0),
                ("needle.txt".into(), 2, 11),
            ]
        );
        assert_eq!(found.scanned_files, 3, "skip/ 配下は列挙しない");
        assert!(!found.hit_file_limit && !found.hit_result_limit);
        assert_eq!(found.results[0].preview, "one needle");
        assert_eq!(found.results[0].highlights, vec![[4, 6]]);
        std::fs::remove_dir_all(root).unwrap();
    }

    // Feature: ファイルツリーのバイナリ検索
    // Scenario: バイナリ除外設定に応じてファイル名と本文を検索する
    // Given: バイナリファイルを含むワークスペースがある
    // When: バイナリ除外設定を切り替えて検索する
    // Then: 除外時は本文を除外し、許可時は本文も検索する
    #[test]
    fn binary_files_are_excluded_only_when_asked() {
        let root = workspace("binary");
        let mut opts = filename_options();
        assert!(run(&root, "blob", &opts).results.is_empty());

        opts.exclude_binary = false;
        let found = run(&root, "blob", &opts);
        assert_eq!(found.results.len(), 1, "名前一致だけは残る");

        opts.search_file_names = false;
        opts.search_contents = true;
        let found = run(&root, "needle", &opts);
        assert_eq!(found.results.iter().filter(|hit| hit.rel_path == "blob.pyc").count(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    // Feature: ワークスペース検索の部分結果通知
    // Scenario: 本文検索対象のファイルを開けない
    // Given: ファイル名は一致するが、本文ファイルが存在しないパス
    // When: 検索エンジンでファイルを調べる
    // Then: 名前一致は残し、本文検索が不完全だったことを記録する
    #[test]
    fn unreadable_content_file_is_marked_as_skipped() {
        let root = workspace("unreadable");
        let mut opts = options();
        opts.search_file_names = true;
        let matcher = super::build_matcher("needle", &opts, false)
            .unwrap()
            .unwrap();
        let mut engine = super::Engine::new(Some(&matcher), &opts, false);

        let found = engine.search_file(
            &root.join("missing.txt"),
            "needle.txt",
            "needle",
            usize::MAX,
        );

        assert_eq!(found.hits.len(), 1);
        assert!(found.skipped);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn limits_are_reported_instead_of_silently_trimming() {
        let root = workspace("limit");
        let mut opts = options();
        opts.max_results = 2;
        let found = run(&root, "needle", &opts);
        assert_eq!(found.results.len(), 2);
        assert!(found.hit_result_limit);

        opts.max_results = 0;
        opts.max_files = 1;
        let found = run(&root, "needle", &opts);
        assert!(found.hit_file_limit);
        std::fs::remove_dir_all(root).unwrap();
    }

    // Given: 同じ検索でファイル名一致と本文一致が発生し、結果上限が1件
    // When: ワークスペースを検索する
    // Then: 中間バッチを含めて結果数を上限以内に保つ
    #[test]
    fn result_limit_counts_file_name_and_content_hits_together() {
        let root = workspace("name_and_content_limit");
        let mut opts = options();
        opts.search_file_names = true;
        opts.max_results = 1;

        let found = run(&root, "needle", &opts);

        assert_eq!(found.results.len(), 1);
        assert!(found.hit_result_limit);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn regex_and_whole_word_come_from_the_same_engine() {
        let root = workspace("regex");
        let mut opts = options();
        opts.use_regex = true;
        let found = run(&root, "need(le)+", &opts);
        assert_eq!(found.results.len(), 3);

        // 正規表現が壊れていても落とさず、理由を返す
        let broken = run(&root, "need(", &opts);
        assert!(broken.pattern_error.is_some() && broken.results.is_empty());

        opts.use_regex = false;
        opts.whole_word = true;
        let found = run(&root, "needl", &opts);
        assert!(found.results.is_empty(), "単語の一部には当たらない");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn glob_excludes_and_shift_jis_contents_are_handled() {
        let root = workspace("glob");
        std::fs::write(
            root.join("sjis.txt"),
            encoding_rs::SHIFT_JIS.encode("日本語のかんじ").0,
        )
        .unwrap();
        let found = run(&root, "かんじ", &options());
        assert_eq!(found.results.len(), 1, "Shift-JIS の本文も当たる");

        let mut opts = options();
        opts.exclude_globs = vec!["*.txt".into()];
        let found = run(&root, "needle", &opts);
        assert!(found.results.is_empty(), "glob 除外が効く");
        std::fs::remove_dir_all(root).unwrap();
    }

    // 途中経過を出さないと、大きなフォルダでは待ちと停止の区別がつかない。
    // 1ファイルに全一致を入れると、時間に関わらず送出の切れ目が決まる
    // (最初の1件で PROGRESS_MAX まで出し、そこで送出が止まる)。
    #[test]
    fn hits_are_streamed_up_to_the_cap() {
        let cap = super::PROGRESS_MAX;
        let root = std::env::temp_dir().join(format!("wasabipad_ws_{}_stream", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("many.txt"), "needle\n".repeat(cap * 2)).unwrap();
        let streamed = std::sync::Mutex::new(Vec::new());
        let found = search_workspace(
            &root,
            "needle",
            &options(),
            &AtomicBool::new(false),
            &|hits| {
                streamed.lock().unwrap().extend(hits);
            },
        );
        let streamed = streamed.into_inner().unwrap();
        assert_eq!(found.results.len(), cap * 2, "確定結果は打ち切らない");
        assert_eq!(
            streamed.len(),
            cap,
            "1件目は待たずに送り、上限で送出を止める"
        );
        let places = places(&found);
        for hit in &streamed {
            assert!(places.contains(&(hit.rel_path.clone(), hit.line, hit.col)));
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    // Feature: ファイルツリーのファイル名検索モード
    // Scenario: ファジー候補の連続一致を検証する
    // Given: needle.txtを検索対象にし、本文検索を無効にする
    // When: ndlとneedでファイル名を検索する
    // Then: 非連続の候補は除外し、連続一致は返す
    #[test]
    fn strict_options_switch_file_names_off_fuzzy() {
        let root = workspace("strict");
        let mut opts = filename_options();
        let names = |found: &super::WorkspaceSearchOutcome| -> Vec<String> {
            found.results.iter().map(|r| r.rel_path.clone()).collect()
        };

        let found = run(&root, "ndl", &opts);
        assert!(found.results.is_empty(), "連続しないファジー候補は表示しない");
        assert!(matches!(
            found.file_name_match_mode,
            super::FileNameMatchMode::Fuzzy
        ));

        assert_eq!(names(&run(&root, "need", &opts)), vec!["needle.txt"]);

        opts.whole_word = true;
        let found = run(&root, "ndl", &opts);
        assert!(found.results.is_empty(), "単語単位なら飛び飛びは当たらない");
        assert!(matches!(
            found.file_name_match_mode,
            super::FileNameMatchMode::Strict
        ));
        assert!(
            run(&root, "eedle", &opts).results.is_empty(),
            "単語の一部にも当たらない"
        );
        assert_eq!(names(&run(&root, "needle", &opts)), vec!["needle.txt"]);

        opts.whole_word = false;
        opts.use_regex = true;
        assert_eq!(
            names(&run(&root, "need.e\\.txt", &opts)),
            vec!["needle.txt"]
        );
        assert!(
            run(&root, "ndl", &opts).results.is_empty(),
            "正規表現としては当たらない"
        );
        // 壊れた正規表現は、本文を検索しなくても理由を返す
        assert!(run(&root, "need(", &opts).pattern_error.is_some());
        std::fs::remove_dir_all(root).unwrap();
    }

    // Feature: ファイルツリーのファイル名検索結果の並べ替え
    // Scenario: 連続一致した候補をスコア順に評価する
    // Given: 短いファイル名と長いファイル名を検索対象にする
    // When: 連続一致するneedでファイル名を検索する
    // Then: 短いファイル名のスコアが高く、強調範囲も返す
    #[test]
    fn verified_file_name_candidates_are_scored() {
        let root = workspace("fuzzy");
        std::fs::write(root.join("sub/needless-extra.txt"), "").unwrap();
        let opts = filename_options();
        let found = run(&root, "need", &opts);
        let by_path: std::collections::HashMap<&str, &super::WorkspaceSearchResult> = found
            .results
            .iter()
            .map(|r| (r.rel_path.as_str(), r))
            .collect();
        let short = by_path["needle.txt"];
        let long = by_path["sub/needless-extra.txt"];
        assert_eq!(found.results.len(), 2);
        assert!(short.score > long.score, "当てはまりの良いほうが高い");
        assert!(!short.highlights.is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    // Feature: ファイルツリーのファイル名検索
    // Scenario: ファジー候補の文字が連続していない項目を除外する
    // Given: `folderA/fileA.txt` と `fa.txt` が検索対象にある
    // When: ファイル名だけを `fa` で検索する
    // Then: ファイル名内で連続一致する `fa.txt` だけを返す
    #[test]
    fn filename_candidates_are_verified_by_contiguous_match() {
        let workspace = FilenameWorkspace::new(
            "filename_verify",
            &[("folderA/fileA.txt", ""), ("fa.txt", "")],
        );

        let opts = filename_options();
        let found = run(workspace.path(), "fa", &opts);

        assert_eq!(
            found.results.iter().map(|result| result.rel_path.as_str()).collect::<Vec<_>>(),
            vec!["fa.txt"],
            "ファジー候補だけでファイル名を一致扱いしない",
        );
    }

    // Feature: ファイルツリーのファイル名検索
    // Scenario: パス部分だけの連続一致をファイル名一致にしない
    // Given: `folderA/fileA.txt` と `folderA/fileA/target.txt` が検索対象にある
    // When: パスを含む `folderA/fileA` でファイル名を検索する
    // Then: ファイル名に `fileA` を含む項目だけを返す
    #[test]
    fn filename_verification_uses_the_filename_part_of_a_path_query() {
        let workspace = FilenameWorkspace::new(
            "filename_path_verify",
            &[
                ("folderA/fileA.txt", ""),
                ("folderA/fileA/target.txt", ""),
            ],
        );

        let opts = filename_options();
        let found = run(workspace.path(), "folderA/fileA", &opts);

        assert_eq!(
            found.results.iter().map(|result| result.rel_path.as_str()).collect::<Vec<_>>(),
            vec!["folderA/fileA.txt"],
            "親フォルダの一致だけではファイル名一致にしない",
        );
    }

    // 位置は char 単位で返す。バイト位置のまま返すと、多バイト文字のある行で
    // 飛び先がずれる (UI は char index として扱う)。
    #[test]
    fn columns_are_character_indexes_and_names_hit_too() {
        let root = std::env::temp_dir().join(format!("wasabipad_ws_{}_chars", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("top.txt"), "skip\nNeedle").unwrap();
        std::fs::write(root.join("sub/deep.txt"), "あ needle").unwrap();
        std::fs::write(root.join("needle-file.txt"), "other").unwrap();

        let mut opts = options();
        opts.search_file_names = true;
        let found = run(&root, "NEEDLE", &opts);
        let mut places = places(&found);
        places.sort();
        assert_eq!(
            places,
            vec![
                ("needle-file.txt".into(), 0, 0), // 名前だけの一致
                ("sub/deep.txt".into(), 0, 2),    // "あ " は 2 文字
                ("top.txt".into(), 1, 0),
            ]
        );
        let name_hit = found.results.iter().find(|r| r.is_filename).unwrap();
        assert_eq!(name_hit.preview, "ファイル名: needle-file.txt");
        std::fs::remove_dir_all(root).unwrap();
    }
}

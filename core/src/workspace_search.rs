use crate::doc::WorkspaceSearchResult;
use crate::search::find_in_line;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

// 検索の打ち切り条件はすべて利用者が決める。ここに既定値は持たない
// (既定値は UI 側の設定ダイアログが単一の定義を持つ)。
// 各上限の 0 は「無制限」。利用者が明示的に上限を入れない限り勝手に省略しない。
#[derive(Clone, serde::Deserialize)]
pub struct SearchOptions {
    pub match_case: bool,
    pub max_file_bytes: u64,
    pub max_files: usize,
    pub max_results: usize,
    pub exclude_dirs: Vec<String>,
    pub exclude_binary: bool,
    pub search_file_names: bool,
    pub search_contents: bool,
    // 0 は「CPUに任せる」。実際の並列数は clamp_workers が決める
    pub workers: usize,
}

// 打ち切りが起きたかを結果と一緒に返す。件数だけ見せて理由を隠すと
// 「あるはずのものが出ない」検索になり、利用者が原因を追えなくなる。
#[derive(Default, serde::Serialize)]
pub struct WorkspaceSearchOutcome {
    pub results: Vec<WorkspaceSearchResult>,
    pub scanned_files: usize,
    pub hit_file_limit: bool,
    pub hit_result_limit: bool,
}

// 一致が行頭から遠いと preview から外れてしまうため、手前に残す文字数
const PREVIEW_LEAD_CHARS: usize = 40;
const PREVIEW_CHARS: usize = 180;
// バイナリ判定に読む先頭バイト数。全体を読むと巨大ファイルで無駄が大きい
const BINARY_PROBE_BYTES: usize = 8 * 1024;

// 0 は無制限。以降の比較をすべて飽和値で書けるようにする
fn limit(value: usize) -> usize {
    if value == 0 { usize::MAX } else { value }
}

fn byte_limit(value: u64) -> u64 {
    if value == 0 { u64::MAX } else { value }
}

// 0=自動。上限は論理コア数で、それを超える指定は意味がないので切り詰める
fn clamp_workers(requested: usize) -> usize {
    let cores = std::thread::available_parallelism().map_or(1, |count| count.get());
    if requested == 0 {
        cores.min(4)
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

    let max_files = limit(options.max_files);
    let max_results = limit(options.max_results);
    let mut files = Vec::new();
    let hit_file_limit = collect_files(
        root,
        &mut files,
        options,
        max_files,
        byte_limit(options.max_file_bytes),
        cancel,
    );
    let scanned_files = files.len();
    let files = Arc::new(files);
    let next = AtomicUsize::new(0);
    let results: Mutex<Vec<(u8, WorkspaceSearchResult)>> = Mutex::new(Vec::new());
    let stopped_by_limit = AtomicBool::new(false);

    std::thread::scope(|scope| {
        for _ in 0..clamp_workers(options.workers) {
            scope.spawn(|| loop {
                if cancel.load(Ordering::Relaxed) {
                    return;
                }
                let index = next.fetch_add(1, Ordering::Relaxed);
                let Some(path) = files.get(index) else { return };
                let relative = path
                    .strip_prefix(root)
                    .unwrap_or(path)
                    .to_string_lossy()
                    .replace('\\', "/");
                let hits = search_file(path, &relative, pattern, options);
                if hits.is_empty() {
                    continue;
                }
                let mut output = results.lock().unwrap();
                if output.len() >= max_results {
                    stopped_by_limit.store(true, Ordering::Relaxed);
                    return;
                }
                output.extend(hits);
            });
        }
    });

    let mut output = results.into_inner().unwrap();
    // 同じファイルの一致をツリーにまとめられるよう、パス順 → ファイル名一致 → 行順に並べる
    output.sort_by(|a, b| {
        (&a.1.rel_path, a.0, a.1.line, a.1.col).cmp(&(&b.1.rel_path, b.0, b.1.line, b.1.col))
    });
    let hit_result_limit = stopped_by_limit.load(Ordering::Relaxed) || output.len() > max_results;
    output.truncate(max_results);
    WorkspaceSearchOutcome {
        results: output.into_iter().map(|(_, result)| result).collect(),
        scanned_files,
        hit_file_limit,
        hit_result_limit,
    }
}

// 1ファイル分の一致。第1要素はツリー内での並び (0=ファイル名一致, 1=本文一致)。
fn search_file(
    path: &Path,
    relative: &str,
    pattern: &str,
    options: &SearchOptions,
) -> Vec<(u8, WorkspaceSearchResult)> {
    // 本文を読むならそのバイト列で、読まないなら先頭だけ覗いてバイナリを判定する
    let bytes = options
        .search_contents
        .then(|| std::fs::read(path).ok())
        .flatten();
    let binary = match &bytes {
        Some(bytes) => is_binary(bytes),
        None => options.exclude_binary && head_is_binary(path),
    };
    if options.exclude_binary && binary {
        return Vec::new();
    }

    let mut hits = Vec::new();
    let file_name = path.file_name().and_then(|name| name.to_str()).unwrap_or("");
    if options.search_file_names && find_in_line(file_name, pattern, 0, options.match_case).is_some()
    {
        hits.push((0, WorkspaceSearchResult {
            rel_path: relative.to_owned(),
            line: 0,
            col: 0,
            preview: format!("ファイル名: {file_name}"),
            is_filename: true,
        }));
    }
    // バイナリの本文は行として意味を持たないため、名前だけを対象にする
    let Some(bytes) = bytes.filter(|_| !binary) else { return hits };
    for (line, text) in decode_text(&bytes).lines().enumerate() {
        collect_line_hits(text, line, relative, pattern, options.match_case, &mut hits);
    }
    hits
}

// 1行に複数一致があれば全部返す。1件目だけ返すと「あるのに出ない」検索になる。
fn collect_line_hits(
    text: &str,
    line: usize,
    relative: &str,
    pattern: &str,
    match_case: bool,
    hits: &mut Vec<(u8, WorkspaceSearchResult)>,
) {
    let mut from = 0;
    let mut chars_before = 0; // text[..from] の文字数。行ごとに数え直すと二乗になる
    while let Some(col) = find_in_line(text, pattern, from, match_case) {
        chars_before += text[from..col].chars().count();
        hits.push((1, WorkspaceSearchResult {
            rel_path: relative.to_owned(),
            line,
            col: chars_before,
            preview: preview_around(text, col),
            is_filename: false,
        }));
        // 一致部分はパターンとバイト長が等しい (大小文字無視も ASCII バイト単位の比較)
        from = col + pattern.len();
        chars_before += pattern.chars().count();
    }
}

// インデントを落とし、一致が見える位置から切り出す
fn preview_around(text: &str, col: usize) -> String {
    let indent = text.len() - text.trim_start().len();
    let body = &text[indent..];
    let offset = col.saturating_sub(indent).min(body.len());
    let skip = body[..offset].chars().count().saturating_sub(PREVIEW_LEAD_CHARS);
    let head = if skip > 0 { "…" } else { "" };
    let shown: String = body.chars().skip(skip).take(PREVIEW_CHARS).collect();
    format!("{head}{}", shown.trim_end())
}

// NUL を含むファイルはテキストとして扱えない (.pyc / 画像 / 実行ファイルなど)。
// UTF-16LE は BOM があれば decode_text が読めるので、テキストとして扱う。
fn is_binary(bytes: &[u8]) -> bool {
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return false;
    }
    bytes[..bytes.len().min(BINARY_PROBE_BYTES)].contains(&0)
}

fn head_is_binary(path: &Path) -> bool {
    use std::io::Read;
    let Ok(mut file) = std::fs::File::open(path) else { return false };
    let mut head = [0u8; BINARY_PROBE_BYTES];
    match file.read(&mut head) {
        Ok(read) => is_binary(&head[..read]),
        Err(_) => false,
    }
}

// 列挙を上限で打ち切ったら true (呼び出し側が利用者へ明示するため)
fn collect_files(
    dir: &Path,
    files: &mut Vec<PathBuf>,
    options: &SearchOptions,
    max_files: usize,
    max_bytes: u64,
    cancel: &AtomicBool,
) -> bool {
    if files.len() >= max_files {
        return true;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return false };
    for entry in entries.flatten() {
        if cancel.load(Ordering::Relaxed) {
            return false;
        }
        if files.len() >= max_files {
            return true;
        }
        let path = entry.path();
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if options.exclude_dirs.iter().any(|excluded| excluded.eq_ignore_ascii_case(&name)) {
                continue;
            }
            if collect_files(&path, files, options, max_files, max_bytes, cancel) {
                return true;
            }
        } else if kind.is_file()
            && entry.metadata().is_ok_and(|metadata| metadata.len() <= max_bytes)
        {
            files.push(path);
        }
    }
    false
}

fn decode_text(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return encoding_rs::UTF_16LE.decode(&bytes[2..]).0.into_owned();
    }
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(&bytes[3..]).into_owned();
    }
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_owned(),
        Err(_) => encoding_rs::SHIFT_JIS.decode(bytes).0.into_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::{search_workspace, SearchOptions};
    use std::sync::atomic::AtomicBool;

    fn options() -> SearchOptions {
        SearchOptions {
            match_case: false,
            max_file_bytes: 0,
            max_files: 0,
            max_results: 0,
            exclude_dirs: vec!["skip".into()],
            exclude_binary: true,
            search_file_names: true,
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

    #[test]
    fn collects_every_match_on_a_line_and_skips_excluded_dirs() {
        let root = workspace("all");
        let found = search_workspace(&root, "needle", &options(), &AtomicBool::new(false));
        let places: Vec<(String, usize, usize)> = found
            .results
            .iter()
            .map(|r| (r.rel_path.clone(), r.line, r.col))
            .collect();
        assert_eq!(places, vec![
            ("needle.txt".into(), 0, 0), // ファイル名一致
            ("needle.txt".into(), 0, 4),
            ("needle.txt".into(), 2, 0),
            ("needle.txt".into(), 2, 11),
        ]);
        assert_eq!(found.scanned_files, 3, "skip/ 配下は列挙しない");
        assert!(!found.hit_file_limit && !found.hit_result_limit);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn binary_files_are_excluded_only_when_asked() {
        let root = workspace("binary");
        let mut opts = options();
        opts.search_contents = false;
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
}

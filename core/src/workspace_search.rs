use crate::doc::WorkspaceSearchResult;
use crate::search::find_in_line;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

// 検索の打ち切り条件はすべて利用者が決める。ここに既定値は持たない
// (既定値は UI 側の設定パネルが単一の定義を持つ)。
#[derive(Clone, serde::Deserialize)]
pub struct SearchOptions {
    pub match_case: bool,
    pub max_file_bytes: u64,
    pub max_files: usize,
    pub max_results: usize,
    pub exclude_dirs: Vec<String>,
    pub search_file_names: bool,
    pub search_contents: bool,
    // 0 は「CPUに任せる」。実際の並列数は clamp_workers が決める
    pub workers: usize,
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
) -> Vec<WorkspaceSearchResult> {
    if pattern.is_empty() || (!options.search_file_names && !options.search_contents) {
        return Vec::new();
    }

    let mut files = Vec::new();
    collect_files(root, &mut files, options);
    let files = Arc::new(files);
    let next = AtomicUsize::new(0);
    let results = Mutex::new(Vec::new());

    std::thread::scope(|scope| {
        for _ in 0..clamp_workers(options.workers) {
            scope.spawn(|| loop {
                if results.lock().unwrap().len() >= options.max_results {
                    return;
                }
                let index = next.fetch_add(1, Ordering::Relaxed);
                let Some(path) = files.get(index) else { return };
                let relative = path
                    .strip_prefix(root)
                    .unwrap_or(path)
                    .to_string_lossy()
                    .replace('\\', "/");
                let file_name = path.file_name().and_then(|name| name.to_str()).unwrap_or("");
                if options.search_file_names
                    && find_in_line(file_name, pattern, 0, options.match_case).is_some()
                {
                    let mut output = results.lock().unwrap();
                    if output.len() < options.max_results {
                        output.push((0, WorkspaceSearchResult {
                            rel_path: relative.clone(),
                            line: 0,
                            col: 0,
                            preview: format!("ファイル名: {file_name}"),
                            is_filename: true,
                        }));
                    }
                }
                if !options.search_contents {
                    continue;
                }
                let Ok(bytes) = std::fs::read(path) else { continue };
                if bytes.contains(&0) {
                    continue;
                }
                for (line, text) in decode_text(&bytes).lines().enumerate() {
                    let Some(col) = find_in_line(text, pattern, 0, options.match_case) else { continue };
                    let mut output = results.lock().unwrap();
                    if output.len() >= options.max_results {
                        return;
                    }
                    output.push((1, WorkspaceSearchResult {
                        rel_path: relative.clone(),
                        line,
                        col: text[..col].chars().count(),
                        preview: text.trim().chars().take(180).collect(),
                        is_filename: false,
                    }));
                }
            });
        }
    });

    let mut output = results.into_inner().unwrap();
    output.sort_by(|a, b| (a.0, &a.1.rel_path, a.1.line, a.1.col).cmp(&(b.0, &b.1.rel_path, b.1.line, b.1.col)));
    output.into_iter().map(|(_, result)| result).collect()
}

fn collect_files(dir: &Path, files: &mut Vec<PathBuf>, options: &SearchOptions) {
    if files.len() >= options.max_files {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if files.len() >= options.max_files {
            return;
        }
        let path = entry.path();
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if options.exclude_dirs.iter().any(|excluded| excluded.eq_ignore_ascii_case(&name)) {
                continue;
            }
            collect_files(&path, files, options);
        } else if kind.is_file()
            && entry.metadata().is_ok_and(|metadata| metadata.len() <= options.max_file_bytes)
        {
            files.push(path);
        }
    }
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

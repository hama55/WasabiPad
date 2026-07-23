use crate::doc::{find_in_line, WorkspaceSearchResult};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

pub fn search_workspace(root: &Path, pattern: &str, match_case: bool) -> Vec<WorkspaceSearchResult> {
    const MAX_FILE_SIZE: u64 = 16 * 1024 * 1024;
    const MAX_FILES: usize = 20_000;
    const MAX_RESULTS: usize = 200;
    if pattern.is_empty() {
        return Vec::new();
    }

    let mut files = Vec::new();
    collect_files(root, root, &mut files, MAX_FILES, MAX_FILE_SIZE);
    let files = Arc::new(files);
    let next = AtomicUsize::new(0);
    let results = Mutex::new(Vec::new());
    let workers = std::thread::available_parallelism().map_or(1, |count| count.get()).min(4);

    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                if results.lock().unwrap().len() >= MAX_RESULTS {
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
                if find_in_line(file_name, pattern, 0, match_case).is_some() {
                    let mut output = results.lock().unwrap();
                    if output.len() < MAX_RESULTS {
                        output.push((0, WorkspaceSearchResult {
                            rel_path: relative.clone(),
                            line: 0,
                            col: 0,
                            preview: format!("ファイル名: {file_name}"),
                            is_filename: true,
                        }));
                    }
                }
                let Ok(bytes) = std::fs::read(path) else { continue };
                if bytes.contains(&0) {
                    continue;
                }
                for (line, text) in decode_text(&bytes).lines().enumerate() {
                    let Some(col) = find_in_line(text, pattern, 0, match_case) else { continue };
                    let mut output = results.lock().unwrap();
                    if output.len() >= MAX_RESULTS {
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

fn collect_files(dir: &Path, root: &Path, files: &mut Vec<PathBuf>, max_files: usize, max_size: u64) {
    if files.len() >= max_files {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if files.len() >= max_files {
            return;
        }
        let path = entry.path();
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            if path != root && matches!(entry.file_name().to_str(), Some(".git" | "node_modules" | "target")) {
                continue;
            }
            collect_files(&path, root, files, max_files, max_size);
        } else if kind.is_file() && entry.metadata().is_ok_and(|metadata| metadata.len() <= max_size) {
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

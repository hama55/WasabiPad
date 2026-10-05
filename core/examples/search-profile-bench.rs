use std::{path::PathBuf, sync::atomic::AtomicBool, time::Instant};
use wasabipad_core::{search_workspace, SearchOptions};

// Feature: 検索最適化設定の比較用測定（製品の動作テストではない）。
// Given: 同じ固定データと並列数。
// When: 公開フォルダ検索APIをウォームアップ後10回実行する。
// Then: 毎回の結果を照合し、API実行時間だけを出力する。
fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("Usage: search-profile-bench <data-directory> <workers: 0=auto>");
        std::process::exit(2);
    }
    let root = PathBuf::from(&args[1]);
    let workers: usize = args[2].parse().unwrap();
    let cases = [
        ("literal_miss", "NoSuchNeedleXYZ", true, false),
        ("literal_hits", "WasabiNeedle", true, false),
        ("ignore_case", "wasabineedle", false, false),
        ("regex_hits", r"WasabiNeedle[0-9]{4}", true, true),
        ("regex_miss", r"NoSuchNeedle[A-Z]{4}", true, true),
        ("japanese", "検索対象", true, false),
    ];
    for (name, pattern, match_case, use_regex) in cases {
        let options = SearchOptions {
            match_case,
            use_regex,
            whole_word: false,
            max_file_bytes: 0,
            max_files: 0,
            max_results: 0,
            exclude_dirs: vec![],
            exclude_globs: vec![],
            exclude_binary: true,
            respect_gitignore: false,
            search_file_names: false,
            search_contents: true,
            workers,
        };
        let cancel = AtomicBool::new(false);
        let mut samples = vec![];
        let mut expected = None;
        for i in 0..12 {
            let start = Instant::now();
            let outcome = search_workspace(&root, pattern, &options, &cancel, &|_| {});
            let ms = start.elapsed().as_secs_f64() * 1000.0;
            assert!(outcome.pattern_error.is_none());
            assert_eq!(outcome.skipped_files, 0);
            assert!(!outcome.hit_file_limit && !outcome.hit_result_limit);
            let mut records: Vec<String> = outcome
                .results
                .iter()
                .map(|r| serde_json::to_string(r).unwrap())
                .collect();
            records.sort();
            let mut hash = 14695981039346656037u64;
            for record in &records {
                for byte in record.bytes() {
                    hash = (hash ^ u64::from(byte)).wrapping_mul(1099511628211);
                }
            }
            let identity = (records.len(), outcome.scanned_files, hash);
            if let Some(ref previous) = expected {
                assert_eq!(previous, &identity);
            } else {
                expected = Some(identity);
            }
            if i >= 2 {
                samples.push(ms);
            }
        }
        println!(
            "{}",
            serde_json::json!({"case":name,"workers":workers,"samples_ms":samples,"identity":expected})
        );
    }
}

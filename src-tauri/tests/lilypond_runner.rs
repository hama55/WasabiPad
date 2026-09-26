#[path = "../src/lilypond_runner.rs"]
mod lilypond_runner;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use lilypond_runner::run_lilypond;

static NEXT_DIRECTORY_ID: AtomicU64 = AtomicU64::new(0);

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        let root = std::env::temp_dir();
        for _ in 0..32 {
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock is after UNIX epoch")
                .as_nanos();
            let id = NEXT_DIRECTORY_ID.fetch_add(1, Ordering::Relaxed);
            let path = root.join(format!(
                "wasabipad-lilypond-test-{}-{timestamp}-{id}",
                std::process::id()
            ));
            match fs::create_dir(&path) {
                Ok(()) => return Self(path),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("create test directory: {error}"),
            }
        }
        panic!("could not reserve a unique test directory");
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn configured_lilypond() -> Option<PathBuf> {
    let executable = std::env::var_os("WASABIPAD_LILYPOND_EXE").map(PathBuf::from);
    if let Some(path) = &executable {
        assert!(
            path.is_file(),
            "WASABIPAD_LILYPOND_EXE is not a file: {}",
            path.display()
        );
    }
    executable
}

fn fixture_directory() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("tests")
        .join("fixtures")
        .join("music-preview")
}

fn fixture_source(file_name: &str) -> (PathBuf, String) {
    let path = fixture_directory().join(file_name);
    let source = fs::read_to_string(&path).expect("read LilyPond fixture");
    (path, source)
}

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

fn fake_lilypond(root: &Path, name: &str, keep_running: bool) -> PathBuf {
    #[cfg(windows)]
    {
        let path = root.join(format!("{name}.cmd"));
        let repeat = if keep_running {
            "goto write_output"
        } else {
            "exit /b 1"
        };
        fs::write(
            &path,
            format!("@echo off\r\necho synthetic syntax error 1>&2\r\n:write_output\r\nfor /L %%i in (1,1,20000) do (\r\n  echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\r\n  echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx 1>&2\r\n)\r\n{repeat}\r\n"),
        )
        .expect("write fake LilyPond batch file");
        path
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;

        let path = root.join(name);
        let body = if keep_running {
            "while :; do printf '%s' \"$chunk\"; printf '%s' \"$chunk\" >&2; done"
        } else {
            "printf '%s' \"$chunk\"; printf '%s' \"$chunk\" >&2; exit 1"
        };
        fs::write(
            &path,
            format!(
                "#!/bin/sh\nchunk=$(head -c 1100000 /dev/zero | tr '\\0' x)\nprintf '%s\\n' 'synthetic syntax error' >&2\n{body}\n"
            ),
        )
        .expect("write fake LilyPond shell script");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
            .expect("make fake LilyPond executable");
        path
    }
}

// Feature: LilyPondの編集bufferからプレビュー用SVGとMIDIを生成する
// Scenario Outline: CLIがscoreとbookの構造に応じた全出力を返す
// Given: SVGとMIDIの有無が異なる保存済みfixtureがある
// When: 公開run_lilypond seamへfixtureの内容と保存元pathを渡す
// Then: SVGページはbook/page順、MIDIは出力番号順で全件返る
// Examples: single.ly、two-books.ly、two-scores.ly、no-midi.ly
#[test]
fn renders_all_supported_fixture_shapes() {
    let Some(executable) = configured_lilypond() else {
        eprintln!("Skipping LilyPond CLI scenarios: WASABIPAD_LILYPOND_EXE is not set");
        return;
    };

    let examples: [(&str, &[&str], &[&str], &[&str]); 4] = [
        ("single.ly", &["output.svg"], &["output.mid"], &["Single"]),
        (
            "two-books.ly",
            &[
                "output-1.svg",
                "output-2.svg",
                "output-1-1.svg",
                "output-1-2.svg",
            ],
            &["output.mid", "output-1.mid"],
            &["Alpha", "Beta"],
        ),
        (
            "two-scores.ly",
            &["output.svg"],
            &["output.mid", "output-1.mid"],
            &["Alpha", "Beta"],
        ),
        ("no-midi.ly", &["output.svg"], &[], &[]),
    ];

    for (file_name, expected_pages, expected_midis, expected_titles) in examples {
        let (source_path, source) = fixture_source(file_name);
        let result = run_lilypond(
            &executable,
            Some(&source_path),
            &source,
            TestDirectory::new().path(),
            Duration::from_secs(30),
            &AtomicBool::new(false),
        )
        .unwrap_or_else(|error| panic!("{file_name} failed: {error}"));

        let page_names: Vec<_> = result
            .svg_pages
            .iter()
            .map(|page| page.file_name.as_str())
            .collect();
        assert_eq!(page_names, expected_pages, "SVG order for {file_name}");
        assert!(result
            .svg_pages
            .iter()
            .all(|page| page.content.contains("<svg")));

        let midi_names: Vec<_> = result
            .midi_files
            .iter()
            .map(|midi| midi.display_name.as_str())
            .collect();
        assert_eq!(midi_names, expected_midis, "MIDI order for {file_name}");
        assert!(result
            .midi_files
            .iter()
            .all(|midi| midi.bytes.starts_with(b"MThd")));
        assert!(expected_titles
            .iter()
            .enumerate()
            .all(|(index, title)| contains_bytes(
                &result.midi_files[index].bytes,
                title.as_bytes()
            )));
    }
}

// Feature: LilyPondは未保存の主文書snapshotから生成する
// Scenario: 保存済み文書の編集bufferを使い、元ファイルを変更しない
// Given: 日本語と空白を含むpathにtwo-books.lyと相対includeが保存されている
// When: Betaのtitleだけを変更したbufferで公開run_lilypond seamを呼ぶ
// Then: MIDIは変更後titleを持ち、元ファイルのbytesは前後で一致する
#[test]
fn renders_unsaved_source_without_changing_the_saved_file() {
    let Some(executable) = configured_lilypond() else {
        eprintln!("Skipping unsaved-source scenario: WASABIPAD_LILYPOND_EXE is not set");
        return;
    };

    let fixture_directory = fixture_directory();
    let files = TestDirectory::new();
    let source_directory = files.path().join("楽譜 source space");
    let work_root = files.path().join("LilyPond output space");
    fs::create_dir(&source_directory).expect("create Japanese source directory");
    fs::create_dir(&work_root).expect("create output directory with spaces");
    let source_path = source_directory.join("two-books.ly");
    fs::copy(fixture_directory.join("two-books.ly"), &source_path).expect("copy two-books fixture");
    fs::copy(
        fixture_directory.join("shared-settings.ily"),
        source_directory.join("shared-settings.ily"),
    )
    .expect("copy relative include fixture");
    let saved_source = fs::read_to_string(&source_path).expect("read saved source fixture");
    let saved_bytes = fs::read(&source_path).expect("read saved fixture bytes");
    let edited_source = saved_source.replace("title = \"Beta\"", "title = \"Unsaved Beta\"");
    assert_ne!(
        edited_source, saved_source,
        "fixture title should be replaced"
    );

    let result = run_lilypond(
        &executable,
        Some(&source_path),
        &edited_source,
        &work_root,
        Duration::from_secs(30),
        &AtomicBool::new(false),
    )
    .expect("render edited buffer snapshot");

    assert!(contains_bytes(&result.midi_files[1].bytes, b"Unsaved Beta"));
    assert_eq!(
        fs::read(&source_path).expect("reread saved fixture"),
        saved_bytes
    );
}

// Feature: LilyPond生成エラーをpreview成功として扱わない
// Scenario: 構文エラーでCLIが失敗する
// Given: 閉じ括弧が不足した未保存sourceがある
// When: 公開run_lilypond seamで生成する
// Then: エラーになり、CLIの診断を呼び出し側へ返す
#[test]
fn reports_lilypond_syntax_errors() {
    let Some(executable) = configured_lilypond() else {
        eprintln!("Skipping syntax-error scenario: WASABIPAD_LILYPOND_EXE is not set");
        return;
    };

    let source = "\\version \"2.26.0\"\n\\score { \\new Staff { c4 }\n";
    let error = run_lilypond(
        &executable,
        None,
        source,
        TestDirectory::new().path(),
        Duration::from_secs(30),
        &AtomicBool::new(false),
    )
    .expect_err("syntax error must not return successful outputs");
    assert!(
        error.to_lowercase().contains("error"),
        "diagnostic: {error}"
    );
}

// Feature: LilyPond外部処理に中止と時間制限を適用する
// Scenario: 期限切れまたは実行中の中止を成功出力として扱わない
// Given: 有効なsingle.lyと、処理中のSchemeループsourceがある
// When: timeoutを0にするか処理中にcancelledをtrueにする
// Then: 子処理を終了・回収して理由を返す
#[test]
fn stops_generation_on_timeout_or_cancellation() {
    let Some(executable) = configured_lilypond() else {
        eprintln!("Skipping timeout/cancellation scenarios: WASABIPAD_LILYPOND_EXE is not set");
        return;
    };

    let (source_path, source) = fixture_source("single.ly");
    let timeout_error = run_lilypond(
        &executable,
        Some(&source_path),
        &source,
        TestDirectory::new().path(),
        Duration::ZERO,
        &AtomicBool::new(false),
    )
    .expect_err("zero timeout must stop generation");
    assert!(timeout_error.to_lowercase().contains("timed out"));

    let looping_source = "\\version \"2.26.0\"\n#(let loop () (loop))\n";
    let work_root = TestDirectory::new();
    let cancelled = Arc::new(AtomicBool::new(false));
    let signal = Arc::clone(&cancelled);
    let cancel_error = thread::scope(|scope| {
        scope.spawn(move || {
            thread::sleep(Duration::from_millis(250));
            signal.store(true, Ordering::Release);
        });
        run_lilypond(
            &executable,
            Some(&source_path),
            looping_source,
            work_root.path(),
            Duration::from_secs(30),
            &cancelled,
        )
    })
    .expect_err("in-flight cancellation must stop generation");
    assert!(cancel_error.to_lowercase().contains("cancel"));
}

// Feature: LilyPondの診断出力を有限の資源として扱う
// Scenario: 大量のstdoutとstderrを出すCLIが失敗または中止する
// Given: 1 MiBを超える両方の出力を出す偽のLilyPond実行ファイルがある
// When: 公開run_lilypond seamを失敗と実行中の中止で呼ぶ
// Then: 構文診断とcapture上限を返し、処理とreaderを回収して呼び出し元へ戻る
#[test]
fn caps_noisy_diagnostics_and_reaps_readers_after_failure_or_cancellation() {
    let root = TestDirectory::new();
    let failing = fake_lilypond(root.path(), "noisy-failure", false);
    let error = run_lilypond(
        &failing,
        None,
        "ignored by fake executable",
        root.path(),
        Duration::from_secs(30),
        &AtomicBool::new(false),
    )
    .expect_err("noisy failing CLI must return an error");
    assert!(
        error.contains("synthetic syntax error"),
        "diagnostic: {error}"
    );
    assert!(
        error.contains("[stderr capture capped at 1 MiB]"),
        "diagnostic cap: {error}"
    );
    assert!(
        error.contains("[stdout capture capped at 1 MiB]"),
        "stdout cap: {error}"
    );
    assert!(
        error.len() < 10_000,
        "error must stay bounded: {}",
        error.len()
    );

    let running = fake_lilypond(root.path(), "noisy-cancellation", true);
    let cancelled = Arc::new(AtomicBool::new(false));
    let signal = Arc::clone(&cancelled);
    let cancel_error = thread::scope(|scope| {
        scope.spawn(move || {
            thread::sleep(Duration::from_millis(100));
            signal.store(true, Ordering::Release);
        });
        run_lilypond(
            &running,
            None,
            "ignored by fake executable",
            root.path(),
            Duration::from_secs(30),
            &cancelled,
        )
    })
    .expect_err("cancelling noisy CLI must reap the process and readers");
    assert!(cancel_error.to_lowercase().contains("cancel"));
}

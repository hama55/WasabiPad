#[path = "../src/external_preview_runner.rs"]
mod external_preview_runner;

use external_preview_runner::{cleanup_job, run_external_preview, ExternalPreviewFormat};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

static NEXT_DIRECTORY_ID: AtomicU64 = AtomicU64::new(0);

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock is after UNIX epoch")
            .as_nanos();
        let id = NEXT_DIRECTORY_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "wasabipad external preview test {} {timestamp} {id}",
            std::process::id()
        ));
        fs::create_dir(&path).expect("create test directory");
        Self(path)
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

fn external_program() -> (PathBuf, Vec<String>, &'static str) {
    #[cfg(windows)]
    {
        let windows_root = std::env::var_os("SystemRoot").expect("SystemRoot is set");
        (
            PathBuf::from(windows_root).join("System32/certutil.exe"),
            vec![
                "-decode".to_owned(),
                "{file}".to_owned(),
                "{output}".to_owned(),
            ],
            "PGh0bWw+cHJldmlldzwvaHRtbD4=",
        )
    }
    #[cfg(unix)]
    {
        (
            PathBuf::from("cp"),
            vec!["{file}".to_owned(), "{output}".to_owned()],
            "<html>preview</html>",
        )
    }
}

fn fake_program_with_body(root: &Path, body: &str) -> PathBuf {
    #[cfg(windows)]
    let path = root.join("fake external failure.cmd");
    #[cfg(unix)]
    let path = root.join("fake external failure");
    fs::write(&path, body).expect("write fake external program");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
            .expect("make fake external program executable");
    }
    path
}

fn fake_failure_program(root: &Path) -> PathBuf {
    #[cfg(windows)]
    let body = "@echo off\r\nexit /b 7\r\n";
    #[cfg(unix)]
    let body = "#!/bin/sh\nexit 7\n";
    fake_program_with_body(root, body)
}

fn fake_missing_output_program(root: &Path) -> PathBuf {
    #[cfg(windows)]
    let body = "@echo off\r\nexit /b 0\r\n";
    #[cfg(unix)]
    let body = "#!/bin/sh\nexit 0\n";
    fake_program_with_body(root, body)
}

fn fake_slow_program(root: &Path) -> PathBuf {
    #[cfg(windows)]
    let body = "@echo off\r\nping 127.0.0.1 -n 30 > nul\r\nexit /b 0\r\n";
    #[cfg(unix)]
    let body = "#!/bin/sh\nsleep 30\nexit 0\n";
    fake_program_with_body(root, body)
}

// Feature: 外部プログラムへのファイル受け渡し
// Scenario: 空白を含む保存済みファイルを単一引数として渡し、一意なHTMLを得る
// Given: 空白を含む保存済み入力ファイルがある
// When: {file}と{output}を指定して公開runner seamを実行する
// Then: 入力を1引数で受け取り、各実行専用フォルダに異なるHTML入口を生成する
#[test]
fn saved_file_with_spaces_is_one_argument_and_each_run_gets_unique_html() {
    let directory = TestDirectory::new();
    let input_path = directory.path().join("saved score with spaces.txt");
    let (executable, arguments, input) = external_program();
    fs::write(&input_path, input).expect("write saved input");
    let cancelled = AtomicBool::new(false);
    let work_root = directory.path().join("run jobs");

    let first = run_external_preview(
        &executable,
        &arguments,
        &input_path,
        ExternalPreviewFormat::Html,
        &work_root,
        Duration::from_secs(5),
        &cancelled,
    )
    .expect("first external preview succeeds");
    let first_path = first.output_path.clone();
    assert!(first_path.is_file());
    assert_eq!(
        fs::read_to_string(&first_path).unwrap(),
        "<html>preview</html>"
    );

    let second = run_external_preview(
        &executable,
        &arguments,
        &input_path,
        ExternalPreviewFormat::Html,
        &work_root,
        Duration::from_secs(5),
        &cancelled,
    )
    .expect("second external preview succeeds");
    assert_ne!(first_path, second.output_path);
    assert!(second.output_path.is_file());

    // Given: WasabiPadが作成したjobの入口出力と、job外の入力ファイルがある
    // When: cleanup_jobをそれぞれへ適用する
    // Then: jobだけが削除され、job外のファイルは削除対象にならない
    cleanup_job(&second.output_path, &work_root).expect("clean external preview job");
    assert!(!second.output_path.exists());
    cleanup_job(&second.output_path, &work_root).expect("repeat cleanup is idempotent");
    assert!(cleanup_job(&input_path, &work_root).is_err());
}

// Feature: 外部プレビューの失敗境界
// Scenario: 外部プログラムの非0終了を成功扱いしない
// Given: 非0で終了する外部プログラムがある
// When: 公開runner seamを実行する
// Then: 終了エラーを返す
#[test]
fn rejects_nonzero_external_exit() {
    let directory = TestDirectory::new();
    let input_path = directory.path().join("input.txt");
    fs::write(&input_path, "input").unwrap();
    let executable = fake_failure_program(directory.path());
    let error = run_external_preview(
        &executable,
        &["{file}".to_owned(), "{output}".to_owned()],
        &input_path,
        ExternalPreviewFormat::Svg,
        &directory.path().join("jobs"),
        Duration::from_secs(5),
        &AtomicBool::new(false),
    )
    .expect_err("nonzero exit must fail");
    assert!(error.contains("exited"));
}

// Feature: 外部プレビューの失敗境界
// Scenario: 成功終了でも入口出力がなければ失敗にする
// Given: 出力を作らず成功終了する外部プログラムがある
// When: 公開runner seamを実行する
// Then: 出力不足エラーを返す
#[test]
fn rejects_missing_output_after_successful_exit() {
    let directory = TestDirectory::new();
    let input_path = directory.path().join("input.txt");
    fs::write(&input_path, "input").unwrap();
    let executable = fake_missing_output_program(directory.path());
    let error = run_external_preview(
        &executable,
        &["{file}".to_owned(), "{output}".to_owned()],
        &input_path,
        ExternalPreviewFormat::Html,
        &directory.path().join("jobs"),
        Duration::from_secs(5),
        &AtomicBool::new(false),
    )
    .expect_err("missing output must fail");
    assert!(error.contains("missing"));
}

// Feature: 外部プレビューの失敗境界
// Scenario: タイムアウトと取消を成功扱いしない
// Given: 終了まで長い外部プログラムがある
// When: 短いtimeoutまたは実行中のcancel flagで公開runner seamを実行する
// Then: 子プロセスを終了して該当エラーを返す
#[test]
fn rejects_timeout_and_cancellation() {
    let directory = TestDirectory::new();
    let input_path = directory.path().join("input.txt");
    fs::write(&input_path, "input").unwrap();
    let executable = fake_slow_program(directory.path());
    let arguments = vec!["{file}".to_owned(), "{output}".to_owned()];
    let timeout_error = run_external_preview(
        &executable,
        &arguments,
        &input_path,
        ExternalPreviewFormat::Html,
        &directory.path().join("timeout jobs"),
        Duration::from_millis(10),
        &AtomicBool::new(false),
    )
    .expect_err("timeout must fail");
    assert!(timeout_error.contains("timed out"));

    let cancelled = Arc::new(AtomicBool::new(false));
    let cancelled_in_thread = cancelled.clone();
    let executable_in_thread = executable.clone();
    let input_in_thread = input_path.clone();
    let work_root = directory.path().join("cancel jobs");
    let worker = thread::spawn(move || {
        run_external_preview(
            &executable_in_thread,
            &arguments,
            &input_in_thread,
            ExternalPreviewFormat::Html,
            &work_root,
            Duration::from_secs(30),
            &cancelled_in_thread,
        )
    });
    thread::sleep(Duration::from_millis(50));
    cancelled.store(true, Ordering::Release);
    let cancel_error = worker
        .join()
        .expect("cancellation worker should join")
        .expect_err("cancellation must fail");
    assert!(cancel_error.contains("cancelled"));
}

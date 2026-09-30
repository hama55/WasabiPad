#[path = "../src/external_preview_runner.rs"]
mod external_preview_runner;

use external_preview_runner::{
    cleanup_job, cleanup_stale_jobs, run_external_preview, ExternalPreviewFormat,
    ExternalPreviewOperations,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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

const OWNER_WORK_ROOT_ENV: &str = "WASABIPAD_TEST_EXTERNAL_PREVIEW_OWNER_ROOT";
const OWNER_INPUT_PATH_ENV: &str = "WASABIPAD_TEST_EXTERNAL_PREVIEW_OWNER_INPUT";
const OWNER_READY_PATH_ENV: &str = "WASABIPAD_TEST_EXTERNAL_PREVIEW_OWNER_READY";
const OWNER_RELEASE_PATH_ENV: &str = "WASABIPAD_TEST_EXTERNAL_PREVIEW_OWNER_RELEASE";

struct PreviewOwnerProcess {
    child: Option<Child>,
    ready_path: PathBuf,
    release_path: PathBuf,
}

impl PreviewOwnerProcess {
    fn spawn(directory: &TestDirectory, work_root: &Path) -> Self {
        let ready_path = directory.path().join("child output ready");
        let release_path = directory.path().join("release child");
        let input_path = directory.path().join("child score.abc");
        let child = Command::new(std::env::current_exe().expect("resolve test executable"))
            .args([
                "--exact",
                "hold_external_preview_job_for_cleanup_test",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(OWNER_WORK_ROOT_ENV, work_root)
            .env(OWNER_INPUT_PATH_ENV, input_path)
            .env(OWNER_READY_PATH_ENV, &ready_path)
            .env(OWNER_RELEASE_PATH_ENV, &release_path)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("start a second test process as the live output owner");
        Self {
            child: Some(child),
            ready_path,
            release_path,
        }
    }

    fn output_path(&mut self) -> PathBuf {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if self.ready_path.is_file() {
                return PathBuf::from(
                    fs::read_to_string(&self.ready_path).expect("read child output path"),
                );
            }
            let child = self.child.as_mut().expect("child process is running");
            if let Some(status) = child.try_wait().expect("check child process") {
                panic!("child exited before creating its output: {status}");
            }
            assert!(
                Instant::now() < deadline,
                "child did not create output in time"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn finish(&mut self) {
        fs::write(&self.release_path, "release").expect("release child process");
        let mut child = self.child.take().expect("child process is running");
        let status = child.wait().expect("wait for child process");
        assert!(status.success(), "child process failed: {status}");
    }
}

impl Drop for PreviewOwnerProcess {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = fs::write(&self.release_path, "release");
            if child.try_wait().ok().flatten().is_none() {
                let _ = child.kill();
            }
            let _ = child.wait();
        }
    }
}

// Feature: 外部プレビューの別process所有ジョブ
// Scenario: cleanup helper processとして親の指示まで保持する
// Given: 親テストが子process用のrunner引数を渡している
// When: 子processが外部プレビュー出力を作って待機する
// Then: 親が確認した後にだけ子processが終了する
#[test]
fn hold_external_preview_job_for_cleanup_test() {
    let Some(work_root) = std::env::var_os(OWNER_WORK_ROOT_ENV).map(PathBuf::from) else {
        return;
    };
    let input_path = PathBuf::from(
        std::env::var_os(OWNER_INPUT_PATH_ENV).expect("child input path is configured"),
    );
    let ready_path = PathBuf::from(
        std::env::var_os(OWNER_READY_PATH_ENV).expect("child ready path is configured"),
    );
    let release_path = PathBuf::from(
        std::env::var_os(OWNER_RELEASE_PATH_ENV).expect("child release path is configured"),
    );
    let (executable, arguments, input) = external_program();
    fs::write(&input_path, input).expect("write child input");
    let result = run_external_preview(
        &executable,
        &arguments,
        &input_path,
        ExternalPreviewFormat::Html,
        &work_root,
        Duration::from_secs(10),
        &AtomicBool::new(false),
    )
    .expect("child external preview succeeds");
    fs::write(&ready_path, result.output_path.to_string_lossy().as_bytes())
        .expect("publish child output path");
    while !release_path.exists() {
        thread::sleep(Duration::from_millis(10));
    }
}

// Feature: 外部プレビューの起動時掃除
// Scenario: 別processが表示中の出力は保持し、終了後にstaleとして回収する
// Given: もう一つのWasabiPad processがrunnerで生成したHTMLを保持している
// When: 親processがcleanupを行い、その後、所有process終了後に再度cleanupする
// Then: 生存中の出力は残り、終了したprocessのjobは次回cleanupで削除される
#[test]
fn cleanup_stale_jobs_preserves_live_process_output_then_reclaims_it_after_exit() {
    let directory = TestDirectory::new();
    let work_root = directory.path().join("shared external preview jobs");
    let mut owner = PreviewOwnerProcess::spawn(&directory, &work_root);
    let output_path = owner.output_path();

    cleanup_stale_jobs(&work_root).expect("clean stale jobs without removing live process output");
    assert!(
        output_path.is_file(),
        "a live process still owns the displayed output"
    );

    owner.finish();
    cleanup_stale_jobs(&work_root).expect("clean output after its owner exits");
    assert!(
        !output_path.exists(),
        "the crashed/exited process output is reclaimed"
    );
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
    let body = "@echo off\r\necho adapter stdout\r\necho adapter failure 1>&2\r\nexit /b 7\r\n";
    #[cfg(unix)]
    let body = "#!/bin/sh\nprintf 'adapter stdout\\n'\nprintf 'adapter failure\\n' >&2\nexit 7\n";
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

// Feature: 外部プレビューの一時成果物掃除
// Scenario: 入口HTMLが先に消えても付属資産を回収しIPC記録を解放する
// Given: 完了済みjobに入口HTMLと大きな付属資産があり、IPC registryが出力を記録している
// When: 入口HTML消失後に通常のcleanup経路を実行する
// Then: job全体が削除され、同じrequest IDを再登録できる
#[test]
fn cleanup_removes_assets_and_releases_record_when_entry_output_is_missing() {
    let directory = TestDirectory::new();
    let input_path = directory.path().join("saved score.abc");
    let (executable, arguments, input) = external_program();
    fs::write(&input_path, input).expect("write saved input");
    let work_root = directory.path().join("run jobs");
    let operations = ExternalPreviewOperations::default();
    let (cancelled, _) = operations
        .register("missing-entry-output", &input_path)
        .expect("register external preview");
    let result = run_external_preview(
        &executable,
        &arguments,
        &input_path,
        ExternalPreviewFormat::Html,
        &work_root,
        Duration::from_secs(5),
        &cancelled,
    )
    .expect("external preview succeeds");
    operations
        .finish_success(
            "missing-entry-output",
            &cancelled,
            &result.output_path,
            &work_root,
        )
        .expect("record completed output");
    let job_directory = result.output_path.parent().unwrap().to_path_buf();
    let attachment = job_directory.join("large-audio-library.dat");
    fs::write(&attachment, vec![0x5a; 1024]).expect("write external attachment");
    fs::remove_file(&result.output_path).expect("simulate entry HTML removed by viewer");

    // When: IPC cleanupが同じ生成パスを掃除し、完了記録を解放する
    operations
        .cleanup_output(&result.output_path)
        .expect("clean job using its configured work root");

    // Then: 付属資産もなくなり、request IDの記録は残らない
    assert!(
        !job_directory.exists(),
        "the attachment is reclaimed with its job"
    );
    assert!(operations
        .register("missing-entry-output", &input_path)
        .is_ok());
    operations.cancel("missing-entry-output").unwrap();
}

// Feature: 外部プレビュー起動時の孤児フォルダ掃除
// Scenario: 現在と過去の保存先からクラッシュ孤児を回収し、稼働中PIDと不正名は保持する
// Given: 両方の保存先にmarkerのないjob名形式の孤児があり、稼働中processと不正名もある
// When: cleanup_stale_rootsへ両方の保存先を渡す
// Then: 死亡PIDの孤児だけを削除し、稼働中processと不正名の内容は保持する
#[test]
fn cleanup_stale_jobs_reclaims_unmarked_orphans_without_touching_live_or_unowned_dirs() {
    let directory = TestDirectory::new();
    let work_root = directory.path().join("isolated work root");
    let previous_work_root = directory.path().join("previous work root");
    fs::create_dir_all(&work_root).expect("create isolated work root");
    fs::create_dir_all(&previous_work_root).expect("create previous isolated work root");
    let stale_job = work_root.join("external-preview-job-4294967295-12345-1");
    fs::create_dir(&stale_job).expect("create marker-window orphan");
    fs::write(stale_job.join("attachment.dat"), "orphan").expect("write orphan asset");
    let previous_stale_job = previous_work_root.join("external-preview-job-4294967295-12345-3");
    fs::create_dir(&previous_stale_job).expect("create previous-root orphan");
    fs::write(previous_stale_job.join("attachment.dat"), "old orphan")
        .expect("write previous-root orphan asset");
    let live_job = work_root.join(format!(
        "external-preview-job-{}-12345-2",
        std::process::id()
    ));
    fs::create_dir(&live_job).expect("create unmarked live job");
    fs::write(live_job.join("attachment.dat"), "active").expect("write active asset");
    let unowned_dir = work_root.join("external-preview-job-not-a-job");
    fs::create_dir(&unowned_dir).expect("create similarly prefixed unrelated directory");
    fs::write(unowned_dir.join("keep.dat"), "unowned").expect("write unrelated asset");

    ExternalPreviewOperations::default()
        .cleanup_stale_roots(&[work_root, previous_work_root])
        .expect("clean verified stale WasabiPad jobs from current and previous roots");

    assert!(
        !stale_job.exists(),
        "the dead-PID marker-window orphan is reclaimed"
    );
    assert!(
        !previous_stale_job.exists(),
        "the previous saved root is also scanned"
    );
    assert!(
        live_job.join("attachment.dat").is_file(),
        "a live owner is preserved"
    );
    assert!(
        unowned_dir.join("keep.dat").is_file(),
        "a malformed name is not owned"
    );
}

// Feature: 外部プレビューの置換と一時成果物の寿命
// Scenario: 同じ入力の再生成中と失敗後も、表示中の完了済み出力を保持する
// Given: 完了した外部出力を現在のプレビューが表示している
// When: 同じ入力で新しい生成を登録し、その生成が失敗する
// Then: 旧出力は明示的なcleanupまで存在し続ける
#[test]
fn keeps_completed_output_until_explicit_cleanup_during_replacement() {
    let directory = TestDirectory::new();
    let input_path = directory.path().join("saved score.abc");
    let (executable, arguments, input) = external_program();
    fs::write(&input_path, input).expect("write saved input");
    let work_root = directory.path().join("run jobs");
    let operations = ExternalPreviewOperations::default();

    let (first_cancelled, _) = operations
        .register("displayed-output", &input_path)
        .expect("register first generation");
    let first = run_external_preview(
        &executable,
        &arguments,
        &input_path,
        ExternalPreviewFormat::Html,
        &work_root,
        Duration::from_secs(5),
        &first_cancelled,
    )
    .expect("first generation succeeds");
    operations
        .finish_success(
            "displayed-output",
            &first_cancelled,
            &first.output_path,
            &work_root,
        )
        .expect("record displayed output");
    assert!(first.output_path.is_file());

    let (replacement_cancelled, _) = operations
        .register("pending-replacement", &input_path)
        .expect("register replacement generation");
    assert!(
        first.output_path.is_file(),
        "the active preview still references this output"
    );

    drop(operations.guard("pending-replacement".to_owned(), replacement_cancelled));
    assert!(
        first.output_path.is_file(),
        "a failed replacement must not remove the active output"
    );

    operations
        .cleanup_output(&first.output_path)
        .expect("clean retired output after replacement");
    assert!(!first.output_path.exists());
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
    assert!(error.contains("adapter stdout"));
    assert!(error.contains("adapter failure"));
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

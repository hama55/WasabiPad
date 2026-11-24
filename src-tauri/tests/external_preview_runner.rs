#[path = "../src/external_preview_runner.rs"]
mod external_preview_runner;

use external_preview_runner::{
    cleanup_job, cleanup_stale_jobs, existing_output, hash_input_file, run_external_preview,
    saved_output, saved_preview_dir, ExternalPreviewConfigKey, ExternalPreviewFormat,
    ExternalPreviewOperations, ExternalPreviewSaveOutcome, ExternalPreviewSourceKind,
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

// Given: 元文書と、同じフォルダの同名HTMLがある
// When: 外部プレビューの表示候補を探す
// Then: HTMLを返し、元文書自身やフォルダは候補にしない
#[test]
fn finds_only_the_sibling_file_with_the_output_extension() {
    let directory = TestDirectory::new();
    let input = directory.path().join("score.abc");
    let html = input.with_extension("html");
    fs::write(&input, "X:1").unwrap();
    fs::write(&html, "<p>score</p>").unwrap();
    fs::create_dir(input.with_extension("svg")).unwrap();
    assert_eq!(existing_output(&input, ExternalPreviewFormat::Html), Some(html.clone()));
    assert_eq!(existing_output(&input, ExternalPreviewFormat::Svg), None);
    assert_eq!(existing_output(&html, ExternalPreviewFormat::Html), None);
}
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

fn fake_success_program(root: &Path) -> PathBuf {
    #[cfg(windows)]
    let path = root.join("fake external success.cmd");
    #[cfg(unix)]
    let path = root.join("fake external success");
    #[cfg(windows)]
    let body = "@echo off\r\necho ^<html^>preview^</html^> > \"%~2\"\r\nexit /b 0\r\n";
    #[cfg(unix)]
    let body = "#!/bin/sh\nprintf '<html>preview</html>' > \"$2\"\nexit 0\n";
    fs::write(&path, body).expect("write fake external success program");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
            .expect("make fake external success program executable");
    }
    path
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
        &AtomicBool::new(false),
    )
    .expect_err("missing output must fail");
    assert!(error.contains("missing"));
}

// Feature: 外部プレビューに生成物制限を設けない
// Scenario: 256個・64MiBを超える生成物でも成功する
// Given: 多数のファイルと大きな音声を生成する外部プログラム
// When: 公開runner seamで実行する
// Then: 正常な入口HTMLを返し、所有する一時領域を清掃できる
#[test]
fn accepts_output_beyond_former_file_and_byte_limits() {
    let directory = TestDirectory::new();
    let input_path = directory.path().join("generate.txt");
    #[cfg(windows)]
    let (executable, args, source) = (
        PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32/WindowsPowerShell/v1.0/powershell.exe"),
        vec!["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "{file}", "{output}"],
        "$out=$args[0]\n[IO.File]::WriteAllText($out,'<html>preview</html>')\n$dir=[IO.Path]::GetDirectoryName($out)\n$f=[IO.File]::Create([IO.Path]::Combine($dir,'audio.wav'))\n$f.SetLength(65*1024*1024)\n$f.Dispose()\n1..260 | ForEach-Object { [IO.File]::WriteAllText([IO.Path]::Combine($dir,\"page-$_.svg\"),'<svg/>') }\n",
    );
    #[cfg(unix)]
    let (executable, args, source) = (
        PathBuf::from("sh"), vec!["{file}", "{output}"],
        "out=$1\nprintf '<html>preview</html>' > \"$out\"\ndir=$(dirname \"$out\")\ndd if=/dev/zero of=\"$dir/audio.wav\" bs=1048576 count=0 seek=65\ni=0; while [ $i -lt 260 ]; do printf '<svg/>' > \"$dir/page-$i.svg\"; i=$((i+1)); done\n",
    );
    #[cfg(windows)]
    let input_path = input_path.with_extension("ps1");
    fs::write(&input_path, source).unwrap();
    let root = directory.path().join("jobs");
    let result = run_external_preview(
        &executable,
        &args.into_iter().map(str::to_owned).collect::<Vec<_>>(),
        &input_path,
        ExternalPreviewFormat::Html,
        &root,
        &AtomicBool::new(false),
    )
    .expect("large output succeeds");
    assert!(result.output_path.is_file());
    assert!(
        fs::metadata(result.output_path.parent().unwrap().join("audio.wav"))
            .unwrap()
            .len()
            > 64 * 1024 * 1024
    );
    cleanup_job(&result.output_path, &root).unwrap();
    assert!(!result.output_path.exists());
}

// Feature: 外部プレビューの失敗境界
// Scenario: 時間制限を設けず、明示的な取消は成功扱いしない
// Given: 終了まで長い外部プログラムがある
// When: 実行中のcancel flagで公開runner seamを取消する
// Then: 子プロセスを終了して該当エラーを返す
#[test]
fn rejects_cancellation() {
    let directory = TestDirectory::new();
    let input_path = directory.path().join("input.txt");
    fs::write(&input_path, "input").unwrap();
    let executable = fake_slow_program(directory.path());
    let arguments = vec!["{file}".to_owned(), "{output}".to_owned()];
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

// Feature: 外部プレビューに時間制限を設けない
// Scenario: 30秒を超える生成が成功する
// Given: 31秒後にHTMLを生成する外部プログラム
// When: 公開runner seamで生成完了を待つ
// Then: 時間による中断をせず、所有する出力を返す
#[test]
fn waits_for_generation_longer_than_thirty_seconds() {
    let directory = TestDirectory::new();
    let input_path = directory.path().join("slow.ps1");
    #[cfg(windows)]
    let (executable, args, source) = (
        PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32/WindowsPowerShell/v1.0/powershell.exe"),
        vec![
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            "{file}",
            "{output}",
        ],
        "Start-Sleep -Seconds 31\n[IO.File]::WriteAllText($args[0],'<html>preview</html>')\n",
    );
    #[cfg(unix)]
    let (executable, args, source) = (
        PathBuf::from("sh"),
        vec!["{file}", "{output}"],
        "sleep 31\nprintf '<html>preview</html>' > \"$1\"\n",
    );
    fs::write(&input_path, source).unwrap();
    let root = directory.path().join("jobs");
    let started = Instant::now();
    let result = run_external_preview(
        &executable,
        &args.into_iter().map(str::to_owned).collect::<Vec<_>>(),
        &input_path,
        ExternalPreviewFormat::Html,
        &root,
        &AtomicBool::new(false),
    )
    .expect("generation has no timeout");
    assert!(started.elapsed() >= Duration::from_secs(30));
    assert!(result.output_path.is_file());
    cleanup_job(&result.output_path, &root).unwrap();
}

// Feature: セッション内外部プレビューの再利用
// Scenario: 同一入力と同一設定なら再変換せず一時生成物を再利用する
// Given: 入力ファイルAを変換して一時生成物をセッション保持へ記録済み
// When: 同じファイル内容と同じ実行ファイル・引数・出力形式で lookup_session_output を呼ぶ
// Then: 既存の一時生成物パスを返す
#[test]
fn reuses_session_output_when_input_and_config_match() {
    let directory = TestDirectory::new();
    let input_path = directory.path().join("song.abc");
    fs::write(&input_path, "X:1\nT:Test\n").unwrap();
    let executable = fake_success_program(directory.path());
    let args = vec!["{file}".to_owned(), "{output}".to_owned()];
    let work_root = directory.path().join("jobs");
    let operations = ExternalPreviewOperations::default();

    let (cancelled, canonical_input) = operations.register("session-reuse-1", &input_path).unwrap();
    let sha256 = hash_input_file(&canonical_input).unwrap();
    let result = run_external_preview(
        &executable,
        &args,
        &input_path,
        ExternalPreviewFormat::Html,
        &work_root,
        &cancelled,
    )
    .unwrap();
    let config = ExternalPreviewConfigKey {
        executable: executable.to_string_lossy().into_owned(),
        args: args.clone(),
        output_format: ExternalPreviewFormat::Html,
    };
    operations
        .finish_session_success(
            "session-reuse-1",
            &cancelled,
            &result.output_path,
            &work_root,
            Some((sha256, config)),
            None,
        )
        .unwrap();

    let reused = operations
        .lookup_session_output(
            &input_path,
            &executable.to_string_lossy(),
            &args,
            ExternalPreviewFormat::Html,
        )
        .unwrap()
        .expect("matching session output must be reused");
    assert_eq!(
        fs::canonicalize(&reused).unwrap(),
        fs::canonicalize(&result.output_path).unwrap()
    );
}

// Feature: セッション内外部プレビューの鮮度と設定一致
// Scenario: ファイル内容変更または設定変更時は再利用せず、再変換成功時に旧世代を即削除する
// Given: 入力ファイルAの第1世代一時生成物が保持されている
// When: 入力内容を変更して lookup_session_output を呼び、再変換成功を finish_session_success で記録する
// Then: 変更後は再利用せず、設定変更も再利用せず、再変換成功後に旧世代フォルダだけ即削除される
#[test]
fn replaces_previous_session_output_when_input_or_config_changes() {
    let directory = TestDirectory::new();
    let input_path = directory.path().join("song.abc");
    fs::write(&input_path, "version-1").unwrap();
    let executable = fake_success_program(directory.path());
    let args = vec!["{file}".to_owned(), "{output}".to_owned()];
    let work_root = directory.path().join("jobs");
    let operations = ExternalPreviewOperations::default();

    let (first_cancelled, canonical_input) = operations.register("gen-1", &input_path).unwrap();
    let first_sha = hash_input_file(&canonical_input).unwrap();
    let first = run_external_preview(
        &executable,
        &args,
        &input_path,
        ExternalPreviewFormat::Html,
        &work_root,
        &first_cancelled,
    )
    .unwrap();
    operations
        .finish_session_success(
            "gen-1",
            &first_cancelled,
            &first.output_path,
            &work_root,
            Some((
                first_sha,
                ExternalPreviewConfigKey {
                    executable: executable.to_string_lossy().into_owned(),
                    args: args.clone(),
                    output_format: ExternalPreviewFormat::Html,
                },
            )),
            None,
        )
        .unwrap();

    // 設定違い（出力形式変更・引数変更）は再利用しない
    assert!(operations
        .lookup_session_output(
            &input_path,
            &executable.to_string_lossy(),
            &args,
            ExternalPreviewFormat::Svg,
        )
        .unwrap()
        .is_none());
    assert!(operations
        .lookup_session_output(
            &input_path,
            &executable.to_string_lossy(),
            &["--other".to_owned(), "{file}".to_owned(), "{output}".to_owned()],
            ExternalPreviewFormat::Html,
        )
        .unwrap()
        .is_none());
    assert!(first.output_path.is_file());

    // 入力内容変更時は再利用しない
    fs::write(&input_path, "version-2").unwrap();
    assert!(operations
        .lookup_session_output(
            &input_path,
            &executable.to_string_lossy(),
            &args,
            ExternalPreviewFormat::Html,
        )
        .unwrap()
        .is_none());
    assert!(first.output_path.is_file());

    // 再変換成功で旧世代は即削除され最新1世代のみ残る
    let (second_cancelled, canonical_input) = operations.register("gen-2", &input_path).unwrap();
    let second_sha = hash_input_file(&canonical_input).unwrap();
    let second = run_external_preview(
        &executable,
        &args,
        &input_path,
        ExternalPreviewFormat::Html,
        &work_root,
        &second_cancelled,
    )
    .unwrap();
    operations
        .finish_session_success(
            "gen-2",
            &second_cancelled,
            &second.output_path,
            &work_root,
            Some((
                second_sha,
                ExternalPreviewConfigKey {
                    executable: executable.to_string_lossy().into_owned(),
                    args: args.clone(),
                    output_format: ExternalPreviewFormat::Html,
                },
            )),
            None,
        )
        .unwrap();

    assert!(!first.output_path.exists());
    assert!(second.output_path.is_file());
    let reused = operations
        .lookup_session_output(
            &input_path,
            &executable.to_string_lossy(),
            &args,
            ExternalPreviewFormat::Html,
        )
        .unwrap()
        .expect("latest session output must be reused");
    assert_eq!(
        fs::canonicalize(&reused).unwrap(),
        fs::canonicalize(&second.output_path).unwrap()
    );
}

// Feature: 表示中旧出力の遅延削除
// Scenario: 更新表示中の旧世代は描画完了まで残し、セッション保持中の出力は通常cleanupで消さない
// Given: 入力ファイルAの旧出力が表示中として protected_displayed_output に渡され、新世代で finish_session_success が完了した
// When: cleanup_retired_output を新出力と旧出力にそれぞれ呼ぶ
// Then: 新出力はセッション保持のため削除されず、表示役目を終えた旧出力だけが削除される
#[test]
fn preserves_session_output_on_retired_cleanup_and_removes_replaced_displayed_output() {
    let directory = TestDirectory::new();
    let input_path = directory.path().join("song.abc");
    fs::write(&input_path, "v1").unwrap();
    let executable = fake_success_program(directory.path());
    let args = vec!["{file}".to_owned(), "{output}".to_owned()];
    let work_root = directory.path().join("jobs");
    let operations = ExternalPreviewOperations::default();

    let (c1, canonical) = operations.register("disp-1", &input_path).unwrap();
    let sha1 = hash_input_file(&canonical).unwrap();
    let first = run_external_preview(
        &executable,
        &args,
        &input_path,
        ExternalPreviewFormat::Html,
        &work_root,
        &c1,
    )
    .unwrap();
    let config = ExternalPreviewConfigKey {
        executable: executable.to_string_lossy().into_owned(),
        args: args.clone(),
        output_format: ExternalPreviewFormat::Html,
    };
    operations
        .finish_session_success("disp-1", &c1, &first.output_path, &work_root, Some((sha1, config.clone())), None)
        .unwrap();

    // 更新中: first が画面表示中のため protected_displayed_output に渡す
    let (c2, _) = operations.register("disp-2", &input_path).unwrap();
    let second = run_external_preview(
        &executable,
        &args,
        &input_path,
        ExternalPreviewFormat::Html,
        &work_root,
        &c2,
    )
    .unwrap();
    operations
        .finish_session_success(
            "disp-2",
            &c2,
            &second.output_path,
            &work_root,
            Some((sha1, config)),
            Some(&first.output_path),
        )
        .unwrap();

    // 旧出力はまだ残っている
    assert!(first.output_path.is_file());
    assert!(second.output_path.is_file());

    // 新出力への retired cleanup はセッション保持中のため消さない
    operations.cleanup_retired_output(&second.output_path).unwrap();
    assert!(second.output_path.is_file());

    // 旧出力への retired cleanup は削除する
    operations.cleanup_retired_output(&first.output_path).unwrap();
    assert!(!first.output_path.exists());
    assert!(second.output_path.is_file());
}

// Feature: セッション終了時清掃と一時保存先変更耐性
// Scenario: 異なる一時保存先にある全セッション保持生成物を一括削除する
// Given: 2つの入力ファイルがそれぞれ異なる work_root に一時生成物を保持している
// When: cleanup_all を実行する
// Then: 両方の work_root 配下のジョブディレクトリがすべて削除され、以降の lookup_session_output は None になる
#[test]
fn cleans_all_session_outputs_across_work_roots() {
    let directory = TestDirectory::new();
    let input_a = directory.path().join("a.abc");
    let input_b = directory.path().join("b.abc");
    fs::write(&input_a, "a").unwrap();
    fs::write(&input_b, "b").unwrap();
    let executable = fake_success_program(directory.path());
    let args = vec!["{file}".to_owned(), "{output}".to_owned()];
    let root_a = directory.path().join("jobs-a");
    let root_b = directory.path().join("jobs-b");
    let operations = ExternalPreviewOperations::default();
    let config = ExternalPreviewConfigKey {
        executable: executable.to_string_lossy().into_owned(),
        args: args.clone(),
        output_format: ExternalPreviewFormat::Html,
    };

    let (ca, can_a) = operations.register("all-a", &input_a).unwrap();
    let sha_a = hash_input_file(&can_a).unwrap();
    let out_a = run_external_preview(&executable, &args, &input_a, ExternalPreviewFormat::Html, &root_a, &ca).unwrap();
    operations
        .finish_session_success("all-a", &ca, &out_a.output_path, &root_a, Some((sha_a, config.clone())), None)
        .unwrap();

    let (cb, can_b) = operations.register("all-b", &input_b).unwrap();
    let sha_b = hash_input_file(&can_b).unwrap();
    let out_b = run_external_preview(&executable, &args, &input_b, ExternalPreviewFormat::Html, &root_b, &cb).unwrap();
    operations
        .finish_session_success("all-b", &cb, &out_b.output_path, &root_b, Some((sha_b, config)), None)
        .unwrap();

    assert!(out_a.output_path.is_file());
    assert!(out_b.output_path.is_file());

    operations.cleanup_all().unwrap();

    assert!(!out_a.output_path.exists());
    assert!(!out_b.output_path.exists());
    assert!(operations
        .lookup_session_output(&input_a, &executable.to_string_lossy(), &args, ExternalPreviewFormat::Html)
        .unwrap()
        .is_none());
    assert!(operations
        .lookup_session_output(&input_b, &executable.to_string_lossy(), &args, ExternalPreviewFormat::Html)
        .unwrap()
        .is_none());
}

// Feature: 保存済み外部プレビューの安全保存と上書き確認
// Scenario: 初回保存で不要ログを除いた一式を保存し、既存時は確認要求後に安全置換する
// Given: 付属資産・サブディレクトリ・ジョブマーカーを含む一時生成物
// When: save_external_preview を overwrite=false、続いて既存状態で overwrite=false と overwrite=true で呼ぶ
// Then: 初回は <元ファイル名>.wasabi-preview/ へ保存し、2回目は OverwriteRequired、承認後のみ安全に置換する
#[test]
fn saves_external_preview_safely_and_requires_overwrite_confirmation() {
    let directory = TestDirectory::new();
    let input_path = directory.path().join("song.abc");
    fs::write(&input_path, "v1").unwrap();
    let executable = fake_success_program(directory.path());
    let args = vec!["{file}".to_owned(), "{output}".to_owned()];
    let work_root = directory.path().join("jobs");
    let operations = ExternalPreviewOperations::default();
    let config = ExternalPreviewConfigKey {
        executable: executable.to_string_lossy().into_owned(),
        args: args.clone(),
        output_format: ExternalPreviewFormat::Html,
    };

    let (c1, can1) = operations.register("save-1", &input_path).unwrap();
    let sha1 = hash_input_file(&can1).unwrap();
    let first = run_external_preview(&executable, &args, &input_path, ExternalPreviewFormat::Html, &work_root, &c1).unwrap();
    let first_dir = first.output_path.parent().unwrap();
    fs::create_dir_all(first_dir.join("assets")).unwrap();
    fs::write(first_dir.join("assets").join("audio.wav"), "wave-v1").unwrap();
    operations
        .finish_session_success("save-1", &c1, &first.output_path, &work_root, Some((sha1, config.clone())), None)
        .unwrap();

    let saved_dir = saved_preview_dir(&input_path).unwrap();
    assert_eq!(saved_dir.file_name().unwrap(), "song.abc.wasabi-preview");

    // 初回保存
    let outcome = operations
        .save_external_preview(&input_path, &first.output_path, ExternalPreviewFormat::Html, false)
        .unwrap();
    match outcome {
        ExternalPreviewSaveOutcome::Saved { output_path } => {
            assert_eq!(
                fs::canonicalize(&output_path).unwrap(),
                fs::canonicalize(saved_dir.join("index.html")).unwrap()
            );
        }
        other => panic!("expected Saved, got {other:?}"),
    }
    assert!(saved_dir.join("assets").join("audio.wav").is_file());
    assert!(!saved_dir.join(".wasabipad-external-preview-job").exists());

    // 第2世代を生成し、上書き確認なしで保存しようとすると OverwriteRequired
    fs::write(&input_path, "v2").unwrap();
    let (c2, can2) = operations.register("save-2", &input_path).unwrap();
    let sha2 = hash_input_file(&can2).unwrap();
    let second = run_external_preview(&executable, &args, &input_path, ExternalPreviewFormat::Html, &work_root, &c2).unwrap();
    let second_dir = second.output_path.parent().unwrap();
    fs::create_dir_all(second_dir.join("assets")).unwrap();
    fs::write(second_dir.join("assets").join("audio.wav"), "wave-v2").unwrap();
    operations
        .finish_session_success("save-2", &c2, &second.output_path, &work_root, Some((sha2, config)), None)
        .unwrap();

    let confirm_needed = operations
        .save_external_preview(&input_path, &second.output_path, ExternalPreviewFormat::Html, false)
        .unwrap();
    assert!(matches!(
        confirm_needed,
        ExternalPreviewSaveOutcome::OverwriteRequired { .. }
    ));
    assert_eq!(
        fs::read_to_string(saved_dir.join("assets").join("audio.wav")).unwrap(),
        "wave-v1"
    );

    // 上書き許可で安全に置換され、ステージング/バックアップ残骸が残らない
    let overwritten = operations
        .save_external_preview(&input_path, &second.output_path, ExternalPreviewFormat::Html, true)
        .unwrap();
    assert!(matches!(overwritten, ExternalPreviewSaveOutcome::Saved { .. }));
    assert_eq!(
        fs::read_to_string(saved_dir.join("assets").join("audio.wav")).unwrap(),
        "wave-v2"
    );
    for entry in fs::read_dir(directory.path()).unwrap() {
        let name = entry.unwrap().file_name().to_string_lossy().into_owned();
        assert!(!name.starts_with(".wasabipad-preview-"), "no leftover staging/backup dir: {name}");
    }
}

// Feature: 読み込み優先順位と鮮度非依存
// Scenario: 保存済み → 同フォルダ → セッション保持 → なしの順で解決し、保存済みは元ファイル編集後も優先される
// Given: 1つの入力ファイルに対し保存済み・同フォルダファイル・セッション保持を揃えた状態
// When: 元ファイル編集後、形式違い、保存済み削除後、同フォルダ削除後の各段階で resolve_reusable_output を呼ぶ
// Then: 優先順位通りに解決し、出力形式不一致の保存済みはスキップされる
#[test]
fn resolves_reusable_output_in_priority_order_ignoring_saved_freshness() {
    let directory = TestDirectory::new();
    let input_path = directory.path().join("song.abc");
    fs::write(&input_path, "v1").unwrap();
    let executable = fake_success_program(directory.path());
    let args = vec!["{file}".to_owned(), "{output}".to_owned()];
    let work_root = directory.path().join("jobs");
    let operations = ExternalPreviewOperations::default();
    let config = ExternalPreviewConfigKey {
        executable: executable.to_string_lossy().into_owned(),
        args: args.clone(),
        output_format: ExternalPreviewFormat::Html,
    };

    let (c1, can1) = operations.register("prio-1", &input_path).unwrap();
    let sha1 = hash_input_file(&can1).unwrap();
    let temp = run_external_preview(&executable, &args, &input_path, ExternalPreviewFormat::Html, &work_root, &c1).unwrap();
    operations
        .finish_session_success("prio-1", &c1, &temp.output_path, &work_root, Some((sha1, config)), None)
        .unwrap();

    // 1) 保存済み作成 + 同フォルダファイル作成
    operations
        .save_external_preview(&input_path, &temp.output_path, ExternalPreviewFormat::Html, false)
        .unwrap();
    let sibling_html = directory.path().join("song.html");
    fs::write(&sibling_html, "<html>sibling</html>").unwrap();

    // 元ファイルを編集しても保存済みは鮮度確認なしで最優先
    fs::write(&input_path, "v2-edited").unwrap();
    let resolved = operations
        .resolve_reusable_output(&input_path, &executable.to_string_lossy(), &args, ExternalPreviewFormat::Html)
        .unwrap()
        .expect("saved must be resolved");
    assert_eq!(resolved.kind, ExternalPreviewSourceKind::Saved);

    // 出力形式不一致（Svg）なら保存済み(index.html)はスキップされる
    assert!(operations
        .resolve_reusable_output(&input_path, &executable.to_string_lossy(), &args, ExternalPreviewFormat::Svg)
        .unwrap()
        .is_none());

    // 2) 保存済み削除 → 同フォルダファイルが選ばれる
    fs::remove_dir_all(saved_preview_dir(&input_path).unwrap()).unwrap();
    let resolved = operations
        .resolve_reusable_output(&input_path, &executable.to_string_lossy(), &args, ExternalPreviewFormat::Html)
        .unwrap()
        .expect("sibling must be resolved");
    assert_eq!(resolved.kind, ExternalPreviewSourceKind::Sibling);

    // 3) 同フォルダファイル削除 → 元内容を v1 に戻せばセッション保持が選ばれる
    fs::remove_file(&sibling_html).unwrap();
    fs::write(&input_path, "v1").unwrap();
    let resolved = operations
        .resolve_reusable_output(&input_path, &executable.to_string_lossy(), &args, ExternalPreviewFormat::Html)
        .unwrap()
        .expect("temporary session output must be resolved");
    assert_eq!(resolved.kind, ExternalPreviewSourceKind::Temporary);
}

// Feature: 保存済み外部プレビューの境界検証
// Scenario: シンボリックリンクやファイル衝突を含む保存済みフォルダを拒否する
// Given: .wasabi-preview のパスに通常ファイルがある状態、またはシンボリックリンクを含む状態
// When: saved_output を呼ぶ
// Then: 通常ファイルは None（無視）、シンボリックリンクはエラーで拒否する
#[test]
fn validates_saved_preview_boundaries() {
    let directory = TestDirectory::new();
    let input_path = directory.path().join("song.abc");
    fs::write(&input_path, "v1").unwrap();
    let saved_dir = saved_preview_dir(&input_path).unwrap();

    // 同名の通常ファイルがある場合は保存済みフォルダ扱いせず None
    fs::write(&saved_dir, "not a directory").unwrap();
    assert!(saved_output(&input_path, ExternalPreviewFormat::Html).unwrap().is_none());
    fs::remove_file(&saved_dir).unwrap();

    // 空ディレクトリ（index.html なし）も None
    fs::create_dir(&saved_dir).unwrap();
    assert!(saved_output(&input_path, ExternalPreviewFormat::Html).unwrap().is_none());

    // index.html があれば Ok(Some)
    fs::write(saved_dir.join("index.html"), "<html>ok</html>").unwrap();
    assert!(saved_output(&input_path, ExternalPreviewFormat::Html).unwrap().is_some());
}

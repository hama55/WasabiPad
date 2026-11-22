// インストール済み 7z.exe を子プロセスとして呼び、.7z の一覧・展開・書き戻しを行う。
// 自前実装しないのは、7z (LZMA2/AES-256/solid) の再実装が割に合わないため。
// パスワードは常に -p で渡す (省略すると 7z が対話プロンプトで待ち続けてハングする)。
use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Condvar, Mutex, OnceLock,
};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

// パスワード起因の失敗を UI 側で識別するためのマーカー (表示前に UI が拾って
// パスワード入力ダイアログへ差し替える)。
pub const PASSWORD_ERROR_MARKER: &str = crate::protocol::PASSWORD_ERROR_MARKER;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_PARALLEL_EXTRACTS: usize = 3;

struct ExtractGate {
    active: Mutex<usize>,
    available: Condvar,
}

struct ExtractPermit {
    gate: &'static ExtractGate,
}

static EXTRACT_GATE: OnceLock<ExtractGate> = OnceLock::new();

fn acquire_extract_permit() -> ExtractPermit {
    let gate = EXTRACT_GATE.get_or_init(|| ExtractGate {
        active: Mutex::new(0),
        available: Condvar::new(),
    });
    let mut active = gate
        .active
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    while *active >= MAX_PARALLEL_EXTRACTS {
        active = gate
            .available
            .wait(active)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
    }
    *active += 1;
    ExtractPermit { gate }
}

impl Drop for ExtractPermit {
    fn drop(&mut self) {
        let mut active = self
            .gate
            .active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *active = active.saturating_sub(1);
        self.gate.available.notify_one();
    }
}

pub fn is_7z_path(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("7z"))
}

pub fn is_zip_path(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("zip"))
}

pub fn is_updateable_archive_path(path: &Path) -> bool {
    is_7z_path(path) || is_zip_path(path)
}

fn find_exe() -> Option<PathBuf> {
    for var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
        if let Some(dir) = std::env::var_os(var) {
            let p = PathBuf::from(dir).join("7-Zip").join("7z.exe");
            if p.is_file() {
                return Some(p);
            }
        }
    }
    // PATH 上にあればそれを使う (which 相当は Command 実行時に解決される)
    Command::new("7z")
        .arg("--help")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|_| PathBuf::from("7z"))
}

fn exe() -> io::Result<&'static Path> {
    static EXE: OnceLock<Option<PathBuf>> = OnceLock::new();
    EXE.get_or_init(find_exe).as_deref().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "7-Zip (7z.exe) が見つかりません。7-Zip をインストールしてください",
        )
    })
}

// 読み取り系 (l/e): パスワード未指定でも必ず -p を渡す。裸の 7z は暗号化書庫で
// 対話プロンプトに入り、stdin が null だと "Break signaled" になるため。
// ダミーの "?" は非暗号書庫では参照されず、暗号書庫では Wrong password になる。
fn read_password_arg(password: &str) -> String {
    format!("-p{}", if password.is_empty() { "?" } else { password })
}

fn resolve_archive_arg(archive: &Path) -> io::Result<PathBuf> {
    let raw = archive.to_string_lossy();
    if raw.is_empty() || raw.chars().any(char::is_control) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "アーカイブのパスが不正です",
        ));
    }
    let resolved = std::path::absolute(archive)?;
    let resolved_str = resolved.to_string_lossy();
    if resolved_str.starts_with('-') || resolved_str.starts_with('@') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "アーカイブのパスが不正です",
        ));
    }
    Ok(resolved)
}

fn validate_entry_arg(entry: &str) -> io::Result<String> {
    if entry.is_empty()
        || entry.chars().any(char::is_control)
        || entry.starts_with('-')
        || entry.starts_with('@')
        || entry.contains('*')
        || entry.contains('?')
        || entry.contains(':')
        || entry.starts_with('/')
        || entry.starts_with('\\')
        || entry.ends_with('/')
        || entry.ends_with('\\')
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "アーカイブ内エントリ名が不正です",
        ));
    }
    let normalized = entry.replace('\\', "/");
    if !Path::new(&normalized)
        .components()
        .all(|component| matches!(component, Component::Normal(_)))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "アーカイブ内エントリ名が不正です",
        ));
    }
    Ok(normalized.replace('/', "\\"))
}

fn build_list_args(archive: &Path, password: &str) -> io::Result<Vec<OsString>> {
    let archive = resolve_archive_arg(archive)?;
    Ok(vec![
        OsString::from(read_password_arg(password)),
        OsString::from("l"),
        OsString::from("-slt"),
        OsString::from("-ba"),
        OsString::from("--"),
        archive.into_os_string(),
    ])
}

fn build_extract_args(archive: &Path, entry: &str, password: &str) -> io::Result<Vec<OsString>> {
    let archive = resolve_archive_arg(archive)?;
    let entry = validate_entry_arg(entry)?;
    Ok(vec![
        OsString::from(read_password_arg(password)),
        OsString::from("e"),
        OsString::from("-so"),
        OsString::from("--"),
        archive.into_os_string(),
        OsString::from(entry),
    ])
}

fn build_update_stdin_args(
    archive: &Path,
    entry: &str,
    password: &str,
    header_encrypted: bool,
) -> io::Result<Vec<OsString>> {
    let archive = resolve_archive_arg(archive)?;
    let entry = validate_entry_arg(entry)?;
    let mut args = Vec::new();
    // 書き込み系で空パスワードに -p を付けると空文字で暗号化されてしまうため省略する
    if !password.is_empty() {
        args.push(OsString::from(format!("-p{password}")));
    }
    args.push(OsString::from("u"));
    if header_encrypted {
        args.push(OsString::from("-mhe=on"));
    }
    args.push(OsString::from(format!("-si{entry}")));
    args.push(OsString::from("--"));
    args.push(archive.into_os_string());
    Ok(args)
}

fn build_delete_args(
    archive: &Path,
    entries: &[String],
    password: &str,
) -> io::Result<Vec<OsString>> {
    let archive = resolve_archive_arg(archive)?;
    let mut validated = Vec::with_capacity(entries.len());
    for entry in entries {
        validated.push(validate_entry_arg(entry)?);
    }
    let mut args = Vec::new();
    if !password.is_empty() {
        args.push(OsString::from(format!("-p{password}")));
    }
    args.push(OsString::from("d"));
    args.push(OsString::from("--"));
    args.push(archive.into_os_string());
    for entry in validated {
        args.push(OsString::from(entry));
    }
    Ok(args)
}

fn base_command(piped_stdin: bool) -> io::Result<Command> {
    let mut cmd = Command::new(exe()?);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.stdin(if piped_stdin {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    // -scc: 非ASCIIエントリ名がコードページ依存で化けないよう出力を UTF-8 に固定
    cmd.arg("-sccUTF-8").arg("-y");
    Ok(cmd)
}

fn is_password_failure(stderr: &str) -> bool {
    stderr.contains("Wrong password") || stderr.contains("Cannot open encrypted archive")
}

fn join_output(
    stdout: thread::JoinHandle<io::Result<Vec<u8>>>,
    stderr: thread::JoinHandle<io::Result<Vec<u8>>>,
) -> io::Result<(Vec<u8>, Vec<u8>)> {
    let stdout = stdout
        .join()
        .map_err(|_| io::Error::other("7z の標準出力読込が異常終了しました"))??;
    let stderr = stderr
        .join()
        .map_err(|_| io::Error::other("7z の標準エラー読込が異常終了しました"))??;
    Ok((stdout, stderr))
}

fn output_too_large_error() -> io::Error {
    io::Error::new(
        io::ErrorKind::FileTooLarge,
        "アーカイブ内ファイルのサイズが大きすぎます",
    )
}

fn run(cmd: Command) -> io::Result<Vec<u8>> {
    run_with_io(cmd, None, None)
}

fn run_with_stdout_limit(cmd: Command, stdout_limit: Option<usize>) -> io::Result<Vec<u8>> {
    run_with_io(cmd, None, stdout_limit)
}

fn run_with_io(
    mut cmd: Command,
    stdin_bytes: Option<Vec<u8>>,
    stdout_limit: Option<usize>,
) -> io::Result<Vec<u8>> {
    let mut child = cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let stdin_writer = if let Some(input) = stdin_bytes {
        let mut stdin = match child.stdin.take() {
            Some(stdin) => stdin,
            None => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(io::Error::other("7z の標準入力を取得できません"));
            }
        };
        Some(thread::spawn(move || -> io::Result<()> {
            let result = stdin.write_all(&input);
            drop(stdin);
            result
        }))
    } else {
        None
    };
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("7z の標準出力を取得できません"));
    let stdout = match stdout {
        Ok(stdout) => stdout,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            if let Some(writer) = stdin_writer {
                let _ = writer.join();
            }
            return Err(error);
        }
    };
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("7z の標準エラーを取得できません"));
    let stderr = match stderr {
        Ok(stderr) => stderr,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            if let Some(writer) = stdin_writer {
                let _ = writer.join();
            }
            return Err(error);
        }
    };
    let limit_exceeded = Arc::new(AtomicBool::new(false));
    let reader_limit_exceeded = Arc::clone(&limit_exceeded);
    let stdout_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        let read_limit = stdout_limit
            .map(|limit| limit.saturating_add(1) as u64)
            .unwrap_or(u64::MAX);
        stdout.take(read_limit).read_to_end(&mut bytes).map(|_| {
            if stdout_limit.is_some_and(|limit| bytes.len() > limit) {
                reader_limit_exceeded.store(true, Ordering::Release);
            }
            bytes
        })
    });
    let stderr_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        stderr.take(u64::MAX).read_to_end(&mut bytes).map(|_| bytes)
    });
    let deadline = Instant::now() + COMMAND_TIMEOUT;
    let status = loop {
        if limit_exceeded.load(Ordering::Acquire) {
            let _ = child.kill();
            let _ = child.wait();
            if let Some(writer) = stdin_writer {
                let _ = writer.join();
            }
            let _ = join_output(stdout_reader, stderr_reader);
            return Err(output_too_large_error());
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                if let Some(writer) = stdin_writer {
                    let _ = writer.join();
                }
                let _ = join_output(stdout_reader, stderr_reader);
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "7z の処理が制限時間を超えました",
                ));
            }
            Ok(None) => thread::sleep(Duration::from_millis(25)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                if let Some(writer) = stdin_writer {
                    let _ = writer.join();
                }
                let _ = join_output(stdout_reader, stderr_reader);
                return Err(error);
            }
        }
    };
    let stdin_result = match stdin_writer {
        Some(writer) => Some(
            writer
                .join()
                .map_err(|_| io::Error::other("7z の標準入力書込が異常終了しました"))?,
        ),
        None => None,
    };
    let (stdout, stderr) = join_output(stdout_reader, stderr_reader)?;
    if stdout_limit.is_some_and(|limit| stdout.len() > limit) {
        return Err(output_too_large_error());
    }
    if status.success() {
        if let Some(Err(error)) = stdin_result {
            return Err(error);
        }
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&stderr).into_owned();
    if is_password_failure(&stderr) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            PASSWORD_ERROR_MARKER,
        ));
    }
    Err(io::Error::new(
        io::ErrorKind::InvalidData,
        format!(
            "7z が失敗しました: {}",
            stderr
                .lines()
                .find(|l| !l.trim().is_empty())
                .unwrap_or("(詳細不明)")
        ),
    ))
}

// エントリ名一覧 (ディレクトリ除く)。ヘッダ暗号化書庫はパスワードが合うまで失敗する。
pub fn list(archive: &Path, password: &str) -> io::Result<Vec<String>> {
    let mut cmd = base_command(false)?;
    cmd.args(build_list_args(archive, password)?);
    let stdout = run(cmd)?;
    let text = String::from_utf8_lossy(&stdout);
    let mut names = Vec::new();
    let mut path: Option<String> = None;
    let mut is_dir = false;
    for line in text.lines().chain(std::iter::once("")) {
        if line.trim().is_empty() {
            if let Some(p) = path.take() {
                if !is_dir {
                    names.push(p.replace('\\', "/"));
                }
            }
            is_dir = false;
        } else if let Some(v) = line.strip_prefix("Path = ") {
            path = Some(v.to_string());
        } else if let Some(v) = line.strip_prefix("Attributes = ") {
            is_dir = v.starts_with('D');
        } else if line.strip_prefix("Folder = +").is_some() {
            is_dir = true;
        }
    }
    if names.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "アーカイブを読み取れません",
        ));
    }
    names.sort();
    Ok(names)
}

// 1エントリの生バイト列を stdout 経由で取得 (一時ファイルを作らない)。
fn extract_with_limit(
    archive: &Path,
    entry: &str,
    password: &str,
    max_size: usize,
) -> io::Result<Vec<u8>> {
    let mut cmd = base_command(false)?;
    cmd.args(build_extract_args(archive, entry, password)?);
    let out = run_with_stdout_limit(cmd, Some(max_size))?;
    if out.is_empty() {
        // 7z e は該当なしでも成功終了するため、空出力は一覧と突き合わせて実在確認する
        if !list(archive, password)?.iter().any(|n| n == entry) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "アーカイブのエントリが見つかりません",
            ));
        }
    }
    Ok(out)
}

pub fn extract(archive: &Path, entry: &str, password: &str) -> io::Result<Vec<u8>> {
    let _permit = acquire_extract_permit();
    extract_with_limit(archive, entry, password, crate::ziptext::MAX_ENTRY)
}

// ヘッダ暗号化 (エントリ名も秘匿) かどうか。パスワード無しの一覧が
// パスワードエラーになる書庫は -mhe=on で作られている。
pub fn is_header_encrypted(archive: &Path) -> io::Result<bool> {
    match list(archive, "") {
        Ok(_) => Ok(false),
        Err(error) if error.kind() == io::ErrorKind::PermissionDenied => Ok(true),
        Err(error) => Err(error),
    }
}

pub(crate) const WORKSPACE_PREFIX: &str = "WasabiPad-archive-temp-";
const WORKSPACE_MARKER: &str = ".wasabipad-workspace";
const STALE_WORKSPACE_AGE: Duration = Duration::from_secs(24 * 60 * 60);

pub fn cleanup_stale_workspaces(parent: &Path) -> io::Result<()> {
    let now = SystemTime::now();
    let Ok(entries) = std::fs::read_dir(parent) else {
        return Ok(());
    };
    for entry in entries {
        let entry = entry?;
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();
        if !name.starts_with(WORKSPACE_PREFIX) || !entry.file_type()?.is_dir() {
            continue;
        }
        let marker = entry.path().join(WORKSPACE_MARKER);
        if !marker.is_file() {
            continue;
        }
        let Ok(modified) = entry.metadata().and_then(|metadata| metadata.modified()) else {
            continue;
        };
        let Ok(age) = now.duration_since(modified) else {
            continue;
        };
        if age >= STALE_WORKSPACE_AGE {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
    Ok(())
}

// 編集済みエントリ1件を標準入力 (-si<entry>) 経由で書き戻す (平文の一時ファイルをディスクへ出さない)。
// 呼び出し側は書庫の排他ハンドルを解放してから呼ぶこと (7z が書庫を差し替えるため)。
pub fn update_bytes(
    archive: &Path,
    entry: &str,
    bytes: &[u8],
    password: &str,
    header_encrypted: bool,
) -> io::Result<()> {
    let mut cmd = base_command(true)?;
    cmd.args(build_update_stdin_args(
        archive,
        entry,
        password,
        header_encrypted,
    )?);
    run_with_io(cmd, Some(bytes.to_vec()), None)?;
    Ok(())
}

pub fn delete(archive: &Path, entries: &[String], password: &str) -> io::Result<()> {
    if entries.is_empty() {
        return Ok(());
    }
    let mut cmd = base_command(false)?;
    cmd.args(build_delete_args(archive, entries, password)?);
    run(cmd)?;
    Ok(())
}

// ---- テスト支援 (doc.rs の結合テストからも使う) ----
#[cfg(test)]
pub(crate) fn available() -> bool {
    exe().is_ok()
}

// src_root 直下のファイル群から書庫を作る (テスト専用。アプリ本体は書庫を新規作成しない)
#[cfg(test)]
pub(crate) fn create_archive_for_test(
    archive: &Path,
    src_root: &Path,
    password: &str,
    header: bool,
) -> io::Result<()> {
    let archive = resolve_archive_arg(archive)?;
    let mut cmd = base_command(false)?;
    if !password.is_empty() {
        cmd.arg(format!("-p{password}"));
    }
    cmd.arg("a");
    if header {
        cmd.arg("-mhe=on");
    }
    cmd.arg("--").arg(archive).arg("*").current_dir(src_root);
    run(cmd).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    // 7z.exe が無い環境ではスキップ (CI 想定)。このマシンでは実行される。
    fn have_7z() -> bool {
        available()
    }

    // Feature: 7z展開の共有並列数
    // Scenario: 複数ビューから独立したエントリを同時に展開する
    // Given: 7z展開用の共有ゲートがある
    // When: 3件を超える展開処理が同時にゲートへ入ろうとする
    // Then: 実行中の展開処理は3件を超えない
    #[test]
    fn extract_gate_caps_process_wide_parallelism() {
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let handles: Vec<_> = (0..(MAX_PARALLEL_EXTRACTS + 4))
            .map(|_| {
                let active = Arc::clone(&active);
                let peak = Arc::clone(&peak);
                thread::spawn(move || {
                    let _permit = acquire_extract_permit();
                    let current = active.fetch_add(1, Ordering::Relaxed) + 1;
                    let mut observed = peak.load(Ordering::Relaxed);
                    while current > observed {
                        match peak.compare_exchange(
                            observed,
                            current,
                            Ordering::Relaxed,
                            Ordering::Relaxed,
                        ) {
                            Ok(_) => break,
                            Err(next) => observed = next,
                        }
                    }
                    thread::sleep(Duration::from_millis(20));
                    active.fetch_sub(1, Ordering::Relaxed);
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }
        assert!(peak.load(Ordering::Relaxed) <= MAX_PARALLEL_EXTRACTS);
    }

    fn temp_root(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("wasabipad_7z_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn create_archive(root: &Path, name: &str, password: &str, header: bool) -> PathBuf {
        let src = root.join("src");
        std::fs::create_dir_all(src.join("sub")).unwrap();
        std::fs::write(src.join("a.txt"), "hello\n").unwrap();
        std::fs::write(src.join("sub").join("b.txt"), "world\n").unwrap();
        let archive = root.join(name);
        create_archive_for_test(&archive, &src, password, header).unwrap();
        archive
    }

    #[test]
    fn list_extract_update_roundtrip_plain() {
        if !have_7z() {
            return;
        }
        let root = temp_root("plain");
        let archive = create_archive(&root, "t.7z", "", false);
        assert_eq!(
            list(&archive, "").unwrap(),
            vec!["a.txt".to_string(), "sub/b.txt".to_string()]
        );
        assert_eq!(extract(&archive, "sub/b.txt", "").unwrap(), b"world\n");
        assert!(!is_header_encrypted(&archive).unwrap());

        update_bytes(&archive, "sub/b.txt", b"updated\n", "", false).unwrap();
        assert_eq!(extract(&archive, "sub/b.txt", "").unwrap(), b"updated\n");
        assert_eq!(
            extract(&archive, "a.txt", "").unwrap(),
            b"hello\n",
            "他エントリは無傷"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn password_archive_requires_and_keeps_password() {
        if !have_7z() {
            return;
        }
        let root = temp_root("pw");
        let archive = create_archive(&root, "t.7z", "secret", true);
        // パスワード無し/誤りはマーカー付き PermissionDenied
        let err = list(&archive, "").unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
        assert!(err.to_string().contains(PASSWORD_ERROR_MARKER));
        assert!(list(&archive, "bad").is_err());
        assert!(is_header_encrypted(&archive).unwrap());

        assert_eq!(list(&archive, "secret").unwrap().len(), 2);
        assert_eq!(extract(&archive, "a.txt", "secret").unwrap(), b"hello\n");

        // 書き戻し後もヘッダ暗号化ごと維持され、平文の一時フォルダを作らない
        update_bytes(&archive, "a.txt", b"reworked\n", "secret", true).unwrap();
        assert!(!std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().starts_with(WORKSPACE_PREFIX)));
        assert!(
            is_header_encrypted(&archive).unwrap(),
            "保存後もヘッダ暗号化のまま"
        );
        assert_eq!(extract(&archive, "a.txt", "secret").unwrap(), b"reworked\n");
        let _ = std::fs::remove_dir_all(&root);
    }

    // Feature: 7zコマンドライン引数インジェクション防御
    // Scenario: スイッチ終端 `--` を配置し、危険なエントリ名を拒否する
    // Given: `-`・`@` で始まるエントリ名、ワイルドカード、パストラバーサル、ドライブ文字を含むエントリ名
    // When: 引数ビルダーを呼ぶ
    // Then: 正常な呼び出しはアーカイブ・エントリの前に `--` を置き、不正なエントリ名は InvalidInput で拒否する
    #[test]
    fn argument_builders_terminate_switches_and_reject_dangerous_entries() {
        let archive = Path::new(r"C:\work\archive.7z");
        let list_args = build_list_args(archive, "").unwrap();
        let sep = list_args.iter().position(|a| a == "--").unwrap();
        assert_eq!(list_args[sep + 1], archive.as_os_str());

        let extract_args = build_extract_args(archive, "sub/a.txt", "pw").unwrap();
        let sep = extract_args.iter().position(|a| a == "--").unwrap();
        assert_eq!(extract_args[sep + 1], archive.as_os_str());
        assert_eq!(extract_args[sep + 2], OsString::from(r"sub\a.txt"));

        let update_args = build_update_stdin_args(archive, "sub/a.txt", "pw", true).unwrap();
        let sep = update_args.iter().position(|a| a == "--").unwrap();
        assert!(update_args[..sep].contains(&OsString::from(r"-sisub\a.txt")));
        assert_eq!(update_args[sep + 1], archive.as_os_str());

        let delete_args = build_delete_args(archive, &["sub/a.txt".to_string()], "").unwrap();
        let sep = delete_args.iter().position(|a| a == "--").unwrap();
        assert_eq!(delete_args[sep + 1], archive.as_os_str());
        assert_eq!(delete_args[sep + 2], OsString::from(r"sub\a.txt"));

        for bad in [
            "-oC:\\evil",
            "@listfile.txt",
            "sub/*.txt",
            "sub/?.txt",
            "../escape.txt",
            "C:/abs.txt",
            "a\0b.txt",
            "",
        ] {
            assert_eq!(
                validate_entry_arg(bad).unwrap_err().kind(),
                io::ErrorKind::InvalidInput,
                "rejected entry: {bad:?}"
            );
        }
    }

    #[test]
    fn missing_entry_is_reported() {
        if !have_7z() {
            return;
        }
        let root = temp_root("miss");
        let archive = create_archive(&root, "t.7z", "", false);
        assert!(extract(&archive, "nope.txt", "").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    // Feature: アーカイブ展開時のメモリ上限
    // Scenario: 上限を超えるエントリを展開する
    // Given: 許容量より大きいエントリがある
    // When: エントリを標準出力から展開する
    // Then: 全内容を保持せずFileTooLargeで打ち切る
    #[test]
    fn extract_stops_when_entry_exceeds_limit() {
        if !have_7z() {
            return;
        }
        let root = temp_root("extract-limit");
        let archive = create_archive(&root, "t.7z", "", false);

        let error = extract_with_limit(&archive, "a.txt", "", 4).unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::FileTooLarge);
        let _ = std::fs::remove_dir_all(&root);
    }
}

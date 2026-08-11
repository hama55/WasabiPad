// インストール済み 7z.exe を子プロセスとして呼び、.7z の一覧・展開・書き戻しを行う。
// 自前実装しないのは、7z (LZMA2/AES-256/solid) の再実装が割に合わないため。
// パスワードは常に -p で渡す (省略すると 7z が対話プロンプトで待ち続けてハングする)。
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    OnceLock,
};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

// パスワード起因の失敗を UI 側で識別するためのマーカー (表示前に UI が拾って
// パスワード入力ダイアログへ差し替える)。
pub const PASSWORD_ERROR_MARKER: &str = crate::protocol::PASSWORD_ERROR_MARKER;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(60);

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

fn base_command() -> io::Result<Command> {
    let mut cmd = Command::new(exe()?);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.stdin(std::process::Stdio::null());
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

fn run(mut cmd: Command) -> io::Result<Vec<u8>> {
    let mut child = cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("7z の標準出力を取得できません"));
    let stdout = match stdout {
        Ok(stdout) => stdout,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
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
            return Err(error);
        }
    };
    let stdout_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.take(u64::MAX).read_to_end(&mut bytes).map(|_| bytes)
    });
    let stderr_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        stderr.take(u64::MAX).read_to_end(&mut bytes).map(|_| bytes)
    });
    let deadline = Instant::now() + COMMAND_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
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
                let _ = join_output(stdout_reader, stderr_reader);
                return Err(error);
            }
        }
    };
    let (stdout, stderr) = join_output(stdout_reader, stderr_reader)?;
    if status.success() {
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
    let mut cmd = base_command()?;
    cmd.arg(read_password_arg(password))
        .arg("l")
        .arg("-slt")
        .arg("-ba")
        .arg(archive);
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
pub fn extract(archive: &Path, entry: &str, password: &str) -> io::Result<Vec<u8>> {
    let mut cmd = base_command()?;
    cmd.arg(read_password_arg(password))
        .arg("e")
        .arg("-so")
        .arg(archive)
        .arg(entry.replace('/', "\\"));
    let out = run(cmd)?;
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
static WORKSPACE_SEQ: AtomicUsize = AtomicUsize::new(0);

// アーカイブ更新用の作業領域。ユーザーがアーカイブと同じフォルダで確認できる位置に置き、
// Drop で必ず消す。プロセス異常終了時の残骸は、次回同じフォルダを使うときに回収する。
pub struct ArchiveWorkspace {
    path: PathBuf,
}

impl ArchiveWorkspace {
    pub fn new(archive: &Path) -> io::Result<Self> {
        let parent = archive
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        cleanup_stale_workspaces(parent)?;
        for _ in 0..100 {
            let seq = WORKSPACE_SEQ.fetch_add(1, Ordering::Relaxed);
            let path = parent.join(format!("{WORKSPACE_PREFIX}{}-{seq}", std::process::id()));
            match std::fs::create_dir(&path) {
                Ok(()) => {
                    if let Err(error) = std::fs::write(
                        path.join(WORKSPACE_MARKER),
                        b"WasabiPad archive workspace\n",
                    ) {
                        let _ = std::fs::remove_dir_all(&path);
                        return Err(error);
                    }
                    return Ok(Self { path });
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        }
        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "アーカイブ用の一時フォルダを作れません",
        ))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for ArchiveWorkspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

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

// 編集済みエントリ1件を書き戻す。data_root はエントリの相対パス構造を再現した
// 一時ディレクトリ (7z u は cwd からの相対パスでエントリ名を決める)。
// 呼び出し側は書庫の排他ハンドルを解放してから呼ぶこと (7z が書庫を差し替えるため)。
pub fn update(
    archive: &Path,
    entry: &str,
    data_root: &Path,
    password: &str,
    header_encrypted: bool,
) -> io::Result<()> {
    let mut cmd = base_command()?;
    // 書き込み系で空パスワードに -p を付けると空文字で暗号化されてしまうため省略する
    if !password.is_empty() {
        cmd.arg(format!("-p{password}"));
    }
    cmd.arg("u");
    if header_encrypted {
        cmd.arg("-mhe=on");
    }
    cmd.arg(archive)
        .arg(entry.replace('/', "\\"))
        .current_dir(data_root);
    run(cmd)?;
    Ok(())
}

pub fn delete(archive: &Path, entries: &[String], password: &str) -> io::Result<()> {
    if entries.is_empty() {
        return Ok(());
    }
    let mut cmd = base_command()?;
    if !password.is_empty() {
        cmd.arg(format!("-p{password}"));
    }
    cmd.arg("d").arg(archive);
    for entry in entries {
        cmd.arg(entry.replace('/', "\\"));
    }
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
    let mut cmd = base_command()?;
    if !password.is_empty() {
        cmd.arg(format!("-p{password}"));
    }
    cmd.arg("a");
    if header {
        cmd.arg("-mhe=on");
    }
    cmd.arg(archive).arg("*").current_dir(src_root);
    run(cmd).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    // 7z.exe が無い環境ではスキップ (CI 想定)。このマシンでは実行される。
    fn have_7z() -> bool {
        available()
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

        let edit_root = root.join("edit");
        std::fs::create_dir_all(edit_root.join("sub")).unwrap();
        std::fs::write(edit_root.join("sub").join("b.txt"), "updated\n").unwrap();
        update(&archive, "sub/b.txt", &edit_root, "", false).unwrap();
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

        // 書き戻し後もヘッダ暗号化ごと維持される
        let edit_root = root.join("edit");
        std::fs::create_dir_all(&edit_root).unwrap();
        std::fs::write(edit_root.join("a.txt"), "reworked\n").unwrap();
        update(&archive, "a.txt", &edit_root, "secret", true).unwrap();
        assert!(
            is_header_encrypted(&archive).unwrap(),
            "保存後もヘッダ暗号化のまま"
        );
        assert_eq!(extract(&archive, "a.txt", "secret").unwrap(), b"reworked\n");
        let _ = std::fs::remove_dir_all(&root);
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
}

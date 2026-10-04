use std::{
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

const PAGE_SIZE: usize = 100;
const MAX_OUTPUT: usize = 16 * 1024 * 1024;

#[derive(Clone, serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct GitCommit {
    pub oid: String,
    pub author: String,
    pub date: String,
    pub message: String,
}

#[derive(Clone, serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct GitHistory {
    pub head: Option<String>,
    pub branch: Option<String>,
    pub commits: Vec<GitCommit>,
    pub has_more: bool,
}

#[derive(Clone, serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct GitChangedFile {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
}

#[derive(Clone, serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct GitFileDiff {
    pub text: String,
    pub binary: bool,
    pub truncated: bool,
}

fn comparison(dir: &Path, commit: &str) -> Result<Vec<String>, String> {
    oid(commit)?;
    let (value, _) = run(
        dir,
        &["rev-list", "--parents", "--max-count=1", commit, "--"],
        MAX_OUTPUT,
    )?;
    let value = String::from_utf8_lossy(&value);
    let mut parts = value.split_whitespace();
    if parts.next() != Some(commit) {
        return Err("コミットが見つかりません".into());
    }
    Ok(match parts.next() {
        Some(parent) => vec![oid(parent)?.into(), commit.into()],
        None => vec!["--root".into(), commit.into()],
    })
}

fn diff_tree(
    dir: &Path,
    commit: &str,
    options: &[&str],
    paths: &[&str],
    limit: usize,
) -> Result<(Vec<u8>, bool), String> {
    let mut args = vec![
        "diff-tree".to_owned(),
        "--no-commit-id".into(),
        "-r".into(),
        "-M".into(),
        "--no-ext-diff".into(),
        "--no-textconv".into(),
        "--submodule=short".into(),
    ];
    args.extend(options.iter().map(|value| (*value).to_owned()));
    args.extend(comparison(dir, commit)?);
    args.push("--".into());
    args.extend(paths.iter().map(|value| (*value).to_owned()));
    run(
        dir,
        &args.iter().map(String::as_str).collect::<Vec<_>>(),
        limit,
    )
}

pub fn read_git_files(path: &str, commit: &str) -> Result<Vec<GitChangedFile>, String> {
    let dir = git_dir(path)?;
    let (bytes, truncated) = diff_tree(&dir, commit, &["--name-status", "-z"], &[], MAX_OUTPUT)?;
    if truncated {
        return Err("変更ファイル一覧が大きすぎるため読み込めません".into());
    }
    let mut parts = bytes.split(|b| *b == 0);
    let mut files = Vec::new();
    while let Some(status) = parts.next() {
        if status.is_empty() {
            break;
        }
        let status = String::from_utf8_lossy(status);
        let first = parts.next().ok_or("変更ファイル一覧が不正です")?;
        let renamed = status.starts_with('R') || status.starts_with('C');
        let target = if renamed {
            parts.next().ok_or("変更ファイル一覧が不正です")?
        } else {
            first
        };
        files.push(GitChangedFile {
            path: String::from_utf8(target.to_vec())
                .map_err(|_| "UTF-8以外のファイル名は表示できません")?,
            old_path: if renamed {
                Some(
                    String::from_utf8(first.to_vec())
                        .map_err(|_| "UTF-8以外のファイル名は表示できません")?,
                )
            } else {
                None
            },
            status: status.chars().next().unwrap().to_string(),
        });
    }
    Ok(files)
}

pub fn read_git_diff(path: &str, commit: &str, file: &str) -> Result<GitFileDiff, String> {
    let files = read_git_files(path, commit)?;
    let selected = files
        .iter()
        .find(|item| item.path == file)
        .ok_or("選択ファイルはこのコミットの変更に含まれません")?;
    let mut paths = vec![selected.path.as_str()];
    if let Some(old) = &selected.old_path {
        paths.push(old);
    }
    let dir = git_dir(path)?;
    let (bytes, mut truncated) = diff_tree(
        &dir,
        commit,
        &["-p", "--no-color", "--no-relative", "--unified=3"],
        &paths,
        1024 * 1024,
    )?;
    let text = String::from_utf8_lossy(&bytes);
    let binary = text.lines().any(|line| line.starts_with("Binary files "));
    let mut shown = String::new();
    for (index, line) in text.split_inclusive('\n').enumerate() {
        if index >= 20_000 || shown.len() + line.len() > 1024 * 1024 {
            truncated = true;
            break;
        }
        shown.push_str(line);
    }
    Ok(GitFileDiff {
        text: shown,
        binary,
        truncated,
    })
}

fn git_dir(path: &str) -> Result<PathBuf, String> {
    let path = Path::new(path);
    if path.file_name().and_then(|name| name.to_str()) != Some(".git") {
        return Err("Git履歴には .git 項目を選択してください".into());
    }
    let target = if path.is_file() {
        let content = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
        let value = content
            .trim()
            .strip_prefix("gitdir: ")
            .ok_or(".git ファイルの参照先が不正です")?;
        path.parent()
            .ok_or(".git の親フォルダがありません")?
            .join(value)
    } else {
        path.to_path_buf()
    };
    let target = target
        .canonicalize()
        .map_err(|error| format!(".git を読み込めません: {error}"))?;
    if !target.is_dir() {
        return Err(".git の参照先がフォルダではありません".into());
    }
    // Git for Windows does not accept Rust's verbatim canonical path prefix.
    #[cfg(windows)]
    {
        let value = target.to_string_lossy();
        if let Some(value) = value.strip_prefix(r"\\?\UNC\") {
            return Ok(PathBuf::from(format!(r"\\{value}")));
        }
        if let Some(value) = value.strip_prefix(r"\\?\") {
            return Ok(PathBuf::from(value));
        }
    }
    Ok(target)
}

fn oid(value: &str) -> Result<&str, String> {
    if matches!(value.len(), 40 | 64) && value.bytes().all(|c| c.is_ascii_hexdigit()) {
        Ok(value)
    } else {
        Err("コミットIDが不正です".into())
    }
}

fn command(dir: &Path) -> Command {
    let mut cmd = Command::new("git");
    // Inherited Git overrides must not redirect this selected repository or its output.
    for (key, _) in std::env::vars_os() {
        if key
            .to_string_lossy()
            .to_ascii_uppercase()
            .starts_with("GIT_")
        {
            cmd.env_remove(key);
        }
    }
    cmd.arg("--no-pager")
        .arg("--git-dir")
        .arg(dir)
        .args([
            "-c",
            "color.ui=false",
            "-c",
            "core.quotePath=false",
            "-c",
            "log.showSignature=false",
        ])
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_ALLOW_PROTOCOL", "")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_LITERAL_PATHSPECS", "1")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd
}

fn run(dir: &Path, args: &[&str], limit: usize) -> Result<(Vec<u8>, bool), String> {
    let mut child = command(dir).args(args).spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "Git が見つかりません。Gitをインストールし、WasabiPadを再起動してください".into()
        } else {
            format!("Gitを起動できません: {error}")
        }
    })?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or("Gitのエラー出力を取得できません")?;
    let error_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stderr.by_ref().take(65536).read_to_end(&mut bytes);
        let _ = std::io::copy(&mut stderr, &mut std::io::sink());
        bytes
    });
    let stdout = child.stdout.take().ok_or("Gitの出力を取得できません")?;
    let stop_output = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let reader_stop = stop_output.clone();
    let output_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout
            .take((limit + 1) as u64)
            .read_to_end(&mut bytes)
            .map(|_| bytes);
        if result.as_ref().map_or(true, |bytes| bytes.len() > limit) {
            reader_stop.store(true, std::sync::atomic::Ordering::Relaxed);
        }
        result
    });
    let started = std::time::Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            break status;
        }
        if stop_output.load(std::sync::atomic::Ordering::Relaxed) {
            // The bounded reader closes stdout after the limit, so stop a producer that keeps running.
            let _ = child.kill();
        }
        if started.elapsed() > std::time::Duration::from_secs(30) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = output_reader.join();
            let _ = error_reader.join();
            return Err("Gitの読み取りがタイムアウトしました。更新から再試行できます".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    };
    let mut bytes = output_reader
        .join()
        .map_err(|_| "Gitの読み取りに失敗しました")?
        .map_err(|error| error.to_string())?;
    let stderr = error_reader.join().unwrap_or_default();
    let truncated = bytes.len() > limit;
    bytes.truncate(limit);
    if !status.success() && !truncated {
        return Err(String::from_utf8_lossy(&stderr).trim().into());
    }
    Ok((bytes, truncated))
}

pub fn read_git_history(
    path: &str,
    head: Option<&str>,
    offset: usize,
) -> Result<GitHistory, String> {
    let dir = git_dir(path)?;
    run(&dir, &["rev-parse", "--is-bare-repository"], MAX_OUTPUT)?;
    let branch = run(
        &dir,
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
        MAX_OUTPUT,
    )
    .ok()
    .map(|(value, _)| String::from_utf8_lossy(&value).trim().to_owned());
    let head = match head {
        Some(head) => Some(oid(head)?.to_owned()),
        None => match run(&dir, &["rev-parse", "--verify", "HEAD"], MAX_OUTPUT) {
            Ok((value, _)) => Some(oid(String::from_utf8_lossy(&value).trim())?.to_owned()),
            Err(error) => {
                // Only a valid unborn symbolic HEAD represents an empty history.
                if branch.is_some() && !dir.join("HEAD").is_dir() {
                    let reference = run(
                        &dir,
                        &[
                            "show-ref",
                            "--verify",
                            &format!("refs/heads/{}", branch.as_deref().unwrap()),
                        ],
                        MAX_OUTPUT,
                    );
                    if reference.is_err() {
                        return Ok(GitHistory {
                            head: None,
                            branch,
                            commits: vec![],
                            has_more: false,
                        });
                    }
                }
                return Err(error);
            }
        },
    };
    let (bytes, truncated) = run(
        &dir,
        &[
            "log",
            "--date-order",
            "--no-decorate",
            "--no-notes",
            "--encoding=UTF-8",
            "--format=%H%x00%an%x00%aI%x00%B%x00",
            &format!("--skip={offset}"),
            &format!("--max-count={}", PAGE_SIZE + 1),
            head.as_deref().unwrap(),
            "--",
        ],
        MAX_OUTPUT,
    )?;
    if truncated {
        return Err("コミット履歴が大きすぎるため読み込めません".into());
    }
    let fields: Vec<_> = bytes.split(|b| *b == 0).collect();
    let mut commits = Vec::new();
    for entry in fields.chunks(4) {
        if entry.len() != 4 {
            break;
        }
        let value = |index| String::from_utf8_lossy(entry[index]).trim().to_owned();
        commits.push(GitCommit {
            oid: value(0),
            author: value(1),
            date: value(2),
            message: value(3),
        });
    }
    let has_more = commits.len() > PAGE_SIZE;
    commits.truncate(PAGE_SIZE);
    Ok(GitHistory {
        head,
        branch,
        commits,
        has_more,
    })
}

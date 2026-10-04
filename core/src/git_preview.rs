use std::{
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

const PAGE_SIZE: usize = 100;
const MAX_OUTPUT: usize = 16 * 1024 * 1024;

pub fn resolve_git_worktree_file(path: &str, commit: &str, file: &str) -> Result<String, String> {
    if file.is_empty()
        || file.contains(['\\', ':', '\0'])
        || file.starts_with('/')
        || file.split('/').any(|p| matches!(p, ".." | "." | ".git"))
    {
        return Err("ファイルのパスが不正です".into());
    }
    let files = if commit == "worktree" {
        read_git_worktree_files(path)?
    } else {
        read_git_files(path, commit)?
    };
    if !files.iter().any(|f| f.path == file) {
        return Err("選択ファイルは変更一覧に含まれません".into());
    }
    let root = Path::new(path)
        .parent()
        .ok_or("作業フォルダがありません")?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let target = root
        .join(file)
        .canonicalize()
        .map_err(|_| "現在の作業ファイルがありません")?;
    if !target.is_file() {
        return Err("現在の作業ファイルがありません".into());
    }
    if !target.starts_with(&root) {
        return Err("作業フォルダ外のファイルは開けません".into());
    }
    git_path(&target)
}

#[derive(Clone, serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct GitBranch {
    pub name: String,
    pub oid: String,
    pub remote: bool,
}

pub fn read_git_branches(path: &str) -> Result<Vec<GitBranch>, String> {
    let dir = git_dir(path)?;
    let (bytes, truncated) = run(
        &dir,
        &[
            "for-each-ref",
            "--format=%(refname)%00%(objectname)%00%(symref)",
            "refs/heads/",
            "refs/remotes/",
        ],
        MAX_OUTPUT,
    )?;
    if truncated {
        return Err("ブランチ一覧が大きすぎるため読み込めません".into());
    }
    let text = String::from_utf8(bytes).map_err(|_| "UTF-8以外のブランチ名は表示できません")?;
    let mut branches = Vec::new();
    for line in text.lines() {
        let parts: Vec<_> = line.split('\0').collect();
        if parts.len() != 3 || !parts[2].is_empty() {
            continue;
        }
        let (name, remote) = if let Some(name) = parts[0].strip_prefix("refs/heads/") {
            (name, false)
        } else if let Some(name) = parts[0].strip_prefix("refs/remotes/") {
            (name, true)
        } else {
            continue;
        };
        branches.push(GitBranch {
            name: name.into(),
            oid: oid(parts[1])?.into(),
            remote,
        });
    }
    Ok(branches)
}

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
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub index_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub worktree_status: Option<String>,
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
    parse_changed_files(&bytes)
}

fn parse_changed_files(bytes: &[u8]) -> Result<Vec<GitChangedFile>, String> {
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
            index_status: None,
            worktree_status: None,
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
    let (bytes, truncated) = diff_tree(
        &dir,
        commit,
        &["-p", "--no-color", "--no-relative", "--unified=3"],
        &paths,
        1024 * 1024,
    )?;
    Ok(bounded_diff(&bytes, truncated))
}

fn bounded_diff(bytes: &[u8], mut truncated: bool) -> GitFileDiff {
    let text = String::from_utf8_lossy(bytes);
    let binary = text.lines().any(|line| line.starts_with("Binary files "));
    let mut shown = String::new();
    for (index, line) in text.split_inclusive('\n').enumerate() {
        if index >= 20_000 || shown.len() + line.len() > 1024 * 1024 {
            truncated = true;
            break;
        }
        shown.push_str(line);
    }
    GitFileDiff {
        text: shown,
        binary,
        truncated,
    }
}

fn worktree_run(path: &str, args: &[&str], limit: usize) -> Result<(Vec<u8>, bool), String> {
    run_command(worktree_command(path)?.args(args), limit, false)
}

fn worktree_command(path: &str) -> Result<Command, String> {
    let dir = git_dir(path)?;
    let root = Path::new(path).parent().ok_or("作業フォルダがありません")?;
    let root = root.to_str().ok_or("作業フォルダ名を読み込めません")?;
    // Preserve Git's built-in line-ending rules without enabling global external filters.
    let mut settings = command(&dir);
    settings
        .env_remove("GIT_CONFIG_NOSYSTEM")
        .env_remove("GIT_CONFIG_GLOBAL")
        .args([
            "config",
            "--null",
            "--type=bool-or-str",
            "--get-regexp",
            "^core\\.(autocrlf|eol)$",
        ]);
    let (settings, truncated) = run_command(&mut settings, 65536, true)?;
    if truncated {
        return Err("Gitの改行設定が大きすぎます".into());
    }
    let mut cmd = command(&dir);
    for setting in settings
        .split(|byte| *byte == 0)
        .filter(|item| !item.is_empty())
    {
        let setting = std::str::from_utf8(setting).map_err(|_| "Gitの改行設定が不正です")?;
        let (key, value) = setting.split_once('\n').ok_or("Gitの改行設定が不正です")?;
        if !matches!(
            (key, value),
            ("core.autocrlf", "true" | "false" | "input") | ("core.eol", "lf" | "crlf" | "native")
        ) {
            return Err("Gitの改行設定が不正です".into());
        }
        cmd.args(["-c", &format!("{key}={value}")]);
    }
    cmd.current_dir(root).args(["--work-tree", root]);
    Ok(cmd)
}

pub fn read_git_worktree_files(path: &str) -> Result<Vec<GitChangedFile>, String> {
    let head = read_git_history(path, None, 0)?.head;
    let mut files = if let Some(head) = &head {
        let (bytes, truncated) = worktree_run(
            path,
            &[
                "diff",
                "--name-status",
                "--no-relative",
                "-z",
                "-M",
                "--no-ext-diff",
                "--no-textconv",
                &head,
                "--",
            ],
            MAX_OUTPUT,
        )?;
        if truncated {
            return Err("変更ファイル一覧が大きすぎます".into());
        }
        parse_changed_files(&bytes)?
    } else {
        let (bytes, truncated) = worktree_run(path, &["ls-files", "-z", "--cached"], MAX_OUTPUT)?;
        if truncated {
            return Err("変更ファイル一覧が大きすぎます".into());
        }
        paths_as_added(&bytes)?
    };
    let (bytes, truncated) = worktree_run(
        path,
        &["ls-files", "-z", "--others", "--exclude-standard"],
        MAX_OUTPUT,
    )?;
    if truncated {
        return Err("変更ファイル一覧が大きすぎます".into());
    }
    files.extend(paths_as_added(&bytes)?);
    files.sort_by(|a, b| a.path.cmp(&b.path));
    files.dedup_by(|a, b| a.path == b.path);
    let root = Path::new(path).parent().ok_or("作業フォルダがありません")?;
    if let Some(head) = &head {
        let mut net = Vec::new();
        for mut file in files {
            if root.join(&file.path).is_file() && (file.status == "D" || file.status == "A") {
                if let Some(previous) = head_blob(path, head, &file.path)? {
                    let target = root
                        .join(&file.path)
                        .canonicalize()
                        .map_err(|e| e.to_string())?;
                    if !target.starts_with(root.canonicalize().map_err(|e| e.to_string())?) {
                        return Err("作業フォルダ外のファイルは表示できません".into());
                    }
                    let target_arg = git_path(&target)?;
                    let (current, _) = worktree_run(
                        path,
                        &["hash-object", "--path", &file.path, "--", &target_arg],
                        MAX_OUTPUT,
                    )?;
                    if previous == String::from_utf8_lossy(&current).trim() {
                        continue;
                    }
                    file.status = "M".into();
                }
            }
            net.push(file);
        }
        files = net;
    } else {
        files.retain(|f| root.join(&f.path).exists());
    }
    let (status, truncated) = worktree_run(
        path,
        &[
            "-c",
            "core.fsmonitor=false",
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--ignore-submodules=none",
        ],
        MAX_OUTPUT,
    )?;
    if truncated {
        return Err("変更状態が大きすぎるため読み込めません".into());
    }
    let mut parts = status.split(|b| *b == 0);
    while let Some(entry) = parts.next() {
        if entry.len() < 4 {
            continue;
        }
        let xy = &entry[..2];
        let name = String::from_utf8(entry[3..].to_vec())
            .map_err(|_| "UTF-8以外のファイル名は表示できません")?;
        if xy.contains(&b'R') || xy.contains(&b'C') {
            parts.next();
        }
        if let Some(file) = files.iter_mut().find(|f| f.path == name) {
            file.index_status =
                (xy[0] != b' ' && xy[0] != b'?').then(|| char::from(xy[0]).to_string());
            file.worktree_status = (xy[1] != b' ').then(|| char::from(xy[1]).to_string());
            if matches!(xy, b"DD" | b"AU" | b"UD" | b"UA" | b"DU" | b"AA" | b"UU") {
                file.status = "U".into();
            }
        }
    }
    Ok(files)
}

fn head_blob(path: &str, head: &str, file: &str) -> Result<Option<String>, String> {
    let dir = git_dir(path)?;
    let (listed, _) = run(&dir, &["ls-tree", "-z", head, "--", file], MAX_OUTPUT)?;
    if listed.is_empty() {
        return Ok(None);
    }
    let record = String::from_utf8_lossy(&listed);
    let value = record
        .split_whitespace()
        .nth(2)
        .ok_or("比較元を読み込めません")?;
    Ok(Some(oid(value)?.to_owned()))
}

fn head_content(path: &str, head: &str, file: &str) -> Result<Option<(Vec<u8>, bool)>, String> {
    let Some(blob) = head_blob(path, head, file)? else {
        return Ok(None);
    };
    let dir = git_dir(path)?;
    Ok(Some(run(&dir, &["cat-file", "blob", &blob], 1024 * 1024)?))
}

fn paths_as_added(bytes: &[u8]) -> Result<Vec<GitChangedFile>, String> {
    bytes
        .split(|b| *b == 0)
        .filter(|p| !p.is_empty())
        .map(|p| {
            Ok(GitChangedFile {
                path: String::from_utf8(p.to_vec())
                    .map_err(|_| "UTF-8以外のファイル名は表示できません")?,
                old_path: None,
                status: "A".into(),
                index_status: None,
                worktree_status: None,
            })
        })
        .collect()
}

pub fn read_git_worktree_diff(path: &str, file: &str) -> Result<GitFileDiff, String> {
    let files = read_git_worktree_files(path)?;
    let selected = files
        .iter()
        .find(|f| f.path == file)
        .ok_or("現在の未コミット変更に含まれません")?;
    let head = read_git_history(path, None, 0)?.head;
    let tracked = worktree_run(
        path,
        &["ls-files", "--error-unmatch", "--", file],
        MAX_OUTPUT,
    )
    .is_ok();
    if let Some(head) = head.as_ref().filter(|_| {
        tracked
            || !Path::new(path).parent().unwrap().join(file).exists()
            || selected.old_path.is_some()
    }) {
        let mut args = vec![
            "diff",
            "-p",
            "-M",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--no-relative",
            "--unified=3",
            &head,
            "--",
            file,
        ];
        if let Some(old) = &selected.old_path {
            args.push(old);
        }
        let (bytes, truncated) = worktree_run(path, &args, 1024 * 1024)?;
        return Ok(bounded_diff(&bytes, truncated));
    }
    let root = Path::new(path).parent().ok_or("作業フォルダがありません")?;
    let target = root.join(file);
    let meta = std::fs::symlink_metadata(&target).map_err(|e| e.to_string())?;
    if let Some((previous, truncated)) = head
        .as_ref()
        .map(|head| head_content(path, head, file))
        .transpose()?
        .flatten()
    {
        if truncated {
            return Ok(GitFileDiff {
                binary: previous.contains(&0),
                text: "比較元のファイルが大きいため差分を省略しました".into(),
                truncated: true,
            });
        }
        return saved_file_diff(path, file, &previous, &target);
    }
    let mut bytes = Vec::new();
    if meta.file_type().is_symlink() {
        bytes.extend(
            std::fs::read_link(&target)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .as_bytes(),
        );
    } else {
        let real = target.canonicalize().map_err(|e| e.to_string())?;
        if !real.starts_with(root.canonicalize().map_err(|e| e.to_string())?) {
            return Err("作業フォルダ外のファイルは表示できません".into());
        }
        std::fs::File::open(real)
            .map_err(|e| e.to_string())?
            .take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
    }
    if bytes.contains(&0) {
        return Ok(GitFileDiff {
            text: String::new(),
            binary: true,
            truncated: false,
        });
    }
    let truncated = bytes.len() > 1024 * 1024;
    bytes.truncate(1024 * 1024);
    let mut text = format!("--- /dev/null\n+++ b/{file}\n@@ 新規ファイル @@\n");
    for line in String::from_utf8_lossy(&bytes).split_inclusive('\n') {
        text.push('+');
        text.push_str(line);
    }
    Ok(bounded_diff(text.as_bytes(), truncated))
}

fn saved_file_diff(
    path: &str,
    file: &str,
    previous: &[u8],
    target: &Path,
) -> Result<GitFileDiff, String> {
    struct Temporary(PathBuf);
    impl Drop for Temporary {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let temp = Temporary(
        std::env::temp_dir().join(format!("wasabipad-git-diff-{}-{nonce}", std::process::id())),
    );
    let mut output = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp.0)
        .map_err(|e| e.to_string())?;
    std::io::Write::write_all(&mut output, previous).map_err(|e| e.to_string())?;
    drop(output);
    let (bytes, truncated) = run_command(
        worktree_command(path)?.args([
            "diff",
            "--no-index",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--unified=3",
            "--",
            temp.0.to_str().ok_or("一時ファイル名を読み込めません")?,
            target.to_str().ok_or("ファイル名を読み込めません")?,
        ]),
        1024 * 1024,
        true,
    )?;
    let result = bounded_diff(&bytes, truncated);
    if result.binary {
        return Ok(GitFileDiff {
            text: String::new(),
            ..result
        });
    }
    let mut header = true;
    let text = result
        .text
        .lines()
        .map(|line| {
            if line.starts_with("@@") {
                header = false;
            }
            if header && line.starts_with("diff --git ") {
                format!("diff --git a/{file} b/{file}")
            } else if header && line.starts_with("--- ") {
                format!("--- a/{file}")
            } else if header && line.starts_with("+++ ") {
                format!("+++ b/{file}")
            } else {
                line.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    Ok(GitFileDiff { text, ..result })
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
    Ok(PathBuf::from(git_path(&target)?))
}

fn git_path(target: &Path) -> Result<String, String> {
    // Git for Windows does not accept Rust's verbatim canonical path prefix.
    #[cfg(windows)]
    {
        let value = target.to_string_lossy();
        if let Some(value) = value.strip_prefix(r"\\?\UNC\") {
            return Ok(format!(r"\\{value}"));
        }
        if let Some(value) = value.strip_prefix(r"\\?\") {
            return Ok(value.to_owned());
        }
    }
    target
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| "ファイル名を読み込めません".into())
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
    run_command(command(dir).args(args), limit, false)
}

fn run_command(
    cmd: &mut Command,
    limit: usize,
    diff_exit: bool,
) -> Result<(Vec<u8>, bool), String> {
    let mut child = cmd.spawn().map_err(|error| {
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
    if !status.success() && !(diff_exit && status.code() == Some(1)) && !truncated {
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

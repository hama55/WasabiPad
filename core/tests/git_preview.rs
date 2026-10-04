use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicUsize, Ordering},
};
use wasabipad_core::{read_git_diff, read_git_files, read_git_history};

static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Repo(PathBuf);
impl Repo {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "wasabipad-git-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        let repo = Self(path);
        repo.git(&["init", "-b", "main"]);
        repo.git(&["config", "user.name", "Preview Author"]);
        repo.git(&["config", "user.email", "preview@example.invalid"]);
        repo
    }
    fn git(&self, args: &[&str]) -> String {
        let result = Command::new("git")
            .arg("-C")
            .arg(&self.0)
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env(
                "GIT_CONFIG_GLOBAL",
                if cfg!(windows) { "NUL" } else { "/dev/null" },
            )
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        String::from_utf8_lossy(&result.stdout).trim().to_owned()
    }
    fn commit(&self, text: &str, message: &str) -> String {
        fs::write(self.0.join("note.txt"), text).unwrap();
        self.git(&["add", "."]);
        self.git(&["commit", "-m", message]);
        self.git(&["rev-parse", "HEAD"])
    }
    fn path(&self) -> String {
        self.0.join(".git").to_string_lossy().into_owned()
    }
}
impl Drop for Repo {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

// Feature: Git履歴プレビューの読み取り
// Scenario: 現在ブランチの履歴を新しい順に取得する
// Given: mainに2つのコミットがある
// When: .gitの履歴を読む
// Then: ブランチ名・HEAD・作者・日時・メッセージと新しい順のコミットが得られる
#[test]
fn history_of_current_branch() {
    let repo = Repo::new();
    let first = repo.commit("one\n", "first");
    let second = repo.commit("two\n", "second");
    let result = read_git_history(&repo.path(), None, 0).unwrap();
    assert_eq!(result.branch.as_deref(), Some("main"));
    assert_eq!(result.head.as_deref(), Some(second.as_str()));
    assert_eq!(
        result
            .commits
            .iter()
            .map(|c| c.oid.as_str())
            .collect::<Vec<_>>(),
        vec![second.as_str(), first.as_str()]
    );
    assert_eq!(result.commits[0].author, "Preview Author");
    assert_eq!(result.commits[0].message, "second");
    assert!(!result.commits[0].date.is_empty());
    assert!(!result.has_more);
}

// Feature: Gitコミット差分
// Scenario: コミット済み内容だけを比較し最初のコミットも表示する
// Given: 2つのコミットと未コミットの変更がある
// When: 各コミットの変更ファイルと差分を読む
// Then: 最初は追加、次は親との差分を返し未コミットの変更は混ざらない
#[test]
fn committed_diff_and_root() {
    let repo = Repo::new();
    let first = repo.commit("one\n", "first");
    let second = repo.commit("two\n", "second");
    fs::write(repo.0.join("note.txt"), "unsaved worktree\n").unwrap();
    let files = read_git_files(&repo.path(), &first).unwrap();
    assert_eq!(files[0].path, "note.txt");
    assert_eq!(files[0].status, "A");
    let root = read_git_diff(&repo.path(), &first, "note.txt").unwrap();
    assert!(root.text.contains("+one"));
    let diff = read_git_diff(&repo.path(), &second, "note.txt").unwrap();
    assert!(diff.text.contains("-one"));
    assert!(diff.text.contains("+two"));
    assert!(!diff.text.contains("unsaved"));
    assert!(!diff.truncated && !diff.binary);
}

// Feature: Git履歴の例外とページング
// Scenario: コミット前・detached HEAD・worktreeを扱う
// Given: 有効なリポジトリとworktree、不正な.git
// When: 各.gitの履歴を読む
// Then: 空状態とHEAD状態を区別しworktreeを読め、不正な対象は失敗する
#[test]
fn empty_detached_worktree_and_invalid() {
    let repo = Repo::new();
    let empty = read_git_history(&repo.path(), None, 0).unwrap();
    assert!(empty.commits.is_empty() && empty.head.is_none());
    assert_eq!(empty.branch.as_deref(), Some("main"));
    let head = repo.commit("one\n", "first");
    repo.git(&["checkout", "--detach"]);
    let detached = read_git_history(&repo.path(), None, 0).unwrap();
    assert!(detached.branch.is_none());
    assert_eq!(detached.head.as_deref(), Some(head.as_str()));
    let worktree = repo.0.join("worktree");
    repo.git(&["worktree", "add", "-b", "other", worktree.to_str().unwrap()]);
    let linked = read_git_history(worktree.join(".git").to_str().unwrap(), None, 0).unwrap();
    assert_eq!(linked.branch.as_deref(), Some("other"));
    repo.git(&["worktree", "remove", "--force", worktree.to_str().unwrap()]);
    fs::create_dir_all(repo.0.join("bad/.git")).unwrap();
    assert!(read_git_history(repo.0.join("bad/.git").to_str().unwrap(), None, 0).is_err());
    assert!(read_git_history(repo.0.to_str().unwrap(), None, 0).is_err());
    assert!(read_git_history(&repo.path(), Some("--all"), 0).is_err());
}

// Feature: Git変更ファイル
// Scenario: 名前変更・削除・バイナリ・空コミットを区別する
// Given: 改名と削除とバイナリ追加を含むコミット
// When: ファイル一覧と差分を読む
// Then: 古い名前と変更種別を保持しバイナリと空コミットを明示できる
#[test]
fn rename_delete_binary_and_empty_commit() {
    let repo = Repo::new();
    repo.commit("one\n", "first");
    fs::write(repo.0.join("deleted.txt"), "delete\n").unwrap();
    repo.git(&["add", "."]);
    repo.git(&["commit", "-m", "prepare"]);
    repo.git(&["mv", "note.txt", "new name 日本語.txt"]);
    repo.git(&["rm", "deleted.txt"]);
    fs::write(repo.0.join("binary.bin"), [0, 1, 2, 3]).unwrap();
    repo.git(&["add", "."]);
    repo.git(&["commit", "-m", "changes"]);
    let head = repo.git(&["rev-parse", "HEAD"]);
    let files = read_git_files(&repo.path(), &head).unwrap();
    let renamed = files.iter().find(|file| file.status == "R").unwrap();
    assert_eq!(renamed.path, "new name 日本語.txt");
    assert_eq!(renamed.old_path.as_deref(), Some("note.txt"));
    assert_eq!(
        files
            .iter()
            .find(|file| file.path == "deleted.txt")
            .unwrap()
            .status,
        "D"
    );
    assert!(
        read_git_diff(&repo.path(), &head, "binary.bin")
            .unwrap()
            .binary
    );
    assert!(read_git_diff(&repo.path(), &head, "deleted.txt")
        .unwrap()
        .text
        .contains("-delete"));
    assert!(read_git_diff(&repo.path(), &head, &renamed.path)
        .unwrap()
        .text
        .contains("rename from"));
    assert!(read_git_diff(&repo.path(), &head, "../outside").is_err());
    repo.git(&["commit", "--allow-empty", "-m", "empty"]);
    assert!(
        read_git_files(&repo.path(), &repo.git(&["rev-parse", "HEAD"]))
            .unwrap()
            .is_empty()
    );
}

// Feature: Git履歴固定
// Scenario: 100件追加読込の途中でHEADが変わる
// Given: 101コミット取得後に別コミットが追加される
// When: 元のHEADから次のページを読む
// Then: 元履歴の最後の1件を返し新HEADのコミットは混ざらない
#[test]
fn pages_use_snapshot_head() {
    let repo = Repo::new();
    let first = repo.commit("one\n", "first");
    for index in 1..101 {
        repo.git(&["commit", "--allow-empty", "-m", &format!("commit {index}")]);
    }
    let page = read_git_history(&repo.path(), None, 0).unwrap();
    assert_eq!(page.commits.len(), 100);
    assert!(page.has_more);
    repo.git(&["commit", "--allow-empty", "-m", "new HEAD"]);
    let next = read_git_history(&repo.path(), page.head.as_deref(), 100).unwrap();
    assert_eq!(next.commits.len(), 1);
    assert_eq!(next.commits[0].oid, first);
    assert!(!next.has_more);
}

// Feature: Git巨大差分
// Scenario: 行数とバイト数の上限を守る
// Given: 2万行以上または1MiB以上のコミット済みテキスト
// When: 差分を読む
// Then: 上限内の内容と省略フラグを返す
#[test]
fn diff_limits_are_explicit() {
    let repo = Repo::new();
    let head = repo.commit(&"row\n".repeat(25_000), "many lines");
    let diff = read_git_diff(&repo.path(), &head, "note.txt").unwrap();
    assert!(diff.truncated);
    assert_eq!(diff.text.lines().count(), 20_000);
    let head = repo.commit(&"long line".repeat(180_000), "many bytes");
    let diff = read_git_diff(&repo.path(), &head, "note.txt").unwrap();
    assert!(diff.truncated);
    assert!(diff.text.len() <= 1024 * 1024);
}

// Feature: マージと閲覧専用のGit読取
// Scenario: マージの第1親との差分を読み、外部変換を実行しない
// Given: 2枝の変更をマージしtextconvを設定したリポジトリ
// When: 履歴とマージ差分を読む
// Then: 両枝の履歴、第1親にない変更を返し外部変換とリポジトリ書換を行わない
#[test]
fn merge_first_parent_and_read_only() {
    fn snapshot(path: &std::path::Path) -> std::collections::BTreeMap<PathBuf, Vec<u8>> {
        fn visit(
            root: &std::path::Path,
            path: &std::path::Path,
            files: &mut std::collections::BTreeMap<PathBuf, Vec<u8>>,
        ) {
            for entry in fs::read_dir(path).unwrap() {
                let entry = entry.unwrap();
                if entry.file_type().unwrap().is_dir() {
                    visit(root, &entry.path(), files);
                } else {
                    files.insert(
                        entry.path().strip_prefix(root).unwrap().to_path_buf(),
                        fs::read(entry.path()).unwrap(),
                    );
                }
            }
        }
        let mut files = std::collections::BTreeMap::new();
        visit(path, path, &mut files);
        files
    }
    let repo = Repo::new();
    repo.commit("root\n", "root");
    repo.git(&["checkout", "-b", "side"]);
    fs::write(repo.0.join("side.txt"), "side value\n").unwrap();
    repo.git(&["add", "."]);
    repo.git(&["commit", "-m", "side"]);
    let side = repo.git(&["rev-parse", "HEAD"]);
    repo.git(&["checkout", "main"]);
    fs::write(repo.0.join("main.txt"), "main value\n").unwrap();
    fs::write(repo.0.join(".gitattributes"), "*.txt diff=unsafe\n").unwrap();
    repo.git(&["add", "."]);
    repo.git(&["commit", "-m", "main"]);
    repo.git(&["merge", "--no-ff", "side", "-m", "merge"]);
    repo.git(&[
        "config",
        "diff.unsafe.textconv",
        "this-executable-must-not-run",
    ]);
    repo.git(&[
        "config",
        "diff.unsafe.command",
        "this-executable-must-not-run",
    ]);
    let before = snapshot(&repo.0.join(".git"));
    let history = read_git_history(&repo.path(), None, 0).unwrap();
    assert!(history.commits.iter().any(|commit| commit.oid == side));
    let files = read_git_files(&repo.path(), history.head.as_deref().unwrap()).unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].path, "side.txt");
    let diff = read_git_diff(&repo.path(), history.head.as_deref().unwrap(), "side.txt").unwrap();
    assert!(diff.text.contains("+side value"));
    assert_eq!(snapshot(&repo.0.join(".git")), before);
}

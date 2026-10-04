use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicUsize, Ordering},
};
use wasabipad_core::{
    read_git_branches, read_git_diff, read_git_files, read_git_history, read_git_worktree_diff,
    read_git_worktree_files, resolve_git_worktree_file,
};

// Feature: Gitの変更ファイルを通常タブで開く
// Scenario: コミット版ではなく現在の作業ファイルを解決する
// Given: コミット後に変更・削除されたファイルがある
// When: コミット内のファイルから開く対象を要求する
// Then: 現在の実ファイルを返し、不存在や範囲外は理由を返す
#[test]
fn opens_current_worktree_file() {
    let repo = Repo::new();
    let commit = repo.commit("old\n", "first");
    fs::write(repo.0.join("note.txt"), "current\n").unwrap();
    let path = resolve_git_worktree_file(&repo.path(), &commit, "note.txt").unwrap();
    assert_eq!(fs::read_to_string(path).unwrap(), "current\n");
    assert!(resolve_git_worktree_file(&repo.path(), &commit, "../secret").is_err());
    fs::remove_file(repo.0.join("note.txt")).unwrap();
    assert!(resolve_git_worktree_file(&repo.path(), &commit, "note.txt")
        .unwrap_err()
        .contains("現在の作業ファイルがありません"));
}

// Feature: 未コミット一覧の状態
// Scenario: 初コミット前、ステージ済み変更、マージ競合を扱う
// Given: 保存済みの新規ファイル、追加後削除、競合マーカーがある
// When: 一覧と差分を読む
// Then: 存在する差分だけとステージ状態・競合を表示する
#[test]
fn unborn_and_conflicting_worktree() {
    let repo = Repo::new();
    fs::write(repo.0.join("note.txt"), "base\n").unwrap();
    fs::write(repo.0.join("gone.txt"), "gone\n").unwrap();
    repo.git(&["add", "."]);
    fs::remove_file(repo.0.join("gone.txt")).unwrap();
    let files = read_git_worktree_files(&repo.path()).unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].index_status.as_deref(), Some("A"));
    assert!(read_git_worktree_diff(&repo.path(), "note.txt")
        .unwrap()
        .text
        .contains("+base"));
    repo.git(&["add", "."]);
    repo.git(&["commit", "-m", "base"]);
    repo.git(&["checkout", "-b", "other"]);
    repo.commit("other\n", "other");
    repo.git(&["checkout", "main"]);
    repo.commit("main\n", "main");
    let _ = Command::new("git")
        .arg("-C")
        .arg(&repo.0)
        .args(["merge", "other"])
        .output()
        .unwrap();
    let files = read_git_worktree_files(&repo.path()).unwrap();
    assert_eq!(files[0].status, "U");
    let diff = read_git_worktree_diff(&repo.path(), "note.txt").unwrap();
    assert!(diff.text.contains("<<<<<<<"));
}

// Feature: 未コミットの保存済み変更
// Scenario: ステージの有無によらずHEADとの合計差分だけ表示する
// Given: 相殺された編集、未追跡と無視対象、未ステージの変更がある
// When: 未コミット一覧と差分を読む
// Then: 相殺と無視対象を除外して保存済み内容を表示する
#[test]
fn worktree_uses_net_changes() {
    let repo = Repo::new();
    repo.commit("one\n", "first");
    fs::write(repo.0.join("note.txt"), "staged\n").unwrap();
    repo.git(&["add", "note.txt"]);
    fs::write(repo.0.join("note.txt"), "one\n").unwrap();
    fs::write(repo.0.join(".gitignore"), "ignored.txt\n").unwrap();
    fs::write(repo.0.join("ignored.txt"), "hidden").unwrap();
    fs::write(repo.0.join("new.txt"), "new\n").unwrap();
    let files = read_git_worktree_files(&repo.path()).unwrap();
    assert!(!files
        .iter()
        .any(|f| f.path == "note.txt" || f.path == "ignored.txt"));
    assert!(files.iter().any(|f| f.path == "new.txt"));
    let diff = read_git_worktree_diff(&repo.path(), "new.txt").unwrap();
    assert!(diff.text.contains("+new\n"));
    fs::write(repo.0.join("note.txt"), "saved\n").unwrap();
    let diff = read_git_worktree_diff(&repo.path(), "note.txt").unwrap();
    assert!(diff.text.contains("-one\n") && diff.text.contains("+saved\n"));
    assert!(read_git_worktree_diff(&repo.path(), "../secret").is_err());
}

// Feature: 未コミットの合計差分
// Scenario: インデックスから外した現在ファイルもHEADと比較する
// Given: HEADにあるファイルをgit rm --cachedして保存内容を残した
// When: 未コミット一覧を読み、本文を変更して差分を読む
// Then: 同内容は表示せず、変更後はHEADからの差分を表示する
#[test]
fn removed_from_index_uses_saved_content() {
    let repo = Repo::new();
    repo.commit("one\n", "first");
    repo.git(&["rm", "--cached", "note.txt"]);
    assert!(read_git_worktree_files(&repo.path()).unwrap().is_empty());
    fs::write(repo.0.join("note.txt"), "two\n").unwrap();
    let diff = read_git_worktree_diff(&repo.path(), "note.txt").unwrap();
    assert!(diff.text.contains("-one\n") && diff.text.contains("+two\n"));
}

// Feature: 特殊な未コミット差分
// Scenario: 本文が差分ヘッダと同じ接頭辞でも変更しない
// Given: インデックスから外れたファイルの本文が-- / ++で始まる
// When: HEADと現在の保存内容を比較する
// Then: 本文の差分行をパスに置き換えない
#[test]
fn worktree_diff_preserves_header_like_content() {
    let repo = Repo::new();
    repo.commit("-- old\n", "first");
    repo.git(&["rm", "--cached", "note.txt"]);
    fs::write(repo.0.join("note.txt"), "++ new\n").unwrap();
    let diff = read_git_worktree_diff(&repo.path(), "note.txt").unwrap();
    assert!(diff.text.contains("--- old\n") && diff.text.contains("+++ new\n"));
}

// Feature: 閲覧ブランチ選択
// Scenario: 大容量ファイルをインデックスから外しても一覧を表示できる
// Given: 16MiBを超えるHEADのファイルと同じ保存済み内容がある
// When: 相殺された一覧を読み、その後本文を変更する
// Then: 同内容は除外し変更後は上限付き差分として扱う
#[test]
fn large_removed_index_file_does_not_break_listing() {
    let repo = Repo::new();
    repo.commit(&"x".repeat(17 * 1024 * 1024), "large");
    repo.git(&["rm", "--cached", "note.txt"]);
    assert!(read_git_worktree_files(&repo.path()).unwrap().is_empty());
    fs::write(repo.0.join("note.txt"), "small\n").unwrap();
    assert_eq!(read_git_worktree_files(&repo.path()).unwrap().len(), 1);
    assert!(
        read_git_worktree_diff(&repo.path(), "note.txt")
            .unwrap()
            .truncated
    );
}

// Feature: 閲覧ブランチ選択
// Scenario: 取得済みブランチから履歴を読み、作業HEADを変更しない
// Given: ローカルとリモート参照がある
// When: ブランチ一覧と選択したOIDの履歴を読む
// Then: 種別とOIDを取得し、元のHEADを保つ
#[test]
fn branches_are_read_only() {
    let repo = Repo::new();
    let first = repo.commit("one\n", "first");
    repo.git(&["branch", "other"]);
    repo.git(&["update-ref", "refs/remotes/origin/other", &first]);
    let second = repo.commit("two\n", "second");
    let branches = read_git_branches(&repo.path()).unwrap();
    let other = branches.iter().find(|b| b.name == "other").unwrap();
    assert!(!other.remote);
    assert!(branches
        .iter()
        .any(|b| b.name == "origin/other" && b.remote));
    let shown = read_git_history(&repo.path(), Some(&other.oid), 0).unwrap();
    assert_eq!(shown.commits.len(), 1);
    assert_eq!(repo.git(&["rev-parse", "HEAD"]), second);
}

static NEXT: AtomicUsize = AtomicUsize::new(0);

// Feature: リポジトリ固有の改行規則
// Scenario: .gitattributesで正規化した同内容を変更として表示しない
// Given: autocrlf=false、text eol=lfのファイルをステージから外してCRLFで保存
// When: アプリの作業フォルダとは別のリポジトリを読む
// Then: リポジトリの属性を使い同内容のファイルを一覧から除外する
#[test]
fn removed_index_file_respects_repository_attributes() {
    let repo = Repo::new();
    repo.git(&["config", "core.autocrlf", "false"]);
    fs::write(repo.0.join(".gitattributes"), "*.txt text eol=lf\n").unwrap();
    repo.commit("base\n", "base");
    repo.git(&["rm", "--cached", "note.txt"]);
    fs::write(repo.0.join("note.txt"), "base\r\n").unwrap();
    assert!(read_git_worktree_files(&repo.path()).unwrap().is_empty());
}

// Feature: 改行設定の読取境界
// Scenario: 改行を含む不正な値を別のGit設定として解釈しない
// Given: core.eolに別設定に見える継続行が含まれる
// When: 未コミット一覧を読む
// Then: 不正な改行設定として失敗し、継続行を適用しない
#[test]
fn invalid_line_ending_setting_is_not_another_config() {
    let repo = Repo::new();
    repo.commit("base\n", "base");
    repo.git(&[
        "config",
        "core.eol",
        "lf\nfilter.attack.clean this-executable-must-not-run",
    ]);
    assert!(read_git_worktree_files(&repo.path())
        .err()
        .expect("不正設定を拒否する")
        .contains("改行設定"));
}

// Feature: 通常Gitと一致する未コミット判定
// Scenario: 改行の自動変換を使う環境でRevertしたファイルは一覧から消える
// Given: システム設定がautocrlf=trueで、HEADはLF、保存済みファイルはCRLF
// When: 保存済み内容をHEADと同じ内容へ戻して未コミット一覧を読む
// Then: 改行形式だけを変更として表示しない
#[test]
#[cfg(windows)]
fn reverted_file_uses_normal_git_line_endings() {
    let setting = Command::new("git")
        .args(["config", "--get", "core.autocrlf"])
        .output()
        .unwrap();
    if String::from_utf8_lossy(&setting.stdout).trim() != "true" {
        return;
    }
    let repo = Repo::new();
    repo.commit("original\n", "base");
    fs::write(repo.0.join("note.txt"), "changed\r\n").unwrap();
    assert_eq!(read_git_worktree_files(&repo.path()).unwrap().len(), 1);
    fs::write(repo.0.join("note.txt"), "original\r\n").unwrap();
    assert!(read_git_worktree_files(&repo.path()).unwrap().is_empty());
}

// Feature: ステージから除外したファイルの未コミット判定
// Scenario: 改行形式だけが異なる保存済みファイルは変更なし
// Given: autocrlf=trueのリポジトリでHEADと同じCRLF内容をインデックスから除外した
// When: HEADと保存済み内容の一覧を読む
// Then: ステージ操作や改行形式だけを本文の差分として表示しない
#[test]
fn removed_index_file_respects_line_endings() {
    let repo = Repo::new();
    repo.git(&["config", "core.autocrlf", "true"]);
    repo.commit("original\nstable\n", "base");
    repo.git(&["rm", "--cached", "note.txt"]);
    fs::write(repo.0.join("note.txt"), "original\r\nstable\r\n").unwrap();
    assert!(read_git_worktree_files(&repo.path()).unwrap().is_empty());
    fs::write(repo.0.join("note.txt"), "changed\r\nstable\r\n").unwrap();
    let diff = read_git_worktree_diff(&repo.path(), "note.txt").unwrap();
    assert!(diff.text.lines().any(|line| line == " stable"));
}

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

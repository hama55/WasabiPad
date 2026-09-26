#[path = "../src/addin_manager.rs"]
mod addin_manager;

use addin_manager::{
    install_verified_archive, is_enabled_version, list_local_status, remove, set_enabled,
};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

struct TestRoot(PathBuf);

impl TestRoot {
    fn new() -> Self {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock is after UNIX epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "wasabipad-addin-manager-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("create isolated app data root");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn make_archive(root: &Path, name: &str, entries: &[(&str, &[u8])]) -> (PathBuf, String) {
    let archive_path = root.join(name);
    let file = fs::File::create(&archive_path).expect("create archive fixture");
    let mut archive = ZipWriter::new(file);
    for (path, bytes) in entries {
        archive
            .start_file(*path, SimpleFileOptions::default())
            .expect("add archive entry");
        archive.write_all(bytes).expect("write archive entry");
    }
    archive.finish().expect("finish archive fixture");
    let digest = format!("{:x}", Sha256::digest(fs::read(&archive_path).unwrap()));
    (archive_path, digest)
}

fn package_entries(id: &str, version: &str, minimum: &str) -> Vec<(String, Vec<u8>)> {
    vec![
        (
            "addon.json".into(),
            format!(
                r#"{{"id":"{id}","version":"{version}","entry":"dist/entry.js","minimumAppVersion":"{minimum}"}}"#
            )
            .into_bytes(),
        ),
        ("dist/entry.js".into(), b"export const entry = true;".to_vec()),
    ]
}

fn entries_as_refs(entries: &[(String, Vec<u8>)]) -> Vec<(&str, &[u8])> {
    entries
        .iter()
        .map(|(path, bytes)| (path.as_str(), bytes.as_slice()))
        .collect()
}

// Feature: 公式アドインを検証してローカルへ導入する
// Scenario: 正しいABCパッケージを検証後に有効化する
// Given: 固定ID、版、entry、互換性を満たしdigestが一致するZIP
// When: rootを注入して導入する
// Then: 展開済み資産と.ready、state.jsonの有効状態を公開する
#[test]
fn installs_verified_archive_and_records_enabled_version() {
    let root = TestRoot::new();
    let entries = package_entries("abc", "1.0.0", "1.7.0");
    let (archive, digest) = make_archive(root.path(), "abc.zip", &entries_as_refs(&entries));

    install_verified_archive(root.path(), "abc", "1.0.0", &archive, &digest).unwrap();

    let package = root.path().join("addins/abc/1.0.0");
    assert!(package.join(".ready").is_file());
    assert_eq!(
        fs::read(package.join("dist/entry.js")).unwrap(),
        b"export const entry = true;"
    );
    assert!(is_enabled_version(root.path(), "abc", "1.0.0").unwrap());
    let status = list_local_status(root.path()).unwrap();
    let abc = status.iter().find(|addon| addon.id == "abc").unwrap();
    assert_eq!(abc.version.as_deref(), Some("1.0.0"));
    assert!(abc.installed && abc.enabled);
    let saved: serde_json::Value =
        serde_json::from_slice(&fs::read(root.path().join("addins/state.json")).unwrap()).unwrap();
    assert_eq!(saved["abc"]["version"], "1.0.0");
    assert_eq!(saved["abc"]["enabled"], true);
}

// Feature: 公式アドインZIPの整合性を検証する
// Scenario: ハッシュが一致しないアーカイブを導入しない
// Given: 正常なZIPと不一致のSHA-256
// When: 導入を要求する
// Then: エラーになり設定・導入済みファイルを作らない
#[test]
fn rejects_archive_with_wrong_digest_without_installing() {
    let root = TestRoot::new();
    let entries = package_entries("abc", "1.0.0", "1.7.0");
    let (archive, _) = make_archive(root.path(), "abc.zip", &entries_as_refs(&entries));

    assert!(
        install_verified_archive(root.path(), "abc", "1.0.0", &archive, &"0".repeat(64)).is_err()
    );

    assert!(!root.path().join("addins/abc/1.0.0").exists());
    assert!(list_local_status(root.path())
        .unwrap()
        .iter()
        .all(|addon| addon.version.is_none()));
}

// Feature: 公式アドインZIPを安全に展開する
// Scenario: 親ディレクトリを指定するZIP entryを拒否する
// Given: addon.jsonとdist/entry.jsに加えて../escape.jsを含むZIP
// When: 正しいdigestを付けて導入する
// Then: 導入を失敗させ、app data root外へファイルを作らない
#[test]
fn rejects_zip_path_traversal_without_writing_outside_addins() {
    let root = TestRoot::new();
    let entries = package_entries("abc", "1.0.0", "1.7.0");
    let mut refs = entries_as_refs(&entries);
    refs.push(("../escape.js", b"outside"));
    let (archive, digest) = make_archive(root.path(), "traversal.zip", &refs);

    assert!(install_verified_archive(root.path(), "abc", "1.0.0", &archive, &digest).is_err());

    assert!(!root.path().join("escape.js").exists());
    assert!(!root.path().join("addins/abc/1.0.0").exists());
}

// Feature: 導入済みアドインを管理する
// Scenario: 無効化と削除で利用状態と削除範囲を守る
// Given: 有効なABCと利用者の楽譜ファイルがある
// When: 無効化してからアドインを削除する
// Then: 配信可否を止め、アドインだけ削除し楽譜を残す
#[test]
fn disable_and_remove_only_affect_managed_addin_files() {
    let root = TestRoot::new();
    let entries = package_entries("abc", "1.0.0", "1.7.0");
    let (archive, digest) = make_archive(root.path(), "abc.zip", &entries_as_refs(&entries));
    install_verified_archive(root.path(), "abc", "1.0.0", &archive, &digest).unwrap();
    let score = root.path().join("my-score.ly");
    fs::write(&score, b"user score").unwrap();
    let older_version = root.path().join("addins/abc/0.9.0");
    fs::create_dir_all(&older_version).unwrap();
    fs::write(older_version.join(".ready"), b"orphaned old version").unwrap();

    set_enabled(root.path(), "abc", false).unwrap();
    assert!(!is_enabled_version(root.path(), "abc", "1.0.0").unwrap());
    assert!(!list_local_status(root.path()).unwrap()[0].enabled);
    set_enabled(root.path(), "abc", true).unwrap();
    assert!(is_enabled_version(root.path(), "abc", "1.0.0").unwrap());
    remove(root.path(), "abc").unwrap();

    assert!(!root.path().join("addins/abc/1.0.0").exists());
    assert!(!root.path().join("addins/abc").exists());
    assert!(list_local_status(root.path())
        .unwrap()
        .iter()
        .all(|addon| addon.version.is_none()));
    assert_eq!(fs::read(score).unwrap(), b"user score");
}

// Feature: 公式アドイン削除の再試行
// Scenario: ファイル削除に失敗しても導入状態を失わない
// Given: 導入済みのABCと、削除を拒否する読み取り専用の配信資産がある
// When: 削除を要求して失敗後に資産を削除可能にして再試行する
// Then: 初回はstateを保持し、再試行で資産とstateを削除する
#[test]
fn failed_package_removal_keeps_state_for_a_retry() {
    let root = TestRoot::new();
    let entries = package_entries("abc", "1.0.0", "1.7.0");
    let (archive, digest) = make_archive(root.path(), "abc.zip", &entries_as_refs(&entries));
    install_verified_archive(root.path(), "abc", "1.0.0", &archive, &digest).unwrap();
    let locked = root.path().join("addins/abc/1.0.0/dist/entry.js");
    #[cfg(windows)]
    let lock = {
        use std::os::windows::fs::OpenOptionsExt;

        fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&locked)
            .unwrap()
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let addon_directory = root.path().join("addins/abc");
        let permissions = fs::metadata(&addon_directory).unwrap().permissions();
        fs::set_permissions(
            &addon_directory,
            fs::Permissions::from_mode(permissions.mode() & !0o222),
        )
        .unwrap();
    }

    assert!(remove(root.path(), "abc").is_err());
    let installed = list_local_status(root.path())
        .unwrap()
        .into_iter()
        .find(|addon| addon.id == "abc")
        .unwrap();
    assert_eq!(installed.version.as_deref(), Some("1.0.0"));
    let saved: serde_json::Value =
        serde_json::from_slice(&fs::read(root.path().join("addins/state.json")).unwrap()).unwrap();
    assert_eq!(saved["abc"]["version"], "1.0.0");
    assert_eq!(saved["abc"]["enabled"], true);

    #[cfg(windows)]
    drop(lock);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let addon_directory = root.path().join("addins/abc");
        let permissions = fs::metadata(&addon_directory).unwrap().permissions();
        fs::set_permissions(
            &addon_directory,
            fs::Permissions::from_mode(permissions.mode() | 0o700),
        )
        .unwrap();
    }

    remove(root.path(), "abc").unwrap();
    assert!(list_local_status(root.path())
        .unwrap()
        .iter()
        .all(|addon| addon.version.is_none()));
}

// Feature: 公式アドインを更新する
// Scenario: 新版のmanifest検証に失敗したら旧版を維持する
// Given: 有効なABC 1.0.0が導入済み
// When: 要求版1.1.0とmanifest版1.2.0が一致しないZIPで更新する
// Then: 旧版のファイルと有効状態を保持する
#[test]
fn failed_update_keeps_previous_version_and_state() {
    let root = TestRoot::new();
    let first = package_entries("abc", "1.0.0", "1.7.0");
    let (archive, digest) = make_archive(root.path(), "abc-1.zip", &entries_as_refs(&first));
    install_verified_archive(root.path(), "abc", "1.0.0", &archive, &digest).unwrap();
    let bad_update = package_entries("abc", "1.2.0", "1.7.0");
    let (archive, digest) = make_archive(root.path(), "abc-2.zip", &entries_as_refs(&bad_update));

    assert!(install_verified_archive(root.path(), "abc", "1.1.0", &archive, &digest).is_err());

    assert_eq!(
        fs::read(root.path().join("addins/abc/1.0.0/dist/entry.js")).unwrap(),
        b"export const entry = true;"
    );
    assert!(!root.path().join("addins/abc/1.1.0").exists());
    assert!(is_enabled_version(root.path(), "abc", "1.0.0").unwrap());
    assert!(!is_enabled_version(root.path(), "abc", "1.1.0").unwrap());
}

// Feature: 無効化した公式アドインを更新する
// Scenario: 手動更新後も利用者が選んだ無効状態を保つ
// Given: 無効化済みのABC 1.0.0が導入されている
// When: 検証済みのABC 1.1.0を導入する
// Then: 新版の資産を導入し、state.jsonと公開状態は無効のままにする
#[test]
fn updating_a_disabled_addin_keeps_it_disabled() {
    let root = TestRoot::new();
    let first = package_entries("abc", "1.0.0", "1.7.0");
    let (archive, digest) = make_archive(root.path(), "abc-1.zip", &entries_as_refs(&first));
    install_verified_archive(root.path(), "abc", "1.0.0", &archive, &digest).unwrap();
    set_enabled(root.path(), "abc", false).unwrap();

    let update = package_entries("abc", "1.1.0", "1.7.0");
    let (archive, digest) = make_archive(root.path(), "abc-2.zip", &entries_as_refs(&update));
    install_verified_archive(root.path(), "abc", "1.1.0", &archive, &digest).unwrap();

    assert!(root.path().join("addins/abc/1.1.0/.ready").is_file());
    assert_eq!(
        fs::read(root.path().join("addins/abc/1.1.0/dist/entry.js")).unwrap(),
        b"export const entry = true;"
    );
    assert!(!root.path().join("addins/abc/1.0.0").exists());
    assert!(!is_enabled_version(root.path(), "abc", "1.1.0").unwrap());
    assert!(!list_local_status(root.path()).unwrap()[0].enabled);
    let saved: serde_json::Value =
        serde_json::from_slice(&fs::read(root.path().join("addins/state.json")).unwrap()).unwrap();
    assert_eq!(saved["abc"]["version"], "1.1.0");
    assert_eq!(saved["abc"]["enabled"], false);
}

// Feature: 公式アドインmanifestの互換性を確認する
// Scenario: 現在のアプリより新しいminimumAppVersionを拒否する
// Given: ハッシュは一致するがminimumAppVersionが1.8.0のZIP
// When: 1.7.0のアプリで導入する
// Then: パッケージも有効状態も作らない
#[test]
fn rejects_addin_requiring_newer_app_version() {
    let root = TestRoot::new();
    let entries = package_entries("abc", "1.0.0", "1.8.0");
    let (archive, digest) = make_archive(root.path(), "future-abc.zip", &entries_as_refs(&entries));

    assert!(install_verified_archive(root.path(), "abc", "1.0.0", &archive, &digest).is_err());

    assert!(!root.path().join("addins/abc/1.0.0").exists());
    assert!(list_local_status(root.path())
        .unwrap()
        .iter()
        .all(|addon| addon.version.is_none()));
}

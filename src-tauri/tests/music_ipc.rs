#[path = "../src/addin_manager.rs"]
mod addin_manager;
#[path = "../src/music_ipc.rs"]
mod music_ipc;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::{SystemTime, UNIX_EPOCH};

struct TestRoot(PathBuf);

impl TestRoot {
    fn new() -> Self {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock is after UNIX epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "wasabipad-music-ipc-{}-{unique}",
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

// Feature: アドインの導入状態を取得する
// Scenario: 未導入アドインの状態を固定IDで照会する
// Given: アドイン状態ファイルが存在しないアプリデータroot
// When: LilyPondの状態を問い合わせる
// Then: installed=false、enabled=false、versionなしを返す
#[test]
fn reports_an_uninstalled_addin_for_a_supported_id() {
    let root = TestRoot::new();

    let status = music_ipc::local_addon_status(root.path(), "lilypond").unwrap();

    assert_eq!(status.id, "lilypond");
    assert_eq!(status.version, None);
    assert!(!status.installed);
    assert!(!status.enabled);
    assert!(music_ipc::local_addon_status(root.path(), "third-party").is_err());
}

// Feature: LilyPond実行ファイルを選ぶ
// Scenario: 設定pathを優先し未設定なら候補から検出する
// Given: 設定pathと自動検出候補の両方に実行ファイルがある
// When: 設定値またはnullを使って解決する
// Then: 設定pathを優先し、設定pathが不正なら候補へ黙ってfallbackしない
#[test]
fn configured_path_wins_and_invalid_setting_does_not_fallback() {
    let root = TestRoot::new();
    let configured = root.path().join("chosen lilypond.exe");
    let detected = root.path().join("path/lilypond.exe");
    fs::create_dir_all(detected.parent().unwrap()).unwrap();
    fs::write(&configured, b"test executable").unwrap();
    fs::write(&detected, b"test executable").unwrap();
    let settings = serde_json::json!({"lilypondExecutablePath": configured});
    let configured_text = settings["lilypondExecutablePath"].as_str().unwrap();
    let selected = music_ipc::resolve_lilypond_executable(
        Some(configured_text),
        std::slice::from_ref(&detected),
    )
    .unwrap();
    assert_eq!(
        selected,
        fs::canonicalize(root.path().join("chosen lilypond.exe")).unwrap()
    );

    let missing_setting = root.path().join("missing.exe").display().to_string();
    let error = music_ipc::resolve_lilypond_executable(
        Some(&missing_setting),
        std::slice::from_ref(&detected),
    )
    .unwrap_err();
    assert!(error.contains("Update lilypondExecutablePath"));
}

// Feature: LilyPond実行ファイルを選ぶ
// Scenario: 設定がnullならPATH候補の実行ファイルを検出する
// Given: settings.jsonのlilypondExecutablePathがnullで候補に実行ファイルがある
// When: 設定値を読み、自動検出を行う
// Then: 候補の実行ファイルを返す
#[test]
fn null_setting_uses_an_auto_detected_candidate() {
    let root = TestRoot::new();
    let detected = root.path().join("bin/lilypond.exe");
    fs::create_dir_all(detected.parent().unwrap()).unwrap();
    fs::write(&detected, b"test executable").unwrap();
    let configured =
        music_ipc::configured_lilypond_path(r#"{"lilypondExecutablePath":null}"#).unwrap();

    let selected =
        music_ipc::resolve_lilypond_executable(configured.as_deref(), &[detected.clone()]).unwrap();

    assert_eq!(selected, fs::canonicalize(detected).unwrap());
}

// Feature: LilyPond生成要求を中止する
// Scenario: cancelがgenerate登録より先に届いても次の登録を止める
// Given: 未登録request IDに対するcancel tombstone
// When: 同じIDでgenerate登録し、別要求を中止する
// Then: 先着cancelは生成開始を拒否し、古い要求のcancelは新しい要求へ波及しない
#[test]
fn cancellation_race_and_old_request_do_not_cancel_a_new_request() {
    let mut registry = music_ipc::JobRegistry::default();
    registry.cancel("cancel-first").unwrap();
    assert!(registry.register("cancel-first").is_err());

    let old = registry.register("old-request").unwrap();
    let new = registry.register("new-request").unwrap();
    registry.cancel("old-request").unwrap();
    assert!(old.load(Ordering::Acquire));
    assert!(!new.load(Ordering::Acquire));

    registry.finish("old-request", &old);
    registry.cancel("new-request").unwrap();
    assert!(new.load(Ordering::Acquire));
}

// Feature: LilyPondソースの保存場所を検証する
// Scenario: 相対sourcePathは保存を案内し、未保存nullは許可する
// Given: 相対pathと未保存状態
// When: sourcePathを検証する
// Then: 相対pathは拒否し、nullはNoneとして通す
#[test]
fn rejects_relative_source_paths_but_allows_unsaved_text() {
    assert!(music_ipc::saved_source_path(Some("score.ly".into()))
        .unwrap_err()
        .contains("Save this LilyPond document"));
    assert_eq!(music_ipc::saved_source_path(None).unwrap(), None);
}

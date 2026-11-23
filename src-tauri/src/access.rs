use std::path::{Path, PathBuf};
use serde_json::Value;
use tauri::Manager;

use crate::external_preview_runner::{ExternalPreviewFormat, ExternalPreviewRequest};

pub(crate) const MAIN_WINDOW_LABEL: &str = "main";
const VIEWER_LABEL_PREFIX: &str = "viewer-";

const VIEWER_ALLOWED_SETTING_KEYS: &[&str] = &[
    "fontFamily",
    "previewFontSize",
    "gitPreviewRatio",
];

pub(crate) fn is_main_window_label(label: &str) -> bool {
    label == MAIN_WINDOW_LABEL
}

pub(crate) fn is_viewer_window_label(label: &str) -> bool {
    label
        .strip_prefix(VIEWER_LABEL_PREFIX)
        .is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit()))
}

pub(crate) fn require_main_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    require_main_window_label(window.label())
}

pub(crate) fn require_main_window_label(label: &str) -> Result<(), String> {
    if is_main_window_label(label) {
        Ok(())
    } else {
        Err("この操作はメインウィンドウからのみ実行できます".to_string())
    }
}

pub(crate) fn require_viewer_or_main(window: &tauri::WebviewWindow) -> Result<(), String> {
    require_viewer_or_main_label(window.label())
}

pub(crate) fn require_viewer_or_main_label(label: &str) -> Result<(), String> {
    if is_main_window_label(label) || is_viewer_window_label(label) {
        Ok(())
    } else {
        Err("許可されていないウィンドウからの呼び出しです".to_string())
    }
}

pub(crate) fn require_matching_viewer_label(
    window: &tauri::WebviewWindow,
    requested_label: &str,
) -> Result<(), String> {
    require_matching_viewer_label_str(window.label(), requested_label)
}

pub(crate) fn require_matching_viewer_label_str(
    caller_label: &str,
    requested_label: &str,
) -> Result<(), String> {
    if is_main_window_label(caller_label)
        || (is_viewer_window_label(caller_label) && caller_label == requested_label)
    {
        Ok(())
    } else {
        Err("他のビューアの表示内容は取得できません".to_string())
    }
}

pub(crate) fn require_setting_update_allowed(
    window: &tauri::WebviewWindow,
    key: &str,
) -> Result<(), String> {
    require_setting_update_allowed_for_label(window.label(), key)
}

pub(crate) fn require_setting_update_allowed_for_label(
    caller_label: &str,
    key: &str,
) -> Result<(), String> {
    if is_main_window_label(caller_label) {
        return Ok(());
    }
    if is_viewer_window_label(caller_label) && VIEWER_ALLOWED_SETTING_KEYS.contains(&key) {
        return Ok(());
    }
    Err("この設定はビューアウィンドウから変更できません".to_string())
}

pub(crate) fn authorize_scoped_path(
    caller_label: &str,
    requested_path: &str,
    expected_path: Option<&Path>,
    allow_any_for_main: bool,
    denied_message: &str,
) -> Result<PathBuf, String> {
    require_viewer_or_main_label(caller_label)?;
    if allow_any_for_main && is_main_window_label(caller_label) {
        return Ok(PathBuf::from(requested_path));
    }
    let Some(expected) = expected_path.and_then(|path| path.canonicalize().ok()) else {
        return Err(denied_message.to_owned());
    };
    let Some(canonical) = PathBuf::from(requested_path).canonicalize().ok() else {
        return Err(denied_message.to_owned());
    };
    if canonical != expected {
        return Err(denied_message.to_owned());
    }
    Ok(canonical)
}

pub(crate) fn allow_asset_scope_for_path(app: &tauri::AppHandle, path: &Path) {
    if path.as_os_str().is_empty() {
        return;
    }
    let scope = app.asset_protocol_scope();
    let target = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    if target.is_dir() {
        let _ = scope.allow_directory(&target, true);
    } else {
        let _ = scope.allow_file(&target);
        if let Some(parent) = target.parent() {
            let _ = scope.allow_directory(parent, true);
        }
    }
}

pub(crate) fn parse_external_preview_arguments(value: &str) -> Result<Vec<String>, String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut started = false;
    let chars: Vec<char> = value.chars().collect();
    let mut index = 0;

    while index < chars.len() {
        let character = chars[index];
        if quote == Some('"') && character == '\\' && chars.get(index + 1) == Some(&'"') {
            current.push('"');
            started = true;
            index += 2;
            continue;
        }
        if let Some(open_quote) = quote {
            if character == open_quote {
                quote = None;
            } else {
                current.push(character);
            }
            started = true;
            index += 1;
            continue;
        }
        if character == '"' || character == '\'' {
            quote = Some(character);
            started = true;
        } else if character.is_whitespace() {
            if started {
                args.push(std::mem::take(&mut current));
                started = false;
            }
        } else {
            current.push(character);
            started = true;
        }
        index += 1;
    }
    if quote.is_some() {
        return Err("外部プレビュー引数の引用符が閉じていません".to_string());
    }
    if started {
        args.push(current);
    }
    Ok(args)
}

fn format_name(format: ExternalPreviewFormat) -> &'static str {
    match format {
        ExternalPreviewFormat::Html => "html",
        ExternalPreviewFormat::Svg => "svg",
    }
}

pub(crate) fn validate_external_preview_request_against_settings(
    settings_json: &str,
    request: &ExternalPreviewRequest,
) -> Result<(), String> {
    let root: Value = serde_json::from_str(settings_json)
        .map_err(|error| format!("設定を読み込めませんでした: {error}"))?;
    let object = root
        .as_object()
        .ok_or_else(|| "設定形式が不正です".to_string())?;

    let adapter_id = request.adapter_id.trim();
    if adapter_id.is_empty() {
        return Err("外部プレビューのアダプタIDが指定されていません".to_string());
    }
    let trusted = object
        .get("trustedExternalPreviewAdapterIds")
        .and_then(Value::as_array)
        .is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(adapter_id)));
    if !trusted {
        return Err("信頼済みとして許可されていない外部プレビューは実行できません".to_string());
    }

    let adapter = object
        .get("externalPreviewAdapters")
        .and_then(Value::as_array)
        .and_then(|adapters| {
            adapters.iter().find(|entry| {
                entry
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    == Some(adapter_id)
            })
        })
        .ok_or_else(|| "登録されていない外部プレビューは実行できません".to_string())?;

    let expected_command = adapter
        .get("command")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "外部プレビューの実行ファイル設定が不正です".to_string())?;
    let expected_args_raw = adapter
        .get("args")
        .and_then(Value::as_str)
        .ok_or_else(|| "外部プレビューの引数設定が不正です".to_string())?;
    let expected_args = parse_external_preview_arguments(expected_args_raw)?;
    let expected_format = adapter
        .get("outputFormat")
        .and_then(Value::as_str)
        .ok_or_else(|| "外部プレビューの出力形式設定が不正です".to_string())?;

    if request.executable.trim() != expected_command
        || request.args != expected_args
        || format_name(request.output_format) != expected_format
    {
        return Err("外部プレビューの実行内容が設定と一致しません".to_string());
    }

    if let Some(requested_work_root) = request.work_root.as_deref() {
        let configured_work_root = object
            .get("externalPreviewTemporaryDirectory")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if configured_work_root != Some(requested_work_root.trim()) {
            return Err("外部プレビューの一時保存先が設定と一致しません".to_string());
        }
    }

    Ok(())
}

pub(crate) fn validate_registered_command_against_settings(
    settings_json: &str,
    prefix: &str,
    command: &str,
    value_kind: &str,
) -> Result<(), String> {
    if value_kind != "file" && value_kind != "string" {
        return Err("登録コマンドの対象種別が不正です".to_string());
    }
    let prefix = prefix.trim();
    let command = command.trim();
    if command.is_empty() {
        return Err("コマンドが空です".to_string());
    }
    let root: Value = serde_json::from_str(settings_json)
        .map_err(|error| format!("設定を読み込めませんでした: {error}"))?;
    let commands = root
        .as_object()
        .and_then(|object| object.get("registeredCommands"))
        .and_then(Value::as_array)
        .ok_or_else(|| "登録されていない外部コマンドは実行できません".to_string())?;

    let matched = commands.iter().any(|entry| {
        let Some(entry) = entry.as_object() else {
            return false;
        };
        let entry_prefix = entry
            .get("prefix")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        let entry_command = entry
            .get("command")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        let entry_kind = entry
            .get("valueKind")
            .and_then(Value::as_str)
            .unwrap_or("file");
        entry_prefix == prefix && entry_command == command && entry_kind == value_kind
    });

    if matched {
        Ok(())
    } else {
        Err("登録されていない外部コマンドは実行できません".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Feature: main と viewer-* ウィンドウのバックエンド権限分離
    // Scenario: viewer-* ウィンドウから main 専用コマンド・他ビューア取得・危険な設定更新を試みる
    // Given: main と viewer-1 と viewer-2 のウィンドウラベル
    // When: 各認可ヘルパーで検証する
    // Then: main のみ全操作を許可し、viewer-1 は自身の payload と表示設定3キーのみ許可される
    #[test]
    fn enforces_window_label_authorization_and_viewer_setting_allowlist() {
        assert!(require_main_window_label("main").is_ok());
        assert!(require_main_window_label("viewer-1").is_err());
        assert!(require_main_window_label("unknown").is_err());

        assert!(require_viewer_or_main_label("main").is_ok());
        assert!(require_viewer_or_main_label("viewer-1").is_ok());
        assert!(require_viewer_or_main_label("viewer-abc").is_err());

        assert!(require_matching_viewer_label_str("viewer-1", "viewer-1").is_ok());
        assert!(require_matching_viewer_label_str("viewer-1", "viewer-2").is_err());
        assert!(require_matching_viewer_label_str("main", "viewer-2").is_ok());

        assert!(require_setting_update_allowed_for_label("viewer-1", "fontFamily").is_ok());
        assert!(require_setting_update_allowed_for_label("viewer-1", "previewFontSize").is_ok());
        assert!(require_setting_update_allowed_for_label("viewer-1", "gitPreviewRatio").is_ok());
        assert!(require_setting_update_allowed_for_label("viewer-1", "registeredCommands").is_err());
        assert!(
            require_setting_update_allowed_for_label("viewer-1", "externalPreviewAdapters")
                .is_err()
        );
        assert!(
            require_setting_update_allowed_for_label("viewer-1", "trustedExternalPreviewAdapterIds")
                .is_err()
        );
        assert!(require_setting_update_allowed_for_label("main", "registeredCommands").is_ok());
    }

    // Feature: 外部プレビュー実行のバックエンド設定照合
    // Scenario: 信頼済みアダプタのみ許可し、未信頼・改ざん引数・未設定作業フォルダを拒否する
    // Given: 1件の登録済み外部プレビューアダプタを含む settings.json
    // When: 一致する要求・未信頼ID・引数改ざん・不正 work_root を検証する
    // Then: 完全一致する信頼済み要求のみ許可される
    #[test]
    fn validates_external_preview_request_against_trusted_settings() {
        let settings = r#"{
            "externalPreviewAdapters": [{
                "id": "adapter-1",
                "extensions": ["abc"],
                "command": "C:\\tools\\render.exe",
                "args": "--in \"{file}\" --out \"{output}\"",
                "outputFormat": "html",
                "preferExternal": true
            }],
            "trustedExternalPreviewAdapterIds": ["adapter-1"],
            "externalPreviewTemporaryDirectory": "C:\\temp\\preview"
        }"#;
        let valid = ExternalPreviewRequest {
            adapter_id: "adapter-1".into(),
            input_path: r"C:\work\song.abc".into(),
            executable: r"C:\tools\render.exe".into(),
            args: vec!["--in".into(), "{file}".into(), "--out".into(), "{output}".into()],
            output_format: ExternalPreviewFormat::Html,
            request_id: "req-1".into(),
            work_root: Some(r"C:\temp\preview".into()),
        };
        assert!(validate_external_preview_request_against_settings(settings, &valid).is_ok());

        let mut tampered_args = ExternalPreviewRequest {
            args: vec!["--evil".into()],
            ..valid
        };
        assert!(
            validate_external_preview_request_against_settings(settings, &tampered_args).is_err()
        );

        tampered_args.args = vec!["--in".into(), "{file}".into(), "--out".into(), "{output}".into()];
        tampered_args.work_root = Some(r"C:\evil".into());
        assert!(
            validate_external_preview_request_against_settings(settings, &tampered_args).is_err()
        );

        let untrusted_settings = r#"{
            "externalPreviewAdapters": [{
                "id": "adapter-1",
                "extensions": ["abc"],
                "command": "C:\\tools\\render.exe",
                "args": "{file} {output}",
                "outputFormat": "html",
                "preferExternal": true
            }],
            "trustedExternalPreviewAdapterIds": []
        }"#;
        let untrusted_req = ExternalPreviewRequest {
            adapter_id: "adapter-1".into(),
            input_path: r"C:\work\song.abc".into(),
            executable: r"C:\tools\render.exe".into(),
            args: vec!["{file}".into(), "{output}".into()],
            output_format: ExternalPreviewFormat::Html,
            request_id: "req-2".into(),
            work_root: None,
        };
        assert!(validate_external_preview_request_against_settings(
            untrusted_settings,
            &untrusted_req
        )
        .is_err());
    }

    // Feature: 登録コマンド実行のバックエンド設定照合
    // Scenario: settings.json に登録済みのコマンドテンプレートのみ許可する
    // Given: ファイル用・文字列用の登録コマンドを持つ settings.json
    // When: 登録済みと未登録のテンプレートを照合する
    // Then: 登録済みのみ許可し、未登録や種別不一致を拒否する
    #[test]
    fn validates_registered_command_against_settings() {
        let settings = r#"{
            "registeredCommands": [
                { "label": "Notepad", "prefix": "", "command": "notepad {file}" },
                { "label": "Search", "prefix": "cmd.exe /D /C", "command": "start \"\" https://example.com/?q={string_in_url}", "valueKind": "string" }
            ]
        }"#;
        assert!(
            validate_registered_command_against_settings(settings, "", "notepad {file}", "file")
                .is_ok()
        );
        assert!(validate_registered_command_against_settings(
            settings,
            "cmd.exe /D /C",
            "start \"\" https://example.com/?q={string_in_url}",
            "string"
        )
        .is_ok());
        assert!(
            validate_registered_command_against_settings(settings, "", "calc.exe", "file").is_err()
        );
        assert!(
            validate_registered_command_against_settings(settings, "", "notepad {file}", "string")
                .is_err()
        );
    }

    // Feature: ビューア・メインのパス認可
    // Scenario: viewer-* は自身の表示対象パスのみ許可し、他ファイルや未存在パスを同一エラーで拒否する
    // Given: 実在する表示対象ファイルと別のファイル
    // When: authorize_scoped_path を viewer-1 / main / 不正ラベルで呼び出す
    // Then: 一致するパスのみ許可され、不一致・未存在・不正ラベルは拒否される
    #[test]
    fn authorizes_scoped_path_for_viewer_and_main() {
        let dir = std::env::temp_dir().join(format!("wasabipad_access_scope_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let allowed = dir.join("allowed.db");
        let other = dir.join("other.db");
        let missing = dir.join("missing.db");
        std::fs::write(&allowed, b"a").unwrap();
        std::fs::write(&other, b"b").unwrap();

        let allowed_str = allowed.to_string_lossy().into_owned();
        let other_str = other.to_string_lossy().into_owned();
        let missing_str = missing.to_string_lossy().into_owned();

        assert!(authorize_scoped_path("viewer-1", &allowed_str, Some(&allowed), false, "denied").is_ok());
        assert_eq!(
            authorize_scoped_path("viewer-1", &other_str, Some(&allowed), false, "denied").unwrap_err(),
            "denied"
        );
        assert_eq!(
            authorize_scoped_path("viewer-1", &missing_str, Some(&allowed), false, "denied").unwrap_err(),
            "denied"
        );
        assert!(authorize_scoped_path("main", &other_str, None, true, "denied").is_ok());
        assert_eq!(
            authorize_scoped_path("main", &other_str, Some(&allowed), false, "denied").unwrap_err(),
            "denied"
        );
        assert!(authorize_scoped_path("evil", &allowed_str, Some(&allowed), true, "denied").is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    // Feature: assetProtocol の動的スコープ許可
    // Scenario: 開いた文書・ビューア対象・外部プレビュー出力のファイルと親ディレクトリのみ assetProtocol へ許可する
    // Given: assetProtocol.scope が空配列で起動した Tauri AppHandle
    // When: allow_asset_scope_for_path に実在ファイルまたはディレクトリパスを渡す
    // Then: ディレクトリなら再帰許可、ファイルなら当該ファイルと親ディレクトリのみ再帰許可する（AppHandle 実体が必要なため仕様記述のみ）
    #[test]
    fn allow_asset_scope_for_path_spec() {}
}

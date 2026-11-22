use std::path::PathBuf;

use wasabipad_core::BookmarkNode;

#[cfg(target_os = "windows")]
#[repr(C)]
struct OpenAsInfo {
    file: *const u16,
    class: *const u16,
    flags: u32,
}

#[cfg(target_os = "windows")]
#[link(name = "shell32")]
extern "system" {
    #[link_name = "SHOpenWithDialog"]
    fn sh_open_with_dialog(parent: *mut std::ffi::c_void, info: *const OpenAsInfo) -> i32;
    #[link_name = "ShellExecuteW"]
    fn shell_execute_w(
        hwnd: *mut std::ffi::c_void,
        operation: *const u16,
        file: *const u16,
        parameters: *const u16,
        directory: *const u16,
        show_command: i32,
    ) -> isize;
}

fn explorer_args(path: &str, is_dir: bool) -> Result<Vec<String>, String> {
    let target = PathBuf::from(path);
    if is_dir {
        if !target.is_dir() {
            return Err("対象フォルダが見つかりません".to_string());
        }
        return Ok(vec![path.to_string()]);
    }
    if !target.is_file() {
        return Err("対象ファイルが見つかりません".to_string());
    }
    Ok(vec![format!("/select,{path}")])
}

pub(crate) fn reveal_in_explorer(path: String, is_dir: bool) -> Result<(), String> {
    let args = explorer_args(&path, is_dir)?;
    let mut cmd = std::process::Command::new("explorer");
    cmd.args(args);
    // explorer は既存ウィンドウへ委譲した場合など正常時でも非0を返すことがあるため終了コードは見ない
    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn open_in_other_app(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;

        let target = PathBuf::from(path);
        if !target.is_file() {
            return Err("対象ファイルが見つかりません".to_string());
        }
        let wide: Vec<u16> = target
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let info = OpenAsInfo {
            file: wide.as_ptr(),
            class: std::ptr::null(),
            // 選択したアプリで対象ファイルを開く。既定アプリの変更は要求しない。
            flags: 0x0000_0004,
        };
        let result = unsafe { sh_open_with_dialog(std::ptr::null_mut(), &info) };
        if result >= 0 {
            Ok(())
        } else {
            Err(format!(
                "アプリ選択画面を開けませんでした (HRESULT: 0x{result:08X})"
            ))
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Err("この機能はWindowsでのみ使用できます".to_string())
    }
}

pub(crate) fn open_in_default_browser(
    path: String,
    effective_extension: Option<String>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let target = PathBuf::from(path);
        let extension = effective_extension
            .as_deref()
            .or_else(|| target.extension().and_then(|value| value.to_str()));
        if !target.is_file() || !is_html_extension(extension) {
            return Err("HTMLファイルが見つかりません".to_string());
        }
        shell_execute_open(&browser_target(&target, effective_extension.as_deref()))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (path, effective_extension);
        Err("この機能はWindowsでのみ使用できます".to_string())
    }
}

#[cfg(target_os = "windows")]
fn is_html_extension(extension: Option<&str>) -> bool {
    matches!(
        extension.map(str::to_ascii_lowercase).as_deref(),
        Some("html" | "htm")
    )
}

#[cfg(target_os = "windows")]
fn browser_target(path: &std::path::Path, effective_extension: Option<&str>) -> String {
    let physical_extension = path
        .extension()
        .and_then(|value| value.to_str());
    if is_html_extension(effective_extension) && !is_html_extension(physical_extension) {
        file_uri_for_path(path)
    } else {
        path.to_string_lossy().into_owned()
    }
}

#[cfg(target_os = "windows")]
fn file_uri_for_path(path: &std::path::Path) -> String {
    use std::fmt::Write as _;

    let path = path.to_string_lossy().replace('\\', "/");
    let (prefix, uri_path) = if path.starts_with("//") {
        ("file://", path.trim_start_matches('/').to_string())
    } else if path.starts_with('/') {
        ("file://", path)
    } else {
        ("file://", format!("/{path}"))
    };
    let mut encoded = String::with_capacity(uri_path.len());
    for byte in uri_path.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~' | b'/' | b':') {
            encoded.push(*byte as char);
        } else {
            let _ = write!(&mut encoded, "%{byte:02X}");
        }
    }
    format!("{prefix}{encoded}")
}

pub(crate) fn is_external_url(url: &str) -> bool {
    let trimmed = url.trim();
    if trimmed.is_empty() || trimmed.chars().any(char::is_whitespace) {
        return false;
    }
    let Some((scheme, rest)) = trimmed.split_once("://") else {
        return false;
    };
    (scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https"))
        && !rest.is_empty()
}

fn open_external_url_with<F>(url: String, open: F) -> Result<(), String>
where
    F: FnOnce(&str) -> Result<(), String>,
{
    let trimmed = url.trim();
    if !is_external_url(trimmed) {
        return Err("HTTPまたはHTTPSのURLではありません".to_string());
    }
    open(trimmed)
}

#[cfg(target_os = "windows")]
fn shell_execute_open(target: &str) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;

    let operation: Vec<u16> = "open".encode_utf16().chain(std::iter::once(0)).collect();
    let wide: Vec<u16> = std::ffi::OsStr::new(target)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let result = unsafe {
        shell_execute_w(
            std::ptr::null_mut(),
            operation.as_ptr(),
            wide.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
        )
    };
    if result > 32 {
        Ok(())
    } else {
        Err(format!(
            "既定のブラウザで開けませんでした (HRESULT: 0x{result:08X})"
        ))
    }
}

pub(crate) fn open_external_url(url: String) -> Result<(), String> {
    open_external_url_with(url, |trimmed| {
        #[cfg(target_os = "windows")]
        {
            shell_execute_open(trimmed)
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = trimmed;
            Err("この機能はWindowsでのみ使用できます".to_string())
        }
    })
}

#[cfg(target_os = "windows")]
fn spawn_command_line(command: &str) -> Result<(), String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError};
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, PROCESS_INFORMATION, STARTUPINFOW,
    };

    let mut command_line: Vec<u16> = OsStr::new(command)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut startup_info = unsafe { std::mem::zeroed::<STARTUPINFOW>() };
    startup_info.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    let mut process_info = unsafe { std::mem::zeroed::<PROCESS_INFORMATION>() };
    let created = unsafe {
        CreateProcessW(
            std::ptr::null(),
            command_line.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            0,
            std::ptr::null(),
            std::ptr::null(),
            &startup_info,
            &mut process_info,
        )
    };
    if created == 0 {
        let error = unsafe { GetLastError() };
        return Err(std::io::Error::from_raw_os_error(error as i32).to_string());
    }

    unsafe {
        let _ = CloseHandle(process_info.hThread);
        let _ = CloseHandle(process_info.hProcess);
    }
    Ok(())
}

#[derive(Debug, serde::Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
#[ts(export)]
pub struct ExternalCommandRequest {
    pub prefix: String,
    pub command: String,
    pub value: String,
    pub value_kind: String,
    pub path: String,
}

fn encode_uri_component_js(value: &str) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            out.push(*byte as char);
        } else {
            let _ = write!(&mut out, "%{byte:02X}");
        }
    }
    out
}

fn one_line_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\r' {
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
            out.push(' ');
        } else if ch == '\n' {
            out.push(' ');
        } else {
            out.push(ch);
        }
    }
    out
}

pub(crate) fn expand_registered_template(template: &str, value: &str, value_kind: &str) -> String {
    let mut result = String::with_capacity(template.len());
    let mut rest = template;
    while !rest.is_empty() {
        if value_kind == "string" {
            if let Some(after) = rest.strip_prefix("{string_in_url}") {
                result.push_str(&encode_uri_component_js(value));
                rest = after;
                continue;
            }
            if let Some(after) = rest.strip_prefix("{string_one_line}") {
                result.push_str(&one_line_value(value));
                rest = after;
                continue;
            }
            if let Some(after) = rest.strip_prefix("{copy_string_clipboard}") {
                rest = after;
                continue;
            }
            if let Some(after) = rest.strip_prefix("{string}") {
                result.push_str(value);
                rest = after;
                continue;
            }
        } else if let Some(after) = rest.strip_prefix("{file}") {
            result.push_str(value);
            rest = after;
            continue;
        }
        let step = rest.chars().next().map(char::len_utf8).unwrap_or(1);
        let next_brace = rest[step..].find('{').map(|offset| offset + step);
        let split_at = next_brace.unwrap_or(rest.len());
        result.push_str(&rest[..split_at]);
        rest = &rest[split_at..];
    }
    result
}

fn split_template_tokens(template: &str) -> Option<Vec<String>> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut started = false;
    let chars: Vec<char> = template.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if in_quotes {
            if ch == '"' {
                if chars.get(i + 1) == Some(&'"') {
                    current.push('"');
                    i += 2;
                    continue;
                }
                in_quotes = false;
            } else {
                current.push(ch);
            }
            started = true;
            i += 1;
            continue;
        }
        if ch == '"' {
            in_quotes = true;
            started = true;
        } else if ch.is_whitespace() {
            if started {
                tokens.push(std::mem::take(&mut current));
                started = false;
            }
        } else {
            current.push(ch);
            started = true;
        }
        i += 1;
    }
    if in_quotes {
        return None;
    }
    if started {
        tokens.push(current);
    }
    Some(tokens)
}

fn is_shell_executable(executable: &str) -> bool {
    let normalized = executable.trim().trim_matches('"');
    let file_name = std::path::Path::new(normalized)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(normalized)
        .to_ascii_lowercase();
    matches!(
        file_name.as_str(),
        "cmd" | "cmd.exe" | "powershell" | "powershell.exe" | "pwsh" | "pwsh.exe"
    ) || file_name.ends_with(".bat")
        || file_name.ends_with(".cmd")
}

#[derive(Debug, PartialEq, Eq)]
enum PreparedExternalCommand {
    Direct { executable: String, args: Vec<String> },
    ShellCommandLine(String),
}

fn prepare_external_command(request: &ExternalCommandRequest) -> Result<PreparedExternalCommand, String> {
    if request.path.contains('\0') || request.value.contains('\0') {
        return Err("不正な文字が含まれています".to_string());
    }
    if !PathBuf::from(&request.path).is_file() {
        return Err("対象ファイルが見つかりません".to_string());
    }
    let effective_value = if request.value_kind == "file" {
        request.path.as_str()
    } else {
        request.value.as_str()
    };
    let prefix = request.prefix.trim();
    let command = request.command.trim();
    if command.is_empty() {
        return Err("コマンドが空です".to_string());
    }
    let combined_template = if prefix.is_empty() {
        command.to_string()
    } else {
        format!("{prefix} {command}")
    };
    if let Some(tokens) = split_template_tokens(&combined_template) {
        if let Some((first, rest)) = tokens.split_first() {
            let executable = expand_registered_template(first, effective_value, &request.value_kind);
            if !executable.trim().is_empty() && !is_shell_executable(&executable) {
                let mut args = Vec::with_capacity(rest.len());
                for token in rest {
                    if request.value_kind == "string" && token == "{copy_string_clipboard}" {
                        continue;
                    }
                    args.push(expand_registered_template(
                        token,
                        effective_value,
                        &request.value_kind,
                    ));
                }
                return Ok(PreparedExternalCommand::Direct { executable, args });
            }
        }
    }
    let expanded_command = expand_registered_template(command, effective_value, &request.value_kind);
    let full = if prefix.is_empty() {
        expanded_command
    } else {
        format!("{prefix} {expanded_command}")
    };
    let trimmed = full.trim();
    if trimmed.is_empty() {
        return Err("コマンドが空です".to_string());
    }
    Ok(PreparedExternalCommand::ShellCommandLine(trimmed.to_string()))
}

pub(crate) fn run_external_command(request: ExternalCommandRequest) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let settings = wasabipad_core::load_settings().map_err(|error| error.to_string())?;
        crate::access::validate_registered_command_against_settings(
            &settings,
            &request.prefix,
            &request.command,
            &request.value_kind,
        )?;
        match prepare_external_command(&request)? {
            PreparedExternalCommand::Direct { executable, args } => {
                std::process::Command::new(executable)
                    .args(args)
                    .spawn()
                    .map(|_| ())
                    .map_err(|error| error.to_string())
            }
            PreparedExternalCommand::ShellCommandLine(command_line) => {
                spawn_command_line(&command_line)
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = request;
        Err("この機能はWindowsでのみ使用できます".to_string())
    }
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use std::fs;

    // Feature: Explorer引数の生成
    // Scenario: 空白を含むファイルを選択する
    // Given: 空白を含む実ファイルが存在する
    // When: ファイル用のExplorer引数を生成する
    // Then: /select,と実ファイルパスが1引数になる
    #[test]
    fn builds_one_select_argument_for_a_file_with_spaces() {
        let root = std::env::temp_dir().join(format!("wasabipad_explorer_{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let file = root.join("memo with space.txt");
        fs::write(&file, "memo").unwrap();

        let args = super::explorer_args(&file.to_string_lossy(), false).unwrap();

        assert_eq!(args, vec![format!("/select,{}", file.to_string_lossy())]);
        fs::remove_dir_all(root).unwrap();
    }

    // Feature: Explorer引数の生成
    // Scenario: フォルダを開く
    // Given: 実フォルダが存在する
    // When: フォルダ用のExplorer引数を生成する
    // Then: フォルダパスだけを1引数として返す
    #[test]
    fn builds_a_directory_argument_for_a_folder() {
        let root = std::env::temp_dir().join(format!("wasabipad_explorer_dir_{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();

        let args = super::explorer_args(&root.to_string_lossy(), true).unwrap();

        assert_eq!(args, vec![root.to_string_lossy().to_string()]);
        fs::remove_dir_all(root).unwrap();
    }

    // Feature: Explorer引数の生成
    // Scenario: 存在しない対象を指定する
    // Given: ファイルもフォルダも存在しないパスがある
    // When: Explorer引数を生成する
    // Then: フォールバック起動せずエラーを返す
    #[test]
    fn rejects_a_missing_explorer_target() {
        let path = std::env::temp_dir()
            .join(format!("wasabipad_missing_explorer_{}", std::process::id()))
            .to_string_lossy()
            .to_string();

        assert!(super::explorer_args(&path, false).is_err());
        assert!(super::explorer_args(&path, true).is_err());
    }

    // Feature: 登録コマンドの外部実行
    // Scenario: 完成したコマンドラインをそのまま起動する
    // Given: すぐ終了するcmd.exeコマンドがある
    // When: 登録コマンドの実行処理を呼ぶ
    // Then: シェルを追加せずに起動できる
    #[test]
    fn runs_the_complete_command_line_without_adding_a_shell() {
        super::spawn_command_line("cmd.exe /D /C exit 0").unwrap();
    }

    // Feature: Markdown外部URLの既定ブラウザ起動
    // Scenario: HTTP/HTTPSだけを外部URLとして受け付ける
    // Given: HTTP、HTTPS、mailto、javascript、プロトコル相対URLがある
    // When: 外部URLの許可判定を行う
    // Then: HTTP/HTTPSだけがtrueになる
    #[test]
    fn accepts_only_http_and_https_external_urls() {
        assert!(super::is_external_url("https://zenn.dev/article?lang=ja#top"));
        assert!(super::is_external_url("HTTP://example.com/manual"));
        assert!(!super::is_external_url("mailto:user@example.com"));
        assert!(!super::is_external_url("javascript:alert(1)"));
        assert!(!super::is_external_url("//example.com/manual"));
    }

    // Feature: Markdown外部URLの既定ブラウザ起動
    // Scenario: HTTP/HTTPS以外を起動しない
    // Given: mailto URLが指定される
    // When: 外部URL起動を要求する
    // Then: ブラウザ起動前にエラーを返す
    #[test]
    fn rejects_non_web_urls_before_opening_browser() {
        assert_eq!(
            super::open_external_url("mailto:user@example.com".to_string()).unwrap_err(),
            "HTTPまたはHTTPSのURLではありません",
        );
    }

    // Feature: Markdown外部URLの既定ブラウザ起動
    // Scenario: 有効なURLを既定ブラウザ起動へ渡す
    // Given: 前後に空白のあるHTTPS URLが指定される
    // When: 外部URL起動を要求する
    // Then: 空白を除いた完全なURLがブラウザ起動処理へ渡される
    #[test]
    fn passes_a_valid_external_url_to_the_browser_opener() {
        let mut opened = None;
        super::open_external_url_with(
            "  https://example.com/manual?lang=ja#top  ".to_string(),
            |url| {
                opened = Some(url.to_string());
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(opened.as_deref(), Some("https://example.com/manual?lang=ja#top"));
    }

    // Feature: 形式指定したHTMLの既定ブラウザ起動
    // Scenario: 実拡張子がHTMLでないファイルをHTMLとして開く
    // Given: 空白と`#`を含む実ファイルパスがある
    // When: 有効拡張子をhtmlにしてブラウザ起動先を作る
    // Then: 実パスをfile URIへ変換し、Windowsの拡張子関連付けに依存しない
    #[test]
    fn uses_a_file_uri_for_html_with_a_different_physical_extension() {
        let path = std::path::Path::new(r"C:\work\memo #1.bin");

        assert_eq!(
            super::browser_target(path, Some("html")),
            "file:///C:/work/memo%20%231.bin"
        );
    }

    // Feature: 形式指定したHTMLの既定ブラウザ起動
    // Scenario: UNC上の実ファイルをHTMLとして開く
    // Given: UNC共有上に空白と`#`を含む実ファイルパスがある
    // When: 有効拡張子をhtmlにしてブラウザ起動先を作る
    // Then: UNCホストをfile URIのauthorityとして保持する
    #[test]
    fn uses_a_unc_authority_for_html_with_a_different_physical_extension() {
        let path = std::path::Path::new(r"\\server\share\memo #1.bin");

        assert_eq!(
            super::browser_target(path, Some("html")),
            "file://server/share/memo%20%231.bin"
        );
    }

    // Feature: 通常HTMLの既定ブラウザ起動
    // Scenario: 実拡張子がHTMLのファイルを開く
    // Given: `.html`の実ファイルパスがある
    // When: ブラウザ起動先を作る
    // Then: 実パスをそのままWindowsへ渡す
    #[test]
    fn keeps_the_physical_path_for_a_genuine_html_file() {
        let path = std::path::Path::new(r"C:\work\index.html");

        assert_eq!(super::browser_target(path, None), r"C:\work\index.html");
    }

    // Feature: 登録コマンドの安全な引数展開と二重置換防止
    // Scenario: 非シェル実行ファイルへ空白と引用符を含むパスを渡す・二重置換候補を含む文字列を渡す
    // Given: 実在ファイルと非シェルコマンド・文字列コマンド
    // When: prepare_external_command / expand_registered_template を呼ぶ
    // Then: 非シェルは実行ファイルと引数配列へ安全分離し、文字列プレースホルダは単一パスで展開する
    #[test]
    fn prepares_direct_args_safely_and_avoids_double_expansion() {
        let root = std::env::temp_dir().join(format!("wasabipad_extcmd_{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let file = root.join("note with space & test.txt");
        fs::write(&file, "hello").unwrap();

        let prepared = super::prepare_external_command(&super::ExternalCommandRequest {
            prefix: String::new(),
            command: r#""C:\Program Files\App\tool.exe" --open {file}"#.into(),
            value: file.to_string_lossy().into_owned(),
            value_kind: "file".into(),
            path: file.to_string_lossy().into_owned(),
        })
        .unwrap();
        assert_eq!(
            prepared,
            super::PreparedExternalCommand::Direct {
                executable: r"C:\Program Files\App\tool.exe".into(),
                args: vec!["--open".into(), file.to_string_lossy().into_owned()],
            }
        );

        let expanded = super::expand_registered_template(
            "open {string_one_line} {string}",
            "a\n{string}",
            "string",
        );
        assert_eq!(expanded, "open a {string} a\n{string}");
        let _ = fs::remove_dir_all(&root);
    }
}

pub(crate) fn load_bookmarks() -> Result<Vec<BookmarkNode>, String> {
    wasabipad_core::load_bookmarks().map_err(|error| error.to_string())
}

pub(crate) fn save_bookmarks(nodes: Vec<BookmarkNode>) -> Result<(), String> {
    wasabipad_core::save_bookmarks(&nodes).map_err(|e| e.to_string())
}

pub(crate) fn load_settings() -> Result<String, String> {
    wasabipad_core::load_settings().map_err(|error| error.to_string())
}

pub(crate) fn update_setting(key: String, value_json: String) -> Result<(), String> {
    wasabipad_core::update_setting(&key, &value_json).map_err(|e| e.to_string())
}

pub(crate) fn path_is_directory(path: String) -> bool {
    PathBuf::from(path).is_dir()
}

pub(crate) fn next_memo_path(
    directory: String,
    stem: String,
    extension: String,
) -> Result<String, String> {
    wasabipad_core::next_available_path(&PathBuf::from(directory), &stem, &extension)
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}

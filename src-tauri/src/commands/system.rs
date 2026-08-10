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

pub(crate) fn open_in_default_browser(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;

        let target = PathBuf::from(path);
        let extension = target.extension().and_then(|value| value.to_str());
        if !target.is_file()
            || !matches!(
                extension.map(str::to_ascii_lowercase).as_deref(),
                Some("html" | "htm")
            )
        {
            return Err("HTMLファイルが見つかりません".to_string());
        }
        let operation: Vec<u16> = "open".encode_utf16().chain(std::iter::once(0)).collect();
        let wide: Vec<u16> = target
            .as_os_str()
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
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Err("この機能はWindowsでのみ使用できます".to_string())
    }
}

#[cfg(target_os = "windows")]
struct ProcessHandles {
    thread: windows_sys::Win32::Foundation::HANDLE,
    process: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(target_os = "windows")]
impl Drop for ProcessHandles {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;

        unsafe {
            let _ = CloseHandle(self.thread);
            let _ = CloseHandle(self.process);
        }
    }
}

#[cfg(target_os = "windows")]
fn spawn_command_line(command: &str) -> Result<(), String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::GetLastError;
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

    let _handles = ProcessHandles {
        thread: process_info.hThread,
        process: process_info.hProcess,
    };
    Ok(())
}

pub(crate) fn run_external_command(command: String, path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let target = PathBuf::from(path);
        if !target.is_file() {
            return Err("対象ファイルが見つかりません".to_string());
        }
        let command = command.trim();
        if command.is_empty() {
            return Err("コマンドが空です".to_string());
        }
        // {file}の置換とプレフィックスの連結はUI側で済ませ、確認欄と同じ文字列をそのまま実行する。
        // コンソールを隠さず起動するが、アプリ側は子プロセスの終了を待たずに戻る。
        spawn_command_line(command)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (command, path);
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

    #[test]
    fn runs_the_complete_command_line_without_adding_a_shell() {
        super::spawn_command_line("cmd.exe /D /C exit 0").unwrap();
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

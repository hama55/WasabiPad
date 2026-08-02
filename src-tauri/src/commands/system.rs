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
}

pub(crate) fn reveal_in_explorer(path: String, is_dir: bool) -> Result<(), String> {
    let mut cmd = std::process::Command::new("explorer");
    if is_dir {
        cmd.arg(&path);
    } else {
        // 空白入りパスでも explorer の legacy parser がパス部分だけを正しく引用できるよう分離する
        cmd.arg("/select,").arg(&path);
    }
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

pub(crate) fn run_external_command(command: String, path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;

        let target = PathBuf::from(path);
        if !target.is_file() {
            return Err("対象ファイルが見つかりません".to_string());
        }
        let command = command.trim();
        if command.is_empty() {
            return Err("コマンドが空です".to_string());
        }
        // {file}の置換とプレフィックスの連結はUI側で済ませ、確認欄と同じ文字列を実行する。
        std::process::Command::new("cmd.exe")
            .args(["/D", "/C", command])
            // 外部GUIアプリを起動するときにコンソール画面を出さない。
            .creation_flags(0x0800_0000)
            .spawn()
            .map_err(|error| error.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (command, path);
        Err("この機能はWindowsでのみ使用できます".to_string())
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

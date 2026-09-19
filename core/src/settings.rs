// アプリ設定JSONの構造はフロント (ui/settings.ts) だけが持つ。
// core はキー単位でJSON値を差し替え、複数プロセスが古い設定全体を上書きしないようにする。
use std::fs::OpenOptions;
use std::io;
use std::path::PathBuf;

// ディレクトリ名は app-config.json から scripts/sync-app-config.mjs が同期する。
// インストーラは exe を %LOCALAPPDATA%\WasabiPad\ へ置く。設定もそこへ揃えると
// インストール版では従来の「exe 隣」と同じ場所になり、保存先が分かれない。
pub(crate) fn app_data_root() -> io::Result<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA")
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "LOCALAPPDATA が取得できません"))?;
    Ok(PathBuf::from(local).join("WasabiPad"))
}

pub(crate) fn config_path(file: &str) -> io::Result<PathBuf> {
    Ok(app_data_root()?.join(file))
}

pub(crate) fn write_config(path: PathBuf, contents: &str) -> io::Result<()> {
    crate::atomic_file::atomic_write(&path, &[contents.as_bytes()])
}

pub fn load() -> io::Result<String> {
    with_settings_lock(|| {
        let path = config_path("settings.json")?;
        match std::fs::read_to_string(path) {
            Ok(contents) => Ok(contents),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok("{}".to_string()),
            Err(error) => Err(error),
        }
    })
}

pub fn update(key: &str, value_json: &str) -> io::Result<()> {
    with_settings_lock(|| {
        let path = config_path("settings.json")?;
        let current = match std::fs::read_to_string(&path) {
            Ok(contents) => contents,
            Err(error) if error.kind() == io::ErrorKind::NotFound => "{}".to_string(),
            Err(error) => return Err(error),
        };
        let json = merge_setting(&current, key, value_json)?;
        write_config(path, &json)
    })
}

fn merge_setting(current: &str, key: &str, value_json: &str) -> io::Result<String> {
    let mut root = serde_json::from_str::<serde_json::Value>(current)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    let object = root.as_object_mut().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidData, "設定JSONがobjectではありません")
    })?;
    let value = serde_json::from_str(value_json)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    object.insert(key.to_string(), value);
    serde_json::to_string_pretty(&root).map_err(io::Error::other)
}

#[cfg(target_os = "windows")]
fn with_settings_lock<T>(operation: impl FnOnce() -> io::Result<T>) -> io::Result<T> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        LockFileEx, UnlockFileEx, LOCKFILE_EXCLUSIVE_LOCK,
    };
    use windows_sys::Win32::System::IO::OVERLAPPED;

    let path = config_path("settings.lock")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(path)?;
    let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
    let handle = file.as_raw_handle();
    let locked = unsafe {
        LockFileEx(
            handle,
            LOCKFILE_EXCLUSIVE_LOCK,
            0,
            u32::MAX,
            u32::MAX,
            &mut overlapped,
        )
    };
    if locked == 0 {
        return Err(io::Error::last_os_error());
    }
    let result = operation();
    let unlocked = unsafe { UnlockFileEx(handle, 0, u32::MAX, u32::MAX, &mut overlapped) };
    if unlocked == 0 && result.is_ok() {
        return Err(io::Error::last_os_error());
    }
    result
}

#[cfg(not(target_os = "windows"))]
fn with_settings_lock<T>(operation: impl FnOnce() -> io::Result<T>) -> io::Result<T> {
    operation()
}

#[cfg(test)]
mod tests {
    use super::merge_setting;

    #[test]
    fn update_preserves_other_process_fields() {
        let merged = merge_setting(
            r#"{"openTabs":{"tabs":["new"]},"indentSize":8}"#,
            "indentSize",
            "4",
        )
        .unwrap();
        let value: serde_json::Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(value["openTabs"]["tabs"][0], "new");
        assert_eq!(value["indentSize"], 4);
    }

    #[test]
    fn update_rejects_corrupt_settings_instead_of_erasing_them() {
        let error = merge_setting("{broken", "indentSize", "4").unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    }
}

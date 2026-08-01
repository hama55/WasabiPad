// アプリ設定JSONの構造はフロント (ui/settings.ts) だけが持つ。
// core はキー単位でJSON値を差し替え、複数プロセスが古い設定全体を上書きしないようにする。
use std::fs::OpenOptions;
use std::io;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

// ディレクトリ名は app-config.json から scripts/sync-app-config.mjs が同期する。
// インストーラは exe を %LOCALAPPDATA%\WasabiPad\ へ置く。設定もそこへ揃えると
// インストール版では従来の「exe 隣」と同じ場所になり、保存先が分かれない。
pub(crate) fn config_path(file: &str) -> io::Result<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA")
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "LOCALAPPDATA が取得できません"))?;
    Ok(PathBuf::from(local).join("WasabiPad").join(file))
}

pub(crate) fn write_config(path: PathBuf, contents: &str) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let id = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temp = path.with_extension(format!("tmp-{}-{timestamp}-{id}", std::process::id()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)?;
        file.write_all(contents.as_bytes())?;
        file.sync_all()?;
        replace_file(&temp, &path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

#[cfg(target_os = "windows")]
fn replace_file(source: &std::path::Path, target: &std::path::Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    let moved = unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(target_os = "windows"))]
fn replace_file(source: &std::path::Path, target: &std::path::Path) -> io::Result<()> {
    std::fs::rename(source, target)
}

pub fn load() -> String {
    with_settings_lock(|| {
        Ok(config_path("settings.json")
            .and_then(std::fs::read_to_string)
            .unwrap_or_else(|_| "{}".to_string()))
    })
    .unwrap_or_else(|_| "{}".to_string())
}

pub fn update(key: &str, value_json: &str) -> io::Result<()> {
    with_settings_lock(|| {
        let path = config_path("settings.json")?;
        let current = std::fs::read_to_string(&path).unwrap_or_else(|_| "{}".to_string());
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

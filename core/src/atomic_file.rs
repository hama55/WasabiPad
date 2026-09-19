use std::fs::OpenOptions;
use std::io::{self, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

pub(crate) fn atomic_write(path: &Path, chunks: &[&[u8]]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
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
        for chunk in chunks {
            file.write_all(chunk)?;
        }
        file.sync_all()?;
        replace_file(&temp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

#[cfg(target_os = "windows")]
fn replace_file(source: &Path, target: &Path) -> io::Result<()> {
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
fn replace_file(source: &Path, target: &Path) -> io::Result<()> {
    std::fs::rename(source, target)
}

#[cfg(test)]
mod tests {
    use super::atomic_write;

    // Feature: 原子的な内部ファイル保存
    // Scenario: 既存ファイルを複数のバイト断片で置換する
    // Given: 古い内容を持つ保存先
    // When: 二つの断片を原子的に書く
    // Then: 保存先には結合済みの新しい内容だけが残る
    #[test]
    fn atomic_write_replaces_existing_content_from_chunks() {
        let root = std::env::temp_dir().join(format!(
            "wasabipad_atomic_write_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("state.bin");
        std::fs::write(&path, b"old").unwrap();

        atomic_write(&path, &[b"new ", b"content"]).unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), b"new content");
        std::fs::remove_dir_all(root).unwrap();
    }
}

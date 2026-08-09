use std::io;
use std::path::{Path, PathBuf};

// 新規メモの採番規則。1件目は "stem.ext"、以降は "stem1.ext"、"stem2.ext"…
// (命名規則はコア側の関心。IPC層はパスを受け取るだけ)
pub fn next_available_path(dir: &Path, stem: &str, extension: &str) -> io::Result<PathBuf> {
    let stem = stem.trim();
    let ext = extension.trim_start_matches('.');
    let with_ext = |base: &str| if ext.is_empty() { base.to_string() } else { format!("{base}.{ext}") };
    validate_windows_file_name(&with_ext(stem))?;
    let plain = dir.join(with_ext(stem));
    if !plain.exists() {
        return Ok(plain);
    }
    for number in 1.. {
        let candidate = dir.join(with_ext(&format!("{stem}{number}")));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    unreachable!()
}

pub fn validate_windows_file_name(name: &str) -> io::Result<()> {
    let invalid = name.is_empty()
        || name == "."
        || name == ".."
        || name.chars().any(|c| c <= '\u{1f}' || r#"<>:"/\|?*"#.contains(c))
        || name.ends_with([' ', '.']);
    let base = name.split('.').next().unwrap_or_default();
    let reserved = matches!(
        base.to_ascii_uppercase().as_str(),
        "CON" | "PRN" | "AUX" | "NUL"
            | "COM1" | "COM2" | "COM3" | "COM4" | "COM5" | "COM6" | "COM7" | "COM8" | "COM9"
            | "LPT1" | "LPT2" | "LPT3" | "LPT4" | "LPT5" | "LPT6" | "LPT7" | "LPT8" | "LPT9"
    );
    if invalid || reserved {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Windowsで使用できない名前です",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{next_available_path, validate_windows_file_name};

    #[test]
    fn accepts_regular_names() {
        assert!(validate_windows_file_name("メモ 1.md").is_ok());
        assert!(validate_windows_file_name("report.final.csv").is_ok());
        assert!(validate_windows_file_name("COM10.txt").is_ok());
    }

    #[test]
    // Feature: 新規メモの連番
    // Scenario: 初期名が存在すると1から順に空き名を探す
    // Given: `memo.txt`が存在する
    // When: `next_available_path`で`memo.txt`の候補を求める
    // Then: `memo1.txt`を返し、さらに`memo1.txt`が存在すると`memo2.txt`を返す
    #[test]
    fn numbers_start_at_one_after_the_plain_name_is_taken() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("wasabipad_next_path_{}_{}_numbers", std::process::id(), unique));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("memo.txt"), "").unwrap();
        assert_eq!(next_available_path(&dir, "memo", ".txt").unwrap(), dir.join("memo1.txt"));
        std::fs::write(dir.join("memo1.txt"), "").unwrap();
        assert_eq!(next_available_path(&dir, "memo", "txt").unwrap(), dir.join("memo2.txt"));
        let _ = std::fs::remove_dir_all(dir);
    }

    // Feature: 新規メモの拡張子変更
    // Scenario: 拡張子を変えたら採番を初期化する
    // Given: `memo.txt`と`memo1.txt`が存在し、`memo.md`は存在しない
    // When: 拡張子`md`で`next_available_path`を呼ぶ
    // Then: `memo.md`を返す
    #[test]
    fn extension_change_restarts_from_the_plain_name() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("wasabipad_next_path_{}_{}_extension", std::process::id(), unique));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("memo.txt"), "").unwrap();
        std::fs::write(dir.join("memo1.txt"), "").unwrap();
        assert_eq!(next_available_path(&dir, "memo", "md").unwrap(), dir.join("memo.md"));
        assert_eq!(next_available_path(&dir, "memo", "").unwrap(), dir.join("memo"));
        assert!(next_available_path(&dir, "CON", "txt").is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_windows_invalid_names() {
        for name in ["", ".", "..", "a?.txt", "a/b.txt", "memo.", "memo ", "CON", "con.txt", "LPT9.log"] {
            assert!(validate_windows_file_name(name).is_err(), "{name}");
        }
    }
}

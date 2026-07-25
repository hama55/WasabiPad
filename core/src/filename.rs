use std::io;
use std::path::{Path, PathBuf};

// 新規メモの採番規則。1件目は "stem.ext"、以降は "stem2.ext"、"stem3.ext"…
// (命名規則はコア側の関心。IPC層はパスを受け取るだけ)
pub fn next_available_path(dir: &Path, stem: &str, extension: &str) -> io::Result<PathBuf> {
    let stem = stem.trim();
    let ext = extension.trim_start_matches('.');
    let with_ext = |base: &str| if ext.is_empty() { base.to_string() } else { format!("{base}.{ext}") };
    validate_windows_file_name(&with_ext(stem))?;
    for number in 1.. {
        let base = if number == 1 { stem.to_string() } else { format!("{stem}{number}") };
        let candidate = dir.join(with_ext(&base));
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
    fn numbers_only_when_the_plain_name_is_taken() {
        let dir = std::env::temp_dir().join(format!("wasabipad_next_path_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(next_available_path(&dir, "memo", "txt").unwrap(), dir.join("memo.txt"));
        std::fs::write(dir.join("memo.txt"), "").unwrap();
        assert_eq!(next_available_path(&dir, "memo", ".txt").unwrap(), dir.join("memo2.txt"));
        assert_eq!(next_available_path(&dir, "memo", "").unwrap(), dir.join("memo"));
        assert!(next_available_path(&dir, "CON", "txt").is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_windows_invalid_names() {
        for name in ["", ".", "..", "a?.txt", "a/b.txt", "memo.", "memo ", "CON", "con.txt", "LPT9.log"] {
            assert!(validate_windows_file_name(name).is_err(), "{name}");
        }
    }
}

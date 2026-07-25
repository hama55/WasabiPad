use std::io;

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
    use super::validate_windows_file_name;

    #[test]
    fn accepts_regular_names() {
        assert!(validate_windows_file_name("メモ 1.md").is_ok());
        assert!(validate_windows_file_name("report.final.csv").is_ok());
        assert!(validate_windows_file_name("COM10.txt").is_ok());
    }

    #[test]
    fn rejects_windows_invalid_names() {
        for name in ["", ".", "..", "a?.txt", "a/b.txt", "memo.", "memo ", "CON", "con.txt", "LPT9.log"] {
            assert!(validate_windows_file_name(name).is_err(), "{name}");
        }
    }
}

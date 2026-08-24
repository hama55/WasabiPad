// This file was generated from shared/protocol.json by scripts/sync-protocol.mjs.
pub(crate) const ARCHIVE_ENTRY_SEPARATOR: &str = "::";
pub(crate) const PASSWORD_ERROR_MARKER: &str = "7z-password";

pub(crate) fn is_image_extension(extension: &str) -> bool {
    matches!(extension.to_ascii_lowercase().as_str(), "apng" | "avif" | "bmp" | "gif" | "ico" | "jpeg" | "jpg" | "png" | "svg" | "webp")
}

pub(crate) fn image_extension_for_mime(mime_type: &str) -> Option<&'static str> {
    match mime_type.split(';').next().unwrap_or_default().trim().to_ascii_lowercase().as_str() {
    "image/apng" => Some("apng"),
    "image/avif" => Some("avif"),
    "image/bmp" => Some("bmp"),
    "image/gif" => Some("gif"),
    "image/x-icon" => Some("ico"),
    "image/vnd.microsoft.icon" => Some("ico"),
    "image/jpeg" => Some("jpg"),
    "image/png" => Some("png"),
    "image/svg+xml" => Some("svg"),
    "image/webp" => Some("webp"),
        _ => None,
    }
}

pub(crate) fn encoding_label(key: &str) -> &'static str {
    match key {
        "utf8" => "UTF-8",
        "utf8bom" => "UTF-8 (BOM)",
        "sjis" => "Shift-JIS",
        "utf16le" => "UTF-16LE",
        _ => "",
    }
}

pub(crate) fn eol_label(key: &str) -> &'static str {
    match key {
        "crlf" => "CRLF",
        "lf" => "LF",
        _ => "",
    }
}

pub(crate) const BYTE_SIZE_BASE: u64 = 1024;
pub(crate) const BYTE_SIZE_UNITS: [&str; 5] = ["B","kB","MB","GB","TB"];

pub(crate) fn format_byte_size(bytes: u64) -> String {
    if bytes < BYTE_SIZE_BASE {
        return format!("{bytes} {}", BYTE_SIZE_UNITS[0]);
    }
    let mut unit_index = 1usize;
    let mut value = bytes as f64 / BYTE_SIZE_BASE as f64;
    while value >= BYTE_SIZE_BASE as f64 && unit_index < 4 {
        value /= BYTE_SIZE_BASE as f64;
        unit_index += 1;
    }
    format!("{value:.1} {}", BYTE_SIZE_UNITS[unit_index])
}

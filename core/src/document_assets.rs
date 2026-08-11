use crate::buffer::TextBuffer;
use std::collections::HashSet;
use std::io;
use std::path::Path;

// 貼り付け画像とアーカイブ内画像のパス規則、および不要画像の掃除だけを担当する。
pub(crate) fn archive_entry_parent(entry: &str) -> &str {
    entry
        .rsplit_once('/')
        .map(|(parent, _)| parent)
        .unwrap_or("")
}

pub(crate) fn archive_entry_stem(entry: &str) -> Option<&str> {
    let name = entry.rsplit('/').next()?;
    let stem = name.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(name);
    (!stem.is_empty()).then_some(stem)
}

pub(crate) fn archive_join(parent: &str, child: &str) -> String {
    if parent.is_empty() {
        child.to_string()
    } else {
        format!("{parent}/{child}")
    }
}

pub(crate) fn valid_archive_entry_path(entry: &str) -> bool {
    !entry.is_empty()
        && !entry.starts_with('/')
        && !entry.starts_with('\\')
        && !entry.split(['/', '\\']).any(|part| part == "..")
}

pub(crate) fn next_archive_image_name(
    entries: &[String],
    directory: &str,
    extension: &str,
) -> io::Result<String> {
    let prefix = format!("{}/", directory.replace('\\', "/").to_lowercase());
    for index in 1..=10_000usize {
        let stem = if index == 1 {
            "pasted-image".to_string()
        } else {
            format!("pasted-image-{index}")
        };
        let name = format!("{stem}.{extension}");
        let full = format!("{prefix}{}", name.to_lowercase());
        if !entries
            .iter()
            .any(|entry| entry.replace('\\', "/").to_lowercase() == full)
        {
            return Ok(name);
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "画像ファイル名を決められません",
    ))
}

pub(crate) fn referenced_image_files(buf: &TextBuffer) -> HashSet<String> {
    let mut referenced = HashSet::new();
    for line in 0..buf.line_count() {
        let text = buf.line(line);
        let lower = text.to_ascii_lowercase();
        let mut from = 0;
        while let Some(relative) = lower[from..].find("<img") {
            let start = from + relative;
            let Some(end_relative) = lower[start..].find('>') else {
                break;
            };
            let end = start + end_relative;
            if let Some(src) = image_src_in_tag(&text[start..=end]) {
                add_referenced_image(&mut referenced, &src);
            }
            from = end + 1;
        }

        let mut from = 0;
        while let Some(relative) = text[from..].find("![") {
            let label_start = from + relative + 2;
            let Some(source_start_relative) = text[label_start..].find("](") else {
                from = label_start;
                continue;
            };
            let source_start = label_start + source_start_relative + 2;
            let Some(source_end_relative) = text[source_start..].find(')') else {
                from = source_start;
                continue;
            };
            let source_end = source_start + source_end_relative;
            if let Some(src) = markdown_image_src(&text[source_start..source_end]) {
                add_referenced_image(&mut referenced, src);
            }
            from = source_end + 1;
        }
    }
    referenced
}

fn add_referenced_image(referenced: &mut HashSet<String>, src: &str) {
    if let Some(name) = image_name_from_src(src) {
        referenced.insert(name);
    }
}

fn markdown_image_src(reference: &str) -> Option<&str> {
    let reference = reference.trim();
    if let Some(reference) = reference.strip_prefix('<') {
        return reference.split_once('>').map(|(src, _)| src);
    }
    reference.split_ascii_whitespace().next()
}

fn image_src_in_tag(tag: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let mut from = 0;
    while let Some(relative) = lower[from..].find("src") {
        let start = from + relative;
        let before_ok = start == 0 || !lower.as_bytes()[start - 1].is_ascii_alphanumeric();
        let after = start + 3;
        let after_ok = after == lower.len()
            || lower.as_bytes()[after].is_ascii_whitespace()
            || lower.as_bytes()[after] == b'=';
        if before_ok && after_ok {
            let mut equal = after;
            while equal < lower.len() && lower.as_bytes()[equal].is_ascii_whitespace() {
                equal += 1;
            }
            if equal < lower.len() && lower.as_bytes()[equal] == b'=' {
                let mut value = equal + 1;
                while value < tag.len() && tag.as_bytes()[value].is_ascii_whitespace() {
                    value += 1;
                }
                if value < tag.len() && matches!(tag.as_bytes()[value], b'"' | b'\'') {
                    let quote = tag.as_bytes()[value];
                    let begin = value + 1;
                    let end = tag.as_bytes()[begin..]
                        .iter()
                        .position(|byte| *byte == quote)?;
                    return Some(tag[begin..begin + end].to_string());
                }
                let value_end = tag[value..]
                    .find(char::is_whitespace)
                    .map(|end| value + end)
                    .unwrap_or(tag.len());
                return Some(tag[value..value_end].trim_end_matches('/').to_string());
            }
        }
        from = after;
    }
    None
}

fn image_name_from_src(src: &str) -> Option<String> {
    let parts: Vec<String> = src
        .replace('\\', "/")
        .split('/')
        .map(|part| part.to_lowercase())
        .collect();
    match parts.as_slice() {
        [root, name] if root == "image" && valid_image_path_part(name) => {
            Some(format!("image/{name}"))
        }
        [root, memo, name]
            if root == "image_markdown"
                && valid_image_path_part(memo)
                && valid_image_path_part(name) =>
        {
            Some(format!("image_markdown/{memo}/{name}"))
        }
        _ => None,
    }
}

fn valid_image_path_part(value: &str) -> bool {
    !value.is_empty() && value != "." && value != ".."
}

pub(crate) fn cleanup_image_dir(dir: &Path, prefix: &str, referenced: &HashSet<String>) -> io::Result<()> {
    if !dir.is_dir() {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_lowercase();
        if !referenced.contains(&format!("{prefix}/{name}")) {
            std::fs::remove_file(entry.path())?;
        }
    }
    remove_empty_dir(dir)
}

pub(crate) fn remove_empty_dir(dir: &Path) -> io::Result<()> {
    if !dir.is_dir() {
        return Ok(());
    }
    if std::fs::read_dir(dir)?.next().is_none() {
        let _ = std::fs::remove_dir(dir);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn archive_path_rules_keep_names_in_their_document_scope() {
        // Feature: 文書内アセットのパス規則
        // Scenario: アーカイブ階層を分解・結合し、危険な相対パスを拒否する
        // Given: 親ディレクトリとファイル名
        // When: パスを分解・結合して検証する
        assert_eq!(archive_entry_parent("notes/memo.md"), "notes");
        assert_eq!(archive_entry_stem("notes/memo.md"), Some("memo"));
        assert_eq!(archive_join("notes", "image.png"), "notes/image.png");
        // Then: 文書内の相対パスだけが有効になる
        assert!(valid_archive_entry_path("notes/image.png"));
        assert!(!valid_archive_entry_path("../image.png"));
        assert!(!valid_archive_entry_path("/image.png"));
    }

    #[test]
    fn referenced_images_and_next_name_follow_image_path_contract() {
        // Feature: 貼り付け画像の参照管理
        // Scenario: HTML/Markdown の参照を抽出し、既存名と衝突しない名前を選ぶ
        // Given: image と image_markdown の参照を含む文書
        let buf = TextBuffer::from_text(
            r#"<img src="image/keep.PNG"><img src='image_markdown/memo/pasted-image-2.jpg'>![keep](image_markdown/memo/pasted-image-3.PNG)![angle](<image/kept.jpg>)"#,
        );
        // When: 参照画像と次の貼り付け名を求める
        let referenced = referenced_image_files(&buf);
        let next = next_archive_image_name(
            &[
                "image/pasted-image.png".to_string(),
                "image/pasted-image-2.png".to_string(),
            ],
            "image",
            "png",
        )
        .unwrap();
        // Then: 大文字小文字を吸収し、未使用名を返す
        assert!(referenced.contains("image/keep.png"));
        assert!(referenced.contains("image_markdown/memo/pasted-image-2.jpg"));
        assert!(referenced.contains("image_markdown/memo/pasted-image-3.png"));
        assert!(referenced.contains("image/kept.jpg"));
        assert_eq!(next, "pasted-image-3.png");
    }
}

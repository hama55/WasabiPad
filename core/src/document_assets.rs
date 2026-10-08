use crate::buffer::TextBuffer;
use std::collections::HashSet;
use std::io;
use std::path::{Path, PathBuf};

const MARKDOWN_IMAGE_DIRECTORY: &str = "image_markdown";
pub(crate) const PASTED_IMAGE_STEM: &str = "pasted-image";

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

pub(crate) fn markdown_asset_dir(path: &Path) -> Option<PathBuf> {
    let stem = path.file_stem()?.to_str()?;
    if stem.is_empty() {
        return None;
    }
    Some(path.parent()?.join(MARKDOWN_IMAGE_DIRECTORY).join(stem))
}

pub(crate) fn markdown_image_relative_dir(memo: &str) -> String {
    format!("{MARKDOWN_IMAGE_DIRECTORY}/{memo}")
}

pub(crate) fn markdown_image_relative_path(memo: &str, name: &str) -> String {
    format!("{}/{name}", markdown_image_relative_dir(memo))
}

pub(crate) fn next_archive_image_name(
    entries: &[String],
    directory: &str,
    extension: &str,
) -> io::Result<String> {
    let prefix = format!("{}/", directory.replace('\\', "/"));
    for index in 1..=10_000usize {
        let stem = if index == 1 {
            PASTED_IMAGE_STEM.to_string()
        } else {
            format!("{PASTED_IMAGE_STEM}-{index}")
        };
        let name = format!("{stem}.{extension}");
        let full = format!("{prefix}{name}");
        if !entries
            .iter()
            .any(|entry| entry.replace('\\', "/") == full)
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
    image_sources(buf).into_iter().filter_map(|src| image_name_from_src(&src)).collect()
}

pub(crate) fn image_sources(buf: &TextBuffer) -> HashSet<String> {
    let mut referenced = HashSet::new();
    let mut pending = String::new();
    for line in 0..buf.line_count() {
        let value = buf.line(line);
        let text = if pending.is_empty() { value.into_owned() } else { pending.push('\n'); pending.push_str(&value); std::mem::take(&mut pending) };
        let lower = text.to_ascii_lowercase();
        let mut from = 0;
        while let Some(relative) = lower[from..].find("<img") {
            let start = from + relative;
            if lower.as_bytes().get(start + 4).is_some_and(|byte| !byte.is_ascii_whitespace() && *byte != b'>' && *byte != b'/') {
                from = start + 4;
                continue;
            }
            let Some(end_relative) = image_tag_end(&text[start..]) else {
                pending = text[start..].to_string();
                break;
            };
            let end = start + end_relative;
            if let Some(src) = image_src_in_tag(&text[start..=end]) {
                referenced.insert(decode_image_src(&decode_image_entities(&src)));
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
                referenced.insert(decode_image_src(src));
            }
            from = source_end + 1;
        }
    }
    referenced
}

pub(crate) fn image_references_in_lines(buf: &TextBuffer, first: usize, last: usize) -> HashSet<String> {
    let mut references = HashSet::new();
    let mut first = first.min(buf.line_count().saturating_sub(1));
    let mut last = last.min(buf.line_count().saturating_sub(1));
    // The buffer index avoids scanning ordinary documents on each keystroke.
    if let Some(opening) = buf.preceding_image_tag_line(first) {
        let mut prefix = buf.line(opening).into_owned();
        let start = prefix.to_ascii_lowercase().rfind("<img").unwrap();
        let mut end_line = opening;
        while end_line < first && image_tag_end(&prefix[start..]).is_none() {
            end_line += 1; prefix.push('\n'); prefix.push_str(&buf.line(end_line));
        }
        if end_line == first { first = opening; }
    }
    let mut block = (first..=last).map(|line| buf.line(line)).collect::<Vec<_>>().join("\n");
    if let Some(start) = block.to_ascii_lowercase().rfind("<img") {
        while image_tag_end(&block[start..]).is_none() && last + 1 < buf.line_count() {
            last += 1; block.push('\n'); block.push_str(&buf.line(last));
        }
    }
    references.extend(referenced_image_files(&TextBuffer::from_text(&block)));
    for line in first..=last {
        let text = buf.line(line);
        if !text.contains("image") && !text.contains("diagram-") { continue; }
        references.extend(referenced_image_files(&TextBuffer::from_text(&text)));
        // A source attribute may occupy its own line in a multiline img tag.
        if let Some(src) = image_src_in_tag(&format!("<img {text}>")) { add_referenced_image(&mut references, &decode_image_src(&decode_image_entities(&src))); }
    }
    references.retain(|reference| generated_diagram_name(reference.rsplit('/').next().unwrap_or_default()));
    references
}

fn image_tag_end(text: &str) -> Option<usize> {
    let mut quote = None;
    for (index, byte) in text.bytes().enumerate() {
        if let Some(delimiter) = quote { if byte == delimiter { quote = None; } }
        else if byte == b'\'' || byte == b'"' { quote = Some(byte); }
        else if byte == b'>' { return Some(index); }
    }
    None
}

fn decode_image_entities(text: &str) -> String {
    text.replace("&quot;", "\"").replace("&apos;", "'").replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
}

fn decode_image_src(text: &str) -> String {
    let mut bytes = Vec::with_capacity(text.len());
    let mut input = text.as_bytes().iter().copied();
    while let Some(byte) = input.next() {
        if byte == b'%' {
            let Some(high) = input.next().and_then(|b| (b as char).to_digit(16)) else { return text.to_string(); };
            let Some(low) = input.next().and_then(|b| (b as char).to_digit(16)) else { return text.to_string(); };
            bytes.push((high * 16 + low) as u8);
        } else { bytes.push(byte); }
    }
    String::from_utf8(bytes).unwrap_or_else(|_| text.to_string())
}

pub(crate) fn diagram_backgrounds(svg: &str) -> io::Result<Option<Vec<String>>> {
    let marker = "<metadata id=\"wasabipad-diagram\">";
    let Some(start) = svg.find(marker) else { return Ok(None); };
    let content = &svg[start + marker.len()..];
    let end = content.find("</metadata>").ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "図の編集情報が不正です"))?;
    let model: serde_json::Value = serde_json::from_str(&decode_image_entities(&content[..end]))
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    let elements = model["elements"].as_array().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "図の編集情報が不正です"))?;
    let mut result = Vec::new();
    for element in elements {
        if element["kind"].as_str() != Some("image") { continue; }
        let src = element["src"].as_str().filter(|src| valid_image_path_part(src) && !src.contains(['/', '\\', ':', '%', '?', '#']) && !src.chars().any(char::is_control))
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "図の背景参照が不正です"))?;
        result.push(src.to_string());
    }
    Ok(Some(result))
}

pub(crate) fn generated_diagram_name(name: &str) -> bool {
    name.starts_with("diagram-") && name.ends_with(".svg")
        && name[8..name.len() - 4].chars().all(|c| c.is_ascii_digit() || c == '-')
}

pub(crate) fn expand_diagram_references(
    references: &mut HashSet<String>,
    current_prefix: &str,
    read: impl Fn(&str) -> io::Result<Vec<u8>>,
) -> io::Result<()> {
    let roots: Vec<_> = references.iter().cloned().collect();
    for reference in roots {
        if !reference.to_ascii_lowercase().ends_with(".svg") { continue; }
        let name = reference.rsplit('/').next().unwrap_or_default();
        let mut actual = reference.clone();
        let bytes = match read(&reference) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound && generated_diagram_name(name) => {
                actual = format!("{current_prefix}/{name}");
                match read(&actual) {
                    Ok(bytes) => bytes,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(error),
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        let svg = std::str::from_utf8(&bytes).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        if let Some(backgrounds) = diagram_backgrounds(svg)? {
            references.insert(actual.clone());
            let prefix = actual.rsplit_once('/').map(|(p, _)| p).unwrap_or_default();
            for src in backgrounds { references.insert(format!("{prefix}/{src}")); }
        }
    }
    Ok(())
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
        let before_ok = start == 0 || lower.as_bytes()[start - 1].is_ascii_whitespace();
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
                    .find(|character: char| character.is_whitespace() || character == '>')
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
    let normalized = src.replace('\\', "/");
    let parts: Vec<&str> = normalized.split('/').collect();
    match parts.as_slice() {
        [root, name] if root.eq_ignore_ascii_case("image") && valid_image_path_part(name) => {
            Some(format!("image/{name}"))
        }
        [root, memo, name]
            if root.eq_ignore_ascii_case(MARKDOWN_IMAGE_DIRECTORY)
                && valid_image_path_part(memo)
                && valid_image_path_part(name) =>
        {
            Some(markdown_image_relative_path(memo, name))
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
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();
        let key = format!("{prefix}/{name}").to_lowercase();
        if !referenced.iter().any(|reference| reference.to_lowercase() == key) {
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
        // Then: アーカイブ内部名の大小文字を保持し、未使用名を返す
        assert!(referenced.contains("image/keep.PNG"));
        assert!(referenced.contains("image_markdown/memo/pasted-image-2.jpg"));
        assert!(referenced.contains("image_markdown/memo/pasted-image-3.PNG"));
        assert!(referenced.contains("image/kept.jpg"));
        assert_eq!(next, "pasted-image-3.png");
    }

    // Feature: アーカイブ内部画像名の同一性
    // Scenario: 大文字小文字だけ異なる画像名を別項目として扱う
    // Given: `Pasted-Image.png`だけが存在するアーカイブ内画像フォルダ
    // When: 次の貼り付け画像名を求める
    // Then: 小文字の`pasted-image.png`を別名として利用できる
    #[test]
    fn archive_image_name_collision_preserves_entry_case() {
        let next = next_archive_image_name(
            &["image/Pasted-Image.png".to_string()],
            "image",
            "png",
        )
        .unwrap();

        assert_eq!(next, "pasted-image.png");
    }
    // Feature: 図履歴の参照取得
    // Scenario: 大きな通常文書の > 入力で画像タグを探索しない
    // Given: 100000 行の画像なし文書
    // When: 最終行の参照を調べる
    // Then: タグ位置は存在せず、対象行の参照も空
    #[test]
    fn ordinary_large_document_has_no_image_tag_scan() {
        let buf = TextBuffer::from_text(&format!("{}>", "ordinary\n".repeat(100_000)));
        assert_eq!(buf.preceding_image_tag_line(100_000), None);
        assert!(image_references_in_lines(&buf, 99_999, 100_000).is_empty());
    }

    // Feature: HTML 図参照
    // Given: 引用符なしおよび自己終了形式の src
    // When: 本文と履歴の参照を抽出する
    // Then: > や / をファイル名に含めない
    #[test]
    fn unquoted_diagram_source_preserves_asset_reference() {
        for tag in ["<img src=image_markdown/memo/diagram-123.svg>", "<img src=image_markdown/memo/diagram-123.svg/>"] {
            let buf = TextBuffer::from_text(tag);
            assert!(referenced_image_files(&buf).contains("image_markdown/memo/diagram-123.svg"));
            assert!(image_references_in_lines(&buf, 0, 0).contains("image_markdown/memo/diagram-123.svg"));
        }
    }
}

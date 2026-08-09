// フォルダ直下の列挙と並び順。文書の状態には触らない (パスと名前だけの世界)。
use serde::Serialize;
use std::cmp::Ordering;
use std::path::{Path, PathBuf};

// フォルダ相対パスとアーカイブ内エントリを結ぶUI共有表現。
pub const ARCHIVE_ENTRY_SEPARATOR: &str = crate::protocol::ARCHIVE_ENTRY_SEPARATOR;

// ツリー1回の展開で返す上限。巨大ディレクトリでも列挙時間を一定に抑える。
const MAX_ENTRIES: usize = 2000;

#[derive(Serialize, ts_rs::TS)]
#[ts(export)]
pub struct FolderEntry {
    pub name: String,
    pub is_dir: bool,
    pub is_archive: bool,
}

pub fn is_lazy_archive_path(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|extension| extension.to_str()).map(str::to_ascii_lowercase).as_deref(),
        Some("zip") | Some("xlsx") | Some("xls") | Some("7z")
    )
}

pub fn join_relative(root: &Path, relative: &str) -> PathBuf {
    root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR))
}

// 指定ディレクトリ (rel_dir が空文字ならルート) の直下だけを列挙する。
// サブフォルダの中身は再帰しない (ツリーの展開ボタンで都度呼ばれる想定)。
pub fn list_children(root: &Path, rel_dir: &str) -> std::io::Result<Vec<FolderEntry>> {
    let dir = if rel_dir.is_empty() { root.to_path_buf() } else { join_relative(root, rel_dir) };
    let mut items = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let is_dir = entry.file_type()?.is_dir();
        items.push(FolderEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            is_archive: !is_dir && is_lazy_archive_path(&entry.path()),
            is_dir,
        });
    }
    items.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| natural_name_cmp(&a.name, &b.name))
            .then_with(|| a.name.cmp(&b.name))
    });
    items.truncate(MAX_ENTRIES);
    Ok(items)
}

// 数字の並びを桁数ではなく数値として比較する (memo2 < memo10)。
pub fn natural_name_cmp(a: &str, b: &str) -> Ordering {
    let a = a.to_lowercase();
    let b = b.to_lowercase();
    let mut ai = a.chars().peekable();
    let mut bi = b.chars().peekable();
    loop {
        match (ai.peek(), bi.peek()) {
            (Some(ac), Some(bc)) if ac.is_ascii_digit() && bc.is_ascii_digit() => {
                let mut an = String::new();
                let mut bn = String::new();
                while ai.peek().is_some_and(|c| c.is_ascii_digit()) {
                    an.push(ai.next().unwrap());
                }
                while bi.peek().is_some_and(|c| c.is_ascii_digit()) {
                    bn.push(bi.next().unwrap());
                }
                let av = an.trim_start_matches('0');
                let bv = bn.trim_start_matches('0');
                let av = if av.is_empty() { "0" } else { av };
                let bv = if bv.is_empty() { "0" } else { bv };
                let ord = av.len().cmp(&bv.len()).then_with(|| av.cmp(bv)).then_with(|| an.len().cmp(&bn.len()));
                if ord != Ordering::Equal {
                    return ord;
                }
            }
            (Some(_), Some(_)) => {
                let ord = ai.next().cmp(&bi.next());
                if ord != Ordering::Equal {
                    return ord;
                }
            }
            _ => return ai.next().cmp(&bi.next()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{list_children, natural_name_cmp};
    use std::cmp::Ordering;

    #[test]
    fn numbers_compare_by_value_not_by_digit_count() {
        assert_eq!(natural_name_cmp("memo2.txt", "memo10.txt"), Ordering::Less);
        assert_eq!(natural_name_cmp("memo10.txt", "memo2.txt"), Ordering::Greater);
        assert_eq!(natural_name_cmp("Memo2", "memo2"), Ordering::Equal, "大小文字は無視する");
        assert_eq!(natural_name_cmp("memo02", "memo2"), Ordering::Greater, "ゼロ埋めは後ろ");
    }

    #[test]
    fn directories_come_before_files_and_names_are_sorted() {
        let root = std::env::temp_dir().join(format!("wasabipad_folder_{}", std::process::id()));
        std::fs::create_dir_all(root.join("sub10")).unwrap();
        std::fs::create_dir_all(root.join("sub2")).unwrap();
        std::fs::write(root.join("a10.txt"), "").unwrap();
        std::fs::write(root.join("a2.txt"), "").unwrap();

        let names: Vec<String> = list_children(&root, "").unwrap().into_iter().map(|e| e.name).collect();
        assert_eq!(names, vec!["sub2", "sub10", "a2.txt", "a10.txt"]);
        assert!(list_children(&root, "missing").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}

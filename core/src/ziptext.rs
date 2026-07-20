// ZIP (xlsx/docx 等) やフォルダをエントリ一覧として展開する。
// 各エントリは左のフォルダビューに並び、選択されたものだけをエディタに表示する。
use encoding_rs::SHIFT_JIS;

const MAX_ENTRY: usize = 32 * 1024 * 1024; // 1エントリの展開上限
const MAX_TOTAL: usize = 256 * 1024 * 1024; // 合計上限

pub struct Entry {
    pub name: String, // 相対パス ("sub/a.txt") またはシート名
    pub text: String,
}

fn u16le(b: &[u8], p: usize) -> Option<u16> {
    Some(u16::from_le_bytes([*b.get(p)?, *b.get(p + 1)?]))
}

fn u32le(b: &[u8], p: usize) -> Option<u32> {
    Some(u32::from_le_bytes([
        *b.get(p)?,
        *b.get(p + 1)?,
        *b.get(p + 2)?,
        *b.get(p + 3)?,
    ]))
}

// End of Central Directory を末尾から探す (コメント最大 64KB)
fn find_eocd(b: &[u8]) -> Option<usize> {
    let lo = b.len().saturating_sub(66_000);
    (lo..b.len().checked_sub(22)? + 1)
        .rev()
        .find(|&i| u32le(b, i) == Some(0x0605_4B50))
}

// エントリ本文の復号: BOM → UTF-8厳密 → Shift-JIS。バイナリらしければ None
fn decode_entry(v: Vec<u8>) -> Option<String> {
    if v.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return Some(String::from_utf8_lossy(&v[3..]).into_owned());
    }
    if v.starts_with(&[0xFF, 0xFE]) {
        let (cow, _, _) = encoding_rs::UTF_16LE.decode(&v[2..]);
        return Some(cow.into_owned());
    }
    match String::from_utf8(v) {
        Ok(s) => {
            if s.contains('\0') {
                None
            } else {
                Some(s)
            }
        }
        Err(e) => {
            let v = e.into_bytes();
            if v.contains(&0) {
                return None;
            }
            let (cow, _, had_errors) = SHIFT_JIS.decode(&v);
            if had_errors {
                None
            } else {
                Some(cow.into_owned())
            }
        }
    }
}

fn decode_name(raw: &[u8], utf8_flag: bool) -> String {
    if utf8_flag {
        return String::from_utf8_lossy(raw).into_owned();
    }
    match std::str::from_utf8(raw) {
        Ok(s) => s.to_string(),
        Err(_) => SHIFT_JIS.decode(raw).0.into_owned(), // 日本語 ZIP 慣習
    }
}

// フォルダを再帰列挙し (相対パス, 絶対パス) の一覧を返す。中身は読まない —
// フォルダの子は ZIP/xls のような合成テキストではなく実ファイルなので、
// 選択時に個別に mmap オープンして編集・保存できるようにする (doc.rs 側の責務)。
pub fn list_dir(root: &std::path::Path) -> Option<Vec<(String, std::path::PathBuf)>> {
    const MAX_FILES: usize = 2000;
    fn collect(root: &std::path::Path, dir: &std::path::Path, out: &mut Vec<(String, std::path::PathBuf)>) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                collect(root, &p, out);
            } else {
                let rel = p
                    .strip_prefix(root)
                    .unwrap_or(&p)
                    .to_string_lossy()
                    .replace('\\', "/");
                out.push((rel, p));
            }
        }
    }
    if !root.is_dir() {
        return None;
    }
    let mut files = Vec::new();
    collect(root, root, &mut files);
    files.sort();
    files.truncate(MAX_FILES);
    if files.is_empty() {
        return None;
    }
    Some(files)
}

// 中央ディレクトリの1エントリのメタ情報 (本文はまだ読まない)
struct CdEntry {
    name: String,
    method: u16,
    flags: u16,
    comp: usize,
    uncomp: usize,
    loff: usize,
}

// 中央ディレクトリを走査してメタ情報だけを集める (本文の展開はしない = 安価)
fn central_dir(bytes: &[u8]) -> Option<Vec<CdEntry>> {
    if !bytes.starts_with(b"PK\x03\x04") {
        return None;
    }
    let eocd = find_eocd(bytes)?;
    let count = u16le(bytes, eocd + 10)? as usize;
    let mut pos = u32le(bytes, eocd + 16)? as usize;
    let mut out = Vec::new();
    for _ in 0..count {
        if u32le(bytes, pos)? != 0x0201_4B50 {
            break;
        }
        let flags = u16le(bytes, pos + 8)?;
        let method = u16le(bytes, pos + 10)?;
        let comp = u32le(bytes, pos + 20)? as usize;
        let uncomp = u32le(bytes, pos + 24)? as usize;
        let nlen = u16le(bytes, pos + 28)? as usize;
        let xlen = u16le(bytes, pos + 30)? as usize;
        let clen = u16le(bytes, pos + 32)? as usize;
        let loff = u32le(bytes, pos + 42)? as usize;
        let name = decode_name(bytes.get(pos + 46..pos + 46 + nlen)?, flags & 0x0800 != 0);
        pos += 46 + nlen + xlen + clen;
        if name.ends_with('/') {
            continue; // ディレクトリ
        }
        out.push(CdEntry { name, method, flags, comp, uncomp, loff });
    }
    if out.is_empty() {
        return None;
    }
    Some(out)
}

// 1エントリぶんの本文を展開してテキスト化する
fn decode_cd_entry(bytes: &[u8], e: &CdEntry) -> Option<String> {
    let nl = u16le(bytes, e.loff + 26)? as usize;
    let xl = u16le(bytes, e.loff + 28)? as usize;
    let data_at = e.loff + 30 + nl + xl;
    let data = bytes.get(data_at..data_at + e.comp)?;

    Some(if e.flags & 1 != 0 {
        "(暗号化エントリ)".to_string()
    } else if e.uncomp > MAX_ENTRY {
        format!("(サイズ超過のためスキップ: {} bytes)", e.uncomp)
    } else {
        let raw = match e.method {
            0 => Some(data.to_vec()),
            8 => miniz_oxide::inflate::decompress_to_vec_with_limit(data, e.uncomp.max(1)).ok(),
            _ => None,
        };
        match raw {
            None => format!("(未対応の圧縮方式: method {})", e.method),
            Some(v) => {
                let n = v.len();
                match decode_entry(v) {
                    Some(s) => s.replace("\r\n", "\n").replace('\r', "\n"),
                    None => format!("(バイナリ: {} bytes)", n),
                }
            }
        }
    })
}

// エントリ名の一覧だけを返す (展開しない = 安価。ツリーの遅延展開用)
pub fn list_names(bytes: &[u8]) -> Option<Vec<String>> {
    let mut names: Vec<String> = central_dir(bytes)?.into_iter().map(|e| e.name).collect();
    names.sort();
    Some(names)
}

// 指定した1エントリだけを展開してテキスト化する (選択時の遅延展開用)
pub fn decode_one(bytes: &[u8], target: &str) -> Option<String> {
    let e = central_dir(bytes)?.into_iter().find(|e| e.name == target)?;
    decode_cd_entry(bytes, &e)
}

pub fn parse(bytes: &[u8]) -> Option<Vec<Entry>> {
    let cd = central_dir(bytes)?;
    let mut entries = Vec::new();
    let mut total_out = 0usize;
    for e in &cd {
        if total_out > MAX_TOTAL {
            entries.push(Entry {
                name: e.name.clone(),
                text: format!("(サイズ超過のためスキップ: {} bytes)", e.uncomp),
            });
            continue;
        }
        let text = decode_cd_entry(bytes, e)?;
        total_out += text.len();
        entries.push(Entry { name: e.name.clone(), text });
    }
    // フォルダビューで階層がまとまるようパス順に並べる
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Some(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    // 最小 ZIP (stored, "a.txt" = "hello\nworld", "b/c.txt" = "x")
    fn build_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut cd = Vec::new();
        for (name, data) in entries {
            let loff = out.len() as u32;
            let crc = 0u32; // 検証しないので 0 で可
            // local header
            out.extend_from_slice(&0x0403_4B50u32.to_le_bytes());
            out.extend_from_slice(&[20, 0, 0, 0x08, 0, 0, 0, 0, 0, 0]); // ver,flags(utf8),method0,time,date
            out.extend_from_slice(&crc.to_le_bytes());
            out.extend_from_slice(&(data.len() as u32).to_le_bytes());
            out.extend_from_slice(&(data.len() as u32).to_le_bytes());
            out.extend_from_slice(&(name.len() as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(name.as_bytes());
            out.extend_from_slice(data);
            // central dir entry
            cd.extend_from_slice(&0x0201_4B50u32.to_le_bytes());
            cd.extend_from_slice(&[20, 0, 20, 0, 0, 0x08, 0, 0, 0, 0, 0, 0]);
            cd.extend_from_slice(&crc.to_le_bytes());
            cd.extend_from_slice(&(data.len() as u32).to_le_bytes());
            cd.extend_from_slice(&(data.len() as u32).to_le_bytes());
            cd.extend_from_slice(&(name.len() as u16).to_le_bytes());
            cd.extend_from_slice(&[0u8; 12]); // xlen,clen,disk,int_attr,ext_attr
            cd.extend_from_slice(&loff.to_le_bytes());
            cd.extend_from_slice(name.as_bytes());
        }
        let cd_off = out.len() as u32;
        let cd_len = cd.len() as u32;
        out.extend_from_slice(&cd);
        out.extend_from_slice(&0x0605_4B50u32.to_le_bytes());
        out.extend_from_slice(&[0, 0, 0, 0]);
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&cd_len.to_le_bytes());
        out.extend_from_slice(&cd_off.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out
    }

    #[test]
    fn parse_stored_zip() {
        let z = build_zip(&[("b/c.txt", b"x"), ("a.txt", b"hello\nworld")]);
        let r = parse(&z).unwrap();
        // パス順にソートされる
        assert_eq!(r[0].name, "a.txt");
        assert_eq!(r[0].text, "hello\nworld");
        assert_eq!(r[1].name, "b/c.txt");
        assert_eq!(r[1].text, "x");
    }

    #[test]
    fn list_names_returns_sorted_names_without_decoding() {
        let z = build_zip(&[("b/c.txt", b"x"), ("a.txt", b"hello\nworld")]);
        let names = list_names(&z).unwrap();
        assert_eq!(names, vec!["a.txt".to_string(), "b/c.txt".to_string()]);
    }

    #[test]
    fn decode_one_returns_only_the_requested_entry() {
        let z = build_zip(&[("b/c.txt", b"x"), ("a.txt", b"hello\nworld")]);
        assert_eq!(decode_one(&z, "b/c.txt").unwrap(), "x");
        assert_eq!(decode_one(&z, "a.txt").unwrap(), "hello\nworld");
        assert!(decode_one(&z, "missing.txt").is_none());
    }

    #[test]
    fn sjis_entry_decodes() {
        let (sjis, _, _) = SHIFT_JIS.encode("日本語\r\nテスト");
        let z = build_zip(&[("a.txt", &sjis)]);
        let r = parse(&z).unwrap();
        assert_eq!(r[0].text, "日本語\nテスト");
    }

    #[test]
    fn binary_entry_shows_size() {
        let z = build_zip(&[("a.bin", &[0u8, 1, 2, 255])]);
        let r = parse(&z).unwrap();
        assert_eq!(r[0].text, "(バイナリ: 4 bytes)");
    }

    #[test]
    fn list_dir_returns_relative_names_and_paths() {
        let root = std::env::temp_dir().join(format!("petapad_dirtest_{}", std::process::id()));
        let sub = root.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(root.join("a.txt"), "hello").unwrap();
        std::fs::write(sub.join("b.txt"), "x").unwrap();
        let r = list_dir(&root).unwrap();
        std::fs::remove_dir_all(&root).unwrap();
        assert_eq!(r[0].0, "a.txt");
        assert!(r[0].1.ends_with("a.txt"));
        assert_eq!(r[1].0, "sub/b.txt");
        assert!(r[1].1.ends_with("b.txt"));
    }

    #[test]
    fn non_zip_returns_none() {
        assert!(parse(b"plain text").is_none());
        assert!(parse(b"PK\x03\x04broken").is_none());
    }
}

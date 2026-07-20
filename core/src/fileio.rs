// 読込/保存 + エンコーディング判定 (BOM → UTF-8厳密 → Shift-JIS)。
// プレーンテキストは常に mmap ベース (hugebuf) で開き、保存はストリーム書き。
use crate::buffer::{Store, TextBuffer};
use crate::hugebuf::HugeBuf;
use encoding_rs::SHIFT_JIS;
use std::borrow::Cow;
use std::fs::{File, OpenOptions};
use std::io::{self, BufWriter, Read, Seek, SeekFrom, Write};
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Encoding {
    Utf8 { bom: bool },
    ShiftJis,
    Utf16Le,
}

impl Encoding {
    pub fn label(&self) -> &'static str {
        match self {
            Encoding::Utf8 { bom: false } => "UTF-8",
            Encoding::Utf8 { bom: true } => "UTF-8 (BOM)",
            Encoding::ShiftJis => "Shift-JIS",
            Encoding::Utf16Le => "UTF-16LE",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Eol {
    Crlf,
    Lf,
}

impl Eol {
    pub fn label(&self) -> &'static str {
        match self {
            Eol::Crlf => "CRLF",
            Eol::Lf => "LF",
        }
    }
    pub fn as_str(&self) -> &'static str {
        match self {
            Eol::Crlf => "\r\n",
            Eol::Lf => "\n",
        }
    }
}

pub struct Opened {
    pub buf: TextBuffer,
    pub enc: Encoding,
    pub eol: Eol,
    // ZIP/.xls のエントリ一覧 (閲覧専用のフォルダビュー用)。buf は先頭エントリ
    pub entries: Option<Vec<crate::ziptext::Entry>>,
    pub byte_len: u64, // ステータスバー表示用。開いた実体のバイト数
    pub source_file: File, // 読み取りだけ共有し、他プロセスの変更を拒否
}

fn opened_from_entries(entries: Vec<crate::ziptext::Entry>, source_file: File) -> Opened {
    let byte_len = entries[0].text.len() as u64;
    Opened {
        buf: TextBuffer::from_text(&entries[0].text),
        enc: Encoding::Utf8 { bom: false },
        eol: Eol::Lf,
        entries: Some(entries),
        byte_len,
        source_file,
    }
}

pub fn open_exclusive(path: &Path) -> io::Result<File> {
    OpenOptions::new().read(true).share_mode(FILE_SHARE_READ).open(path)
}

pub fn read_locked(file: &File) -> io::Result<Vec<u8>> {
    let mut f = file.try_clone()?;
    f.seek(SeekFrom::Start(0))?;
    let mut bytes = Vec::new();
    f.read_to_end(&mut bytes)?;
    Ok(bytes)
}

pub fn is_archive_handle(file: &File) -> bool {
    let Ok(mut f) = file.try_clone() else { return false };
    if f.seek(SeekFrom::Start(0)).is_err() {
        return false;
    }
    let mut head = Vec::with_capacity(8);
    if f.take(8).read_to_end(&mut head).is_err() {
        return false;
    }
    head.starts_with(b"PK\x03\x04")
        || head.starts_with(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1])
}

// 実ファイル1つを開く。フォルダの展開は doc.rs (Doc::open) の責務。
pub fn open_buffer(path: &Path) -> io::Result<Opened> {
    let source_file = open_exclusive(path)?;
    let len = source_file.metadata()?.len();

    let is_archive = is_archive_handle(&source_file);
    if is_archive {
        // ZIP (xlsx/docx/zip) と CFB (.xls) はフォルダビューで開く
        let bytes = read_locked(&source_file)?;
        if let Some(v) = crate::ziptext::parse(&bytes).or_else(|| crate::xlstext::parse(&bytes)) {
            return Ok(opened_from_entries(v, source_file));
        }
        // シグネチャはあるが解析不能 → 通常テキストとして扱う
        let (text, enc) = decode(&bytes);
        let eol = detect_eol(&text);
        return Ok(Opened { buf: TextBuffer::from_text(&text), enc, eol, entries: None, byte_len: len, source_file });
    }

    // どんなファイルでも mmap を試す。UTF-16LE (行分割が byte 単位不可) と
    // 空ファイルは None/スキップして通常読込へフォールバック。
    if len > 0 {
        if let Some((h, enc, eol)) = HugeBuf::open(source_file.try_clone()?)? {
            return Ok(Opened {
                buf: TextBuffer::from_huge(h),
                enc,
                eol,
                entries: None,
                byte_len: len,
                source_file,
            });
        }
    }
    let bytes = read_locked(&source_file)?;
    let (text, enc) = decode(&bytes);
    let eol = detect_eol(&text);
    Ok(Opened { buf: TextBuffer::from_text(&text), enc, eol, entries: None, byte_len: len, source_file })
}

fn decode(bytes: &[u8]) -> (String, Encoding) {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return (
            String::from_utf8_lossy(&bytes[3..]).into_owned(),
            Encoding::Utf8 { bom: true },
        );
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (cow, _, _) = encoding_rs::UTF_16LE.decode(&bytes[2..]);
        return (cow.into_owned(), Encoding::Utf16Le);
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => (s.to_string(), Encoding::Utf8 { bom: false }),
        Err(_) => {
            let (cow, _, _) = SHIFT_JIS.decode(bytes);
            (cow.into_owned(), Encoding::ShiftJis)
        }
    }
}

fn detect_eol(text: &str) -> Eol {
    match text.find('\n') {
        Some(i) if i > 0 && text.as_bytes()[i - 1] == b'\r' => Eol::Crlf,
        Some(_) => Eol::Lf,
        None => Eol::Crlf, // 既定
    }
}

fn encode_str<'a>(enc: Encoding, s: &'a str) -> Cow<'a, [u8]> {
    match enc {
        Encoding::Utf8 { .. } => Cow::Borrowed(s.as_bytes()),
        Encoding::ShiftJis => match SHIFT_JIS.encode(s).0 {
            Cow::Borrowed(b) => Cow::Borrowed(b),
            Cow::Owned(v) => Cow::Owned(v),
        },
        Encoding::Utf16Le => {
            let mut v = Vec::with_capacity(s.len() * 2);
            for u in s.encode_utf16() {
                v.extend_from_slice(&u.to_le_bytes());
            }
            Cow::Owned(v)
        }
    }
}

static TEMP_SEQ: AtomicUsize = AtomicUsize::new(0);

// 排他ハンドルと mmap を呼び出し側で解放してから差し替えられるよう、常に一時ファイルだけ作る。
pub fn save_buffer(
    path: &Path,
    buf: &TextBuffer,
    enc: Encoding,
    eol: Eol,
) -> io::Result<PathBuf> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(format!(".mptmp-{}-{}", std::process::id(), TEMP_SEQ.fetch_add(1, Ordering::Relaxed)));
    let tmp = PathBuf::from(tmp);
    {
        let f = std::fs::File::create(&tmp)?;
        let mut w = BufWriter::with_capacity(1 << 20, f);
        write_stream(&mut w, buf, enc, eol)?;
        w.flush()?;
    }
    Ok(tmp)
}

fn write_stream<W: Write>(w: &mut W, buf: &TextBuffer, enc: Encoding, eol: Eol) -> io::Result<()> {
    match enc {
        Encoding::Utf8 { bom: true } => w.write_all(&[0xEF, 0xBB, 0xBF])?,
        Encoding::Utf16Le => w.write_all(&[0xFF, 0xFE])?,
        _ => {}
    }
    let sep = encode_str(enc, eol.as_str());
    match &buf.store {
        Store::Small(lines) => {
            for (i, l) in lines.iter().enumerate() {
                if i > 0 {
                    w.write_all(&sep)?;
                }
                w.write_all(&encode_str(enc, l))?;
            }
        }
        Store::Huge(h) => {
            let same = h.matches_format(enc, eol);
            let mut first = true;
            for c in 0..h.nchunks() {
                if let Some(lines) = h.overlay_lines(c) {
                    for l in lines {
                        if !first {
                            w.write_all(&sep)?;
                        }
                        w.write_all(&encode_str(enc, l))?;
                        first = false;
                    }
                } else if same {
                    // 未編集チャンク: 生バイトをそのままコピー (最速パス)
                    if !first {
                        w.write_all(&sep)?;
                    }
                    w.write_all(h.chunk_raw_trimmed(c))?;
                    first = false;
                } else {
                    for l in h.decode_chunk(c).iter() {
                        if !first {
                            w.write_all(&sep)?;
                        }
                        w.write_all(&encode_str(enc, l))?;
                        first = false;
                    }
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_exclusive_until_drop(path: &Path, opened: Opened) {
        assert!(File::open(path).is_ok(), "読み取り専用アクセスは許可するはず");
        assert!(OpenOptions::new().write(true).open(path).is_err(), "書き込みを拒否するはず");
        let renamed = path.with_extension("locked-rename");
        assert!(std::fs::rename(path, &renamed).is_err(), "名前変更を拒否するはず");
        assert!(std::fs::remove_file(path).is_err(), "削除を拒否するはず");
        drop(opened);
        assert!(File::open(path).is_ok(), "文書解放後は読み取れるはず");
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn detect_utf8_sjis() {
        let (_, e) = decode("あいう".as_bytes());
        assert_eq!(e, Encoding::Utf8 { bom: false });
        let (sjis, _, _) = SHIFT_JIS.encode("日本語テスト");
        let (s, e) = decode(&sjis);
        assert_eq!(e, Encoding::ShiftJis);
        assert_eq!(s, "日本語テスト");
    }

    #[test]
    fn eol_detection() {
        assert_eq!(detect_eol("a\r\nb"), Eol::Crlf);
        assert_eq!(detect_eol("a\nb"), Eol::Lf);
    }

    #[test]
    fn stream_save_small() {
        let buf = TextBuffer::from_text("あ\nb");
        let mut out = Vec::new();
        write_stream(&mut out, &buf, Encoding::Utf8 { bom: false }, Eol::Crlf).unwrap();
        assert_eq!(out, "あ\r\nb".as_bytes());
    }

    // mmap-always: 64MB 未満の通常ファイルでも mmap で開く
    #[test]
    fn small_file_uses_mmap() {
        let path = std::env::temp_dir().join("petapad_test_mmap_small.txt");
        std::fs::write(&path, "line1\nline2\nあいう").unwrap();
        let o = open_buffer(&path).unwrap();
        assert!(o.buf.is_huge(), "小ファイルも mmap 経路で開くはず");
        assert_eq!(o.buf.line_count(), 3);
        assert_eq!(o.buf.line(2), "あいう");
        assert_exclusive_until_drop(&path, o);
    }

    // 空ファイルは mmap 不可 → in-RAM へフォールバック
    #[test]
    fn empty_file_falls_back_to_ram() {
        let path = std::env::temp_dir().join("petapad_test_mmap_empty.txt");
        std::fs::write(&path, "").unwrap();
        let o = open_buffer(&path).unwrap();
        assert!(!o.buf.is_huge());
        assert_eq!(o.buf.line_count(), 1);
        assert_exclusive_until_drop(&path, o);
    }

    #[test]
    fn utf16_ram_file_is_exclusive() {
        let path = std::env::temp_dir().join("petapad_test_exclusive_utf16.txt");
        std::fs::write(&path, [0xFF, 0xFE, b'a', 0]).unwrap();
        let o = open_buffer(&path).unwrap();
        assert!(!o.buf.is_huge());
        assert_exclusive_until_drop(&path, o);
    }
}

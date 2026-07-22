// 読込/保存 + エンコーディング判定 (BOM → UTF-8厳密 → Shift-JIS)。
// プレーンテキストは常に mmap ベース (hugebuf) で開き、保存はストリーム書き。
use crate::buffer::{Store, TextBuffer};
use crate::hugebuf::HugeBuf;
use encoding_rs::SHIFT_JIS;
use serde::{Deserialize, Serialize};
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

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub enum EncodingId {
    #[serde(rename = "utf8")]
    Utf8,
    #[serde(rename = "utf8bom")]
    Utf8Bom,
    #[serde(rename = "sjis")]
    ShiftJis,
    #[serde(rename = "utf16le")]
    Utf16Le,
}

impl From<Encoding> for EncodingId {
    fn from(value: Encoding) -> Self {
        match value {
            Encoding::Utf8 { bom: false } => Self::Utf8,
            Encoding::Utf8 { bom: true } => Self::Utf8Bom,
            Encoding::ShiftJis => Self::ShiftJis,
            Encoding::Utf16Le => Self::Utf16Le,
        }
    }
}

impl From<EncodingId> for Encoding {
    fn from(value: EncodingId) -> Self {
        match value {
            EncodingId::Utf8 => Self::Utf8 { bom: false },
            EncodingId::Utf8Bom => Self::Utf8 { bom: true },
            EncodingId::ShiftJis => Self::ShiftJis,
            EncodingId::Utf16Le => Self::Utf16Le,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
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
    crate::archive::has_container_signature(&head)
}

// 実ファイル1つを開く。フォルダの展開は doc.rs (Doc::open) の責務。
pub fn open_buffer(path: &Path) -> io::Result<Opened> {
    let source_file = open_exclusive(path)?;
    let len = source_file.metadata()?.len();

    let is_archive = is_archive_handle(&source_file);
    if is_archive {
        // ZIP (xlsx/docx/zip) と CFB (.xls) はフォルダビューで開く
        let bytes = read_locked(&source_file)?;
        if let Some(v) = crate::archive::parse(&bytes) {
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

pub fn open_buffer_as(path: &Path, requested: Encoding) -> io::Result<Opened> {
    const MAX_UTF16_BYTES: u64 = 256 * 1024 * 1024;
    let source_file = open_exclusive(path)?;
    if is_archive_handle(&source_file) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "アーカイブは文字コードを指定して再読込できません"));
    }
    let len = source_file.metadata()?.len();
    if requested == Encoding::Utf16Le && len > MAX_UTF16_BYTES {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "256MBを超えるUTF-16LEファイルは指定再読込できません"));
    }
    if len > 0 {
        if let Some((h, enc, eol)) = HugeBuf::open_as(source_file.try_clone()?, requested)? {
            return Ok(Opened { buf: TextBuffer::from_huge(h), enc, eol, entries: None, byte_len: len, source_file });
        }
    }
    let bytes = read_locked(&source_file)?;
    let (text, enc) = decode_as(&bytes, requested)?;
    let eol = detect_eol(&text);
    Ok(Opened { buf: TextBuffer::from_text(&text), enc, eol, entries: None, byte_len: len, source_file })
}

fn decode_as(bytes: &[u8], requested: Encoding) -> io::Result<(String, Encoding)> {
    match requested {
        Encoding::Utf8 { .. } => {
            let (body, bom) = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) { (&bytes[3..], true) } else { (bytes, false) };
            let text = String::from_utf8(body.to_vec()).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "UTF-8として読み込めません"))?;
            Ok((text, Encoding::Utf8 { bom }))
        }
        Encoding::ShiftJis => {
            let (text, _, had_errors) = SHIFT_JIS.decode(bytes);
            if had_errors { return Err(io::Error::new(io::ErrorKind::InvalidData, "Shift-JISとして読み込めません")); }
            Ok((text.into_owned(), Encoding::ShiftJis))
        }
        Encoding::Utf16Le => {
            let body = bytes.strip_prefix(&[0xFF, 0xFE]).unwrap_or(bytes);
            let (text, _, had_errors) = encoding_rs::UTF_16LE.decode(body);
            if had_errors { return Err(io::Error::new(io::ErrorKind::InvalidData, "UTF-16LEとして読み込めません")); }
            Ok((text.into_owned(), Encoding::Utf16Le))
        }
    }
}

pub(crate) fn detect_mmap_format(bytes: &[u8]) -> Option<(Encoding, usize, Eol)> {
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return None;
    }
    let (enc, bom) = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        (Encoding::Utf8 { bom: true }, 3)
    } else if valid_utf8_prefix(bytes) {
        (Encoding::Utf8 { bom: false }, 0)
    } else {
        (Encoding::ShiftJis, 0)
    };
    Some((enc, bom, detect_eol_bytes(bytes)))
}

fn valid_utf8_prefix(bytes: &[u8]) -> bool {
    match std::str::from_utf8(bytes) {
        Ok(_) => true,
        Err(error) => error.error_len().is_none() && bytes.len() - error.valid_up_to() < 4,
    }
}

pub(crate) fn detect_eol_bytes(bytes: &[u8]) -> Eol {
    match memchr::memchr(b'\n', bytes) {
        Some(i) if i > 0 && bytes[i - 1] == b'\r' => Eol::Crlf,
        Some(_) => Eol::Lf,
        None => Eol::Crlf,
    }
}

fn detect_eol(text: &str) -> Eol {
    detect_eol_bytes(text.as_bytes())
}

fn encode_str<'a>(enc: Encoding, s: &'a str) -> io::Result<Cow<'a, [u8]>> {
    Ok(match enc {
        Encoding::Utf8 { .. } => Cow::Borrowed(s.as_bytes()),
        Encoding::ShiftJis => match SHIFT_JIS.encode(s) {
            (_, _, true) => return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Shift-JISで表現できない文字が含まれています",
            )),
            (Cow::Borrowed(b), _, false) => Cow::Borrowed(b),
            (Cow::Owned(v), _, false) => Cow::Owned(v),
        },
        Encoding::Utf16Le => {
            let mut v = Vec::with_capacity(s.len() * 2);
            for u in s.encode_utf16() {
                v.extend_from_slice(&u.to_le_bytes());
            }
            Cow::Owned(v)
        }
    })
}

static TEMP_SEQ: AtomicUsize = AtomicUsize::new(0);

pub struct SaveTransaction {
    temp: Option<PathBuf>,
}

pub struct SaveCommitError {
    error: Option<io::Error>,
    temp: Option<PathBuf>,
}

impl SaveTransaction {
    #[cfg(test)]
    pub fn path(&self) -> &Path {
        self.temp.as_deref().unwrap()
    }

    pub fn commit(mut self, target: &Path) -> Result<(), SaveCommitError> {
        let temp = self.temp.take().unwrap();
        match std::fs::rename(&temp, target) {
            Ok(()) => Ok(()),
            Err(error) => Err(SaveCommitError { error: Some(error), temp: Some(temp) }),
        }
    }
}

impl Drop for SaveTransaction {
    fn drop(&mut self) {
        if let Some(temp) = self.temp.take() {
            let _ = std::fs::remove_file(temp);
        }
    }
}

impl SaveCommitError {
    pub fn into_parts(mut self) -> (io::Error, PathBuf) {
        (self.error.take().unwrap(), self.temp.take().unwrap())
    }
}

impl Drop for SaveCommitError {
    fn drop(&mut self) {
        if let Some(temp) = self.temp.take() {
            let _ = std::fs::remove_file(temp);
        }
    }
}

// 排他ハンドルとmmapを呼び出し側で解放してからcommitできるよう、tempだけを先に作る。
pub fn begin_save(
    path: &Path,
    buf: &TextBuffer,
    enc: Encoding,
    eol: Eol,
) -> io::Result<SaveTransaction> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(format!(".mptmp-{}-{}", std::process::id(), TEMP_SEQ.fetch_add(1, Ordering::Relaxed)));
    let tmp = PathBuf::from(tmp);
    let write_result = (|| -> io::Result<()> {
        let f = std::fs::File::create(&tmp)?;
        let mut w = BufWriter::with_capacity(1 << 20, f);
        write_stream(&mut w, buf, enc, eol)?;
        w.flush()?;
        Ok(())
    })();
    if let Err(error) = write_result {
        let _ = std::fs::remove_file(&tmp);
        return Err(error);
    }
    Ok(SaveTransaction { temp: Some(tmp) })
}

fn write_stream<W: Write>(w: &mut W, buf: &TextBuffer, enc: Encoding, eol: Eol) -> io::Result<()> {
    match enc {
        Encoding::Utf8 { bom: true } => w.write_all(&[0xEF, 0xBB, 0xBF])?,
        Encoding::Utf16Le => w.write_all(&[0xFF, 0xFE])?,
        _ => {}
    }
    let sep = encode_str(enc, eol.as_str())?;
    match &buf.store {
        Store::Small(lines) => {
            for (i, l) in lines.iter().enumerate() {
                if i > 0 {
                    w.write_all(&sep)?;
                }
                w.write_all(&encode_str(enc, l)?)?;
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
                        w.write_all(&encode_str(enc, l)?)?;
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
                        w.write_all(&encode_str(enc, l)?)?;
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

    fn unique_temp_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "wasabipad_{label}_{}_{}.txt",
            std::process::id(),
            TEMP_SEQ.fetch_add(1, Ordering::Relaxed)
        ))
    }

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

    #[test]
    fn explicit_decoding_uses_requested_encoding() {
        let (sjis, _, _) = SHIFT_JIS.encode("日本語");
        assert_eq!(decode_as(&sjis, Encoding::ShiftJis).unwrap().0, "日本語");
        assert!(decode_as(&sjis, Encoding::Utf8 { bom: false }).is_err());
        assert_eq!(decode_as(b"\xEF\xBB\xBFhello", Encoding::Utf8 { bom: false }).unwrap().1, Encoding::Utf8 { bom: true });
    }

    #[test]
    fn shift_jis_save_rejects_unrepresentable_characters() {
        let buf = TextBuffer::from_text("日本語😀");
        let mut out = Vec::new();
        let error = write_stream(&mut out, &buf, Encoding::ShiftJis, Eol::Crlf).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn abandoned_save_transaction_removes_temp_file() {
        let path = unique_temp_path("abandoned_save");
        let transaction = begin_save(
            &path,
            &TextBuffer::from_text("draft"),
            Encoding::Utf8 { bom: false },
            Eol::Lf,
        )
        .unwrap();
        let temp = transaction.path().to_path_buf();
        assert!(temp.exists());
        drop(transaction);
        assert!(!temp.exists());
    }

    // mmap-always: 64MB 未満の通常ファイルでも mmap で開く
    #[test]
    fn small_file_uses_mmap() {
        let path = std::env::temp_dir().join("wasabipad_test_mmap_small.txt");
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
        let path = std::env::temp_dir().join("wasabipad_test_mmap_empty.txt");
        std::fs::write(&path, "").unwrap();
        let o = open_buffer(&path).unwrap();
        assert!(!o.buf.is_huge());
        assert_eq!(o.buf.line_count(), 1);
        assert_exclusive_until_drop(&path, o);
    }

    #[test]
    fn utf16_ram_file_is_exclusive() {
        let path = std::env::temp_dir().join("wasabipad_test_exclusive_utf16.txt");
        std::fs::write(&path, [0xFF, 0xFE, b'a', 0]).unwrap();
        let o = open_buffer(&path).unwrap();
        assert!(!o.buf.is_huge());
        assert_exclusive_until_drop(&path, o);
    }

    #[test]
    fn mmap_and_ram_buffers_apply_edits_identically() {
        let mut original = (0..4100).map(|i| i.to_string()).collect::<Vec<_>>().join("\n");
        original.replace_range(
            original.match_indices('\n').nth(4095).unwrap().0 + 1
                ..original.match_indices('\n').nth(4096).unwrap().0,
            "日本語",
        );
        let path = unique_temp_path("buffer_equivalence");
        std::fs::write(&path, &original).unwrap();
        let opened = open_buffer(&path).unwrap();
        let Opened { mut buf, source_file, .. } = opened;
        let mut ram = TextBuffer::from_text(&original);

        let insert_at = crate::buffer::Pos { line: 4096, col: "日".len() };
        let huge_end = buf.insert(insert_at, "X\nY");
        let ram_end = ram.insert(insert_at, "X\nY");
        assert_eq!(huge_end, ram_end);

        let delete_from = crate::buffer::Pos { line: 4094, col: 1 };
        let delete_to = crate::buffer::Pos { line: 4098, col: 1 };
        assert_eq!(buf.range_text(delete_from, delete_to), ram.range_text(delete_from, delete_to));
        assert_eq!(buf.delete(delete_from, delete_to), ram.delete(delete_from, delete_to));
        assert_eq!(buf.line_count(), ram.line_count());
        for line in 0..buf.line_count() {
            assert_eq!(buf.line(line), ram.line(line));
        }

        drop(buf);
        drop(source_file);
        std::fs::remove_file(path).unwrap();
    }
}

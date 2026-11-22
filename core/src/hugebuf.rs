// 巨大ファイル用バッファ: mmap + 疎な行インデックス + 編集チャンクのみ実体化。
// ファイル本体は RAM に載せず、表示行をオンデマンドでデコードする。
use crate::buffer::Pos;
use crate::fileio::{Encoding, Eol};
use encoding_rs::{CoderResult, SHIFT_JIS, UTF_8};
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::os::windows::io::AsRawHandle;
use std::sync::Arc;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::Memory::{
    CreateFileMappingW, MapViewOfFile, UnmapViewOfFile, FILE_MAP_READ,
    MEMORY_MAPPED_VIEW_ADDRESS, PAGE_READONLY,
};

pub const CHUNK: usize = 4096; // 1チャンクの行数

struct Mapping {
    _file: std::fs::File, // ハンドル保持
    hmap: HANDLE,
    ptr: *const u8,
    len: usize,
}

// SAFETY: Mapping exclusively owns `_file`, `hmap`, and the immutable read-only
// mapped view `ptr` (`PAGE_READONLY` / `FILE_MAP_READ`). Neither the handle nor
// the mapped bytes are mutated, so transferring ownership between threads is safe.
unsafe impl Send for Mapping {}

impl Mapping {
    fn open(file: std::fs::File, expected_len: u64) -> io::Result<Mapping> {
        let actual_len = file.metadata()?.len();
        if actual_len != expected_len || actual_len == 0 {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "読込中にファイルサイズが変更されました",
            ));
        }
        let map_len = usize::try_from(actual_len).map_err(|_| {
            io::Error::new(io::ErrorKind::FileTooLarge, "ファイルが大きすぎます")
        })?;
        let max_high = (actual_len >> 32) as u32;
        let max_low = actual_len as u32;
        unsafe {
            let hf = file.as_raw_handle() as HANDLE;
            let hmap = CreateFileMappingW(
                hf,
                std::ptr::null(),
                PAGE_READONLY,
                max_high,
                max_low,
                std::ptr::null(),
            );
            if hmap.is_null() {
                return Err(io::Error::last_os_error());
            }
            let view = MapViewOfFile(hmap, FILE_MAP_READ, 0, 0, map_len);
            if view.Value.is_null() {
                CloseHandle(hmap);
                return Err(io::Error::last_os_error());
            }
            Ok(Mapping {
                _file: file,
                hmap,
                ptr: view.Value as *const u8,
                len: map_len,
            })
        }
    }

    fn bytes(&self) -> &[u8] {
        unsafe { std::slice::from_raw_parts(self.ptr, self.len) }
    }
}

impl Drop for Mapping {
    fn drop(&mut self) {
        unsafe {
            UnmapViewOfFile(MEMORY_MAPPED_VIEW_ADDRESS { Value: self.ptr as *mut _ });
            CloseHandle(self.hmap);
        }
    }
}

pub struct HugeBuf {
    map: Option<Mapping>,
    mapped_len: usize,
    pub enc: Encoding,
    pub orig_eol: Eol,
    binary: bool,
    checkpoints: Vec<u64>, // chunk c の先頭行のバイトオフセット
    orig_counts: Vec<u32>, // 元ファイルでの chunk 行数 (デコード用、不変)
    counts: Vec<u32>,      // 現在の chunk 行数 (編集で変動)
    overlay: BTreeMap<usize, Vec<String>>, // 編集済み chunk のみ実体化
    prefix: RefCell<Vec<u64>>, // prefix[c] = chunk c の先頭グローバル行番号
    prefix_valid: Cell<bool>,
    cache: RefCell<Vec<(usize, Arc<Vec<String>>)>>, // 未編集 chunk のデコードキャッシュ (LRU 4件)
    total: usize,
    image_tag_lines: std::collections::BTreeSet<usize>,
}

fn decode_bytes(enc: Encoding, mut b: &[u8]) -> String {
    if b.last() == Some(&b'\r') {
        b = &b[..b.len() - 1];
    }
    match enc {
        Encoding::ShiftJis => SHIFT_JIS.decode(b).0.into_owned(),
        _ => String::from_utf8_lossy(b).into_owned(),
    }
}

#[allow(clippy::too_many_arguments)]
fn scan_decoded_chunk(
    decoder: &mut encoding_rs::Decoder,
    input: &[u8],
    last: bool,
    decoded: &mut String,
    binary: &mut bool,
    image_line: &mut usize,
    image_tail: &mut String,
    image_tag_lines: &mut std::collections::BTreeSet<usize>,
) {
    let mut consumed = 0usize;
    loop {
        let (result, read, had_errors) = decoder.decode_to_string(&input[consumed..], decoded, last);
        consumed += read;
        *binary |= had_errors;
        if !decoded.is_empty() {
            for (index, segment) in decoded.split('\n').enumerate() {
                if index > 0 {
                    *image_line += 1;
                }
                let crosses_chunk = index == 0
                    && crate::buffer::TextBuffer::has_image_tag(&format!(
                        "{image_tail}{}",
                        segment.chars().take(3).collect::<String>()
                    ));
                if crosses_chunk || crate::buffer::TextBuffer::has_image_tag(segment) {
                    image_tag_lines.insert(*image_line);
                }
            }
            if decoded.contains('\n') {
                *image_tail = decoded
                    .rsplit('\n')
                    .next()
                    .unwrap_or_default()
                    .chars()
                    .rev()
                    .take(3)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect();
            } else {
                let mut combined = String::with_capacity(image_tail.len() + decoded.len());
                combined.push_str(image_tail);
                combined.push_str(decoded);
                *image_tail = combined
                    .chars()
                    .rev()
                    .take(3)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect();
            }
            decoded.clear();
        }
        match result {
            CoderResult::InputEmpty => break,
            CoderResult::OutputFull => {
                if decoded.capacity() < 16 {
                    decoded.reserve(16);
                }
            }
        }
    }
}

impl HugeBuf {
    // UTF-16 (行分割が byte 単位でできない) は None → 通常読込へフォールバック
    pub fn open(file: File) -> io::Result<Option<(HugeBuf, Encoding, Eol)>> {
        Self::open_with_encoding(file, None, None)
    }

    pub fn open_as(file: File, enc: Encoding) -> io::Result<Option<(HugeBuf, Encoding, Eol)>> {
        Self::open_with_encoding(file, Some(enc), None)
    }

    pub fn open_with_progress(
        file: File,
        progress: Option<&mut crate::fileio::LoadProgress<'_>>,
    ) -> io::Result<Option<(HugeBuf, Encoding, Eol)>> {
        Self::open_with_encoding(file, None, progress)
    }

    pub fn open_with_encoding(
        mut file: File,
        forced: Option<Encoding>,
        mut progress: Option<&mut crate::fileio::LoadProgress<'_>>,
    ) -> io::Result<Option<(HugeBuf, Encoding, Eol)>> {
        let len = file.metadata()?.len();
        if let Some(report) = progress.as_deref_mut() {
            report(0, len);
        }
        file.seek(SeekFrom::Start(0))?;
        // 先頭 1MB でエンコーディング/EOL 判定
        let head_len = len.min(1024 * 1024) as usize;
        let mut head = vec![0u8; head_len];
        file.read_exact(&mut head)?;
        let (enc, bom, eol) = match forced {
            Some(Encoding::Utf16Le) => return Ok(None),
            Some(Encoding::ShiftJis) => (Encoding::ShiftJis, 0, crate::fileio::detect_eol_bytes(&head)),
            Some(Encoding::Utf8 { .. }) => {
                let bom = usize::from(head.starts_with(&[0xEF, 0xBB, 0xBF])) * 3;
                (Encoding::Utf8 { bom: bom > 0 }, bom, crate::fileio::detect_eol_bytes(&head))
            }
            None => match crate::fileio::detect_mmap_format(&head) {
                Some(format) => format,
                None => return Ok(None),
            },
        };

        // 行インデックス走査: CHUNK 行ごとのチェックポイントだけ保持
        file.seek(SeekFrom::Start(0))?;
        let mut decoder = match enc {
            Encoding::Utf8 { .. } => Some(UTF_8.new_decoder()),
            Encoding::ShiftJis => Some(SHIFT_JIS.new_decoder()),
            Encoding::Utf16Le => None,
        };
        const SCAN_CHUNK: usize = 4 * 1024 * 1024;
        // encoding_rsの出力上限はStringのcapacityで決まるため、最大3倍を確保する。
        let mut decoded = String::with_capacity(SCAN_CHUNK * 3);
        let mut binary = head.contains(&0);
        let mut checkpoints: Vec<u64> = vec![bom as u64];
        let mut nlines: usize = 1; // 行0 は開始済み
        let mut buf = vec![0u8; SCAN_CHUNK];
        let mut offset: u64 = 0;
        let mut last_percent = 0u8;
        let mut image_tag_lines = std::collections::BTreeSet::new();
        let mut image_line = 0usize;
        let mut image_tail = String::new();
        loop {
            let n = file.read(&mut buf)?;
            if n == 0 {
                if let Some(decoder) = decoder.as_mut() {
                    scan_decoded_chunk(
                        decoder,
                        &[],
                        true,
                        &mut decoded,
                        &mut binary,
                        &mut image_line,
                        &mut image_tail,
                        &mut image_tag_lines,
                    );
                }
                break;
            }
            binary |= buf[..n].contains(&0);
            if let Some(decoder) = decoder.as_mut() {
                scan_decoded_chunk(
                    decoder,
                    &buf[..n],
                    false,
                    &mut decoded,
                    &mut binary,
                    &mut image_line,
                    &mut image_tail,
                    &mut image_tag_lines,
                );
            }
            for p in memchr::memchr_iter(b'\n', &buf[..n]) {
                if nlines.is_multiple_of(CHUNK) {
                    checkpoints.push(offset + p as u64 + 1);
                }
                nlines += 1;
            }
            offset += n as u64;
            if let Some(report) = progress.as_deref_mut() {
                let percent = ((offset.saturating_mul(100) / len.max(1)).min(99)) as u8;
                if percent > last_percent {
                    last_percent = percent;
                    report(offset, len);
                }
            }
        }
        if let Some(report) = progress.as_deref_mut() {
            report(offset, offset);
        }
        drop(buf);
        let total = nlines;
        let nchunks = checkpoints.len();
        let mut orig_counts = vec![CHUNK as u32; nchunks];
        orig_counts[nchunks - 1] = (total - (nchunks - 1) * CHUNK) as u32;

        let map = Mapping::open(file, offset)?;
        let mapped_len = map.len;
        Ok(Some((
            HugeBuf {
                map: Some(map),
                mapped_len,
                enc,
                orig_eol: eol,
                binary,
                checkpoints,
                counts: orig_counts.clone(),
                orig_counts,
                overlay: BTreeMap::new(),
                prefix: RefCell::new(Vec::new()),
                prefix_valid: Cell::new(false),
                cache: RefCell::new(Vec::new()),
                total,
                image_tag_lines,
            },
            enc,
            eol,
        )))
    }

    pub fn line_count(&self) -> usize {
        self.total
    }

    pub(crate) fn image_tag_lines(&self) -> &std::collections::BTreeSet<usize> { &self.image_tag_lines }

    pub fn nchunks(&self) -> usize {
        self.checkpoints.len()
    }

    pub fn matches_format(&self, enc: Encoding, eol: Eol) -> bool {
        self.enc == enc && self.orig_eol == eol
    }

    pub fn is_binary(&self) -> bool {
        self.binary
    }

    pub(crate) fn release_mapping(&mut self) -> bool {
        self.map.take().is_some()
    }

    pub(crate) fn restore_mapping(&mut self, file: File) -> io::Result<()> {
        if self.map.is_none() {
            self.map = Some(Mapping::open(file, self.mapped_len as u64)?);
        }
        Ok(())
    }

    fn chunk_raw(&self, c: usize) -> &[u8] {
        let Some(map) = self.map.as_ref() else {
            return &[];
        };
        let start = self.checkpoints[c] as usize;
        let end = if c + 1 < self.checkpoints.len() {
            self.checkpoints[c + 1] as usize
        } else {
            map.len
        };
        &map.bytes()[start..end]
    }

    // 保存用: 生バイト (末尾チャンク以外は終端改行を除去)
    pub fn chunk_raw_trimmed(&self, c: usize) -> &[u8] {
        let mut raw = self.chunk_raw(c);
        if c + 1 < self.checkpoints.len() {
            if raw.last() == Some(&b'\n') {
                raw = &raw[..raw.len() - 1];
            }
            if raw.last() == Some(&b'\r') {
                raw = &raw[..raw.len() - 1];
            }
        }
        raw
    }

    pub fn overlay_lines(&self, c: usize) -> Option<&Vec<String>> {
        self.overlay.get(&c)
    }

    pub fn decode_chunk(&self, c: usize) -> Arc<Vec<String>> {
        {
            let mut cache = self.cache.borrow_mut();
            if let Some(i) = cache.iter().position(|(k, _)| *k == c) {
                let e = cache.remove(i);
                let arc = e.1.clone();
                cache.insert(0, e);
                return arc;
            }
        }
        let raw = self.chunk_raw(c);
        let want = self.orig_counts[c] as usize;
        let mut lines = Vec::with_capacity(want);
        let mut start = 0usize;
        for p in memchr::memchr_iter(b'\n', raw) {
            lines.push(decode_bytes(self.enc, &raw[start..p]));
            start = p + 1;
            if lines.len() == want {
                break;
            }
        }
        if lines.len() < want {
            lines.push(decode_bytes(self.enc, &raw[start..]));
        }
        if self.binary {
            lines = lines
                .into_iter()
                .map(crate::fileio::sanitize_binary_text)
                .collect();
        }
        let arc = Arc::new(lines);
        let mut cache = self.cache.borrow_mut();
        cache.insert(0, (c, arc.clone()));
        cache.truncate(4);
        arc
    }

    fn ensure_prefix(&self) {
        if self.prefix_valid.get() {
            return;
        }
        let mut p = self.prefix.borrow_mut();
        p.clear();
        p.reserve(self.counts.len() + 1);
        p.push(0);
        let mut acc = 0u64;
        for &n in &self.counts {
            acc += n as u64;
            p.push(acc);
        }
        self.prefix_valid.set(true);
    }

    // グローバル行番号 → (chunk, chunk内行)
    fn locate(&self, line: usize) -> (usize, usize) {
        self.ensure_prefix();
        let p = self.prefix.borrow();
        let c = (p.partition_point(|&v| v <= line as u64) - 1).min(self.counts.len() - 1);
        (c, line - p[c] as usize)
    }

    pub fn line(&self, i: usize) -> String {
        let (c, j) = self.locate(i);
        if let Some(lines) = self.overlay.get(&c) {
            lines[j].clone()
        } else {
            self.decode_chunk(c)[j].clone()
        }
    }

    fn materialize(&mut self, c: usize) {
        if !self.overlay.contains_key(&c) {
            let v: Vec<String> = (*self.decode_chunk(c)).clone();
            self.overlay.insert(c, v);
            self.cache.borrow_mut().retain(|(k, _)| *k != c);
        }
    }

    pub fn insert(&mut self, pos: Pos, text: &str) -> Pos {
        let (c, j) = self.locate(pos.line);
        self.materialize(c);
        let lines = self.overlay.get_mut(&c).unwrap();
        if !text.contains('\n') {
            lines[j].insert_str(pos.col, text);
            return Pos { line: pos.line, col: pos.col + text.len() };
        }
        let tail = lines[j].split_off(pos.col);
        let mut it = text.split('\n');
        lines[j].push_str(it.next().unwrap());
        let mut cur = j;
        for seg in it {
            cur += 1;
            lines.insert(cur, seg.to_string());
        }
        let end_col = lines[cur].len();
        lines[cur].push_str(&tail);
        let added = cur - j;
        self.counts[c] += added as u32;
        self.total += added;
        self.prefix_valid.set(false);
        Pos { line: pos.line + added, col: end_col }
    }

    pub fn delete(&mut self, s: Pos, e: Pos) -> String {
        let (c1, j1) = self.locate(s.line);
        let (c2, j2) = self.locate(e.line);
        if c1 == c2 {
            self.materialize(c1);
            let lines = self.overlay.get_mut(&c1).unwrap();
            if j1 == j2 {
                return lines[j1].drain(s.col..e.col).collect();
            }
            let mut removed = String::new();
            removed.push_str(&lines[j1][s.col..]);
            removed.push('\n');
            for l in &lines[j1 + 1..j2] {
                removed.push_str(l);
                removed.push('\n');
            }
            removed.push_str(&lines[j2][..e.col]);
            let tail = lines[j2][e.col..].to_string();
            lines[j1].truncate(s.col);
            lines[j1].push_str(&tail);
            lines.drain(j1 + 1..=j2);
            let n = j2 - j1;
            self.counts[c1] -= n as u32;
            self.total -= n;
            self.prefix_valid.set(false);
            removed
        } else {
            let removed = self.range_text(s, e);
            self.materialize(c1);
            self.materialize(c2);
            let tail = {
                let l2 = &self.overlay[&c2];
                l2[j2][e.col..].to_string()
            };
            {
                let l1 = self.overlay.get_mut(&c1).unwrap();
                l1.truncate(j1 + 1);
                l1[j1].truncate(s.col);
                l1[j1].push_str(&tail);
            }
            self.counts[c1] = (j1 + 1) as u32;
            {
                let l2 = self.overlay.get_mut(&c2).unwrap();
                l2.drain(..=j2);
            }
            self.counts[c2] -= (j2 + 1) as u32;
            for mid in c1 + 1..c2 {
                self.overlay.insert(mid, Vec::new());
                self.counts[mid] = 0;
            }
            self.total -= e.line - s.line;
            self.prefix_valid.set(false);
            removed
        }
    }

    pub fn range_text(&self, s: Pos, e: Pos) -> String {
        if s.line == e.line {
            let l = self.line(s.line);
            return l[s.col..e.col].to_string();
        }
        let mut out = String::new();
        for i in s.line..=e.line {
            let l = self.line(i);
            if i == s.line {
                out.push_str(&l[s.col..]);
            } else if i == e.line {
                out.push('\n');
                out.push_str(&l[..e.col]);
            } else {
                out.push('\n');
                out.push_str(&l);
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Feature: 巨大ファイルのデコード走査
    // Scenario: 出力バッファが OutputFull に達する入力を走査する
    // Given: 小さな出力バッファと改行・<img タグを含む不正UTF-8混在バイト列
    // When: scan_decoded_chunk でチャンクと EOF を走査する
    // Then: OutputFull で途中打ち切りせず全行の <img 位置を正確に記録する
    #[test]
    fn scan_decoded_chunk_handles_output_full_without_losing_line_alignment() {
        let mut decoder = UTF_8.new_decoder();
        let mut decoded = String::with_capacity(8);
        let mut binary = false;
        let mut image_line = 0usize;
        let mut image_tail = String::new();
        let mut image_tag_lines = std::collections::BTreeSet::new();
        // 3 バイト置換文字へ展開される不正バイトの連続の後に <img タグがある行
        let input = b"\xFF\xFF\xFF\xFF\xFF\nline1\n<img src=\"a.png\">\n";
        scan_decoded_chunk(
            &mut decoder,
            input,
            false,
            &mut decoded,
            &mut binary,
            &mut image_line,
            &mut image_tail,
            &mut image_tag_lines,
        );
        scan_decoded_chunk(
            &mut decoder,
            &[],
            true,
            &mut decoded,
            &mut binary,
            &mut image_line,
            &mut image_tail,
            &mut image_tag_lines,
        );

        assert!(binary);
        assert_eq!(image_line, 3);
        assert!(image_tag_lines.contains(&2));
    }

    // Feature: HugeBuf のスレッド安全性
    // Scenario: HugeBuf 単体が Send を満たす
    // Given: Mapping のみに Send を閉じ込めた HugeBuf
    // When: コンパイル時境界を確認する
    // Then: 外部の unsafe impl Send に頼らず Send である
    #[test]
    fn huge_buf_is_send() {
        fn assert_send<T: Send>() {}
        assert_send::<HugeBuf>();
    }
}

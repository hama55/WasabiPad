// 巨大ファイル用バッファ: mmap + 疎な行インデックス + 編集チャンクのみ実体化。
// ファイル本体は RAM に載せず、表示行をオンデマンドでデコードする。
use crate::buffer::Pos;
use crate::fileio::{Encoding, Eol};
use encoding_rs::SHIFT_JIS;
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::os::windows::io::AsRawHandle;
use std::rc::Rc;
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
impl Mapping {
    fn open(file: std::fs::File, len: u64) -> io::Result<Mapping> {
        unsafe {
            let hf = file.as_raw_handle() as HANDLE;
            let hmap =
                CreateFileMappingW(hf, std::ptr::null(), PAGE_READONLY, 0, 0, std::ptr::null());
            if hmap.is_null() {
                return Err(io::Error::last_os_error());
            }
            let view = MapViewOfFile(hmap, FILE_MAP_READ, 0, 0, 0);
            if view.Value.is_null() {
                CloseHandle(hmap);
                return Err(io::Error::last_os_error());
            }
            Ok(Mapping { _file: file, hmap, ptr: view.Value as *const u8, len: len as usize })
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
    map: Mapping,
    pub enc: Encoding,
    pub orig_eol: Eol,
    checkpoints: Vec<u64>, // chunk c の先頭行のバイトオフセット
    orig_counts: Vec<u32>, // 元ファイルでの chunk 行数 (デコード用、不変)
    counts: Vec<u32>,      // 現在の chunk 行数 (編集で変動)
    overlay: BTreeMap<usize, Vec<String>>, // 編集済み chunk のみ実体化
    prefix: RefCell<Vec<u64>>, // prefix[c] = chunk c の先頭グローバル行番号
    prefix_valid: Cell<bool>,
    cache: RefCell<Vec<(usize, Rc<Vec<String>>)>>, // 未編集 chunk のデコードキャッシュ (LRU 4件)
    total: usize,
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

impl HugeBuf {
    // UTF-16 (行分割が byte 単位でできない) は None → 通常読込へフォールバック
    pub fn open(file: File) -> io::Result<Option<(HugeBuf, Encoding, Eol)>> {
        Self::open_with_encoding(file, None)
    }

    pub fn open_as(file: File, enc: Encoding) -> io::Result<Option<(HugeBuf, Encoding, Eol)>> {
        Self::open_with_encoding(file, Some(enc))
    }

    fn open_with_encoding(mut file: File, forced: Option<Encoding>) -> io::Result<Option<(HugeBuf, Encoding, Eol)>> {
        let len = file.metadata()?.len();
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
        let mut checkpoints: Vec<u64> = vec![bom as u64];
        let mut nlines: usize = 1; // 行0 は開始済み
        let mut buf = vec![0u8; 4 * 1024 * 1024];
        let mut offset: u64 = 0;
        loop {
            let n = file.read(&mut buf)?;
            if n == 0 {
                break;
            }
            for p in memchr::memchr_iter(b'\n', &buf[..n]) {
                if nlines.is_multiple_of(CHUNK) {
                    checkpoints.push(offset + p as u64 + 1);
                }
                nlines += 1;
            }
            offset += n as u64;
        }
        drop(buf);
        let total = nlines;
        let nchunks = checkpoints.len();
        let mut orig_counts = vec![CHUNK as u32; nchunks];
        orig_counts[nchunks - 1] = (total - (nchunks - 1) * CHUNK) as u32;

        let map = Mapping::open(file, len)?;
        Ok(Some((
            HugeBuf {
                map,
                enc,
                orig_eol: eol,
                checkpoints,
                counts: orig_counts.clone(),
                orig_counts,
                overlay: BTreeMap::new(),
                prefix: RefCell::new(Vec::new()),
                prefix_valid: Cell::new(false),
                cache: RefCell::new(Vec::new()),
                total,
            },
            enc,
            eol,
        )))
    }

    pub fn line_count(&self) -> usize {
        self.total
    }

    pub fn nchunks(&self) -> usize {
        self.checkpoints.len()
    }

    pub fn matches_format(&self, enc: Encoding, eol: Eol) -> bool {
        self.enc == enc && self.orig_eol == eol
    }

    fn chunk_raw(&self, c: usize) -> &[u8] {
        let start = self.checkpoints[c] as usize;
        let end = if c + 1 < self.checkpoints.len() {
            self.checkpoints[c + 1] as usize
        } else {
            self.map.len
        };
        &self.map.bytes()[start..end]
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

    pub fn decode_chunk(&self, c: usize) -> Rc<Vec<String>> {
        {
            let mut cache = self.cache.borrow_mut();
            if let Some(i) = cache.iter().position(|(k, _)| *k == c) {
                let e = cache.remove(i);
                let rc = e.1.clone();
                cache.insert(0, e);
                return rc;
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
        let rc = Rc::new(lines);
        let mut cache = self.cache.borrow_mut();
        cache.insert(0, (c, rc.clone()));
        cache.truncate(4);
        rc
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

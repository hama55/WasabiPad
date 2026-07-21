// 旧 Excel (.xls, BIFF8) をシートごとのセルテキストとして展開する。
// CFB (OLE2 複合ファイル) から Workbook ストリームを取り出し、
// SST/セルレコードを読んでタブ区切りテキストに変換する。
use crate::ziptext::Entry;
use std::collections::BTreeMap;

const ENDOFCHAIN: u32 = 0xFFFF_FFFE;

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

// ---- CFB (複合ファイル) ----

struct Cfb<'a> {
    data: &'a [u8],
    sec_size: usize,
    fat: Vec<u32>,
    minifat: Vec<u32>,
    mini_stream: Vec<u8>,
    mini_cutoff: usize,
    dir: Vec<(String, u32, usize)>, // (名前, 先頭セクタ, サイズ)
}

impl<'a> Cfb<'a> {
    fn sector(&self, sect: u32) -> Option<&'a [u8]> {
        let off = (sect as usize + 1) * self.sec_size;
        self.data.get(off..off + self.sec_size)
    }

    fn read_chain(&self, start: u32, size: usize, fat: &[u32], mini: bool) -> Option<Vec<u8>> {
        let mut out = Vec::with_capacity(size);
        let mut sect = start;
        let mut guard = 0;
        while sect != ENDOFCHAIN && sect < 0xFFFF_FFFA {
            let chunk: &[u8] = if mini {
                let off = sect as usize * 64;
                self.mini_stream.get(off..off + 64)?
            } else {
                self.sector(sect)?
            };
            out.extend_from_slice(chunk);
            sect = *fat.get(sect as usize)?;
            guard += 1;
            if guard > 4_000_000 || out.len() >= size + self.sec_size {
                break;
            }
        }
        out.truncate(size);
        if out.len() < size {
            return None;
        }
        Some(out)
    }

    fn stream(&self, start: u32, size: usize) -> Option<Vec<u8>> {
        if size < self.mini_cutoff {
            self.read_chain(start, size, &self.minifat, true)
        } else {
            self.read_chain(start, size, &self.fat, false)
        }
    }
}

fn parse_cfb(data: &[u8]) -> Option<Cfb<'_>> {
    if !data.starts_with(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]) {
        return None;
    }
    let sec_size = 1usize << u16le(data, 30)?;
    if sec_size != 512 && sec_size != 4096 {
        return None;
    }
    let first_dir = u32le(data, 48)?;
    let mini_cutoff = u32le(data, 56)? as usize;
    let first_minifat = u32le(data, 60)?;
    let n_minifat = u32le(data, 64)? as usize;
    let first_difat = u32le(data, 68)?;
    let n_difat = u32le(data, 72)? as usize;

    // DIFAT → FAT セクタ一覧
    let mut fat_sects = Vec::new();
    for i in 0..109 {
        let v = u32le(data, 76 + i * 4)?;
        if v < 0xFFFF_FFFA {
            fat_sects.push(v);
        }
    }
    let mut dsect = first_difat;
    let per = sec_size / 4 - 1;
    for _ in 0..n_difat {
        if dsect >= 0xFFFF_FFFA {
            break;
        }
        let off = (dsect as usize + 1) * sec_size;
        let sec = data.get(off..off + sec_size)?;
        for i in 0..per {
            let v = u32le(sec, i * 4)?;
            if v < 0xFFFF_FFFA {
                fat_sects.push(v);
            }
        }
        dsect = u32le(sec, per * 4)?;
    }

    let mut cfb = Cfb {
        data,
        sec_size,
        fat: Vec::new(),
        minifat: Vec::new(),
        mini_stream: Vec::new(),
        mini_cutoff,
        dir: Vec::new(),
    };
    for s in fat_sects {
        let sec = cfb.sector(s)?;
        for i in 0..sec_size / 4 {
            cfb.fat.push(u32le(sec, i * 4)?);
        }
    }

    // ディレクトリ
    let mut dir_bytes = Vec::new();
    let mut sect = first_dir;
    let mut guard = 0;
    while sect != ENDOFCHAIN && sect < 0xFFFF_FFFA {
        dir_bytes.extend_from_slice(cfb.sector(sect)?);
        sect = *cfb.fat.get(sect as usize)?;
        guard += 1;
        if guard > 100_000 {
            break;
        }
    }
    for e in dir_bytes.chunks_exact(128) {
        let nlen = u16le(e, 64)? as usize;
        if !(2..=64).contains(&nlen) {
            cfb.dir.push((String::new(), 0, 0));
            continue;
        }
        let units: Vec<u16> = (0..(nlen - 2) / 2)
            .map(|i| u16::from_le_bytes([e[i * 2], e[i * 2 + 1]]))
            .collect();
        let name = String::from_utf16_lossy(&units);
        let start = u32le(e, 116)?;
        let size = u32le(e, 120)? as usize;
        cfb.dir.push((name, start, size));
    }
    if cfb.dir.is_empty() {
        return None;
    }

    // ルートの mini stream と miniFAT
    let (_, root_start, root_size) = cfb.dir[0].clone();
    cfb.mini_stream = cfb
        .read_chain(root_start, root_size, &cfb.fat, false)
        .unwrap_or_default();
    let mut msect = first_minifat;
    let mut guard = 0;
    while msect != ENDOFCHAIN && msect < 0xFFFF_FFFA && guard < n_minifat + 4 {
        let sec = cfb.sector(msect)?;
        for i in 0..sec_size / 4 {
            cfb.minifat.push(u32le(sec, i * 4)?);
        }
        msect = *cfb.fat.get(msect as usize)?;
        guard += 1;
    }
    Some(cfb)
}

// ---- BIFF8 ----

// SST + CONTINUE をまたぐ読み取りカーソル。
// 文字データの途中でセグメント境界を越える時のみ flags バイトを再読みする。
struct Cursor<'a> {
    segs: Vec<&'a [u8]>,
    si: usize,
    off: usize,
}

impl<'a> Cursor<'a> {
    fn remaining_in_seg(&self) -> usize {
        self.segs.get(self.si).map_or(0, |s| s.len() - self.off)
    }

    fn advance_seg(&mut self) -> bool {
        while self.si < self.segs.len() && self.off >= self.segs[self.si].len() {
            self.si += 1;
            self.off = 0;
        }
        self.si < self.segs.len()
    }

    fn u8(&mut self) -> Option<u8> {
        if !self.advance_seg() {
            return None;
        }
        let v = self.segs[self.si][self.off];
        self.off += 1;
        Some(v)
    }

    fn u16(&mut self) -> Option<u16> {
        Some(u16::from_le_bytes([self.u8()?, self.u8()?]))
    }

    fn u32(&mut self) -> Option<u32> {
        Some(u32::from_le_bytes([self.u8()?, self.u8()?, self.u8()?, self.u8()?]))
    }

    fn skip(&mut self, n: usize) -> Option<()> {
        for _ in 0..n {
            self.u8()?;
        }
        Some(())
    }

    // XLUnicodeRichExtendedString
    fn read_string(&mut self) -> Option<String> {
        let cch = self.u16()? as usize;
        let flags = self.u8()?;
        let crun = if flags & 0x08 != 0 { self.u16()? as usize } else { 0 };
        let cbext = if flags & 0x04 != 0 { self.u32()? as usize } else { 0 };
        let mut high = flags & 0x01 != 0;
        let mut units: Vec<u16> = Vec::with_capacity(cch);
        let mut remaining = cch;
        while remaining > 0 {
            if !self.advance_seg() {
                return None;
            }
            let bpc = if high { 2 } else { 1 };
            let avail = self.remaining_in_seg() / bpc;
            if avail == 0 {
                // 文字データ途中の CONTINUE 境界: 新しい flags バイトで幅が変わりうる
                self.si += 1;
                self.off = 0;
                high = self.u8()? & 0x01 != 0;
                continue;
            }
            let take = avail.min(remaining);
            for _ in 0..take {
                let u = if high {
                    self.u16()?
                } else {
                    self.u8()? as u16
                };
                units.push(u);
            }
            remaining -= take;
        }
        self.skip(crun * 4)?;
        self.skip(cbext)?;
        Some(String::from_utf16_lossy(&units))
    }
}

// 単一レコード内の XLUnicodeString (cch u16 + flags + chars)
fn read_simple_string(b: &[u8]) -> Option<String> {
    let cch = u16le(b, 0)? as usize;
    let flags = *b.get(2)?;
    if flags & 0x01 != 0 {
        let units: Vec<u16> = (0..cch)
            .map(|i| u16le(b, 3 + i * 2))
            .collect::<Option<_>>()?;
        Some(String::from_utf16_lossy(&units))
    } else {
        let bytes = b.get(3..3 + cch)?;
        Some(bytes.iter().map(|&c| c as char).collect())
    }
}

fn rk_value(rk: u32) -> f64 {
    let div100 = rk & 2 != 0;
    let v = if rk & 1 != 0 {
        ((rk as i32) >> 2) as f64
    } else {
        f64::from_bits(((rk & 0xFFFF_FFFC) as u64) << 32)
    };
    if div100 {
        v / 100.0
    } else {
        v
    }
}

fn fmt_f64(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e15 {
        format!("{}", v as i64)
    } else {
        format!("{}", v)
    }
}

fn clean(s: String) -> String {
    s.replace(['\n', '\r', '\t'], " ")
}

fn workbook_stream(bytes: &[u8]) -> Option<Vec<u8>> {
    let cfb = parse_cfb(bytes)?;
    let (_, start, size) = cfb
        .dir
        .iter()
        .find(|(n, _, _)| n == "Workbook" || n == "Book")?
        .clone();
    cfb.stream(start, size)
}

fn enumerate_records(wb: &[u8]) -> Option<Vec<(u16, usize, usize)>> {
    let mut recs: Vec<(u16, usize, usize)> = Vec::new(); // (id, data開始, len)
    let mut p = 0usize;
    while p + 4 <= wb.len() {
        let id = u16le(wb, p)?;
        let len = u16le(wb, p + 2)? as usize;
        if p + 4 + len > wb.len() {
            break;
        }
        recs.push((id, p + 4, len));
        p += 4 + len;
    }
    if recs.is_empty() {
        None
    } else {
        Some(recs)
    }
}

struct Globals {
    sst: Vec<String>,
    sheet_names: Vec<String>,
    unsupported: bool, // BIFF8 以外の旧形式
}

// グローバル部 (BOF〜EOF) だけを読む: SST とシート名一覧。セルはまだ読まない
fn parse_globals(wb: &[u8], recs: &[(u16, usize, usize)]) -> Option<Globals> {
    // BIFF バージョン確認 (BOF.vers == 0x0600 が BIFF8)
    if recs[0].0 != 0x0809 || u16le(wb, recs[0].1) != Some(0x0600) {
        return Some(Globals { sst: Vec::new(), sheet_names: Vec::new(), unsupported: true });
    }
    let mut sst: Vec<String> = Vec::new();
    let mut sheet_names: Vec<String> = Vec::new();
    for (i, &(id, off, len)) in recs.iter().enumerate() {
        match id {
            0x0085 => {
                // BOUNDSHEET: +6 cch(u8) +7 flags + name
                let d = &wb[off..off + len];
                let cch = *d.get(6)? as usize;
                let flags = *d.get(7)?;
                let name = if flags & 1 != 0 {
                    let units: Vec<u16> =
                        (0..cch).map(|k| u16le(d, 8 + k * 2)).collect::<Option<_>>()?;
                    String::from_utf16_lossy(&units)
                } else {
                    d.get(8..8 + cch)?.iter().map(|&c| c as char).collect()
                };
                sheet_names.push(name);
            }
            0x00FC => {
                // SST: 直後の CONTINUE (0x003C) を連結して読む
                let mut segs: Vec<&[u8]> = vec![&wb[off..off + len]];
                for &(cid, coff, clen) in &recs[i + 1..] {
                    if cid == 0x003C {
                        segs.push(&wb[coff..coff + clen]);
                    } else {
                        break;
                    }
                }
                let mut cur = Cursor { segs, si: 0, off: 0 };
                let _total = cur.u32()?;
                let unique = cur.u32()? as usize;
                for _ in 0..unique.min(4_000_000) {
                    match cur.read_string() {
                        Some(s) => sst.push(s),
                        None => break,
                    }
                }
            }
            0x000A => break, // グローバル部の EOF
            _ => {}
        }
    }
    Some(Globals { sst, sheet_names, unsupported: false })
}

// 実際のワークシート substream (BOF dt=0x0010) の出現順に、表示名を確定する
// (BOUNDSHEET の数と実体がずれる場合は Sheet{n} で補う。parse/decode_one で名前を揃えるため共通化)
fn sheet_display_names(wb: &[u8], recs: &[(u16, usize, usize)], sheet_names: &[String]) -> Vec<String> {
    let mut names = Vec::new();
    for &(id, off, _) in recs {
        if id == 0x0809 && u16le(wb, off + 2) == Some(0x0010) {
            let idx = names.len();
            names.push(sheet_names.get(idx).cloned().unwrap_or_else(|| format!("Sheet{}", idx + 1)));
        }
    }
    names
}

// 1シート substream (BOF の位置 start_i) のセルを収集する
fn collect_sheet_cells(
    wb: &[u8],
    recs: &[(u16, usize, usize)],
    start_i: usize,
    sst: &[String],
) -> Option<BTreeMap<(u32, u32), String>> {
    let mut cells: BTreeMap<(u32, u32), String> = BTreeMap::new();
    let mut pending_formula: Option<(u32, u32)> = None;
    let mut i = start_i + 1;
    while i < recs.len() {
        let (cid, coff, clen) = recs[i];
        let d = &wb[coff..coff + clen];
        match cid {
            0x000A => break, // EOF
            0x00FD => {
                // LABELSST
                let (r, c) = (u16le(d, 0)? as u32, u16le(d, 2)? as u32);
                let isst = u32le(d, 6)? as usize;
                if let Some(s) = sst.get(isst) {
                    cells.insert((r, c), clean(s.clone()));
                }
            }
            0x0204 => {
                // LABEL (インライン文字列)
                let (r, c) = (u16le(d, 0)? as u32, u16le(d, 2)? as u32);
                if let Some(s) = read_simple_string(&d[6..]) {
                    cells.insert((r, c), clean(s));
                }
            }
            0x0203 => {
                // NUMBER
                let (r, c) = (u16le(d, 0)? as u32, u16le(d, 2)? as u32);
                let v = f64::from_le_bytes(d.get(6..14)?.try_into().ok()?);
                cells.insert((r, c), fmt_f64(v));
            }
            0x027E => {
                // RK
                let (r, c) = (u16le(d, 0)? as u32, u16le(d, 2)? as u32);
                cells.insert((r, c), fmt_f64(rk_value(u32le(d, 6)?)));
            }
            0x00BD => {
                // MULRK
                let r = u16le(d, 0)? as u32;
                let c0 = u16le(d, 2)? as u32;
                let n = (clen - 6) / 6;
                for k in 0..n {
                    let rk = u32le(d, 4 + k * 6 + 2)?;
                    cells.insert((r, c0 + k as u32), fmt_f64(rk_value(rk)));
                }
            }
            0x0006 => {
                // FORMULA: キャッシュ済み結果
                let (r, c) = (u16le(d, 0)? as u32, u16le(d, 2)? as u32);
                let res = d.get(6..14)?;
                if res[6] == 0xFF && res[7] == 0xFF {
                    match res[0] {
                        0 => pending_formula = Some((r, c)), // 次の STRING が値
                        1 => {
                            cells.insert((r, c), if res[2] != 0 { "TRUE" } else { "FALSE" }.to_string());
                        }
                        2 => {
                            cells.insert((r, c), "#ERR".to_string());
                        }
                        _ => {}
                    }
                } else {
                    let v = f64::from_le_bytes(res.try_into().ok()?);
                    cells.insert((r, c), fmt_f64(v));
                }
            }
            0x0207 => {
                // STRING (直前の FORMULA の文字列結果)
                if let Some((r, c)) = pending_formula.take() {
                    if let Some(s) = read_simple_string(d) {
                        cells.insert((r, c), clean(s));
                    }
                }
            }
            0x0205 => {
                // BOOLERR
                let (r, c) = (u16le(d, 0)? as u32, u16le(d, 2)? as u32);
                let v = *d.get(6)?;
                let is_err = *d.get(7)? != 0;
                let s = if is_err {
                    "#ERR".to_string()
                } else if v != 0 {
                    "TRUE".to_string()
                } else {
                    "FALSE".to_string()
                };
                cells.insert((r, c), s);
            }
            _ => {}
        }
        i += 1;
    }
    Some(cells)
}

fn cells_to_text(cells: &BTreeMap<(u32, u32), String>) -> String {
    if cells.is_empty() {
        return "(セルなし)".to_string();
    }
    let mut text = String::new();
    let mut cur_row: Option<u32> = None;
    let mut prev_col: Option<u32> = None;
    for (&(r, c), v) in cells {
        if cur_row.is_some() && cur_row != Some(r) {
            text.push('\n');
        }
        if cur_row != Some(r) {
            cur_row = Some(r);
            prev_col = None;
        }
        // タブ区切り: 空セル分もタブで埋めて列位置を保つ
        for _ in 0..(c - prev_col.unwrap_or(0)) {
            text.push('\t');
        }
        text.push_str(v);
        prev_col = Some(c);
    }
    text
}

// シート名の一覧だけを返す (セルは読まない = 安価。ツリーの遅延展開用)
pub fn list_sheet_names(bytes: &[u8]) -> Option<Vec<String>> {
    let wb = workbook_stream(bytes)?;
    let recs = enumerate_records(&wb)?;
    let g = parse_globals(&wb, &recs)?;
    if g.unsupported {
        return Some(vec!["(未対応)".to_string()]);
    }
    let names = sheet_display_names(&wb, &recs, &g.sheet_names);
    if names.is_empty() {
        None
    } else {
        Some(names)
    }
}

// 指定した1シートだけを展開してテキスト化する (選択時の遅延展開用)
pub fn decode_one(bytes: &[u8], target: &str) -> Option<String> {
    let wb = workbook_stream(bytes)?;
    let recs = enumerate_records(&wb)?;
    let g = parse_globals(&wb, &recs)?;
    if g.unsupported {
        return None;
    }
    let names = sheet_display_names(&wb, &recs, &g.sheet_names);
    let target_idx = names.iter().position(|n| n == target)?;
    let mut sheet_idx = 0usize;
    for (i, &(id, off, _)) in recs.iter().enumerate() {
        if id == 0x0809 && u16le(&wb, off + 2) == Some(0x0010) {
            if sheet_idx == target_idx {
                let cells = collect_sheet_cells(&wb, &recs, i, &g.sst)?;
                return Some(cells_to_text(&cells));
            }
            sheet_idx += 1;
        }
    }
    None
}

pub fn parse(bytes: &[u8]) -> Option<Vec<Entry>> {
    let wb = workbook_stream(bytes)?;
    let recs = enumerate_records(&wb)?;
    let g = parse_globals(&wb, &recs)?;
    if g.unsupported {
        return Some(vec![Entry {
            name: "(未対応)".to_string(),
            text: "(BIFF8 以外の旧形式 .xls のため未対応)".to_string(),
        }]);
    }

    let mut entries: Vec<Entry> = Vec::new();
    let mut sheet_idx = 0usize;
    for (i, &(id, off, _)) in recs.iter().enumerate() {
        if id == 0x0809 && u16le(&wb, off + 2) == Some(0x0010) {
            let cells = collect_sheet_cells(&wb, &recs, i, &g.sst)?;
            let name = g
                .sheet_names
                .get(sheet_idx)
                .cloned()
                .unwrap_or_else(|| format!("Sheet{}", sheet_idx + 1));
            sheet_idx += 1;
            entries.push(Entry { name, text: cells_to_text(&cells) });
        }
    }
    if entries.is_empty() {
        return None;
    }
    Some(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(id: u16, data: &[u8]) -> Vec<u8> {
        let mut v = id.to_le_bytes().to_vec();
        v.extend_from_slice(&(data.len() as u16).to_le_bytes());
        v.extend_from_slice(data);
        v
    }

    fn build_workbook_stream() -> Vec<u8> {
        let mut wb = Vec::new();
        // BOF (globals)
        let mut bof = 0x0600u16.to_le_bytes().to_vec();
        bof.extend_from_slice(&0x0005u16.to_le_bytes());
        bof.extend_from_slice(&[0u8; 12]);
        wb.extend(rec(0x0809, &bof));
        // BOUNDSHEET: name "テスト" (unicode)
        let mut bs = vec![0u8; 6]; // lbPlyPos + grbit
        bs.push(3); // cch
        bs.push(1); // unicode
        for u in "テスト".encode_utf16() {
            bs.extend_from_slice(&u.to_le_bytes());
        }
        wb.extend(rec(0x0085, &bs));
        // SST: "abc" (compressed) と "あい" (unicode)
        let mut sst = 2u32.to_le_bytes().to_vec();
        sst.extend_from_slice(&2u32.to_le_bytes());
        sst.extend_from_slice(&3u16.to_le_bytes());
        sst.push(0);
        sst.extend_from_slice(b"abc");
        sst.extend_from_slice(&2u16.to_le_bytes());
        sst.push(1);
        for u in "あい".encode_utf16() {
            sst.extend_from_slice(&u.to_le_bytes());
        }
        wb.extend(rec(0x00FC, &sst));
        wb.extend(rec(0x000A, &[]));
        // BOF (worksheet)
        let mut bof2 = 0x0600u16.to_le_bytes().to_vec();
        bof2.extend_from_slice(&0x0010u16.to_le_bytes());
        bof2.extend_from_slice(&[0u8; 12]);
        wb.extend(rec(0x0809, &bof2));
        // LABELSST r0c0="abc", r0c2="あい"
        let cell = |r: u16, c: u16, isst: u32| {
            let mut d = r.to_le_bytes().to_vec();
            d.extend_from_slice(&c.to_le_bytes());
            d.extend_from_slice(&0u16.to_le_bytes());
            d.extend_from_slice(&isst.to_le_bytes());
            d
        };
        wb.extend(rec(0x00FD, &cell(0, 0, 0)));
        wb.extend(rec(0x00FD, &cell(0, 2, 1)));
        // NUMBER r1c1=3.5
        let mut num = 1u16.to_le_bytes().to_vec();
        num.extend_from_slice(&1u16.to_le_bytes());
        num.extend_from_slice(&0u16.to_le_bytes());
        num.extend_from_slice(&3.5f64.to_le_bytes());
        wb.extend(rec(0x0203, &num));
        // RK r2c0=42
        let mut rk = 2u16.to_le_bytes().to_vec();
        rk.extend_from_slice(&0u16.to_le_bytes());
        rk.extend_from_slice(&0u16.to_le_bytes());
        rk.extend_from_slice(&(((42u32) << 2) | 1).to_le_bytes());
        wb.extend(rec(0x027E, &rk));
        wb.extend(rec(0x000A, &[]));
        wb
    }

    fn dir_entry(name: &str, typ: u8, start: u32, size: u32) -> Vec<u8> {
        let mut e = vec![0u8; 128];
        let units: Vec<u16> = name.encode_utf16().collect();
        for (i, u) in units.iter().enumerate() {
            e[i * 2..i * 2 + 2].copy_from_slice(&u.to_le_bytes());
        }
        e[64..66].copy_from_slice(&(((units.len() + 1) * 2) as u16).to_le_bytes());
        e[66] = typ;
        e[116..120].copy_from_slice(&start.to_le_bytes());
        e[120..124].copy_from_slice(&size.to_le_bytes());
        e
    }

    pub fn build_xls() -> Vec<u8> {
        let wb = build_workbook_stream();
        let wb_sectors = wb.len().div_ceil(512);
        // ヘッダ
        let mut h = vec![0u8; 512];
        h[..8].copy_from_slice(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
        h[24..26].copy_from_slice(&0x003Eu16.to_le_bytes()); // minor
        h[26..28].copy_from_slice(&0x0003u16.to_le_bytes()); // major
        h[28..30].copy_from_slice(&0xFFFEu16.to_le_bytes()); // byte order
        h[30..32].copy_from_slice(&9u16.to_le_bytes()); // 512B sector
        h[32..34].copy_from_slice(&6u16.to_le_bytes());
        h[44..48].copy_from_slice(&1u32.to_le_bytes()); // FAT sectors
        h[48..52].copy_from_slice(&1u32.to_le_bytes()); // first dir
        h[56..60].copy_from_slice(&0u32.to_le_bytes()); // mini cutoff 0 = 常に通常FAT
        h[60..64].copy_from_slice(&ENDOFCHAIN.to_le_bytes());
        h[68..72].copy_from_slice(&ENDOFCHAIN.to_le_bytes());
        for i in 0..109 {
            let v = if i == 0 { 0u32 } else { 0xFFFF_FFFF };
            h[76 + i * 4..80 + i * 4].copy_from_slice(&v.to_le_bytes());
        }
        // FAT (sector 0)
        let mut fat = vec![0xFFu8; 512];
        let set = |f: &mut [u8], i: usize, v: u32| {
            f[i * 4..i * 4 + 4].copy_from_slice(&v.to_le_bytes())
        };
        set(&mut fat, 0, 0xFFFF_FFFD); // FAT 自身
        set(&mut fat, 1, ENDOFCHAIN); // dir
        for s in 0..wb_sectors {
            let next = if s + 1 < wb_sectors { (2 + s + 1) as u32 } else { ENDOFCHAIN };
            set(&mut fat, 2 + s, next);
        }
        // dir (sector 1)
        let mut dir = Vec::new();
        dir.extend(dir_entry("Root Entry", 5, ENDOFCHAIN, 0));
        dir.extend(dir_entry("Workbook", 2, 2, wb.len() as u32));
        dir.resize(512, 0);
        // 連結
        let mut out = h;
        out.extend(fat);
        out.extend(dir);
        let mut wbp = wb.clone();
        wbp.resize(wb_sectors * 512, 0);
        out.extend(wbp);
        out
    }

    #[test]
    fn parse_synthetic_xls() {
        let xls = build_xls();
        let r = parse(&xls).expect("parse xls");
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].name, "テスト");
        assert_eq!(r[0].text, "abc\t\tあい\n\t3.5\n42");
    }

    #[test]
    fn non_cfb_returns_none() {
        assert!(parse(b"not an xls").is_none());
    }

    #[test]
    fn list_sheet_names_matches_parse_without_reading_cells() {
        let xls = build_xls();
        let names = list_sheet_names(&xls).expect("list_sheet_names xls");
        assert_eq!(names, vec!["テスト".to_string()]);
    }

    #[test]
    fn decode_one_returns_only_the_requested_sheet() {
        let xls = build_xls();
        assert_eq!(decode_one(&xls, "テスト").unwrap(), "abc\t\tあい\n\t3.5\n42");
        assert!(decode_one(&xls, "存在しない").is_none());
    }

    // 実アプリでの目視確認用に temp へ書き出す補助 (cargo test で生成)
    #[test]
    fn dump_sample_for_manual_check() {
        let p = std::env::temp_dir().join("mp_synth.xls");
        let _ = std::fs::write(p, build_xls());
    }
}

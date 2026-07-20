// 高レベル文書API: Tauri/GUI から叩く単一エントリポイント。
// 文書本体 (TextBuffer: Small=RAM / Huge=mmap+overlay) と Undo を所有し、
// 可視行取得・編集・検索・保存を提供する。全文は決して外へ渡さない。
//
// 列の単位: IPC境界では Unicode スカラー(char)index、内部では UTF-8 バイト col。
// 変換は to_byte / to_char が担う (グラフェムは非対応 = ネイティブ版と同じ割り切り)。
use crate::buffer::{Pos, TextBuffer};
use crate::fileio::{self, Encoding, Eol};
use crate::undo::{Edit, UndoEntry, UndoStack};
use crate::ziptext::Entry;
use serde::Serialize;
use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

pub struct Doc {
    buf: TextBuffer,
    undo: UndoStack,
    pub enc: Encoding,
    pub eol: Eol,
    pub path: Option<PathBuf>,
    entries: Option<Vec<Entry>>, // ZIP/.xls の展開エントリ (閲覧専用)
    folder_root: Option<PathBuf>, // フォルダ閲覧中のルート絶対パス (新規作成/リネーム/子一覧取得の起点)
    view_only: bool, // アーカイブ閲覧・フォルダ選択前は編集不可
    replace_progress: Option<ReplaceProgress>, // 全置換のチャンク間進行状態
    byte_len: u64, // ステータスバー表示用。開いた実体のバイト数
    archive_path: Option<PathBuf>, // フォルダ非経由で直接開いた zip/xlsx/xls 自身 (未展開)
    source_file: Option<File>, // 現在表示中の実ファイルを読み取り共有・書き込み拒否で保持
    recovery_temp: Option<RecoveryTemp>, // 保存差し替え失敗時に編集内容を保持する backing file
}

struct RecoveryTemp(PathBuf);

impl Drop for RecoveryTemp {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[derive(Serialize)]
pub struct FolderEntry {
    pub name: String,
    pub is_dir: bool,
}

#[derive(Serialize)]
pub struct DocInfo {
    pub kind: String, // "text" | "archive"
    pub line_count: usize,
    pub enc: String,
    pub eol: String,
    pub path: String,
    pub entries: Option<Vec<String>>, // archive(zip/xls) の閲覧専用エントリ名
    pub folder_entries: Option<Vec<FolderEntry>>, // フォルダ直下の子 (サブフォルダ含む、再帰しない)
    pub folder_root: Option<String>, // フォルダ閲覧中のルート絶対パス
    pub view_only: bool,
    pub byte_len: u64,
}

// char 単位の位置 (フロントと共有)
#[derive(Serialize, serde::Deserialize, Clone, Copy)]
pub struct PosC {
    pub line: usize,
    pub col: usize,
}

#[derive(Serialize)]
pub struct EditResult {
    pub caret: PosC,
    pub line_count: usize,
}

#[derive(Serialize)]
pub struct FindResult {
    pub start: PosC,
    pub end: PosC,
}

#[derive(Serialize)]
pub struct WorkspaceSearchResult {
    pub rel_path: String,
    pub line: usize,
    pub col: usize,
    pub preview: String,
}

// チャンク分割検索の再開カーソル。1回の呼び出しで budget 行だけ走査し、
// 続きがあればこれを次回呼び出しにそのまま渡す (巨大ファイルで全件不一致になっても
// Mutex を長時間握り続けないようにするため)。
#[derive(Serialize, serde::Deserialize, Clone, Copy)]
pub struct FindCursor {
    pub wrapped: bool,
    pub line: usize,
}

#[derive(Serialize)]
#[serde(tag = "kind")]
pub enum FindOutcome {
    Found { start: PosC, end: PosC },
    More { cursor: FindCursor },
    NotFound,
}

#[derive(Serialize)]
pub struct ReplaceChunkResult {
    pub done: bool,
    pub count: usize, // この置換セッションでの累計置換数
    pub caret: PosC,
    pub line_count: usize,
}

// 全置換の進行状態 (チャンク間で Doc に保持し、完了時に1つの UndoEntry へまとめる)
#[derive(Default)]
struct ReplaceProgress {
    edits: Vec<Edit>,
    pos: Pos,
    find_cursor: Option<FindCursor>,
    count: usize,
}

pub fn enc_to_str(e: Encoding) -> &'static str {
    match e {
        Encoding::Utf8 { bom: false } => "utf8",
        Encoding::Utf8 { bom: true } => "utf8bom",
        Encoding::ShiftJis => "sjis",
        Encoding::Utf16Le => "utf16le",
    }
}

pub fn str_to_enc(s: &str) -> Encoding {
    match s {
        "utf8bom" => Encoding::Utf8 { bom: true },
        "sjis" => Encoding::ShiftJis,
        "utf16le" => Encoding::Utf16Le,
        _ => Encoding::Utf8 { bom: false },
    }
}

pub fn eol_to_str(e: Eol) -> &'static str {
    match e {
        Eol::Crlf => "crlf",
        Eol::Lf => "lf",
    }
}

pub fn str_to_eol(s: &str) -> Eol {
    if s == "lf" {
        Eol::Lf
    } else {
        Eol::Crlf
    }
}

impl Doc {
    pub fn empty() -> Doc {
        Doc {
            buf: TextBuffer::new(),
            undo: UndoStack::new(),
            enc: Encoding::Utf8 { bom: false },
            eol: Eol::Crlf,
            path: None,
            entries: None,
            folder_root: None,
            view_only: false,
            replace_progress: None,
            byte_len: 0,
            archive_path: None,
            source_file: None,
            recovery_temp: None,
        }
    }

    // フォルダを開いてもこの時点では子ファイルを一切読まない (直下一覧すら取得しない)。
    // ツリーの展開ボタン (list_folder_entries) を押して初めてそのディレクトリの直下だけを
    // 見る。ファイルを選択する (select_entry) までメモビューには何も表示しない。
    // ZIP/.xls/単一ファイルは open_file へ委譲。
    pub fn open(path: &Path) -> io::Result<Doc> {
        if path.is_dir() {
            let mut d = Doc::empty();
            d.folder_root = Some(path.to_path_buf());
            d.view_only = true; // まだ何も選択されていないので編集不可
            return Ok(d);
        }
        Doc::open_file(path)
    }

    // 指定ディレクトリ (rel_dir が空文字ならルート) の直下だけを列挙する。
    // サブフォルダの中身は再帰しない (ツリーの展開ボタンで都度呼ばれる想定)。
    fn list_folder_children(root: &Path, rel_dir: &str) -> Option<Vec<FolderEntry>> {
        const MAX_ENTRIES: usize = 2000;
        let dir = if rel_dir.is_empty() {
            root.to_path_buf()
        } else {
            root.join(rel_dir.replace('/', &std::path::MAIN_SEPARATOR.to_string()))
        };
        let rd = std::fs::read_dir(&dir).ok()?;
        let mut items: Vec<FolderEntry> = rd
            .flatten()
            .filter_map(|e| {
                let is_dir = e.file_type().ok()?.is_dir();
                Some(FolderEntry { name: e.file_name().to_string_lossy().into_owned(), is_dir })
            })
            .collect();
        items.sort_by(|a, b| a.name.cmp(&b.name));
        items.truncate(MAX_ENTRIES);
        Some(items)
    }

    // ツリーの展開ボタン用の公開API。
    pub fn list_folder_entries(&self, rel_dir: &str) -> Option<Vec<FolderEntry>> {
        Self::list_folder_children(self.folder_root.as_ref()?, rel_dir)
    }

    pub fn workspace_root(&self) -> Option<PathBuf> {
        self.folder_root.clone()
    }

    // zip/xlsx/xls は拡張子で判定し、中身は読まないまま「未展開」状態で開く。
    // ツリーの展開ボタン (list_archive_entries) が押されて初めてエントリ名を、
    // エントリ選択 (select_entry) で初めてその1エントリの本文を読む。
    fn is_lazy_archive_ext(path: &Path) -> bool {
        matches!(
            path.extension().and_then(|e| e.to_str()).map(|s| s.to_ascii_lowercase()).as_deref(),
            Some("zip") | Some("xlsx") | Some("xls")
        )
    }

    fn open_file(path: &Path) -> io::Result<Doc> {
        if Self::is_lazy_archive_ext(path) {
            let source_file = fileio::open_exclusive(path)?;
            if fileio::is_archive_handle(&source_file) {
                let byte_len = source_file.metadata()?.len();
                return Ok(Doc {
                buf: TextBuffer::new(),
                undo: UndoStack::new(),
                enc: Encoding::Utf8 { bom: false },
                eol: Eol::Lf,
                path: None, // アーカイブは元ファイルを壊さないよう保存先を持たない
                entries: None,
                folder_root: None,
                view_only: true,
                replace_progress: None,
                byte_len,
                archive_path: Some(path.to_path_buf()),
                    source_file: Some(source_file),
                    recovery_temp: None,
                });
            }
        }

        let o = fileio::open_buffer(path)?;
        let view_only = o.entries.is_some();
        Ok(Doc {
            buf: o.buf,
            undo: UndoStack::new(),
            enc: o.enc,
            eol: o.eol,
            path: if view_only {
                None // アーカイブは元ファイルを壊さないよう保存先を持たない
            } else {
                Some(path.to_path_buf())
            },
            entries: o.entries,
            folder_root: None,
            view_only,
            replace_progress: None,
            byte_len: o.byte_len,
            archive_path: None,
            source_file: Some(o.source_file),
            recovery_temp: None,
        })
    }

    pub fn info(&self, path: String) -> DocInfo {
        DocInfo {
            // フォルダ閲覧中はどの子ファイル (アーカイブ内エントリ含む) を表示していても
            // "text" 扱い (folder_entries 側でツリーを組み立てる)。folder_root が無い場合のみ、
            // 直接開いたアーカイブ (またはその1エントリ表示中) を "archive" とする。
            kind: if self.folder_root.is_none() && (self.entries.is_some() || self.archive_path.is_some()) {
                "archive".into()
            } else {
                "text".into()
            },
            line_count: self.buf.line_count(),
            enc: enc_to_str(self.enc).into(),
            eol: eol_to_str(self.eol).into(),
            path,
            entries: self
                .entries
                .as_ref()
                .map(|v| v.iter().map(|e| e.name.clone()).collect()),
            // ルート直下だけを毎回安価に取り直す (再帰しない読み取り専用の read_dir 1回分)
            folder_entries: self
                .folder_root
                .as_ref()
                .and_then(|root| Self::list_folder_children(root, "")),
            folder_root: self
                .folder_root
                .as_ref()
                .map(|p| p.to_string_lossy().into_owned()),
            view_only: self.view_only,
            byte_len: self.byte_len,
        }
    }

    pub fn line_count(&self) -> usize {
        self.buf.line_count()
    }

    // 可視範囲の行テキスト (char列そのまま)。全文は渡さない。
    pub fn lines(&self, start: usize, count: usize) -> Vec<String> {
        let end = (start + count).min(self.buf.line_count());
        (start..end).map(|i| self.buf.line(i).into_owned()).collect()
    }

    pub fn line_char_len(&self, line: usize) -> usize {
        if line >= self.buf.line_count() {
            return 0;
        }
        self.buf.line(line).chars().count()
    }

    // サイドバーでの別エントリ選択。rel_path の形は3通り:
    // - フォルダの実ファイル ("sub/a.txt"): そのファイルとして開き直す (編集可)
    // - フォルダ内 zip/xlsx/xls の1エントリ ("sub/data.zip::Sheet1"): そのアーカイブだけを
    //   読んで該当エントリを展開する (フォルダ一覧はそのまま維持、閲覧専用)
    // - 直接開いた (フォルダ非経由) zip/xlsx/xls の1エントリ ("Sheet1"): エントリ名そのもの
    // - 従来の一括展開済みアーカイブ (上記以外の拡張子。docx 等): entries をエントリ名で検索
    pub fn select_entry(&mut self, rel_path: &str) -> Option<DocInfo> {
        if let Some(root) = self.folder_root.clone() {
            if let Some((archive_rel, entry_name)) = rel_path.split_once("::") {
                let archive_real = root.join(archive_rel.replace('/', &std::path::MAIN_SEPARATOR.to_string()));
                let source_file = fileio::open_exclusive(&archive_real).ok()?;
                let bytes = fileio::read_locked(&source_file).ok()?;
                let text = crate::ziptext::decode_one(&bytes, entry_name)
                    .or_else(|| crate::xlstext::decode_one(&bytes, entry_name))?;
                self.byte_len = text.len() as u64;
                self.buf = TextBuffer::from_text(&text);
                self.undo.clear();
                self.view_only = true;
                self.source_file = Some(source_file);
                self.recovery_temp = None;
                return Some(self.info(archive_real.to_string_lossy().into_owned()));
            }
            let path = root.join(rel_path.replace('/', &std::path::MAIN_SEPARATOR.to_string()));
            if self.path.as_deref() == Some(path.as_path()) {
                return Some(self.info(path.to_string_lossy().into_owned()));
            }
            let mut d = Doc::open_file(&path).ok()?;
            let path_str = path.to_string_lossy().into_owned();
            d.folder_root = Some(root);
            let info = d.info(path_str);
            *self = d;
            return Some(info);
        }
        if let Some(archive_path) = self.archive_path.clone() {
            let bytes = fileio::read_locked(self.source_file.as_ref()?).ok()?;
            let text = crate::ziptext::decode_one(&bytes, rel_path)
                .or_else(|| crate::xlstext::decode_one(&bytes, rel_path))?;
            self.byte_len = text.len() as u64;
            self.buf = TextBuffer::from_text(&text);
            self.undo.clear();
            self.view_only = true;
            return Some(self.info(archive_path.to_string_lossy().into_owned()));
        }
        let text = self.entries.as_ref()?.iter().find(|e| e.name == rel_path)?.text.clone();
        self.byte_len = text.len() as u64;
        self.buf = TextBuffer::from_text(&text);
        self.undo.clear();
        self.view_only = true;
        Some(self.info(String::new()))
    }

    // ツリーの展開ボタン用。zip/xlsx/xls の中身 (エントリ名一覧) だけを安価に取得する
    // (本文は展開しない)。rel_path が空文字なら「直接開いているアーカイブ自身」、
    // それ以外はフォルダ内の実ファイル (zip/xlsx/xls) の相対パス。
    pub fn list_archive_entries(&self, rel_path: &str) -> Option<Vec<String>> {
        let bytes = if rel_path.is_empty() {
            fileio::read_locked(self.source_file.as_ref()?).ok()?
        } else {
            let path = self.folder_root.as_ref()?.join(rel_path.replace('/', &std::path::MAIN_SEPARATOR.to_string()));
            std::fs::read(path).ok()?
        };
        crate::ziptext::list_names(&bytes).or_else(|| crate::xlstext::list_sheet_names(&bytes))
    }

    // フォルダ内に空の新規ファイルを作り、その場で開く (サイドバーの「新規メモ作成」)。
    // rel_dir はフォルダルートからの相対パス(サブフォルダ見出しを右クリックした場合)。
    pub fn create_note(&mut self, rel_dir: Option<&str>, name: &str) -> io::Result<DocInfo> {
        let root = self
            .folder_root
            .clone()
            .ok_or_else(|| io::Error::new(io::ErrorKind::Other, "フォルダを開いていません"))?;
        let dir = match rel_dir {
            Some(r) if !r.is_empty() => root.join(r.replace('/', &std::path::MAIN_SEPARATOR.to_string())),
            _ => root.clone(),
        };
        let path = dir.join(name);
        if path.exists() {
            return Err(io::Error::new(io::ErrorKind::AlreadyExists, "同名のファイルが既にあります"));
        }
        std::fs::write(&path, b"")?;
        let mut d = Doc::open_file(&path)?;
        d.folder_root = Some(root);
        let path_str = path.to_string_lossy().into_owned();
        let info = d.info(path_str);
        *self = d;
        Ok(info)
    }

    // サイドバー上のファイル/フォルダ見出しをリネームする。開いている文書自身または
    // その配下がリネーム対象なら、パス表記だけを追従させる (バッファは開き直さない)。
    pub fn rename_entry(&mut self, rel_path: &str, new_name: &str) -> io::Result<DocInfo> {
        let root = self
            .folder_root
            .clone()
            .ok_or_else(|| io::Error::new(io::ErrorKind::Other, "フォルダを開いていません"))?;
        let old_abs = root.join(rel_path.replace('/', &std::path::MAIN_SEPARATOR.to_string()));
        let parent = old_abs
            .parent()
            .ok_or_else(|| io::Error::new(io::ErrorKind::Other, "不正なパスです"))?;
        let new_abs = parent.join(new_name);
        std::fs::rename(&old_abs, &new_abs)?;
        if let Some(cur) = self.path.clone() {
            if let Ok(rest) = cur.strip_prefix(&old_abs) {
                self.path = Some(if rest.as_os_str().is_empty() { new_abs.clone() } else { new_abs.join(rest) });
            }
        }
        let path_str = self
            .path
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        Ok(self.info(path_str))
    }

    // 範囲[start,end)を削除して text を挿入する統一プリミティブ。
    // 挿入=start==end, 削除=text空, 置換=両方。位置は char 単位。
    pub fn edit(
        &mut self,
        start: PosC,
        end: PosC,
        caret_before: PosC,
        text: &str,
        coalesce: bool,
    ) -> EditResult {
        if self.view_only {
            return EditResult {
                caret: caret_before,
                line_count: self.buf.line_count(),
            };
        }
        let s = self.to_byte(start);
        let e = self.to_byte(end);
        let cb = self.to_byte(caret_before);
        let mut edits = Vec::new();
        let mut pos = s;
        if s < e {
            let removed = self.buf.delete(s, e);
            edits.push(Edit::Delete { start: s, text: removed });
            pos = s;
        }
        let after = if !text.is_empty() {
            let end2 = self.buf.insert(pos, text);
            edits.push(Edit::Insert { pos, text: text.to_string() });
            end2
        } else {
            pos
        };
        if !edits.is_empty() {
            // 連続1文字入力のみ coalesce (選択削除を伴わないとき)
            self.undo.push(
                UndoEntry { edits, caret_before: cb, caret_after: after },
                coalesce && s == e,
            );
        }
        EditResult {
            caret: self.to_char(after),
            line_count: self.buf.line_count(),
        }
    }

    pub fn undo(&mut self) -> Option<EditResult> {
        let (caret, _touched) = self.undo.undo(&mut self.buf)?;
        Some(EditResult {
            caret: self.to_char(caret),
            line_count: self.buf.line_count(),
        })
    }

    pub fn redo(&mut self) -> Option<EditResult> {
        let (caret, _touched) = self.undo.redo(&mut self.buf)?;
        Some(EditResult {
            caret: self.to_char(caret),
            line_count: self.buf.line_count(),
        })
    }

    // 後方検索(前へ)は単発フルスキャン。前方検索(次へ)はチャンク分割エンジンで
    // 1回で完了させた結果を返す (テスト/小ファイル向けの簡易 API)。
    pub fn find(
        &self,
        pat: &str,
        from: PosC,
        forward: bool,
        match_case: bool,
    ) -> Option<FindResult> {
        if pat.is_empty() {
            return None;
        }
        if forward {
            return match self.find_step(pat, from, match_case, None, usize::MAX) {
                FindOutcome::Found { start, end } => Some(FindResult { start, end }),
                _ => None,
            };
        }
        let start = self.to_byte(from);
        let (s, e) = find_backward(&self.buf, pat, start, match_case, true)?;
        Some(FindResult {
            start: self.to_char(s),
            end: self.to_char(e),
        })
    }

    // チャンク分割前方検索: 1回の呼び出しで最大 budget 行だけ走査する。
    // 続きがあれば FindOutcome::More{cursor} を返すので、呼び出し側 (フロント) は
    // Found/NotFound になるまでこれをループ呼び出しする。巨大ファイルで一致が
    // 見つからない/末尾付近にある場合でも、1呼び出しあたりの Mutex 保持時間を
    // 一定に抑えられるため、その間にスクロール/入力の IPC が割り込める。
    pub fn find_step(
        &self,
        pat: &str,
        from: PosC,
        match_case: bool,
        cursor: Option<FindCursor>,
        budget: usize,
    ) -> FindOutcome {
        if pat.is_empty() {
            return FindOutcome::NotFound;
        }
        let start = self.to_byte(from);
        let cur = cursor.unwrap_or(FindCursor { wrapped: false, line: start.line });
        match find_chunk(&self.buf, pat, start, match_case, cur, budget, true) {
            ChunkStep::Found(s, e) => FindOutcome::Found { start: self.to_char(s), end: self.to_char(e) },
            ChunkStep::More(c) => FindOutcome::More { cursor: c },
            ChunkStep::NotFound => FindOutcome::NotFound,
        }
    }

    // チャンク分割全置換: 1回の呼び出しで最大 budget 件だけ置換する (内部の一致探索
    // 自体もチャンク分割されるため、一致がまばら/皆無でも1呼び出しの走査量は一定)。
    // 完了時 (done=true) に初めて1つの UndoEntry としてコミットする。
    pub fn replace_all_chunk(
        &mut self,
        pat: &str,
        rep: &str,
        match_case: bool,
        budget: usize,
    ) -> ReplaceChunkResult {
        if self.view_only || pat.is_empty() {
            return ReplaceChunkResult {
                done: true,
                count: 0,
                caret: PosC { line: 0, col: 0 },
                line_count: self.buf.line_count(),
            };
        }
        const SCAN_BUDGET: usize = 20_000;
        let mut prog = self.replace_progress.take().unwrap_or_default();
        let mut replaced = 0;
        loop {
            if replaced >= budget.max(1) {
                let result = ReplaceChunkResult {
                    done: false,
                    count: prog.count,
                    caret: self.to_char(prog.pos),
                    line_count: self.buf.line_count(),
                };
                self.replace_progress = Some(prog);
                return result;
            }
            let cur = prog
                .find_cursor
                .unwrap_or(FindCursor { wrapped: false, line: prog.pos.line });
            match find_chunk(&self.buf, pat, prog.pos, match_case, cur, SCAN_BUDGET, false) {
                ChunkStep::Found(s, e) => {
                    prog.find_cursor = None;
                    let removed = self.buf.delete(s, e);
                    prog.edits.push(Edit::Delete { start: s, text: removed });
                    let end = self.buf.insert(s, rep);
                    prog.edits.push(Edit::Insert { pos: s, text: rep.to_string() });
                    prog.pos = end;
                    prog.count += 1;
                    replaced += 1;
                }
                ChunkStep::More(c) => {
                    prog.find_cursor = Some(c);
                    let result = ReplaceChunkResult {
                        done: false,
                        count: prog.count,
                        caret: self.to_char(prog.pos),
                        line_count: self.buf.line_count(),
                    };
                    self.replace_progress = Some(prog);
                    return result;
                }
                ChunkStep::NotFound => {
                    let caret = self.to_char(prog.pos);
                    let line_count = self.buf.line_count();
                    let count = prog.count;
                    if count > 0 {
                        self.undo.push(
                            UndoEntry {
                                edits: prog.edits,
                                caret_before: Pos::default(),
                                caret_after: prog.pos,
                            },
                            false,
                        );
                    }
                    self.replace_progress = None;
                    return ReplaceChunkResult { done: true, count, caret, line_count };
                }
            }
        }
    }

    // 進行中の全置換を打ち切り、ここまでの変更を1つの UndoEntry としてコミットする
    // (ユーザーがヒット数超過の確認ダイアログでキャンセルした場合など)。
    pub fn replace_all_cancel(&mut self) -> EditResult {
        if let Some(prog) = self.replace_progress.take() {
            let caret = self.to_char(prog.pos);
            if prog.count > 0 {
                self.undo.push(
                    UndoEntry {
                        edits: prog.edits,
                        caret_before: Pos::default(),
                        caret_after: prog.pos,
                    },
                    false,
                );
            }
            return EditResult { caret, line_count: self.buf.line_count() };
        }
        EditResult { caret: self.to_char(Pos::default()), line_count: self.buf.line_count() }
    }

    // 保存。tempへ全量書出し後、排他とmmapを短時間だけ解放して差し替え、即座に再取得する。
    pub fn save(&mut self, path: &Path, enc: Encoding, eol: Eol) -> io::Result<()> {
        let tmp = fileio::save_buffer(path, &self.buf, enc, eol)?;
        let same_target = self.path.as_deref() == Some(path);
        let old_recovery = self.recovery_temp.take();
        self.buf = TextBuffer::new();
        if same_target {
            self.source_file = None;
        }
        if let Err(rename_error) = std::fs::rename(&tmp, path) {
            // 差し替えに失敗しても、書き出し済みtempから編集中内容を復元する。
            let recovered = fileio::open_buffer(&tmp)?;
            self.buf = recovered.buf;
            if same_target {
                self.source_file = fileio::open_exclusive(path).ok();
            }
            drop(old_recovery);
            self.recovery_temp = Some(RecoveryTemp(tmp));
            return Err(rename_error);
        }
        self.source_file = None;
        let o = fileio::open_buffer(path)?;
        self.buf = o.buf;
        self.source_file = Some(o.source_file);
        drop(old_recovery);
        self.enc = enc;
        self.eol = eol;
        self.path = Some(path.to_path_buf());
        self.undo.break_coalescing();
        Ok(())
    }

    pub fn set_enc(&mut self, enc: Encoding) {
        self.enc = enc;
    }

    pub fn set_eol(&mut self, eol: Eol) {
        self.eol = eol;
    }

    // ---- char index <-> byte col 変換 ----
    fn to_byte(&self, p: PosC) -> Pos {
        let n = self.buf.line_count();
        if n == 0 {
            return Pos { line: 0, col: 0 };
        }
        let line = p.line.min(n - 1);
        let s = self.buf.line(line);
        let col = s
            .char_indices()
            .nth(p.col)
            .map(|(i, _)| i)
            .unwrap_or_else(|| s.len());
        Pos { line, col }
    }

    fn to_char(&self, p: Pos) -> PosC {
        if p.line >= self.buf.line_count() {
            return PosC { line: p.line, col: 0 };
        }
        let s = self.buf.line(p.line);
        let col = s[..p.col.min(s.len())].chars().count();
        PosC { line: p.line, col }
    }
}

// ---- 検索 ----
// 単一行に収まるパターンの1行内マッチ判定
fn line_match(buf: &TextBuffer, pat: &str, line: usize, col_from: usize, match_case: bool) -> Option<(Pos, Pos)> {
    find_in_line(&buf.line(line), pat, col_from, match_case)
        .map(|i| (Pos { line, col: i }, Pos { line, col: i + pat.len() }))
}

fn bytes_eq(a: &[u8], b: &[u8], case: bool) -> bool {
    a.len() == b.len()
        && if case {
            a == b
        } else {
            a.iter().zip(b).all(|(x, y)| x.to_ascii_lowercase() == y.to_ascii_lowercase())
        }
}

// 改行を含むパターンについて、行 l を開始行とする一致があるかどうか (位置フィルタなし)。
// segs[0] は行 l の末尾に一致する必要がある(\n の直前で終わるため)。
fn multiline_match_at(buf: &TextBuffer, segs: &[&str], l: usize, match_case: bool) -> Option<(Pos, Pos)> {
    let n = buf.line_count();
    let m = segs.len();
    if l + m > n {
        return None;
    }
    let first = buf.line(l);
    let s0 = segs[0];
    if first.len() < s0.len() {
        return None;
    }
    let col0 = first.len() - s0.len();
    if !first.is_char_boundary(col0) || !bytes_eq(&first.as_bytes()[col0..], s0.as_bytes(), match_case) {
        return None;
    }
    for k in 1..m - 1 {
        if !bytes_eq(buf.line(l + k).as_bytes(), segs[k].as_bytes(), match_case) {
            return None;
        }
    }
    let last = buf.line(l + m - 1);
    let sl = segs[m - 1];
    if last.len() < sl.len() || !bytes_eq(&last.as_bytes()[..sl.len()], sl.as_bytes(), match_case) {
        return None;
    }
    Some((Pos { line: l, col: col0 }, Pos { line: l + m - 1, col: sl.len() }))
}

// ---- 後方検索 (前へ / Shift+Enter): 対話的な利用頻度が低いため従来通り単発フルスキャン ----
fn find_backward(
    buf: &TextBuffer,
    pat: &str,
    start: Pos,
    match_case: bool,
    wrap_around: bool,
) -> Option<(Pos, Pos)> {
    if pat.contains('\n') {
        let segs: Vec<&str> = pat.split('\n').collect();
        return multiline_backward(buf, &segs, start, match_case, wrap_around);
    }
    let n = buf.line_count();
    let scan = |line: usize, limit: usize| -> Option<usize> {
        let text = buf.line(line);
        let mut last = None;
        let mut from = 0;
        while let Some(i) = find_in_line(&text, pat, from, match_case) {
            if i + pat.len() > limit {
                break;
            }
            last = Some(i);
            from = i + 1;
            while from < text.len() && !text.is_char_boundary(from) {
                from += 1;
            }
        }
        last
    };
    for line in (0..=start.line).rev() {
        let limit = if line == start.line { start.col } else { buf.line_len(line) };
        if let Some(i) = scan(line, limit) {
            return Some((Pos { line, col: i }, Pos { line, col: i + pat.len() }));
        }
    }
    if wrap_around {
        for line in (start.line..n).rev() {
            let limit = buf.line_len(line);
            if let Some(i) = scan(line, limit) {
                return Some((Pos { line, col: i }, Pos { line, col: i + pat.len() }));
            }
        }
    }
    None
}

fn multiline_backward(
    buf: &TextBuffer,
    segs: &[&str],
    start: Pos,
    match_case: bool,
    wrap_around: bool,
) -> Option<(Pos, Pos)> {
    let n = buf.line_count();
    for l in (0..=start.line).rev() {
        if let Some(r) = multiline_match_at(buf, segs, l, match_case) {
            if r.1.line < start.line || (r.1.line == start.line && r.1.col <= start.col) {
                return Some(r);
            }
        }
    }
    if wrap_around {
        for l in (0..n).rev() {
            if let Some(r) = multiline_match_at(buf, segs, l, match_case) {
                return Some(r);
            }
        }
    }
    None
}

// ---- 前方検索のチャンク分割エンジン (次へ / 全置換で共用) ----
// 1回で最大 budget 行だけ走査し、続きがあれば Continue(次回に渡すカーソル) を返す。
enum ChunkStep {
    Found(Pos, Pos),
    More(FindCursor),
    NotFound,
}

fn find_chunk(
    buf: &TextBuffer,
    pat: &str,
    start: Pos,
    match_case: bool,
    cur: FindCursor,
    budget: usize,
    wrap_around: bool,
) -> ChunkStep {
    let n = buf.line_count();
    if n == 0 {
        return ChunkStep::NotFound;
    }
    let multiline = pat.contains('\n');
    let segs: Vec<&str> = if multiline { pat.split('\n').collect() } else { Vec::new() };

    let hi = if !cur.wrapped { n } else { (start.line + 1).min(n) };
    if cur.line >= hi {
        return if !cur.wrapped && wrap_around {
            find_chunk(buf, pat, start, match_case, FindCursor { wrapped: true, line: 0 }, budget, wrap_around)
        } else {
            ChunkStep::NotFound
        };
    }
    let end_line = cur.line.saturating_add(budget.max(1)).min(hi);

    for line in cur.line..end_line {
        let hit = if multiline {
            multiline_match_at(buf, &segs, line, match_case)
        } else {
            let col_from = if !cur.wrapped && line == start.line { start.col } else { 0 };
            line_match(buf, pat, line, col_from, match_case)
        };
        let Some((s, e)) = hit else { continue };
        // 前方フェーズでは、カーソル位置より前で終わる一致(まだ primary で除外していないもの)は対象外
        if !cur.wrapped && multiline && !(s.line > start.line || s.col >= start.col) {
            continue;
        }
        return ChunkStep::Found(s, e);
    }

    if end_line < hi {
        return ChunkStep::More(FindCursor { wrapped: cur.wrapped, line: end_line });
    }
    if !cur.wrapped && wrap_around {
        find_chunk(buf, pat, start, match_case, FindCursor { wrapped: true, line: 0 }, budget, wrap_around)
    } else {
        ChunkStep::NotFound
    }
}

fn find_in_line(line: &str, pat: &str, from: usize, match_case: bool) -> Option<usize> {
    if from > line.len() {
        return None;
    }
    if match_case {
        return line[from..].find(pat).map(|i| from + i);
    }
    find_ascii_case_insensitive(line, pat, from)
}

// ASCII 大小文字を無視する検索は、末尾不一致時に次の候補へ大きく進める。
// 既存仕様どおり、非 ASCII 文字は大小文字変換しない。
fn find_ascii_case_insensitive(line: &str, pat: &str, from: usize) -> Option<usize> {
    let haystack = line.as_bytes();
    let needle = pat.as_bytes();
    if from > haystack.len()
        || needle.is_empty()
        || haystack.len().saturating_sub(from) < needle.len()
    {
        return None;
    }

    let mut shift = [needle.len(); 256];
    for (i, &byte) in needle[..needle.len() - 1].iter().enumerate() {
        shift[byte.to_ascii_lowercase() as usize] = needle.len() - 1 - i;
    }

    let mut pos = from;
    while pos <= haystack.len() - needle.len() {
        let mut j = needle.len();
        while j > 0
            && haystack[pos + j - 1].to_ascii_lowercase() == needle[j - 1].to_ascii_lowercase()
        {
            j -= 1;
        }
        if j == 0 {
            if line.is_char_boundary(pos) {
                return Some(pos);
            }
            pos += 1;
        } else {
            pos += shift[haystack[pos + needle.len() - 1].to_ascii_lowercase() as usize];
        }
    }
    None
}

pub fn search_workspace(root: &Path, pat: &str, match_case: bool) -> Vec<WorkspaceSearchResult> {
    const MAX_FILE_SIZE: u64 = 16 * 1024 * 1024;
    const MAX_FILES: usize = 20_000;
    const MAX_RESULTS: usize = 200;
    if pat.is_empty() {
        return Vec::new();
    }

    let mut files = Vec::new();
    collect_search_files(root, root, &mut files, MAX_FILES, MAX_FILE_SIZE);
    let files = Arc::new(files);
    let next = AtomicUsize::new(0);
    let results = Mutex::new(Vec::new());
    let workers = std::thread::available_parallelism().map_or(1, |n| n.get()).min(4);

    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                if results.lock().unwrap().len() >= MAX_RESULTS {
                    return;
                }
                let index = next.fetch_add(1, Ordering::Relaxed);
                let Some(path) = files.get(index) else { return };
                let rel_path = path
                    .strip_prefix(root)
                    .unwrap_or(path)
                    .to_string_lossy()
                    .replace('\\', "/");
                let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if find_in_line(file_name, pat, 0, match_case).is_some() {
                    let mut out = results.lock().unwrap();
                    if out.len() < MAX_RESULTS {
                        out.push((0, WorkspaceSearchResult {
                            rel_path: rel_path.clone(),
                            line: 0,
                            col: 0,
                            preview: format!("ファイル名: {file_name}"),
                        }));
                    }
                }
                let Ok(bytes) = std::fs::read(path) else { continue };
                if bytes.contains(&0) {
                    continue;
                }
                let text = decode_search_text(&bytes);
                for (line, text) in text.lines().enumerate() {
                    let Some(col) = find_in_line(text, pat, 0, match_case) else { continue };
                    let mut out = results.lock().unwrap();
                    if out.len() >= MAX_RESULTS {
                        return;
                    }
                    out.push((1, WorkspaceSearchResult {
                        rel_path: rel_path.clone(),
                        line,
                        col: text[..col].chars().count(),
                        preview: text.trim().chars().take(180).collect(),
                    }));
                }
            });
        }
    });

    let mut out = results.into_inner().unwrap();
    out.sort_by(|a, b| (a.0, &a.1.rel_path, a.1.line, a.1.col).cmp(&(b.0, &b.1.rel_path, b.1.line, b.1.col)));
    out.into_iter().map(|(_, result)| result).collect()
}

fn collect_search_files(dir: &Path, root: &Path, files: &mut Vec<PathBuf>, max_files: usize, max_file_size: u64) {
    if files.len() >= max_files {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if files.len() >= max_files {
            return;
        }
        let path = entry.path();
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            if path != root && matches!(entry.file_name().to_str(), Some(".git" | "node_modules" | "target")) {
                continue;
            }
            collect_search_files(&path, root, files, max_files, max_file_size);
        } else if kind.is_file() && entry.metadata().map_or(false, |m| m.len() <= max_file_size) {
            files.push(path);
        }
    }
}

fn decode_search_text(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return encoding_rs::UTF_16LE.decode(&bytes[2..]).0.into_owned();
    }
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(&bytes[3..]).into_owned();
    }
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_owned(),
        Err(_) => encoding_rs::SHIFT_JIS.decode(bytes).0.into_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(t: &str) -> Doc {
        Doc {
            buf: TextBuffer::from_text(t),
            undo: UndoStack::new(),
            enc: Encoding::Utf8 { bom: false },
            eol: Eol::Lf,
            path: None,
            entries: None,
            folder_root: None,
            view_only: false,
            replace_progress: None,
            byte_len: 0,
            archive_path: None,
            source_file: None,
            recovery_temp: None,
        }
    }
    fn p(line: usize, col: usize) -> PosC {
        PosC { line, col }
    }

    #[test]
    fn insert_ascii() {
        let mut d = doc("abc");
        let r = d.edit(p(0, 1), p(0, 1), p(0, 1), "XY", false);
        assert_eq!(d.lines(0, 1), vec!["aXYbc"]);
        assert_eq!((r.caret.line, r.caret.col), (0, 3));
        assert_eq!(r.line_count, 1);
    }

    #[test]
    fn insert_newline_splits_lines() {
        let mut d = doc("abc");
        let r = d.edit(p(0, 2), p(0, 2), p(0, 2), "\n", false);
        assert_eq!(d.line_count(), 2);
        assert_eq!(d.lines(0, 2), vec!["ab", "c"]);
        assert_eq!((r.caret.line, r.caret.col), (1, 0));
    }

    #[test]
    fn col_is_char_index_not_byte() {
        // 全角 "あいう" の char col 2 に挿入 → byte col 6 に変換される
        let mut d = doc("あいう");
        d.edit(p(0, 2), p(0, 2), p(0, 2), "X", false);
        assert_eq!(d.lines(0, 1), vec!["あいXう"]);
    }

    #[test]
    fn delete_range_then_undo_redo() {
        let mut d = doc("hello\nworld");
        let r = d.edit(p(0, 2), p(1, 3), p(1, 3), "", false);
        assert_eq!(d.lines(0, 10), vec!["held"]);
        assert_eq!(d.line_count(), 1);
        assert_eq!((r.caret.line, r.caret.col), (0, 2));
        let u = d.undo().unwrap();
        assert_eq!(d.lines(0, 10), vec!["hello", "world"]);
        assert_eq!((u.caret.line, u.caret.col), (1, 3));
        d.redo().unwrap();
        assert_eq!(d.lines(0, 10), vec!["held"]);
    }

    #[test]
    fn find_returns_char_positions() {
        let d = doc("あ foo\nbar foo");
        let r = d.find("foo", p(0, 0), true, true).unwrap();
        assert_eq!((r.start.line, r.start.col), (0, 2)); // "あ " = 2 chars
        assert_eq!((r.end.line, r.end.col), (0, 5));
        let r2 = d.find("foo", r.end, true, true).unwrap();
        assert_eq!(r2.start.line, 1);
    }

    #[test]
    fn case_insensitive_find_skips_non_matching_candidates() {
        let d = doc("xx NEEDLE xx needle");
        let r = d.find("NeEdLe", p(0, 0), true, false).unwrap();
        assert_eq!((r.start.line, r.start.col), (0, 3));
        let r2 = d.find("NeEdLe", r.end, true, false).unwrap();
        assert_eq!((r2.start.line, r2.start.col), (0, 13));
    }

    #[test]
    fn case_insensitive_find_preserves_utf8_character_positions() {
        let d = doc("あいう NEEDLE");
        let r = d.find("needle", p(0, 0), true, false).unwrap();
        assert_eq!((r.start.line, r.start.col), (0, 4));
    }

    #[test]
    fn workspace_search_is_recursive_and_returns_character_columns() {
        let root = std::env::temp_dir().join(format!("petapad_search_{}", std::process::id()));
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("top.txt"), "skip\nNeedle").unwrap();
        std::fs::write(root.join("sub").join("deep.txt"), "あ needle").unwrap();
        std::fs::write(root.join("needle-file.txt"), "other").unwrap();

        let results = search_workspace(&root, "NEEDLE", false);
        assert_eq!(results.len(), 3);
        assert_eq!((results[0].rel_path.as_str(), results[0].preview.as_str()), ("needle-file.txt", "ファイル名: needle-file.txt"));
        assert_eq!((results[1].rel_path.as_str(), results[1].line, results[1].col), ("sub/deep.txt", 0, 2));
        assert_eq!((results[2].rel_path.as_str(), results[2].line, results[2].col), ("top.txt", 1, 0));

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn consecutive_typing_coalesces_to_single_undo() {
        let mut d = doc("");
        d.edit(p(0, 0), p(0, 0), p(0, 0), "a", true);
        d.edit(p(0, 1), p(0, 1), p(0, 1), "b", true);
        d.edit(p(0, 2), p(0, 2), p(0, 2), "c", true);
        assert_eq!(d.lines(0, 1), vec!["abc"]);
        d.undo().unwrap();
        assert_eq!(d.lines(0, 1), vec![""]);
    }

    #[test]
    fn view_only_rejects_edit() {
        let mut d = doc("abc");
        d.view_only = true;
        d.edit(p(0, 0), p(0, 0), p(0, 0), "X", false);
        assert_eq!(d.lines(0, 1), vec!["abc"]);
    }

    #[test]
    fn save_reacquires_exclusive_lock() {
        let path = std::env::temp_dir().join(format!("petapad_save_lock_{}.txt", std::process::id()));
        std::fs::write(&path, "abc").unwrap();
        let mut d = Doc::open(&path).unwrap();
        d.edit(p(0, 3), p(0, 3), p(0, 3), "!", false);
        d.save(&path, Encoding::Utf8 { bom: false }, Eol::Lf).unwrap();
        assert_eq!(d.lines(0, 1), vec!["abc!"]);
        assert!(File::open(&path).is_ok(), "保存直後も読み取り共有を維持する");
        drop(d);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "abc!");
        std::fs::remove_file(path).unwrap();
    }

    // フォルダを開いた直後は何も選択されておらず (メモビューは空)、ルート直下の一覧だけが
    // 安価に取れる。ファイルを選択して初めて編集可能な通常文書として開く。
    #[test]
    fn open_folder_lists_root_children_lazily_and_selects_files() {
        let root = std::env::temp_dir().join(format!("petapad_doctest_{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.txt"), "hello").unwrap();
        std::fs::write(root.join("b.txt"), "world").unwrap();

        let mut d = Doc::open(&root).unwrap();
        assert!(File::open(root.join("a.txt")).is_ok(), "フォルダ一覧だけでは子ファイルをロックしない");
        assert!(d.view_only, "何も選択されていない間は編集不可");
        assert_eq!(d.lines(0, 1), vec![""], "フォルダを開いた直後は何も表示しない");

        let root_children = d.list_folder_entries("").unwrap();
        let names: Vec<&str> = root_children.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["a.txt", "b.txt"]);
        assert!(root_children.iter().all(|e| !e.is_dir));

        // ファイルを選択すると編集可能な実ファイルとして開く
        let info = d.select_entry("a.txt").unwrap();
        assert!(std::fs::OpenOptions::new().write(true).open(root.join("a.txt")).is_err(), "選択した実ファイルだけを書き込み禁止にする");
        assert!(!info.view_only, "フォルダの子ファイルは編集可能なはず");
        assert_eq!(d.lines(0, 1), vec!["hello"]);
        assert!(d.path.as_ref().unwrap().ends_with("a.txt"));

        // 編集して保存できる (実ファイルとして扱われている)
        let r = d.edit(p(0, 5), p(0, 5), p(0, 5), "!", false);
        assert_eq!(r.line_count, 1);
        assert_eq!(d.lines(0, 1), vec!["hello!"]);

        // 別エントリへ切り替えると実ファイルとして開き直る
        let info2 = d.select_entry("b.txt").unwrap();
        assert!(File::open(root.join("a.txt")).is_ok(), "選択解除したファイルはロックを解放する");
        assert!(std::fs::OpenOptions::new().write(true).open(root.join("b.txt")).is_err(), "新しく選択したファイルを書き込み禁止にする");
        assert_eq!(info2.kind, "text");
        assert!(!info2.view_only);
        assert!(info2.path.ends_with("b.txt"));
        assert_eq!(d.lines(0, 1), vec!["world"]);
        assert!(d.folder_root.is_some(), "フォルダルートは切替後も保持される");

        drop(d); // 選択中ファイルの排他を解放してからfixtureを削除
        std::fs::remove_dir_all(&root).unwrap();
    }

    // サブフォルダはツリーの展開ボタンを押すまでその中身 (さらに奥のファイル) を
    // 一切読まない。直下一覧は再帰しないので、深い階層があっても軽い。
    #[test]
    fn subfolder_children_are_listed_only_on_demand() {
        let root = std::env::temp_dir().join(format!("petapad_doctest_sub_{}", std::process::id()));
        let sub = root.join("sub1");
        let deep = sub.join("sub1a");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(root.join("top.txt"), "top").unwrap();
        std::fs::write(sub.join("inner.txt"), "inner").unwrap();
        std::fs::write(deep.join("deep.txt"), "deep").unwrap();

        let d = Doc::open(&root).unwrap();
        let root_children = d.list_folder_entries("").unwrap();
        let names: Vec<&str> = root_children.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["sub1", "top.txt"], "ルート直下だけを見る (奥の deep.txt などは含まれない)");
        assert!(root_children.iter().find(|e| e.name == "sub1").unwrap().is_dir);

        let sub1_children = d.list_folder_entries("sub1").unwrap();
        let sub1_names: Vec<&str> = sub1_children.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(sub1_names, vec!["inner.txt", "sub1a"]);

        let deep_children = d.list_folder_entries("sub1/sub1a").unwrap();
        let deep_names: Vec<&str> = deep_children.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(deep_names, vec!["deep.txt"]);

        std::fs::remove_dir_all(&root).unwrap();
    }

    // ziptext.rs のテストヘルパーと同一形式 (格納のみ) の最小 ZIP を組み立てる
    fn build_test_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut cd = Vec::new();
        for (name, data) in entries {
            let loff = out.len() as u32;
            let crc = 0u32;
            out.extend_from_slice(&0x0403_4B50u32.to_le_bytes());
            out.extend_from_slice(&[20, 0, 0, 0x08, 0, 0, 0, 0, 0, 0]);
            out.extend_from_slice(&crc.to_le_bytes());
            out.extend_from_slice(&(data.len() as u32).to_le_bytes());
            out.extend_from_slice(&(data.len() as u32).to_le_bytes());
            out.extend_from_slice(&(name.len() as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(name.as_bytes());
            out.extend_from_slice(data);
            cd.extend_from_slice(&0x0201_4B50u32.to_le_bytes());
            cd.extend_from_slice(&[20, 0, 20, 0, 0, 0x08, 0, 0, 0, 0, 0, 0]);
            cd.extend_from_slice(&crc.to_le_bytes());
            cd.extend_from_slice(&(data.len() as u32).to_le_bytes());
            cd.extend_from_slice(&(data.len() as u32).to_le_bytes());
            cd.extend_from_slice(&(name.len() as u16).to_le_bytes());
            cd.extend_from_slice(&[0u8; 12]);
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

    // .zip を直接開いた場合、展開ボタン (list_archive_entries) を押すまでは
    // 中身を一切読まない (空のまま) ことを確認する
    #[test]
    fn standalone_zip_open_is_lazy_until_entry_selected() {
        let root = std::env::temp_dir().join(format!("petapad_doctest_zip2_{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let zpath = root.join("notes.zip");
        std::fs::write(&zpath, build_test_zip(&[("memo.txt", b"secret text")])).unwrap();

        let mut d = Doc::open(&zpath).unwrap();
        assert!(std::fs::OpenOptions::new().write(true).open(&zpath).is_err(), "直接開いたアーカイブを書き込み禁止にする");
        assert!(d.view_only);
        assert_eq!(d.lines(0, 1), vec![""], "展開前は中身が空のはず");
        assert!(d.folder_root.is_none());

        let names = d.list_archive_entries("").unwrap();
        assert_eq!(names, vec!["memo.txt".to_string()]);

        let info = d.select_entry("memo.txt").unwrap();
        assert_eq!(info.kind, "archive");
        assert_eq!(d.lines(0, 1), vec!["secret text"]);

        drop(d);
        std::fs::remove_dir_all(&root).unwrap();
    }

    // フォルダ閲覧中に見つかった zip も同様に遅延展開する。エントリ選択後も
    // フォルダの一覧 (ツリー) はそのまま維持される。
    #[test]
    fn folder_browsing_lists_and_opens_nested_zip_entries_without_full_expand() {
        let root = std::env::temp_dir().join(format!("petapad_doctest_zip3_{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a_note.txt"), "hello").unwrap();
        std::fs::write(
            root.join("data.zip"),
            build_test_zip(&[("b/c.txt", b"x"), ("a.txt", b"ZIPCONTENT")]),
        )
        .unwrap();

        let mut d = Doc::open(&root).unwrap();
        assert_eq!(d.lines(0, 1), vec![""], "フォルダを開いた直後は何も選択されていない");
        assert!(d.view_only);

        let root_children = d.list_folder_entries("").unwrap();
        let names: Vec<&str> = root_children.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["a_note.txt", "data.zip"]);

        let names = d.list_archive_entries("data.zip").unwrap();
        assert_eq!(names, vec!["a.txt".to_string(), "b/c.txt".to_string()]);

        let info = d.select_entry("data.zip::a.txt").unwrap();
        // フォルダ閲覧中は kind は "text" のまま (folder_entries でツリーを組み立てるため)。
        // 実際に編集不可であることは view_only で示す。
        assert_eq!(info.kind, "text");
        assert!(info.view_only);
        assert_eq!(d.lines(0, 1), vec!["ZIPCONTENT"]);
        assert!(d.folder_root.is_some(), "フォルダルートは選択後も維持される");

        drop(d);
        std::fs::remove_dir_all(&root).unwrap();
    }

    // budget を小さくして一致が確実にチャンク境界をまたぐようにし、find_step の
    // チャンク分割がバッファ全体を正しく再開・走査できているか確認する。
    #[test]
    fn find_step_resumes_correctly_across_chunk_boundary() {
        let d = doc("a\nb\nneedle\nc\nd");
        let mut cursor = None;
        loop {
            match d.find_step("needle", p(0, 0), true, cursor, 2) {
                FindOutcome::Found { start, end } => {
                    assert_eq!((start.line, start.col), (2, 0));
                    assert_eq!((end.line, end.col), (2, 6));
                    return;
                }
                FindOutcome::More { cursor: c } => cursor = Some(c),
                FindOutcome::NotFound => panic!("見つかるはずの一致が見つからなかった"),
            }
        }
    }

    // 複数行パターンの開始行がちょうどチャンクの最終行になるようにし、
    // 継続行(次チャンク側になるはずの行)を含む一致も取りこぼさないか確認する。
    // multiline_match_at はチャンクの範囲に関わらずバッファ全体を直接読むため、
    // 理論上は問題ないはずだが、それを固定するための回帰テスト。
    #[test]
    fn find_step_finds_multiline_match_spanning_chunk_boundary() {
        let d = doc("a\nb\nneedle-start\nneedle-end\nc");
        let mut cursor = None;
        loop {
            match d.find_step("needle-start\nneedle-end", p(0, 0), true, cursor, 3) {
                FindOutcome::Found { start, end } => {
                    assert_eq!((start.line, start.col), (2, 0));
                    assert_eq!((end.line, end.col), (3, 10));
                    return;
                }
                FindOutcome::More { cursor: c } => cursor = Some(c),
                FindOutcome::NotFound => panic!("見つかるはずの一致が見つからなかった"),
            }
        }
    }
}

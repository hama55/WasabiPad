// 高レベル文書API: Tauri/GUI から叩く単一エントリポイント。
// 文書本体 (TextBuffer: Small=RAM / Huge=mmap+overlay) と Undo を所有し、
// 可視行取得・編集・検索・保存を提供する。全文は決して外へ渡さない。
//
// 列の単位: IPC境界では Unicode スカラー(char)index、内部では UTF-8 バイト col。
// 変換は to_byte / to_char が担う (グラフェムは非対応 = ネイティブ版と同じ割り切り)。
use crate::buffer::{Pos, TextBuffer};
use crate::fileio::{self, Encoding, EncodingId, Eol};
use crate::undo::{Edit, UndoEntry, UndoStack};
use crate::ziptext::Entry;
use serde::Serialize;
use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};

fn join_relative(root: &Path, relative: &str) -> PathBuf {
    root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR))
}

pub struct Doc {
    buf: TextBuffer,
    undo: UndoStack,
    enc: Encoding,
    eol: Eol,
    source: DocumentSource,
    replace_progress: Option<ReplaceProgress>, // 全置換のチャンク間進行状態
    byte_len: u64, // ステータスバー表示用。開いた実体のバイト数
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

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum DocKind {
    Text,
    Archive,
}

enum DocumentSource {
    Untitled { recovery_temp: Option<RecoveryTemp> },
    File {
        path: PathBuf,
        source_file: Option<File>,
        recovery_temp: Option<RecoveryTemp>,
    },
    Folder { root: PathBuf, selected: FolderSelection },
    Archive {
        path: PathBuf,
        source_file: File,
        entries: Option<Vec<Entry>>,
    },
}

enum FolderSelection {
    None,
    File {
        path: PathBuf,
        source_file: Option<File>,
        recovery_temp: Option<RecoveryTemp>,
    },
    Archive {
        path: PathBuf,
        source_file: File,
        entries: Option<Vec<Entry>>,
    },
}

impl DocumentSource {
    fn path(&self) -> Option<&Path> {
        match self {
            Self::File { path, .. } => Some(path),
            Self::Folder { selected: FolderSelection::File { path, .. }, .. } => Some(path),
            _ => None,
        }
    }

    fn folder_root(&self) -> Option<&Path> {
        match self {
            Self::Folder { root, .. } => Some(root),
            _ => None,
        }
    }

    fn entries(&self) -> Option<&[Entry]> {
        match self {
            Self::Archive { entries: Some(entries), .. }
            | Self::Folder { selected: FolderSelection::Archive { entries: Some(entries), .. }, .. } => {
                Some(entries)
            }
            _ => None,
        }
    }

    fn is_view_only(&self) -> bool {
        !matches!(
            self,
            Self::Untitled { .. }
                | Self::File { .. }
                | Self::Folder { selected: FolderSelection::File { .. }, .. }
        )
    }

    fn kind(&self) -> DocKind {
        if matches!(self, Self::Archive { .. }) {
            DocKind::Archive
        } else {
            DocKind::Text
        }
    }

    fn display_path(&self) -> Option<&Path> {
        match self {
            Self::File { path, .. } | Self::Archive { path, .. } => Some(path),
            Self::Folder { selected: FolderSelection::File { path, .. }, .. }
            | Self::Folder { selected: FolderSelection::Archive { path, .. }, .. } => Some(path),
            _ => None,
        }
    }

    fn take_recovery(&mut self) -> Option<RecoveryTemp> {
        match self {
            Self::Untitled { recovery_temp }
            | Self::File { recovery_temp, .. }
            | Self::Folder {
                selected: FolderSelection::File { recovery_temp, .. }, ..
            } => recovery_temp.take(),
            _ => None,
        }
    }

    fn set_recovery(&mut self, recovery: RecoveryTemp) {
        match self {
            Self::Untitled { recovery_temp }
            | Self::File { recovery_temp, .. }
            | Self::Folder {
                selected: FolderSelection::File { recovery_temp, .. }, ..
            } => *recovery_temp = Some(recovery),
            _ => {}
        }
    }

    fn set_source_file(&mut self, source: Option<File>) {
        match self {
            Self::File { source_file, .. }
            | Self::Folder { selected: FolderSelection::File { source_file, .. }, .. } => {
                *source_file = source
            }
            _ => {}
        }
    }
}

fn into_folder_selection(source: DocumentSource) -> Option<FolderSelection> {
    match source {
        DocumentSource::File { path, source_file, recovery_temp } => {
            Some(FolderSelection::File { path, source_file, recovery_temp })
        }
        DocumentSource::Archive { path, source_file, entries } => {
            Some(FolderSelection::Archive { path, source_file, entries })
        }
        _ => None,
    }
}

#[derive(Serialize)]
pub struct DocInfo {
    pub kind: DocKind,
    pub line_count: usize,
    pub enc: EncodingId,
    pub eol: Eol,
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

impl Doc {
    pub fn path(&self) -> Option<&Path> {
        self.source.path()
    }

    pub fn empty() -> Doc {
        Doc {
            buf: TextBuffer::new(),
            undo: UndoStack::new(),
            enc: Encoding::Utf8 { bom: false },
            eol: Eol::Crlf,
            source: DocumentSource::Untitled { recovery_temp: None },
            replace_progress: None,
            byte_len: 0,
        }
    }

    // フォルダを開いてもこの時点では子ファイルを一切読まない (直下一覧すら取得しない)。
    // ツリーの展開ボタン (list_folder_entries) を押して初めてそのディレクトリの直下だけを
    // 見る。ファイルを選択する (select_entry) までメモビューには何も表示しない。
    // ZIP/.xls/単一ファイルは open_file へ委譲。
    pub fn open(path: &Path) -> io::Result<Doc> {
        if path.is_dir() {
            let mut doc = Doc::empty();
            doc.source = DocumentSource::Folder {
                root: path.to_path_buf(),
                selected: FolderSelection::None,
            };
            return Ok(doc);
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
            join_relative(root, rel_dir)
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
        Self::list_folder_children(self.source.folder_root()?, rel_dir)
    }

    pub fn workspace_root(&self) -> Option<PathBuf> {
        self.source.folder_root().map(Path::to_path_buf)
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
                source: DocumentSource::Archive {
                    path: path.to_path_buf(),
                    source_file,
                    entries: None,
                },
                replace_progress: None,
                byte_len,
                });
            }
        }

        let o = fileio::open_buffer(path)?;
        let source = if let Some(entries) = o.entries {
            DocumentSource::Archive {
                path: path.to_path_buf(),
                source_file: o.source_file,
                entries: Some(entries),
            }
        } else {
            DocumentSource::File {
                path: path.to_path_buf(),
                source_file: Some(o.source_file),
                recovery_temp: None,
            }
        };
        Ok(Doc {
            buf: o.buf,
            undo: UndoStack::new(),
            enc: o.enc,
            eol: o.eol,
            source,
            replace_progress: None,
            byte_len: o.byte_len,
        })
    }

    pub fn info(&self, path: String) -> DocInfo {
        DocInfo {
            // フォルダ閲覧中はどの子ファイル (アーカイブ内エントリ含む) を表示していても
            // "text" 扱い (folder_entries 側でツリーを組み立てる)。folder_root が無い場合のみ、
            // 直接開いたアーカイブ (またはその1エントリ表示中) を "archive" とする。
            kind: self.source.kind(),
            line_count: self.buf.line_count(),
            enc: self.enc.into(),
            eol: self.eol,
            path,
            entries: self.source.entries().map(|v| v.iter().map(|e| e.name.clone()).collect()),
            // ルート直下だけを毎回安価に取り直す (再帰しない読み取り専用の read_dir 1回分)
            folder_entries: self
                .source
                .folder_root()
                .and_then(|root| Self::list_folder_children(root, "")),
            folder_root: self.source.folder_root().map(|p| p.to_string_lossy().into_owned()),
            view_only: self.source.is_view_only(),
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
        if let Some(root) = self.source.folder_root().map(Path::to_path_buf) {
            if let Some((archive_rel, entry_name)) = rel_path.split_once("::") {
                let archive_real = join_relative(&root, archive_rel);
                let source_file = fileio::open_exclusive(&archive_real).ok()?;
                let bytes = fileio::read_locked(&source_file).ok()?;
                let text = crate::archive::decode_one(&bytes, entry_name)?;
                self.byte_len = text.len() as u64;
                self.buf = TextBuffer::from_text(&text);
                self.undo.clear();
                self.source = DocumentSource::Folder {
                    root,
                    selected: FolderSelection::Archive {
                        path: archive_real.clone(),
                        source_file,
                        entries: None,
                    },
                };
                return Some(self.info(archive_real.to_string_lossy().into_owned()));
            }
            let path = join_relative(&root, rel_path);
            if self.source.path() == Some(path.as_path()) {
                return Some(self.info(path.to_string_lossy().into_owned()));
            }
            let mut d = Doc::open_file(&path).ok()?;
            let path_str = path.to_string_lossy().into_owned();
            let selected = into_folder_selection(d.source)?;
            d.source = DocumentSource::Folder { root, selected };
            let info = d.info(path_str);
            *self = d;
            return Some(info);
        }
        let (archive_path, text) = match &self.source {
            DocumentSource::Archive { path, source_file, entries } => {
                let text = if let Some(entries) = entries {
                    entries.iter().find(|entry| entry.name == rel_path)?.text.clone()
                } else {
                    let bytes = fileio::read_locked(source_file).ok()?;
                    crate::archive::decode_one(&bytes, rel_path)?
                };
                (path.to_string_lossy().into_owned(), text)
            }
            _ => return None,
        };
        self.byte_len = text.len() as u64;
        self.buf = TextBuffer::from_text(&text);
        self.undo.clear();
        Some(self.info(archive_path))
    }

    // ツリーの展開ボタン用。zip/xlsx/xls の中身 (エントリ名一覧) だけを安価に取得する
    // (本文は展開しない)。rel_path が空文字なら「直接開いているアーカイブ自身」、
    // それ以外はフォルダ内の実ファイル (zip/xlsx/xls) の相対パス。
    pub fn list_archive_entries(&self, rel_path: &str) -> Option<Vec<String>> {
        let bytes = if rel_path.is_empty() {
            let source_file = match &self.source {
                DocumentSource::Archive { source_file, .. }
                | DocumentSource::Folder {
                    selected: FolderSelection::Archive { source_file, .. }, ..
                } => source_file,
                _ => return None,
            };
            fileio::read_locked(source_file).ok()?
        } else {
            let path = join_relative(self.source.folder_root()?, rel_path);
            std::fs::read(path).ok()?
        };
        crate::archive::list(&bytes)
    }

    // フォルダ内に空の新規ファイルを作り、その場で開く (サイドバーの「新規メモ作成」)。
    // rel_dir はフォルダルートからの相対パス(サブフォルダ見出しを右クリックした場合)。
    pub fn create_note(&mut self, rel_dir: Option<&str>, name: &str) -> io::Result<DocInfo> {
        let root = self
            .source
            .folder_root()
            .map(Path::to_path_buf)
            .ok_or_else(|| io::Error::other("フォルダを開いていません"))?;
        let dir = match rel_dir {
            Some(r) if !r.is_empty() => join_relative(&root, r),
            _ => root.clone(),
        };
        let path = dir.join(name);
        if path.exists() {
            return Err(io::Error::new(io::ErrorKind::AlreadyExists, "同名のファイルが既にあります"));
        }
        std::fs::write(&path, b"")?;
        let mut d = Doc::open_file(&path)?;
        let selected = into_folder_selection(d.source)
            .ok_or_else(|| io::Error::other("作成した文書を開けません"))?;
        d.source = DocumentSource::Folder { root, selected };
        let path_str = path.to_string_lossy().into_owned();
        let info = d.info(path_str);
        *self = d;
        Ok(info)
    }

    // サイドバー上のファイル/フォルダ見出しをリネームする。開いている文書自身または
    // その配下がリネーム対象なら、パス表記だけを追従させる (バッファは開き直さない)。
    pub fn rename_entry(&mut self, rel_path: &str, new_name: &str) -> io::Result<DocInfo> {
        let root = self
            .source
            .folder_root()
            .map(Path::to_path_buf)
            .ok_or_else(|| io::Error::other("フォルダを開いていません"))?;
        let old_abs = join_relative(&root, rel_path);
        let parent = old_abs
            .parent()
            .ok_or_else(|| io::Error::other("不正なパスです"))?;
        let new_abs = parent.join(new_name);
        std::fs::rename(&old_abs, &new_abs)?;
        if let DocumentSource::Folder { selected, .. } = &mut self.source {
            let current = match selected {
                FolderSelection::File { path, .. } | FolderSelection::Archive { path, .. } => path,
                FolderSelection::None => return Ok(self.info(String::new())),
            };
            if let Ok(rest) = current.strip_prefix(&old_abs) {
                *current = if rest.as_os_str().is_empty() {
                    new_abs.clone()
                } else {
                    new_abs.join(rest)
                };
            }
        }
        let path_str = self.source.display_path()
            .map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
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
        if self.source.is_view_only() {
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
        if self.source.is_view_only() || pat.is_empty() {
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
        if self.source.is_view_only() {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, "閲覧専用文書は保存できません"));
        }
        let transaction = fileio::begin_save(path, &self.buf, enc, eol)?;
        let same_target = self.source.path() == Some(path);
        let workspace_root = self.source.folder_root().map(Path::to_path_buf);
        let old_recovery = self.source.take_recovery();
        self.buf = TextBuffer::new();
        if same_target {
            self.source.set_source_file(None);
        }
        if let Err(failure) = transaction.commit(path) {
            let (rename_error, tmp) = failure.into_parts();
            // 差し替えに失敗しても、書き出し済みtempから編集中内容を復元する。
            let recovered = fileio::open_buffer(&tmp)?;
            self.buf = recovered.buf;
            if same_target {
                self.source.set_source_file(fileio::open_exclusive(path).ok());
            }
            drop(old_recovery);
            self.source.set_recovery(RecoveryTemp(tmp));
            return Err(rename_error);
        }
        let o = fileio::open_buffer(path)?;
        self.buf = o.buf;
        drop(old_recovery);
        self.enc = enc;
        self.eol = eol;
        let selected = FolderSelection::File {
            path: path.to_path_buf(),
            source_file: Some(o.source_file),
            recovery_temp: None,
        };
        self.source = if let Some(root) = workspace_root {
            DocumentSource::Folder { root, selected }
        } else if let FolderSelection::File { path, source_file, recovery_temp } = selected {
            DocumentSource::File { path, source_file, recovery_temp }
        } else {
            unreachable!()
        };
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
            a.iter().zip(b).all(|(x, y)| x.eq_ignore_ascii_case(y))
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
    for (k, segment) in segs.iter().enumerate().take(m - 1).skip(1) {
        if !bytes_eq(buf.line(l + k).as_bytes(), segment.as_bytes(), match_case) {
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

pub(crate) fn find_in_line(line: &str, pat: &str, from: usize, match_case: bool) -> Option<usize> {
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
            && haystack[pos + j - 1].eq_ignore_ascii_case(&needle[j - 1])
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_search::search_workspace;

    fn doc(t: &str) -> Doc {
        Doc {
            buf: TextBuffer::from_text(t),
            undo: UndoStack::new(),
            enc: Encoding::Utf8 { bom: false },
            eol: Eol::Lf,
            source: DocumentSource::Untitled { recovery_temp: None },
            replace_progress: None,
            byte_len: 0,
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
    fn replace_all_completion_is_one_undo_entry() {
        let mut d = doc("foo a\nx\nfoo b\nfoo");
        let result = loop {
            let result = d.replace_all_chunk("foo", "bar", true, 1);
            if result.done {
                break result;
            }
        };

        assert_eq!(result.count, 3);
        assert_eq!(d.lines(0, 10), vec!["bar a", "x", "bar b", "bar"]);
        d.undo().unwrap();
        assert_eq!(d.lines(0, 10), vec!["foo a", "x", "foo b", "foo"]);
        assert!(d.undo().is_none());
        d.redo().unwrap();
        assert_eq!(d.lines(0, 10), vec!["bar a", "x", "bar b", "bar"]);
    }

    #[test]
    fn replace_all_cancel_commits_partial_work_as_one_undo_entry() {
        let mut d = doc("foo\nfoo\nfoo");
        let result = d.replace_all_chunk("foo", "bar", true, 1);
        assert!(!result.done);
        assert_eq!(result.count, 1);

        d.replace_all_cancel();
        assert_eq!(d.lines(0, 10), vec!["bar", "foo", "foo"]);
        d.undo().unwrap();
        assert_eq!(d.lines(0, 10), vec!["foo", "foo", "foo"]);
        assert!(d.undo().is_none());
        d.redo().unwrap();
        assert_eq!(d.lines(0, 10), vec!["bar", "foo", "foo"]);
    }

    #[test]
    fn view_only_rejects_edit() {
        let mut d = doc("abc");
        d.source = DocumentSource::Folder {
            root: PathBuf::new(),
            selected: FolderSelection::None,
        };
        d.edit(p(0, 0), p(0, 0), p(0, 0), "X", false);
        assert_eq!(d.lines(0, 1), vec!["abc"]);
    }

    #[test]
    fn document_source_derives_kind_and_editability() {
        let untitled = DocumentSource::Untitled { recovery_temp: None };
        assert!(!untitled.is_view_only());
        assert_eq!(untitled.kind(), DocKind::Text);

        let file = DocumentSource::File {
            path: PathBuf::from("memo.txt"),
            source_file: None,
            recovery_temp: None,
        };
        assert!(!file.is_view_only());
        assert_eq!(file.path(), Some(Path::new("memo.txt")));

        let folder = DocumentSource::Folder {
            root: PathBuf::from("workspace"),
            selected: FolderSelection::None,
        };
        assert!(folder.is_view_only());
        assert_eq!(folder.kind(), DocKind::Text);
        assert_eq!(folder.folder_root(), Some(Path::new("workspace")));
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
        assert!(d.source.is_view_only(), "何も選択されていない間は編集不可");
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
        assert!(d.path().unwrap().ends_with("a.txt"));

        // 編集して保存できる (実ファイルとして扱われている)
        let r = d.edit(p(0, 5), p(0, 5), p(0, 5), "!", false);
        assert_eq!(r.line_count, 1);
        assert_eq!(d.lines(0, 1), vec!["hello!"]);

        // 別エントリへ切り替えると実ファイルとして開き直る
        let info2 = d.select_entry("b.txt").unwrap();
        assert!(File::open(root.join("a.txt")).is_ok(), "選択解除したファイルはロックを解放する");
        assert!(std::fs::OpenOptions::new().write(true).open(root.join("b.txt")).is_err(), "新しく選択したファイルを書き込み禁止にする");
        assert_eq!(info2.kind, DocKind::Text);
        assert!(!info2.view_only);
        assert!(info2.path.ends_with("b.txt"));
        assert_eq!(d.lines(0, 1), vec!["world"]);
        assert!(d.workspace_root().is_some(), "フォルダルートは切替後も保持される");

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
        assert!(d.source.is_view_only());
        assert_eq!(d.lines(0, 1), vec![""], "展開前は中身が空のはず");
        assert!(d.workspace_root().is_none());

        let names = d.list_archive_entries("").unwrap();
        assert_eq!(names, vec!["memo.txt".to_string()]);

        let info = d.select_entry("memo.txt").unwrap();
        assert_eq!(info.kind, DocKind::Archive);
        assert_eq!(d.lines(0, 1), vec!["secret text"]);
        let save_target = root.join("must-not-save.txt");
        let error = d.save(&save_target, Encoding::Utf8 { bom: false }, Eol::Lf).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(d.lines(0, 1), vec!["secret text"]);
        assert!(!save_target.exists());

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
        assert!(d.source.is_view_only());

        let root_children = d.list_folder_entries("").unwrap();
        let names: Vec<&str> = root_children.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["a_note.txt", "data.zip"]);

        let names = d.list_archive_entries("data.zip").unwrap();
        assert_eq!(names, vec!["a.txt".to_string(), "b/c.txt".to_string()]);

        let info = d.select_entry("data.zip::a.txt").unwrap();
        // フォルダ閲覧中は kind は "text" のまま (folder_entries でツリーを組み立てるため)。
        // 実際に編集不可であることは view_only で示す。
        assert_eq!(info.kind, DocKind::Text);
        assert!(info.view_only);
        assert_eq!(d.lines(0, 1), vec!["ZIPCONTENT"]);
        assert!(d.workspace_root().is_some(), "フォルダルートは選択後も維持される");

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

// 高レベル文書API: Tauri/GUI から叩く単一エントリポイント。
// 文書本体 (TextBuffer: Small=RAM / Huge=mmap+overlay) と Undo を所有し、
// 可視行取得・編集・検索・保存を提供する。全文は決して外へ渡さない。
//
// 列の単位: IPC境界では Unicode スカラー(char)index、内部では UTF-8 バイト col。
// 変換は to_byte / to_char が担う (グラフェムは非対応 = ネイティブ版と同じ割り切り)。
use crate::archive_port::{self, ArchivePort};
use crate::buffer::{Pos, TextBuffer};
use crate::fileio::{self, Encoding, EncodingId, Eol, FileStamp};
use crate::filename::next_available_path;
use crate::folder::join_relative;
pub use crate::folder::FolderEntry;
use crate::search::{find_backward, find_chunk, ChunkStep};
use crate::undo::{Edit, UndoEntry, UndoStack};
use crate::ziptext::Entry;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

fn is_image_path(path: &Path) -> bool {
    match path.extension().and_then(|ext| ext.to_str()) {
        Some(ext) => matches!(
            ext.to_ascii_lowercase().as_str(),
            "apng" | "avif" | "bmp" | "gif" | "ico" | "jpeg" | "jpg" | "png" | "svg" | "webp"
        ),
        None => false,
    }
}

pub struct Doc {
    buf: TextBuffer,
    undo: UndoStack,
    enc: Encoding,
    eol: Eol,
    source: DocumentSource,
    replace_progress: Option<ReplaceProgress>, // 全置換のチャンク間進行状態
    byte_len: u64,                             // ステータスバー表示用。開いた実体のバイト数
    // 7z のパスワードをアーカイブ絶対パス単位でメモリ保持する (ディスクへは残さない)。
    // 同じフォルダ内の複数の 7z を行き来しても都度入力し直さずに済む。
    sevenz_passwords: HashMap<PathBuf, String>,
    archive_port: Arc<dyn ArchivePort>,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug, ts_rs::TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum DocKind {
    Text,
    Archive,
}

// 開いている実体。フォルダ閲覧中かどうか (root) とは直交する軸として持つ。
// 以前は Folder 変種が File/Archive の中身を丸ごと再掲していたため、
// 全アクセサが同じ形を2回ずつ match する必要があった。
enum Target {
    None,
    File {
        path: PathBuf,
        source_file: Option<File>,
        stamp: Option<FileStamp>, // ハンドル非保持 (=外部編集可) の場合の変更検知用
    },
    Archive {
        path: PathBuf,
        // 書庫更新直後の再openに失敗しても、パスと編集中の本文は保持する。
        source_file: Option<File>,
        entries: Option<Vec<Entry>>,
        // 7z.exe 経由で書き戻せる表示中エントリ名。7z/zip のテキストだけが対象。
        editable_entry: Option<String>,
    },
}

// root=Some ならフォルダ閲覧中。target はその中で選択中の実体 (未選択なら None)。
struct DocumentSource {
    root: Option<PathBuf>,
    target: Target,
}

impl DocumentSource {
    fn untitled() -> Self {
        Self {
            root: None,
            target: Target::None,
        }
    }

    fn file(path: PathBuf, source_file: Option<File>, stamp: Option<FileStamp>) -> Self {
        Self {
            root: None,
            target: Target::File {
                path,
                source_file,
                stamp,
            },
        }
    }

    // 通常ファイルとして編集して保存できるパス。アーカイブ内エントリは None。
    fn path(&self) -> Option<&Path> {
        match &self.target {
            Target::File { path, .. } => Some(path),
            _ => None,
        }
    }

    fn folder_root(&self) -> Option<&Path> {
        self.root.as_deref()
    }

    fn entries(&self) -> Option<&[Entry]> {
        match &self.target {
            Target::Archive {
                entries: Some(entries),
                ..
            } => Some(entries),
            _ => None,
        }
    }

    fn is_view_only(&self) -> bool {
        matches!(
            &self.target,
            Target::Archive {
                editable_entry: None,
                ..
            }
        ) || matches!(&self.target, Target::File { path, .. } if is_image_path(path))
    }

    // フォルダ閲覧中は kind を Text のままにする (ツリーは folder_entries が組み立てるため)。
    fn kind(&self) -> DocKind {
        if self.root.is_none() && matches!(self.target, Target::Archive { .. }) {
            DocKind::Archive
        } else {
            DocKind::Text
        }
    }

    fn display_path(&self) -> Option<&Path> {
        match &self.target {
            Target::File { path, .. } | Target::Archive { path, .. } => Some(path),
            Target::None => None,
        }
    }

    fn set_source_file(&mut self, source: Option<File>) {
        if let Target::File { source_file, .. } = &mut self.target {
            *source_file = source;
        }
    }

    fn take_source_file(&mut self) -> Option<File> {
        match &mut self.target {
            Target::File { source_file, .. } => source_file.take(),
            _ => None,
        }
    }

    fn stamp(&self) -> Option<FileStamp> {
        match &self.target {
            Target::File { stamp, .. } => *stamp,
            _ => None,
        }
    }

    fn set_stamp(&mut self, new: Option<FileStamp>) {
        if let Target::File { stamp, .. } = &mut self.target {
            *stamp = new;
        }
    }
}

#[derive(Serialize, ts_rs::TS)]
#[ts(export)]
pub struct DocInfo {
    pub kind: DocKind,
    pub line_count: usize,
    pub enc: EncodingId,
    pub eol: Eol,
    pub path: String,
    pub entries: Option<Vec<String>>, // 非編集アーカイブのエントリ名
    pub folder_entries: Option<Vec<FolderEntry>>, // フォルダ直下の子 (サブフォルダ含む、再帰しない)
    pub folder_root: Option<String>,  // フォルダ閲覧中のルート絶対パス
    pub view_only: bool,
    pub byte_len: u64,
    pub is_huge: bool,
}

// char 単位の位置 (フロントと共有)
#[derive(Serialize, serde::Deserialize, Clone, Copy, ts_rs::TS)]
#[ts(export, rename = "Pos")]
pub struct PosC {
    pub line: usize,
    pub col: usize,
}

#[derive(Serialize, ts_rs::TS)]
#[ts(export)]
pub struct EditResult {
    pub caret: PosC,
    pub line_count: usize,
}

#[derive(serde::Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct EditManyItem {
    pub start: PosC,
    pub end: PosC,
    pub text: String,
}

#[derive(Serialize, ts_rs::TS)]
#[ts(export)]
pub struct EditManyResult {
    pub carets: Vec<PosC>,
    pub line_count: usize,
}

#[derive(Serialize, ts_rs::TS)]
#[ts(export)]
pub struct FindResult {
    pub start: PosC,
    pub end: PosC,
}

// Clone は途中経過の送出用 (確定した結果を残したまま、送る分だけ複製する)
#[derive(Serialize, Clone, ts_rs::TS)]
#[ts(export)]
pub struct WorkspaceSearchResult {
    pub rel_path: String,
    pub line: usize,
    pub col: usize,
    pub preview: String,
    // preview 上の一致範囲 [開始char, 長さ]。正規表現でもファジーでも
    // フロントが検索し直せないため、当てた側が位置を持って渡す。
    pub highlights: Vec<[usize; 2]>,
    pub is_filename: bool,
    // ファジー一致の当てはまりの良さ (本文一致は 0)。並べ替えに要るので線に載せる。
    // 途中経過を確定結果と同じ順で出すには、フロント側も同じ鍵で並べる必要がある。
    pub score: i32,
}

// チャンク分割検索の再開カーソル。1回の呼び出しで budget 行だけ走査し、
// 続きがあればこれを次回呼び出しにそのまま渡す (巨大ファイルで全件不一致になっても
// Mutex を長時間握り続けないようにするため)。
#[derive(Serialize, serde::Deserialize, Clone, Copy, ts_rs::TS)]
#[ts(export)]
pub struct FindCursor {
    pub wrapped: bool,
    pub line: usize,
}

#[derive(Serialize, ts_rs::TS)]
#[serde(tag = "kind")]
#[ts(export)]
pub enum FindOutcome {
    Found { start: PosC, end: PosC },
    More { cursor: FindCursor },
    NotFound,
}

// 外部変更ポーリングの結果。Reloaded は未編集文書を自動で読み直した場合。
#[derive(Serialize, ts_rs::TS)]
#[serde(tag = "kind", rename_all = "lowercase")]
#[ts(export)]
pub enum ExternalCheck {
    Unchanged,
    Reloaded { info: DocInfo },
    Conflict,
}

// 保存の結果。Conflict は保存先が外部で変更されていたため本体を上書きせず、
// 編集内容を退避ファイルへ保存した場合。
#[derive(Serialize, Debug, ts_rs::TS)]
#[serde(tag = "kind", rename_all = "lowercase")]
#[ts(export)]
pub enum SaveOutcome {
    Saved,
    Conflict { saved_to: String },
}

#[derive(Serialize, ts_rs::TS)]
#[ts(export)]
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

    pub fn display_path(&self) -> Option<&Path> {
        self.source.display_path()
    }

    pub fn viewer_source(&self) -> Option<(PathBuf, String)> {
        match &self.source.target {
            Target::Archive {
                path,
                editable_entry: Some(entry),
                ..
            } => Some((path.clone(), entry.clone())),
            _ => None,
        }
    }

    pub fn read_archive_asset(&self, archive: &Path, entry: &str) -> io::Result<Vec<u8>> {
        let Target::Archive { path, .. } = &self.source.target else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "アーカイブを開いていません",
            ));
        };
        if path != archive || !self.archive_port.supports_path(archive) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "表示中のアーカイブと一致しません",
            ));
        }
        if !valid_archive_entry_path(entry) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "アーカイブ内パスが不正です",
            ));
        }
        let bytes = self
            .archive_port
            .extract(archive, entry, self.sevenz_password(archive))
            .map_err(|error| self.annotate_sevenz_error(archive, error))?;
        if bytes.len() > crate::ziptext::MAX_ENTRY {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "画像サイズが大きすぎます",
            ));
        }
        Ok(bytes)
    }

    pub fn empty() -> Doc {
        Self::empty_with_archive_port(archive_port::system())
    }

    fn empty_with_archive_port(archive_port: Arc<dyn ArchivePort>) -> Doc {
        Doc {
            buf: TextBuffer::new(),
            undo: UndoStack::new(),
            enc: Encoding::Utf8 { bom: false },
            eol: Eol::Crlf,
            source: DocumentSource::untitled(),
            replace_progress: None,
            byte_len: 0,
            sevenz_passwords: HashMap::new(),
            archive_port,
        }
    }

    // フォルダを開いてもこの時点では子ファイルを一切読まない (直下一覧すら取得しない)。
    // ツリーの展開ボタン (list_folder_entries) を押して初めてそのディレクトリの直下だけを
    // 見る。ファイルを選択する (select_entry) までメモビューには何も表示しない。
    // ZIP/.xls/単一ファイルは open_file へ委譲。
    pub fn open(path: &Path) -> io::Result<Doc> {
        let archive_port = archive_port::system();
        if path.is_dir() {
            let _ = archive_port.cleanup_stale_workspaces(path);
            let mut doc = Doc::empty_with_archive_port(archive_port);
            doc.source = DocumentSource {
                root: Some(path.to_path_buf()),
                ..DocumentSource::untitled()
            };
            return Ok(doc);
        }
        Doc::open_file(path, archive_port)
    }

    // 指定ディレクトリ (rel_dir が空文字ならルート) の直下だけを列挙する。
    // サブフォルダの中身は再帰しない (ツリーの展開ボタンで都度呼ばれる想定)。
    // ツリーの展開ボタン用の公開API。
    pub fn list_folder_entries(&self, rel_dir: &str) -> io::Result<Option<Vec<FolderEntry>>> {
        self.source
            .folder_root()
            .map(|root| crate::folder::list_children(root, rel_dir))
            .transpose()
    }

    pub fn workspace_root(&self) -> Option<PathBuf> {
        self.source.folder_root().map(Path::to_path_buf)
    }

    // zip/xlsx/xls は拡張子で判定し、中身は読まないまま「未展開」状態で開く。
    // ツリーの展開ボタン (list_archive_entries) が押されて初めてエントリ名を、
    // エントリ選択 (select_entry) で初めてその1エントリの本文を読む。
    fn open_file(path: &Path, archive_port: Arc<dyn ArchivePort>) -> io::Result<Doc> {
        if archive_port.supports_path(path) {
            if let Some(parent) = path.parent() {
                let _ = archive_port.cleanup_stale_workspaces(parent);
            }
        }
        if crate::folder::is_lazy_archive_path(path) {
            let source_file = fileio::open_exclusive(path)?;
            if fileio::is_archive_handle(&source_file) {
                let byte_len = source_file.metadata()?.len();
                return Ok(Doc {
                    buf: TextBuffer::new(),
                    undo: UndoStack::new(),
                    enc: Encoding::Utf8 { bom: false },
                    eol: Eol::Lf,
                    source: DocumentSource {
                        root: None,
                        target: Target::Archive {
                            path: path.to_path_buf(),
                            source_file: Some(source_file),
                            entries: None,
                            editable_entry: None,
                        },
                    },
                    replace_progress: None,
                    byte_len,
                    sevenz_passwords: HashMap::new(),
                    archive_port,
                });
            }
        }

        let o = fileio::open_buffer(path)?;
        let source = if let Some(entries) = o.entries {
            DocumentSource {
                root: None,
                target: Target::Archive {
                    path: path.to_path_buf(),
                    source_file: o.source_file,
                    entries: Some(entries),
                    editable_entry: None,
                },
            }
        } else {
            DocumentSource::file(path.to_path_buf(), o.source_file, o.stamp)
        };
        let buf = if is_image_path(path) {
            TextBuffer::from_text(&format!("(バイナリ: {} bytes)", o.byte_len))
        } else {
            o.buf
        };
        Ok(Doc {
            buf,
            undo: UndoStack::new(),
            enc: o.enc,
            eol: o.eol,
            source,
            replace_progress: None,
            byte_len: o.byte_len,
            sevenz_passwords: HashMap::new(),
            archive_port,
        })
    }

    pub fn reload_with_encoding(&mut self, enc: Encoding) -> io::Result<DocInfo> {
        let path = self.source.path().map(Path::to_path_buf).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::PermissionDenied,
                "この文書は文字コードを指定して再読込できません",
            )
        })?;
        let o = fileio::open_buffer_as(&path, enc)?;
        Ok(self.adopt_opened(path, o))
    }

    // ディスクから読み直した Opened で文書全体を差し替える (undo/検索状態は破棄)。
    fn adopt_opened(&mut self, path: PathBuf, o: fileio::Opened) -> DocInfo {
        let source = DocumentSource {
            root: self.source.folder_root().map(Path::to_path_buf),
            ..DocumentSource::file(path.clone(), o.source_file, o.stamp)
        };
        let buf = if is_image_path(&path) {
            TextBuffer::from_text(&format!("(バイナリ: {} bytes)", o.byte_len))
        } else {
            o.buf
        };
        let replacement = Doc {
            buf,
            undo: UndoStack::new(),
            enc: o.enc,
            eol: o.eol,
            source,
            replace_progress: None,
            byte_len: o.byte_len,
            sevenz_passwords: std::mem::take(&mut self.sevenz_passwords),
            archive_port: Arc::clone(&self.archive_port),
        };
        let info = replacement.info(path.to_string_lossy().into_owned());
        *self = replacement;
        info
    }

    // 外部変更ポーリング。ハンドル非保持 (=閾値未満の実ファイル) の文書のみ対象。
    // dirty (未保存の編集あり) なら自動再読込せず Conflict を返し、UI がバナーで確認する。
    pub fn poll_external(&mut self, dirty: bool) -> ExternalCheck {
        let Some(stored) = self.source.stamp() else {
            return ExternalCheck::Unchanged;
        };
        let Some(path) = self.source.path().map(Path::to_path_buf) else {
            return ExternalCheck::Unchanged;
        };
        match fileio::stamp(&path) {
            Ok(stamp) if stamp == stored => return ExternalCheck::Unchanged,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return ExternalCheck::Unchanged
            }
            _ => {}
        }
        if dirty {
            return ExternalCheck::Conflict;
        }
        match self.reload_from_disk() {
            Ok(info) => ExternalCheck::Reloaded { info },
            // 削除・置換中などで読めない場合もバナーで知らせる
            Err(_) => ExternalCheck::Conflict,
        }
    }

    // 編集中の内容を捨てて現在のディスク内容を読み直す (バナーの「再読込」)。
    pub fn reload_from_disk(&mut self) -> io::Result<DocInfo> {
        let path = self.source.path().map(Path::to_path_buf).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::PermissionDenied,
                "この文書は再読込できません",
            )
        })?;
        let o = fileio::open_buffer(&path)?;
        if o.entries.is_some() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "ファイルがアーカイブに置き換えられています",
            ));
        }
        Ok(self.adopt_opened(path, o))
    }

    // バナーの「無視」: 現在のディスク状態を新しい基準として記録し、以後の保存で上書きする。
    pub fn ack_external(&mut self) {
        if self.source.stamp().is_none() {
            return;
        }
        let Some(path) = self.source.path().map(Path::to_path_buf) else {
            return;
        };
        if let Ok(stamp) = fileio::stamp(&path) {
            self.source.set_stamp(Some(stamp));
        }
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
            entries: self
                .source
                .entries()
                .map(|v| v.iter().map(|e| e.name.clone()).collect()),
            // ルート直下だけを毎回安価に取り直す (再帰しない読み取り専用の read_dir 1回分)
            folder_entries: self
                .source
                .folder_root()
                .and_then(|root| crate::folder::list_children(root, "").ok()),
            folder_root: self
                .source
                .folder_root()
                .map(|p| p.to_string_lossy().into_owned()),
            view_only: self.source.is_view_only(),
            byte_len: self.byte_len,
            is_huge: self.buf.is_huge(),
        }
    }

    pub fn line_count(&self) -> usize {
        self.buf.line_count()
    }

    // 可視範囲の行テキスト (char列そのまま)。全文は渡さない。
    pub fn lines(&self, start: usize, count: usize) -> Vec<String> {
        let end = (start + count).min(self.buf.line_count());
        (start..end)
            .map(|i| self.buf.line(i).into_owned())
            .collect()
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
    //   読んで該当エントリを展開する (フォルダ一覧はそのまま維持)
    // - 直接開いた (フォルダ非経由) zip/xlsx/xls の1エントリ ("Sheet1"): エントリ名そのもの
    // - 従来の一括展開済みアーカイブ (上記以外の拡張子。docx 等): entries をエントリ名で検索
    pub fn select_entry(&mut self, rel_path: &str) -> io::Result<Option<DocInfo>> {
        if let Some(root) = self.source.folder_root().map(Path::to_path_buf) {
            if let Some((archive_rel, entry_name)) =
                rel_path.split_once(crate::folder::ARCHIVE_ENTRY_SEPARATOR)
            {
                let archive_real = join_relative(&root, archive_rel);
                let source_file = fileio::open_exclusive(&archive_real)?;
                let (text, meta) = if self.archive_port.supports_path(&archive_real) {
                    self.decode_archive_entry(&archive_real, entry_name)?
                } else {
                    let bytes = fileio::read_locked(&source_file)?;
                    let text = crate::archive::decode_one(&bytes, entry_name).ok_or_else(|| {
                        io::Error::new(
                            io::ErrorKind::InvalidData,
                            "アーカイブのエントリが見つかりません",
                        )
                    })?;
                    (text, None)
                };
                if let Some((enc, eol)) = meta {
                    self.enc = enc;
                    self.eol = eol;
                }
                self.byte_len = text.len() as u64;
                self.buf = TextBuffer::from_text(&text);
                self.undo.clear();
                self.source = DocumentSource {
                    root: Some(root),
                    target: Target::Archive {
                        path: archive_real.clone(),
                        source_file: Some(source_file),
                        entries: None,
                        editable_entry: meta.map(|_| entry_name.to_string()),
                    },
                };
                return Ok(Some(self.info(archive_real.to_string_lossy().into_owned())));
            }
            let path = join_relative(&root, rel_path);
            if self.source.path() == Some(path.as_path()) {
                return Ok(Some(self.info(path.to_string_lossy().into_owned())));
            }
            let mut d = Doc::open_file(&path, Arc::clone(&self.archive_port))?;
            let path_str = path.to_string_lossy().into_owned();
            d.source.root = Some(root);
            d.sevenz_passwords = std::mem::take(&mut self.sevenz_passwords);
            let info = d.info(path_str);
            *self = d;
            return Ok(Some(info));
        }
        let (archive_path, text, meta) = match &self.source.target {
            Target::Archive {
                path,
                source_file,
                entries,
                ..
            } => {
                if self.archive_port.supports_path(path) {
                    let path = path.clone();
                    let (text, meta) = self.decode_archive_entry(&path, rel_path)?;
                    (path.to_string_lossy().into_owned(), text, meta)
                } else {
                    let text = if let Some(entries) = entries {
                        match entries.iter().find(|entry| entry.name == rel_path) {
                            Some(entry) => entry.text.clone(),
                            None => return Ok(None),
                        }
                    } else {
                        let Some(source_file) = source_file else {
                            return Err(io::Error::new(
                                io::ErrorKind::WouldBlock,
                                "アーカイブを読み込めません。再度開いてください",
                            ));
                        };
                        let bytes = fileio::read_locked(source_file)?;
                        crate::archive::decode_one(&bytes, rel_path).ok_or_else(|| {
                            io::Error::new(
                                io::ErrorKind::InvalidData,
                                "アーカイブのエントリが見つかりません",
                            )
                        })?
                    };
                    (path.to_string_lossy().into_owned(), text, None)
                }
            }
            _ => return Ok(None),
        };
        if let Some((enc, eol)) = meta {
            self.enc = enc;
            self.eol = eol;
        }
        if let Target::Archive { editable_entry, .. } = &mut self.source.target {
            *editable_entry = meta.map(|_| rel_path.to_string());
        }
        self.byte_len = text.len() as u64;
        self.buf = TextBuffer::from_text(&text);
        self.undo.clear();
        Ok(Some(self.info(archive_path)))
    }

    // 7z/zip の1エントリを展開してテキスト化する。編集して書き戻せる (=テキストとして
    // 復元可能な) 場合のみ検出した enc/eol を返す。バイナリ等は説明文 + None (閲覧専用)。
    fn decode_archive_entry(
        &self,
        archive: &Path,
        entry: &str,
    ) -> io::Result<(String, Option<(Encoding, Eol)>)> {
        let bytes = match self
            .archive_port
            .extract(archive, entry, self.sevenz_password(archive))
        {
            Ok(bytes) => bytes,
            Err(error)
                if self.archive_port.supports_legacy_zip_fallback(archive)
                    && !self.archive_port.is_password_error(&error) =>
            {
                // テスト用の最小 ZIP や一部の古い ZIP は CRC 情報が厳密でないことがある。
                // 7z で読めない場合だけ既存の軽量パーサへ戻し、通常の ZIP 互換性を保つ。
                let raw = std::fs::read(archive)?;
                let text = crate::archive::decode_one(&raw, entry).ok_or(error)?;
                let editable = !text.starts_with("(バイナリ:")
                    && !text.starts_with("(暗号化エントリ)")
                    && !text.starts_with("(未対応の圧縮方式:")
                    && !text.starts_with("(サイズ超過のためスキップ:");
                return Ok((
                    text.clone(),
                    editable.then_some((Encoding::Utf8 { bom: false }, fileio::detect_eol(&text))),
                ));
            }
            Err(error) => return Err(self.annotate_sevenz_error(archive, error)),
        };
        if bytes.len() > crate::ziptext::MAX_ENTRY {
            return Ok((
                format!("(サイズ超過のためスキップ: {} bytes)", bytes.len()),
                None,
            ));
        }
        // UTF-16 (BOM付き) 以外で NUL を含むものはバイナリとみなし書き戻し対象から外す
        if !bytes.starts_with(&[0xFF, 0xFE]) && bytes.contains(&0) {
            return Ok((format!("(バイナリ: {} bytes)", bytes.len()), None));
        }
        let (text, enc) = fileio::decode(&bytes);
        let eol = fileio::detect_eol(&text);
        Ok((text, Some((enc, eol))))
    }

    fn sevenz_password(&self, archive: &Path) -> &str {
        self.sevenz_passwords
            .get(archive)
            .map(String::as_str)
            .unwrap_or("")
    }

    // パスワード起因の失敗に「未入力か誤りか」を付け ("7z-password:required" 等)、
    // UI がダイアログの文言を選べるようにする。
    fn annotate_sevenz_error(&self, archive: &Path, error: io::Error) -> io::Error {
        if error.kind() == io::ErrorKind::PermissionDenied
            && self.archive_port.is_password_error(&error)
        {
            let state = if self.sevenz_password(archive).is_empty() {
                "required"
            } else {
                "wrong"
            };
            return io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("{}:{state}", crate::archive_port::PASSWORD_ERROR_MARKER),
            );
        }
        error
    }

    // パスワード入力ダイアログの結果を保持する。rel_path はパスワードを要求した対象:
    // "" = 直接開いている書庫、それ以外 = フォルダルートからの相対パス。
    pub fn set_archive_password(&mut self, rel_path: &str, password: &str) -> io::Result<()> {
        let path = if rel_path.is_empty() {
            match &self.source.target {
                Target::Archive { path, .. } => path.clone(),
                _ => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "アーカイブを開いていません",
                    ))
                }
            }
        } else {
            let root = self.source.folder_root().ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, "フォルダを開いていません")
            })?;
            join_relative(root, rel_path)
        };
        self.sevenz_passwords.insert(path, password.to_string());
        Ok(())
    }

    // ツリーの展開ボタン用。zip/xlsx/xls の中身 (エントリ名一覧) だけを安価に取得する
    // (本文は展開しない)。rel_path が空文字なら「直接開いているアーカイブ自身」、
    // それ以外はフォルダ内の実ファイル (zip/xlsx/xls) の相対パス。
    pub fn list_archive_entries(&self, rel_path: &str) -> io::Result<Option<Vec<String>>> {
        // 7z/zip は自前パーサではなく 7z.exe に一覧させる (暗号化書庫に対応)
        let archive_abs = if rel_path.is_empty() {
            match &self.source.target {
                Target::Archive { path, .. } if self.archive_port.supports_path(path) => {
                    Some(path.clone())
                }
                _ => None,
            }
        } else {
            self.source
                .folder_root()
                .map(|root| join_relative(root, rel_path))
                .filter(|p| self.archive_port.supports_path(p))
        };
        if let Some(p) = archive_abs {
            return self
                .archive_port
                .list(&p, self.sevenz_password(&p))
                .map(Some)
                .map_err(|e| self.annotate_sevenz_error(&p, e));
        }
        let bytes = if rel_path.is_empty() {
            let Target::Archive { source_file, .. } = &self.source.target else {
                return Ok(None);
            };
            let Some(source_file) = source_file else {
                return Err(io::Error::new(
                    io::ErrorKind::WouldBlock,
                    "アーカイブを読み込めません。再度開いてください",
                ));
            };
            fileio::read_locked(source_file)?
        } else {
            let Some(root) = self.source.folder_root() else {
                return Ok(None);
            };
            std::fs::read(join_relative(root, rel_path))?
        };
        crate::archive::list(&bytes)
            .map(Some)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "アーカイブを読み取れません"))
    }

    // フォルダ内に空の新規ファイルを作り、その場で開く (サイドバーの「新規メモ作成」)。
    // rel_dir はフォルダルートからの相対パス(サブフォルダ見出しを右クリックした場合)。
    pub fn create_note(&mut self, rel_dir: Option<&str>, name: &str) -> io::Result<DocInfo> {
        crate::validate_windows_file_name(name)?;
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
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "同名のファイルが既にあります",
            ));
        }
        std::fs::write(&path, b"")?;
        let mut d = match Doc::open_file(&path, Arc::clone(&self.archive_port)) {
            Ok(doc) => doc,
            Err(error) => {
                let _ = std::fs::remove_file(&path);
                return Err(error);
            }
        };
        d.source.root = Some(root);
        let path_str = path.to_string_lossy().into_owned();
        let info = d.info(path_str);
        *self = d;
        Ok(info)
    }

    // サイドバー上のファイル/フォルダ見出しをリネームする。開いている文書自身または
    // その配下がリネーム対象なら、パス表記だけを追従させる (バッファは開き直さない)。
    pub fn rename_entry(&mut self, rel_path: &str, new_name: &str) -> io::Result<DocInfo> {
        crate::validate_windows_file_name(new_name)?;
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
        if self.source.folder_root().is_some() {
            let current = match &mut self.source.target {
                Target::File { path, .. } | Target::Archive { path, .. } => path,
                Target::None => return Ok(self.info(String::new())),
            };
            if let Ok(rest) = current.strip_prefix(&old_abs) {
                *current = if rest.as_os_str().is_empty() {
                    new_abs.clone()
                } else {
                    new_abs.join(rest)
                };
            }
        }
        let path_str = self
            .source
            .display_path()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        Ok(self.info(path_str))
    }

    // フォルダビューからの削除は、開いているフォルダの配下だけに限定する。
    // 巨大ファイルを選択中でも削除できるよう、削除対象なら保持中のハンドルを先に解放する。
    pub fn delete_entry(&mut self, rel_path: &str) -> io::Result<DocInfo> {
        if rel_path.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "フォルダ自体は削除できません",
            ));
        }
        let root = self
            .source
            .folder_root()
            .map(Path::to_path_buf)
            .ok_or_else(|| io::Error::other("フォルダを開いていません"))?;
        let target = join_relative(&root, rel_path);
        let metadata = std::fs::symlink_metadata(&target)?;
        if metadata.file_type().is_symlink() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "シンボリックリンクは削除できません",
            ));
        }
        let canonical_root = root.canonicalize()?;
        let canonical_target = target.canonicalize()?;
        if canonical_target == canonical_root || !canonical_target.starts_with(&canonical_root) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "フォルダの外は削除できません",
            ));
        }

        let current_path = self.source.display_path().map(Path::to_path_buf);
        let affected = current_path.as_ref().is_some_and(|path| {
            path.canonicalize().ok().is_some_and(|current| {
                current == canonical_target || current.starts_with(&canonical_target)
            })
        });
        let held_target = if affected {
            Some(std::mem::replace(&mut self.source.target, Target::None))
        } else {
            None
        };
        let delete_result = if metadata.is_dir() {
            std::fs::remove_dir_all(&target)
        } else {
            std::fs::remove_file(&target)
        };
        if let Err(error) = delete_result {
            if let Some(target) = held_target {
                self.source.target = target;
            }
            return Err(error);
        }

        if affected {
            drop(held_target);
            self.buf = TextBuffer::new();
            self.undo.clear();
            self.enc = Encoding::Utf8 { bom: false };
            self.eol = Eol::Crlf;
            self.replace_progress = None;
            self.byte_len = 0;
            self.source.target = Target::None;
            return Ok(self.info(root.to_string_lossy().into_owned()));
        }

        let path = self
            .source
            .display_path()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| root.to_string_lossy().into_owned());
        Ok(self.info(path))
    }

    // メモごとに画像を分けないと、同じフォルダ内のメモ同士で画像の持ち主が分からなくなる。
    pub fn save_pasted_image(&mut self, bytes: &[u8], mime_type: &str) -> io::Result<String> {
        if self.source.is_view_only() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "閲覧専用の文書には画像を貼り付けられません",
            ));
        }
        if bytes.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "画像データが空です",
            ));
        }
        let extension = image_extension(mime_type).ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "対応していない画像形式です")
        })?;
        if let Target::Archive {
            path,
            editable_entry: Some(entry),
            ..
        } = &self.source.target
        {
            if self.archive_port.supports_path(path) {
                let archive = path.clone();
                let memo_entry = entry.clone();
                return self.save_archive_image(&archive, &memo_entry, bytes, extension);
            }
        }
        let memo = self.source.path().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "先にメモを保存してください")
        })?;
        let parent = memo
            .parent()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "メモの保存先が不正です"))?;
        let memo_name = memo
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    "メモの画像フォルダ名を作れません",
                )
            })?;
        let image_dir = parent.join("image_markdown").join(memo_name);
        std::fs::create_dir_all(&image_dir)?;
        let path = next_available_path(&image_dir, "pasted-image", extension)?;
        std::fs::write(&path, bytes)?;
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "画像ファイル名を作れません")
            })?;
        Ok(format!("image_markdown/{memo_name}/{name}"))
    }

    fn save_archive_image(
        &mut self,
        archive: &Path,
        memo_entry: &str,
        bytes: &[u8],
        extension: &str,
    ) -> io::Result<String> {
        let password = self.sevenz_password(archive).to_string();
        let existing = self
            .archive_port
            .list(archive, &password)
            .map_err(|error| self.annotate_sevenz_error(archive, error))?;
        let memo_name = archive_entry_stem(memo_entry).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "メモの画像フォルダ名を作れません",
            )
        })?;
        let parent = archive_entry_parent(memo_entry);
        let relative_dir = archive_join(parent, &format!("image_markdown/{memo_name}"));
        let image_name = next_archive_image_name(&existing, &relative_dir, extension)?;
        let relative_src = format!("image_markdown/{memo_name}/{image_name}");
        let entry = archive_join(parent, &relative_src);
        let workspace = self.archive_port.new_workspace(archive)?;
        let staged = workspace
            .path()
            .join(entry.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = staged.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&staged, bytes)?;
        let header_encrypted = self
            .archive_port
            .preserves_header_encryption(archive, &password)?;
        let archive_port = Arc::clone(&self.archive_port);
        self.run_archive_command(archive, move || {
            archive_port.update(
                archive,
                &entry,
                workspace.path(),
                &password,
                header_encrypted,
            )
        })?;
        Ok(relative_src)
    }

    // 本文から参照が消えた画像を削除する。旧 image フォルダも既存メモのために整理する。
    pub fn cleanup_unused_images(&mut self) -> io::Result<()> {
        if self.source.is_view_only() {
            return Ok(());
        }
        if let Target::Archive {
            path,
            editable_entry: Some(entry),
            ..
        } = &self.source.target
        {
            if self.archive_port.supports_path(path) {
                let archive = path.clone();
                let memo_entry = entry.clone();
                return self.cleanup_archive_images(&archive, &memo_entry);
            }
        }
        let Some(memo) = self.source.path() else {
            return Ok(());
        };
        let Some(parent) = memo.parent() else {
            return Ok(());
        };
        let memo_name = memo
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty());
        let referenced = referenced_image_files(&self.buf);
        if let Some(memo_name) = memo_name {
            let image_root = parent.join("image_markdown");
            let image_dir = image_root.join(memo_name);
            cleanup_image_dir(
                &image_dir,
                &format!("image_markdown/{}", memo_name.to_lowercase()),
                &referenced,
            )?;
            remove_empty_dir(&image_root)?;
        }
        let legacy_dir = parent.join("image");
        cleanup_image_dir(&legacy_dir, "image", &referenced)?;
        Ok(())
    }

    fn cleanup_archive_images(&mut self, archive: &Path, memo_entry: &str) -> io::Result<()> {
        let password = self.sevenz_password(archive).to_string();
        let entries = self
            .archive_port
            .list(archive, &password)
            .map_err(|error| self.annotate_sevenz_error(archive, error))?;
        let memo_name = archive_entry_stem(memo_entry).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "メモの画像フォルダ名を作れません",
            )
        })?;
        let parent = archive_entry_parent(memo_entry);
        let relative_prefix = archive_join(parent, &format!("image_markdown/{memo_name}"));
        let referenced = referenced_image_files(&self.buf);
        let stale: Vec<String> = entries
            .into_iter()
            .filter(|entry| {
                let normalized = entry.replace('\\', "/").to_lowercase();
                let Some(name) = normalized.strip_prefix(&(relative_prefix.to_lowercase() + "/"))
                else {
                    return false;
                };
                !name.contains('/')
                    && !referenced.contains(&format!(
                        "image_markdown/{}/{name}",
                        memo_name.to_lowercase()
                    ))
            })
            .collect();
        if stale.is_empty() {
            return Ok(());
        }
        let archive_port = Arc::clone(&self.archive_port);
        self.run_archive_command(archive, move || {
            archive_port.delete(archive, &stale, &password)
        })
    }

    fn run_archive_command<F>(&mut self, archive: &Path, operation: F) -> io::Result<()>
    where
        F: FnOnce() -> io::Result<()>,
    {
        let target = std::mem::replace(&mut self.source.target, Target::None);
        let (path, source_file, entries, editable_entry) = match target {
            Target::Archive {
                path,
                source_file,
                entries,
                editable_entry,
            } => (path, source_file, entries, editable_entry),
            other => {
                self.source.target = other;
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "アーカイブ更新対象がありません",
                ));
            }
        };
        if path != archive {
            self.source.target = Target::Archive {
                path,
                source_file,
                entries,
                editable_entry,
            };
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "更新対象のアーカイブが変わっています",
            ));
        }
        drop(source_file);
        let command_result =
            operation().map_err(|error| self.annotate_sevenz_error(archive, error));
        let reopened = fileio::open_exclusive(&path);
        match reopened {
            Ok(source_file) => {
                self.source.target = Target::Archive {
                    path,
                    source_file: Some(source_file),
                    entries,
                    editable_entry,
                };
                command_result
            }
            Err(reopen_error) => {
                self.source.target = Target::Archive {
                    path,
                    source_file: None,
                    entries,
                    editable_entry,
                };
                if command_result.is_err() {
                    command_result
                } else {
                    Err(reopen_error)
                }
            }
        }
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
    ) -> Option<EditResult> {
        // 閲覧専用文書は「編集できた」と嘘をつかず None を返す (呼び出し側でエラーにする)
        if self.source.is_view_only() {
            return None;
        }
        let s = self.to_byte(start);
        let e = self.to_byte(end);
        let cb = self.to_byte(caret_before);
        let mut edits = Vec::new();
        let mut pos = s;
        if s < e {
            let removed = self.buf.delete(s, e);
            edits.push(Edit::Delete {
                start: s,
                text: removed,
            });
            pos = s;
        }
        let after = if !text.is_empty() {
            let end2 = self.buf.insert(pos, text);
            edits.push(Edit::Insert {
                pos,
                text: text.to_string(),
            });
            end2
        } else {
            pos
        };
        if !edits.is_empty() {
            // 連続1文字入力のみ coalesce (選択削除を伴わないとき)
            self.undo.push(
                UndoEntry {
                    edits,
                    caret_before: cb,
                    caret_after: after,
                },
                coalesce && s == e,
            );
        }
        Some(EditResult {
            caret: self.to_char(after),
            line_count: self.buf.line_count(),
        })
    }

    pub fn edit_many(
        &mut self,
        items: Vec<EditManyItem>,
        caret_before: PosC,
        primary_index: usize,
    ) -> Option<EditManyResult> {
        if self.source.is_view_only() {
            return None;
        }
        if items.is_empty() {
            return Some(EditManyResult {
                carets: Vec::new(),
                line_count: self.buf.line_count(),
            });
        }
        let cb = self.to_byte(caret_before);
        let mut indexed: Vec<_> = items.into_iter().enumerate().collect();
        indexed.sort_by(|(_, a), (_, b)| {
            b.start
                .line
                .cmp(&a.start.line)
                .then_with(|| b.start.col.cmp(&a.start.col))
        });
        let mut edits = Vec::new();
        let mut carets: Vec<Option<Pos>> = vec![None; indexed.len()];
        for (index, item) in indexed {
            let start = self.to_byte(item.start);
            let end = self.to_byte(item.end);
            if start < end {
                let removed = self.buf.delete(start, end);
                edits.push(Edit::Delete {
                    start,
                    text: removed,
                });
            }
            let after = if item.text.is_empty() {
                start
            } else {
                let after = self.buf.insert(start, &item.text);
                edits.push(Edit::Insert {
                    pos: start,
                    text: item.text,
                });
                after
            };
            for caret in carets.iter_mut().flatten() {
                if caret.line > end.line {
                    caret.line = after.line + (caret.line - end.line);
                } else if caret.line == end.line && *caret >= end {
                    caret.line = after.line;
                    caret.col = after.col + (caret.col - end.col);
                }
            }
            carets[index] = Some(after);
        }
        let carets: Vec<Pos> = carets
            .into_iter()
            .map(|caret| caret.unwrap_or(cb))
            .collect();
        if !edits.is_empty() {
            let caret_after = carets.get(primary_index).copied().unwrap_or(cb);
            self.undo.push(
                UndoEntry {
                    edits,
                    caret_before: cb,
                    caret_after,
                },
                false,
            );
        }
        Some(EditManyResult {
            carets: carets
                .into_iter()
                .map(|caret| self.to_char(caret))
                .collect(),
            line_count: self.buf.line_count(),
        })
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
        let cur = cursor.unwrap_or(FindCursor {
            wrapped: false,
            line: start.line,
        });
        match find_chunk(&self.buf, pat, start, match_case, cur, budget, true) {
            ChunkStep::Found(s, e) => FindOutcome::Found {
                start: self.to_char(s),
                end: self.to_char(e),
            },
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
            let cur = prog.find_cursor.unwrap_or(FindCursor {
                wrapped: false,
                line: prog.pos.line,
            });
            match find_chunk(
                &self.buf,
                pat,
                prog.pos,
                match_case,
                cur,
                SCAN_BUDGET,
                false,
            ) {
                ChunkStep::Found(s, e) => {
                    prog.find_cursor = None;
                    let removed = self.buf.delete(s, e);
                    prog.edits.push(Edit::Delete {
                        start: s,
                        text: removed,
                    });
                    let end = self.buf.insert(s, rep);
                    prog.edits.push(Edit::Insert {
                        pos: s,
                        text: rep.to_string(),
                    });
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
                    return ReplaceChunkResult {
                        done: true,
                        count,
                        caret,
                        line_count,
                    };
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
            return EditResult {
                caret,
                line_count: self.buf.line_count(),
            };
        }
        EditResult {
            caret: self.to_char(Pos::default()),
            line_count: self.buf.line_count(),
        }
    }

    // 保存。tempへ全量書出し後、排他とmmapを短時間だけ解放して差し替え、即座に再取得する。
    // 保存先が外部で変更されていた場合は本体を上書きせず、退避ファイルへ保存して知らせる。
    pub fn save(&mut self, path: &Path, enc: Encoding, eol: Eol) -> io::Result<SaveOutcome> {
        // 7z のエントリ表示中に書庫自身のパスへ保存 = エントリの書き戻し。
        // 別パスへの保存 (名前を付けて保存) は通常ファイルとして下へ流す。
        if let Target::Archive {
            path: archive_path,
            editable_entry: Some(entry),
            ..
        } = &self.source.target
        {
            if archive_path == path {
                let (archive_path, entry) = (archive_path.clone(), entry.clone());
                return self.save_archive_entry(&archive_path, &entry, enc, eol);
            }
        }
        if self.source.is_view_only() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "閲覧専用文書は保存できません",
            ));
        }
        let same_target = self.source.path() == Some(path);
        if same_target {
            if let Some(stored) = self.source.stamp() {
                match fileio::stamp(path) {
                    Ok(current) if current != stored => {
                        let conflict = fileio::conflict_path(path);
                        let transaction = fileio::begin_save(&conflict, &self.buf, enc, eol)?;
                        transaction
                            .commit(&conflict)
                            .map_err(fileio::SaveCommitError::into_error)?;
                        return Ok(SaveOutcome::Conflict {
                            saved_to: conflict.to_string_lossy().into_owned(),
                        });
                    }
                    Ok(_) => {}
                    Err(error) => return Err(error),
                }
            }
        }
        let transaction = fileio::begin_save(path, &self.buf, enc, eol)?;
        let workspace_root = self.source.folder_root().map(Path::to_path_buf);
        // 差し替え中だけ旧mmap/ハンドルを解放する。失敗時は編集中の内容と監視状態を戻す。
        let old_buf = std::mem::replace(&mut self.buf, TextBuffer::new());
        let old_source_file = if same_target {
            self.source.take_source_file()
        } else {
            None
        };
        if let Err(failure) = transaction.commit(path) {
            self.buf = old_buf;
            if same_target {
                self.source.set_source_file(old_source_file);
            }
            return Err(failure.into_error());
        }
        let o = match fileio::open_buffer(path) {
            Ok(opened) => opened,
            Err(error) => {
                self.buf = old_buf;
                if same_target {
                    self.source.set_source_file(old_source_file);
                }
                return Err(error);
            }
        };
        self.buf = o.buf;
        self.enc = enc;
        self.eol = eol;
        self.source = DocumentSource {
            root: workspace_root,
            ..DocumentSource::file(path.to_path_buf(), o.source_file, o.stamp)
        };
        self.undo.break_coalescing();
        Ok(SaveOutcome::Saved)
    }

    // 7z/zip エントリの書き戻し。アーカイブと同じフォルダの作業領域へ構造を再現して
    // 7z u で更新する。7z.exe が書庫本体を差し替えるため、排他ハンドルは実行中だけ手放す。
    fn save_archive_entry(
        &mut self,
        archive: &Path,
        entry: &str,
        enc: Encoding,
        eol: Eol,
    ) -> io::Result<SaveOutcome> {
        let password = self.sevenz_password(archive).to_string();
        // ヘッダ暗号化 (-mhe=on) は更新時に指定し直さないと失われるため事前に検出する
        let header_encrypted = self
            .archive_port
            .preserves_header_encryption(archive, &password)?;
        let workspace = self.archive_port.new_workspace(archive)?;
        let entry_file = workspace
            .path()
            .join(entry.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = entry_file.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let transaction = fileio::begin_save(&entry_file, &self.buf, enc, eol)?;
        transaction
            .commit(&entry_file)
            .map_err(fileio::SaveCommitError::into_error)?;
        let archive_port = Arc::clone(&self.archive_port);
        self.run_archive_command(archive, move || {
            archive_port.update(
                archive,
                entry,
                workspace.path(),
                &password,
                header_encrypted,
            )
        })?;
        self.enc = enc;
        self.eol = eol;
        self.undo.break_coalescing();
        Ok(SaveOutcome::Saved)
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
            return PosC {
                line: p.line,
                col: 0,
            };
        }
        let s = self.buf.line(p.line);
        let col = s[..p.col.min(s.len())].chars().count();
        PosC { line: p.line, col }
    }
}

fn image_extension(mime_type: &str) -> Option<&'static str> {
    match mime_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "image/apng" => Some("apng"),
        "image/avif" => Some("avif"),
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/bmp" => Some("bmp"),
        "image/svg+xml" => Some("svg"),
        "image/x-icon" | "image/vnd.microsoft.icon" => Some("ico"),
        _ => None,
    }
}

fn archive_entry_parent(entry: &str) -> &str {
    entry
        .rsplit_once('/')
        .map(|(parent, _)| parent)
        .unwrap_or("")
}

fn archive_entry_stem(entry: &str) -> Option<&str> {
    let name = entry.rsplit('/').next()?;
    let stem = name.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(name);
    (!stem.is_empty()).then_some(stem)
}

fn archive_join(parent: &str, child: &str) -> String {
    if parent.is_empty() {
        child.to_string()
    } else {
        format!("{parent}/{child}")
    }
}

fn valid_archive_entry_path(entry: &str) -> bool {
    !entry.is_empty()
        && !entry.starts_with('/')
        && !entry.starts_with('\\')
        && !entry.split(['/', '\\']).any(|part| part == "..")
}

fn next_archive_image_name(
    entries: &[String],
    directory: &str,
    extension: &str,
) -> io::Result<String> {
    let prefix = format!("{}/", directory.replace('\\', "/").to_lowercase());
    for index in 1..=10_000usize {
        let stem = if index == 1 {
            "pasted-image".to_string()
        } else {
            format!("pasted-image-{index}")
        };
        let name = format!("{stem}.{extension}");
        let full = format!("{prefix}{}", name.to_lowercase());
        if !entries
            .iter()
            .any(|entry| entry.replace('\\', "/").to_lowercase() == full)
        {
            return Ok(name);
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "画像ファイル名を決められません",
    ))
}

fn referenced_image_files(buf: &TextBuffer) -> HashSet<String> {
    let mut referenced = HashSet::new();
    for line in 0..buf.line_count() {
        let text = buf.line(line);
        let lower = text.to_ascii_lowercase();
        let mut from = 0;
        while let Some(relative) = lower[from..].find("<img") {
            let start = from + relative;
            let Some(end_relative) = lower[start..].find('>') else {
                break;
            };
            let end = start + end_relative;
            if let Some(src) = image_src_in_tag(&text[start..=end]) {
                if let Some(name) = image_name_from_src(&src) {
                    referenced.insert(name);
                }
            }
            from = end + 1;
        }
    }
    referenced
}

fn image_src_in_tag(tag: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let mut from = 0;
    while let Some(relative) = lower[from..].find("src") {
        let start = from + relative;
        let before_ok = start == 0 || !lower.as_bytes()[start - 1].is_ascii_alphanumeric();
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
                    .find(char::is_whitespace)
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
    let parts: Vec<String> = src
        .replace('\\', "/")
        .split('/')
        .map(|part| part.to_lowercase())
        .collect();
    match parts.as_slice() {
        [root, name] if root == "image" && valid_image_path_part(name) => {
            Some(format!("image/{name}"))
        }
        [root, memo, name]
            if root == "image_markdown"
                && valid_image_path_part(memo)
                && valid_image_path_part(name) =>
        {
            Some(format!("image_markdown/{memo}/{name}"))
        }
        _ => None,
    }
}

fn valid_image_path_part(value: &str) -> bool {
    !value.is_empty() && value != "." && value != ".."
}

fn cleanup_image_dir(dir: &Path, prefix: &str, referenced: &HashSet<String>) -> io::Result<()> {
    if !dir.is_dir() {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_lowercase();
        if !referenced.contains(&format!("{prefix}/{name}")) {
            std::fs::remove_file(entry.path())?;
        }
    }
    remove_empty_dir(dir)
}

fn remove_empty_dir(dir: &Path) -> io::Result<()> {
    if !dir.is_dir() {
        return Ok(());
    }
    if std::fs::read_dir(dir)?.next().is_none() {
        let _ = std::fs::remove_dir(dir);
    }
    Ok(())
}

// ---- 検索 ----
// 単一行に収まるパターンの1行内マッチ判定
#[cfg(test)]
mod tests {
    use super::*;

    // Feature: 貼り付け画像の形式判定
    // Scenario: UIが扱う画像MIMEを文書保存側でも拡張子へ変換する
    // Given: APNG、AVIF、ICO、非対応形式のMIME
    // When: image_extensionを呼ぶ
    // Then: 対応形式だけ対応する拡張子を返し、非対応形式はNoneを返す
    #[test]
    fn image_mime_types_are_mapped_to_extensions() {
        assert_eq!(image_extension("image/apng"), Some("apng"));
        assert_eq!(image_extension("image/avif"), Some("avif"));
        assert_eq!(image_extension("image/x-icon; charset=binary"), Some("ico"));
        assert_eq!(image_extension("image/tiff"), None);
    }

    struct FakeArchivePort;

    impl ArchivePort for FakeArchivePort {
        fn supports_path(&self, _: &Path) -> bool {
            true
        }

        fn supports_legacy_zip_fallback(&self, _: &Path) -> bool {
            false
        }

        fn list(&self, _: &Path, _: &str) -> io::Result<Vec<String>> {
            Ok(vec!["fake.txt".to_string()])
        }

        fn extract(&self, _: &Path, _: &str, _: &str) -> io::Result<Vec<u8>> {
            Ok(b"fake".to_vec())
        }

        fn preserves_header_encryption(&self, _: &Path, _: &str) -> io::Result<bool> {
            Ok(false)
        }

        fn is_password_error(&self, _: &io::Error) -> bool {
            false
        }

        fn cleanup_stale_workspaces(&self, _: &Path) -> io::Result<()> {
            Ok(())
        }

        fn new_workspace(
            &self,
            _: &Path,
        ) -> io::Result<Box<dyn crate::archive_port::ArchiveWorkspacePort>> {
            Err(io::Error::other("not used in fake"))
        }

        fn update(&self, _: &Path, _: &str, _: &Path, _: &str, _: bool) -> io::Result<()> {
            Ok(())
        }

        fn delete(&self, _: &Path, _: &[String], _: &str) -> io::Result<()> {
            Ok(())
        }
    }

    fn pos(line: usize, col: usize) -> PosC {
        PosC { line, col }
    }

    fn sevenz_root(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("wasabipad_doc7z_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn archive_port_can_be_replaced_without_starting_7z() {
        let root = sevenz_root("fake-port");
        let archive = root.join("fake.archive");
        std::fs::write(&archive, b"placeholder").unwrap();
        let source_file = File::open(&archive).unwrap();
        let doc = Doc {
            buf: TextBuffer::new(),
            undo: UndoStack::new(),
            enc: Encoding::Utf8 { bom: false },
            eol: Eol::Lf,
            source: DocumentSource {
                root: None,
                target: Target::Archive {
                    path: archive.clone(),
                    source_file: Some(source_file),
                    entries: None,
                    editable_entry: None,
                },
            },
            replace_progress: None,
            byte_len: 0,
            sevenz_passwords: HashMap::new(),
            archive_port: Arc::new(FakeArchivePort),
        };

        assert_eq!(
            doc.list_archive_entries("").unwrap(),
            Some(vec!["fake.txt".to_string()])
        );
        let _ = std::fs::remove_dir_all(root);
    }

    // 直接開いた パスワード付き 7z: 一覧→パスワード設定→選択→編集→保存→再読込の一巡
    #[test]
    fn sevenz_password_entry_edit_and_save_roundtrip() {
        if !crate::sevenz::available() {
            return;
        }
        let root = sevenz_root("direct");
        let src = root.join("src");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("a.txt"), "hello\n").unwrap();
        let archive = root.join("t.7z");
        crate::sevenz::create_archive_for_test(&archive, &src, "pw", true).unwrap();

        let mut d = Doc::open(&archive).unwrap();
        assert!(
            d.info(String::new()).view_only,
            "エントリ未選択の間は閲覧専用"
        );

        // パスワード無しの一覧は required マーカー付きで失敗する
        let err = d.list_archive_entries("").unwrap_err();
        assert!(
            err.to_string().contains(&format!(
                "{}:required",
                crate::sevenz::PASSWORD_ERROR_MARKER
            )),
            "{err}"
        );

        // 誤ったパスワードは wrong マーカー
        d.set_archive_password("", "bad").unwrap();
        let err = d.list_archive_entries("").unwrap_err();
        assert!(
            err.to_string()
                .contains(&format!("{}:wrong", crate::sevenz::PASSWORD_ERROR_MARKER)),
            "{err}"
        );

        d.set_archive_password("", "pw").unwrap();
        assert_eq!(
            d.list_archive_entries("").unwrap().unwrap(),
            vec!["a.txt".to_string()]
        );

        let info = d.select_entry("a.txt").unwrap().unwrap();
        assert!(!info.view_only, "7z のテキストエントリは編集可能");
        assert_eq!(d.lines(0, 2), vec!["hello".to_string(), String::new()]);

        d.edit(pos(0, 0), pos(0, 0), pos(0, 0), "X", false)
            .expect("編集できる");
        let outcome = d
            .save(&archive, Encoding::Utf8 { bom: false }, Eol::Lf)
            .unwrap();
        assert!(matches!(outcome, SaveOutcome::Saved));

        // 書き戻し後もパスワード + ヘッダ暗号化が維持され、内容が更新されている
        assert!(crate::sevenz::is_header_encrypted(&archive).unwrap());
        assert_eq!(
            crate::sevenz::extract(&archive, "a.txt", "pw").unwrap(),
            b"Xhello\n"
        );

        let image_src = d.save_pasted_image(&[1, 2, 3, 4], "image/png").unwrap();
        assert_eq!(image_src, "image_markdown/a/pasted-image.png");
        assert_eq!(
            crate::sevenz::extract(&archive, &image_src, "pw").unwrap(),
            [1, 2, 3, 4]
        );
        assert!(!std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with(crate::sevenz::WORKSPACE_PREFIX)));
        d.cleanup_unused_images().unwrap();
        assert!(!crate::sevenz::list(&archive, "pw")
            .unwrap()
            .contains(&image_src));
        assert!(crate::sevenz::is_header_encrypted(&archive).unwrap());

        // 排他ハンドルは取り直されており、続けて編集・保存できる
        d.edit(pos(0, 0), pos(0, 1), pos(0, 0), "", false)
            .expect("再編集できる");
        d.save(&archive, Encoding::Utf8 { bom: false }, Eol::Lf)
            .unwrap();
        assert_eq!(
            crate::sevenz::extract(&archive, "a.txt", "pw").unwrap(),
            b"hello\n"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    // フォルダ内の 7z ("sub/t.7z::b.txt" 形式) の展開と書き戻し
    #[test]
    fn sevenz_inside_folder_edits_entry() {
        if !crate::sevenz::available() {
            return;
        }
        let root = sevenz_root("folder");
        let src = root.join("srcdata");
        std::fs::create_dir_all(src.join("sub")).unwrap();
        std::fs::write(src.join("sub").join("b.txt"), "world\n").unwrap();
        let ws = root.join("ws");
        std::fs::create_dir_all(&ws).unwrap();
        let archive = ws.join("t.7z");
        crate::sevenz::create_archive_for_test(&archive, &src, "", false).unwrap();

        let mut d = Doc::open(&ws).unwrap();
        assert_eq!(
            d.list_archive_entries("t.7z").unwrap().unwrap(),
            vec!["sub/b.txt".to_string()]
        );
        let info = d.select_entry("t.7z::sub/b.txt").unwrap().unwrap();
        assert!(!info.view_only);
        assert_eq!(d.lines(0, 1), vec!["world".to_string()]);

        d.edit(pos(0, 0), pos(0, 0), pos(0, 0), "Y", false)
            .expect("編集できる");
        d.save(&archive, Encoding::Utf8 { bom: false }, Eol::Lf)
            .unwrap();
        assert_eq!(
            crate::sevenz::extract(&archive, "sub/b.txt", "").unwrap(),
            b"Yworld\n"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn zip_entry_image_is_saved_inside_archive() {
        if !crate::sevenz::available() {
            return;
        }
        let root = sevenz_root("zip-image");
        let src = root.join("src");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("memo.md"), "# memo\n").unwrap();
        let archive = root.join("memo.zip");
        crate::sevenz::create_archive_for_test(&archive, &src, "", false).unwrap();

        let mut d = Doc::open(&archive).unwrap();
        let info = d.select_entry("memo.md").unwrap().unwrap();
        assert!(!info.view_only);
        let image_src = d.save_pasted_image(&[9, 8, 7], "image/png").unwrap();
        assert_eq!(image_src, "image_markdown/memo/pasted-image.png");
        assert_eq!(
            crate::sevenz::extract(&archive, &image_src, "").unwrap(),
            [9, 8, 7]
        );
        assert_eq!(
            d.read_archive_asset(&archive, &image_src).unwrap(),
            [9, 8, 7]
        );
        d.cleanup_unused_images().unwrap();
        assert!(!crate::sevenz::list(&archive, "")
            .unwrap()
            .contains(&image_src));
        assert!(!std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with(crate::sevenz::WORKSPACE_PREFIX)));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn password_zip_entry_image_is_saved_inside_archive() {
        if !crate::sevenz::available() {
            return;
        }
        let root = sevenz_root("zip-image-pw");
        let src = root.join("src");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("memo.md"), "# memo\n").unwrap();
        let archive = root.join("memo.zip");
        crate::sevenz::create_archive_for_test(&archive, &src, "pw", false).unwrap();

        let mut d = Doc::open(&archive).unwrap();
        d.set_archive_password("", "bad").unwrap();
        let error = match d.select_entry("memo.md") {
            Ok(_) => panic!("誤った ZIP パスワードが受理された"),
            Err(error) => error,
        };
        assert!(
            error
                .to_string()
                .contains(crate::sevenz::PASSWORD_ERROR_MARKER),
            "{error}"
        );
        d.set_archive_password("", "pw").unwrap();
        let info = d.select_entry("memo.md").unwrap().unwrap();
        assert!(!info.view_only);
        let image_src = d.save_pasted_image(&[5, 4, 3], "image/png").unwrap();
        assert_eq!(
            crate::sevenz::extract(&archive, &image_src, "pw").unwrap(),
            [5, 4, 3]
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    // バイナリエントリは説明文表示のみで編集不可のまま
    #[test]
    fn sevenz_binary_entry_stays_view_only() {
        if !crate::sevenz::available() {
            return;
        }
        let root = sevenz_root("bin");
        let src = root.join("src");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("a.bin"), [0u8, 1, 2, 255]).unwrap();
        let archive = root.join("t.7z");
        crate::sevenz::create_archive_for_test(&archive, &src, "", false).unwrap();

        let mut d = Doc::open(&archive).unwrap();
        let info = d.select_entry("a.bin").unwrap().unwrap();
        assert!(info.view_only);
        assert_eq!(d.lines(0, 1), vec!["(バイナリ: 4 bytes)".to_string()]);
        assert!(d
            .edit(pos(0, 0), pos(0, 0), pos(0, 0), "X", false)
            .is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    fn doc(t: &str) -> Doc {
        Doc {
            buf: TextBuffer::from_text(t),
            undo: UndoStack::new(),
            enc: Encoding::Utf8 { bom: false },
            eol: Eol::Lf,
            source: DocumentSource::untitled(),
            replace_progress: None,
            byte_len: 0,
            sevenz_passwords: HashMap::new(),
            archive_port: archive_port::system(),
        }
    }
    fn p(line: usize, col: usize) -> PosC {
        PosC { line, col }
    }

    #[test]
    fn insert_ascii() {
        let mut d = doc("abc");
        let r = d.edit(p(0, 1), p(0, 1), p(0, 1), "XY", false).unwrap();
        assert_eq!(d.lines(0, 1), vec!["aXYbc"]);
        assert_eq!((r.caret.line, r.caret.col), (0, 3));
        assert_eq!(r.line_count, 1);
    }

    #[test]
    fn insert_newline_splits_lines() {
        let mut d = doc("abc");
        let r = d.edit(p(0, 2), p(0, 2), p(0, 2), "\n", false).unwrap();
        assert_eq!(d.line_count(), 2);
        assert_eq!(d.lines(0, 2), vec!["ab", "c"]);
        assert_eq!((r.caret.line, r.caret.col), (1, 0));
    }

    #[test]
    fn edit_many_is_one_undo_entry() {
        let mut d = doc("ab\ncd");
        let items = vec![
            EditManyItem {
                start: p(0, 1),
                end: p(0, 1),
                text: "X".into(),
            },
            EditManyItem {
                start: p(1, 1),
                end: p(1, 1),
                text: "X".into(),
            },
        ];
        let r = d.edit_many(items, p(0, 1), 0).unwrap();
        assert_eq!(d.lines(0, 2), vec!["aXb", "cXd"]);
        assert_eq!(
            r.carets.iter().map(|p| (p.line, p.col)).collect::<Vec<_>>(),
            vec![(0, 2), (1, 2)]
        );

        d.undo().unwrap();
        assert_eq!(d.lines(0, 2), vec!["ab", "cd"]);
        assert!(d.undo().is_none(), "複数キャレット入力は1回のUndoで戻る");

        d.redo().unwrap();
        assert_eq!(d.lines(0, 2), vec!["aXb", "cXd"]);
    }

    #[test]
    fn col_is_char_index_not_byte() {
        // 全角 "あいう" の char col 2 に挿入 → byte col 6 に変換される
        let mut d = doc("あいう");
        d.edit(p(0, 2), p(0, 2), p(0, 2), "X", false).unwrap();
        assert_eq!(d.lines(0, 1), vec!["あいXう"]);
    }

    #[test]
    fn delete_range_then_undo_redo() {
        let mut d = doc("hello\nworld");
        let r = d.edit(p(0, 2), p(1, 3), p(1, 3), "", false).unwrap();
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
    fn consecutive_typing_coalesces_to_single_undo() {
        let mut d = doc("");
        d.edit(p(0, 0), p(0, 0), p(0, 0), "a", true).unwrap();
        d.edit(p(0, 1), p(0, 1), p(0, 1), "b", true).unwrap();
        d.edit(p(0, 2), p(0, 2), p(0, 2), "c", true).unwrap();
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
    fn empty_folder_selection_accepts_draft_edit() {
        let mut d = doc("abc");
        d.source = DocumentSource {
            root: Some(PathBuf::new()),
            ..DocumentSource::untitled()
        };
        d.edit(p(0, 0), p(0, 0), p(0, 0), "X", false).unwrap();
        assert_eq!(d.lines(0, 1), vec!["Xabc"]);
    }

    #[test]
    fn document_source_derives_kind_and_editability() {
        let untitled = DocumentSource::untitled();
        assert!(!untitled.is_view_only());
        assert_eq!(untitled.kind(), DocKind::Text);
        assert_eq!(untitled.folder_root(), None);

        let file = DocumentSource::file(PathBuf::from("memo.txt"), None, None);
        assert!(!file.is_view_only());
        assert_eq!(file.path(), Some(Path::new("memo.txt")));

        // root と target は直交する: フォルダを開いていても選択前は編集可能な下書き
        let folder = DocumentSource {
            root: Some(PathBuf::from("workspace")),
            ..DocumentSource::untitled()
        };
        assert!(!folder.is_view_only());
        assert_eq!(folder.kind(), DocKind::Text);
        assert_eq!(folder.folder_root(), Some(Path::new("workspace")));
        assert_eq!(folder.path(), None, "未選択のフォルダは保存先を持たない");
    }

    #[test]
    fn save_keeps_small_file_editable_by_others() {
        let path =
            std::env::temp_dir().join(format!("wasabipad_save_lock_{}.txt", std::process::id()));
        std::fs::write(&path, "abc").unwrap();
        let mut d = Doc::open(&path).unwrap();
        d.edit(p(0, 3), p(0, 3), p(0, 3), "!", false).unwrap();
        assert!(matches!(
            d.save(&path, Encoding::Utf8 { bom: false }, Eol::Lf)
                .unwrap(),
            SaveOutcome::Saved
        ));
        assert_eq!(d.lines(0, 1), vec!["abc!"]);
        assert!(
            std::fs::OpenOptions::new().write(true).open(&path).is_ok(),
            "小ファイルは保存後も他アプリから書き込めるはず"
        );
        drop(d);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "abc!");
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn poll_external_reloads_clean_doc() {
        let path =
            std::env::temp_dir().join(format!("wasabipad_poll_clean_{}.txt", std::process::id()));
        std::fs::write(&path, "before").unwrap();
        let mut d = Doc::open(&path).unwrap();
        assert!(matches!(d.poll_external(false), ExternalCheck::Unchanged));
        std::fs::write(&path, "after-external").unwrap();
        match d.poll_external(false) {
            ExternalCheck::Reloaded { info } => assert_eq!(info.line_count, 1),
            _ => panic!("未編集文書は自動再読込されるはず"),
        }
        assert_eq!(d.lines(0, 1), vec!["after-external"]);
        assert!(matches!(d.poll_external(false), ExternalCheck::Unchanged));
        drop(d);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn poll_external_ignores_deleted_doc() {
        let path =
            std::env::temp_dir().join(format!("wasabipad_poll_deleted_{}.txt", std::process::id()));
        std::fs::write(&path, "before").unwrap();
        let mut d = Doc::open(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert!(matches!(d.poll_external(false), ExternalCheck::Unchanged));
        assert!(matches!(d.poll_external(true), ExternalCheck::Unchanged));
    }

    #[test]
    fn poll_external_reports_conflict_when_dirty_and_ack_adopts_disk_state() {
        let path =
            std::env::temp_dir().join(format!("wasabipad_poll_dirty_{}.txt", std::process::id()));
        std::fs::write(&path, "base").unwrap();
        let mut d = Doc::open(&path).unwrap();
        d.edit(p(0, 4), p(0, 4), p(0, 4), "+mine", false).unwrap();
        std::fs::write(&path, "theirs-external").unwrap();
        assert!(matches!(d.poll_external(true), ExternalCheck::Conflict));
        assert_eq!(
            d.lines(0, 1),
            vec!["base+mine"],
            "dirty文書は勝手に読み直さない"
        );
        // 「無視」= 現ディスク状態を基準に採用 → 以後は変更なし扱い
        d.ack_external();
        assert!(matches!(d.poll_external(true), ExternalCheck::Unchanged));
        drop(d);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn conflicting_save_diverts_to_sidecar_file() {
        let dir = std::env::temp_dir().join(format!("wasabipad_conflict_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("memo.txt");
        std::fs::write(&path, "base").unwrap();
        let mut d = Doc::open(&path).unwrap();
        d.edit(p(0, 4), p(0, 4), p(0, 4), "+mine", false).unwrap();
        std::fs::write(&path, "theirs-external").unwrap();
        let saved_to = match d
            .save(&path, Encoding::Utf8 { bom: false }, Eol::Lf)
            .unwrap()
        {
            SaveOutcome::Conflict { saved_to } => PathBuf::from(saved_to),
            SaveOutcome::Saved => panic!("外部変更があるときは本体を上書きしないはず"),
        };
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "theirs-external",
            "外部の変更が残るはず"
        );
        assert_eq!(
            std::fs::read_to_string(&saved_to).unwrap(),
            "base+mine",
            "自分の編集は退避されるはず"
        );
        drop(d);
        std::fs::remove_dir_all(dir).unwrap();
    }

    // フォルダを開いた直後は何も選択されておらず (メモビューは空)、ルート直下の一覧だけが
    // 安価に取れる。ファイル未選択中も新規メモの下書きを入力できる。
    #[test]
    fn open_folder_lists_root_children_lazily_and_selects_files() {
        let root = std::env::temp_dir().join(format!("wasabipad_doctest_{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir(root.join("z-folder")).unwrap();
        std::fs::write(root.join("VSCodeチャット保存.txt"), "chat").unwrap();
        std::fs::write(root.join("a.txt"), "hello").unwrap();
        std::fs::write(root.join("b.txt"), "world").unwrap();
        std::fs::write(root.join("file10.txt"), "ten").unwrap();
        std::fs::write(root.join("file2.txt"), "two").unwrap();

        let mut d = Doc::open(&root).unwrap();
        assert!(
            File::open(root.join("a.txt")).is_ok(),
            "フォルダ一覧だけでは子ファイルをロックしない"
        );
        assert!(
            !d.source.is_view_only(),
            "何も選択されていない間は下書きを編集できる"
        );
        assert_eq!(
            d.lines(0, 1),
            vec![""],
            "フォルダを開いた直後は何も表示しない"
        );

        let root_children = d.list_folder_entries("").unwrap().unwrap();
        let names: Vec<&str> = root_children.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "z-folder",
                "a.txt",
                "b.txt",
                "file2.txt",
                "file10.txt",
                "VSCodeチャット保存.txt"
            ]
        );
        assert!(root_children[0].is_dir);

        // ファイルを選択すると編集可能な実ファイルとして開く
        let info = d.select_entry("a.txt").unwrap().unwrap();
        assert!(
            std::fs::OpenOptions::new()
                .write(true)
                .open(root.join("a.txt"))
                .is_ok(),
            "小ファイルは選択中も他アプリから書き込める"
        );
        assert!(!info.view_only, "フォルダの子ファイルは編集可能なはず");
        assert_eq!(d.lines(0, 1), vec!["hello"]);
        assert!(d.path().unwrap().ends_with("a.txt"));

        // 編集して保存できる (実ファイルとして扱われている)
        let r = d.edit(p(0, 5), p(0, 5), p(0, 5), "!", false).unwrap();
        assert_eq!(r.line_count, 1);
        assert_eq!(d.lines(0, 1), vec!["hello!"]);

        // 別エントリへ切り替えると実ファイルとして開き直る
        let info2 = d.select_entry("b.txt").unwrap().unwrap();
        assert!(
            File::open(root.join("a.txt")).is_ok(),
            "選択解除したファイルも読み取れる"
        );
        assert!(
            std::fs::OpenOptions::new()
                .write(true)
                .open(root.join("b.txt"))
                .is_ok(),
            "新しく選択した小ファイルも書き込み可能なまま"
        );
        assert_eq!(info2.kind, DocKind::Text);
        assert!(!info2.view_only);
        assert!(info2.path.ends_with("b.txt"));
        assert_eq!(d.lines(0, 1), vec!["world"]);
        assert!(
            d.workspace_root().is_some(),
            "フォルダルートは切替後も保持される"
        );

        drop(d); // 選択中ファイルの排他を解放してからfixtureを削除
        std::fs::remove_dir_all(&root).unwrap();
    }

    // Feature: 画像ファイルを右側プレビューへ渡すための簡易エディタ表示
    // Scenario: 画像ファイルを開く
    // Given: PNG形式のファイルがある
    // When: そのファイルを文書として開く
    // Then: バイナリサイズを表示し、編集不可になる
    #[test]
    fn image_file_shows_binary_description_and_is_view_only() {
        let root = std::env::temp_dir().join(format!("wasabipad_image_doc_{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("picture.PNG");
        let bytes = [0x89, b'P', b'N', b'G', 0x0d, 0x0a];
        std::fs::write(&path, bytes).unwrap();

        let mut d = Doc::open(&path).unwrap();
        let info = d.info(path.to_string_lossy().into_owned());
        assert!(info.view_only);
        assert_eq!(d.lines(0, 1), vec!["(バイナリ: 6 bytes)".to_string()]);
        assert!(d.edit(p(0, 0), p(0, 0), p(0, 0), "X", false).is_none());

        drop(d);
        std::fs::remove_dir_all(&root).unwrap();
    }

    fn image_fixture(name: &str) -> (PathBuf, Doc) {
        let root =
            std::env::temp_dir().join(format!("wasabipad_image_{name}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("memo.md"), "").unwrap();

        let mut d = Doc::open(&root).unwrap();
        d.select_entry("memo.md").unwrap().unwrap();
        (root, d)
    }

    #[test]
    fn pasted_image_is_saved_under_the_memo_specific_directory() {
        let (root, mut d) = image_fixture("path");
        let src = d.save_pasted_image(&[1, 2, 3], "image/png").unwrap();
        assert_eq!(src, "image_markdown/memo/pasted-image.png");
        let image = root.join(src.replace('/', std::path::MAIN_SEPARATOR_STR));
        assert!(image.is_file());
        drop(d);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn referenced_pasted_image_is_kept_during_cleanup() {
        let (root, mut d) = image_fixture("keep");
        let src = d.save_pasted_image(&[1, 2, 3], "image/png").unwrap();
        let image = root.join(src.replace('/', std::path::MAIN_SEPARATOR_STR));
        let tag = format!("<img src=\"{src}\" alt=\"貼り付け画像\" width=\"900\">\n");
        let mut d = d;
        d.edit(pos(0, 0), pos(0, 0), pos(0, 0), &tag, false)
            .unwrap();
        d.cleanup_unused_images().unwrap();
        assert!(image.is_file(), "参照中の画像は残す");
        drop(d);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn unreferenced_pasted_image_is_removed_with_empty_directory() {
        let (root, mut d) = image_fixture("remove");
        let src = d.save_pasted_image(&[1, 2, 3], "image/png").unwrap();
        let image = root.join(src.replace('/', std::path::MAIN_SEPARATOR_STR));
        let mut d = d;
        let tag = format!("<img src=\"{src}\" alt=\"貼り付け画像\" width=\"900\">\n");
        d.edit(pos(0, 0), pos(0, 0), pos(0, 0), &tag, false)
            .unwrap();
        d.cleanup_unused_images().unwrap();
        d.edit(pos(0, 0), pos(1, 0), pos(0, 0), "", false).unwrap();
        d.cleanup_unused_images().unwrap();
        assert!(!image.exists(), "タグ削除後は画像も削除する");
        assert!(
            !root.join("image_markdown").exists(),
            "空になった画像フォルダも整理する"
        );
        drop(d);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn deleting_selected_folder_entry_resets_the_document_to_the_folder() {
        let root = std::env::temp_dir().join(format!("wasabipad_delete_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("memo.txt"), "memo").unwrap();

        let mut d = Doc::open(&root).unwrap();
        d.select_entry("memo.txt").unwrap().unwrap();
        let info = d.delete_entry("memo.txt").unwrap();
        assert!(!root.join("memo.txt").exists());
        assert!(d.path().is_none());
        assert_eq!(d.line_count(), 1);
        let root_string = root.to_string_lossy().into_owned();
        assert_eq!(info.folder_root.as_deref(), Some(root_string.as_str()));
        let _ = std::fs::remove_dir_all(&root);
    }

    // サブフォルダはツリーの展開ボタンを押すまでその中身 (さらに奥のファイル) を
    // 一切読まない。直下一覧は再帰しないので、深い階層があっても軽い。
    #[test]
    fn subfolder_children_are_listed_only_on_demand() {
        let root =
            std::env::temp_dir().join(format!("wasabipad_doctest_sub_{}", std::process::id()));
        let sub = root.join("sub1");
        let deep = sub.join("sub1a");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(root.join("top.txt"), "top").unwrap();
        std::fs::write(sub.join("inner.txt"), "inner").unwrap();
        std::fs::write(deep.join("deep.txt"), "deep").unwrap();

        let d = Doc::open(&root).unwrap();
        let root_children = d.list_folder_entries("").unwrap().unwrap();
        let names: Vec<&str> = root_children.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["sub1", "top.txt"],
            "ルート直下だけを見る (奥の deep.txt などは含まれない)"
        );
        assert!(
            root_children
                .iter()
                .find(|e| e.name == "sub1")
                .unwrap()
                .is_dir
        );

        let sub1_children = d.list_folder_entries("sub1").unwrap().unwrap();
        let sub1_names: Vec<&str> = sub1_children.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(sub1_names, vec!["sub1a", "inner.txt"]);

        let deep_children = d.list_folder_entries("sub1/sub1a").unwrap().unwrap();
        let deep_names: Vec<&str> = deep_children.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(deep_names, vec!["deep.txt"]);

        std::fs::remove_dir_all(&root).unwrap();
    }

    // .zip を直接開いた場合、展開ボタン (list_archive_entries) を押すまでは
    // 中身を一切読まない (空のまま) ことを確認する
    #[test]
    fn standalone_zip_open_is_lazy_until_entry_selected() {
        let root =
            std::env::temp_dir().join(format!("wasabipad_doctest_zip2_{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let zpath = root.join("notes.zip");
        std::fs::write(
            &zpath,
            crate::ziptext::build_stored_zip(&[("memo.txt", b"secret text")]),
        )
        .unwrap();

        let mut d = Doc::open(&zpath).unwrap();
        assert!(
            std::fs::OpenOptions::new()
                .write(true)
                .open(&zpath)
                .is_err(),
            "直接開いたアーカイブを書き込み禁止にする"
        );
        assert!(d.source.is_view_only());
        assert_eq!(d.lines(0, 1), vec![""], "展開前は中身が空のはず");
        assert!(d.workspace_root().is_none());

        let names = d.list_archive_entries("").unwrap().unwrap();
        assert_eq!(names, vec!["memo.txt".to_string()]);

        let info = d.select_entry("memo.txt").unwrap().unwrap();
        assert_eq!(info.kind, DocKind::Archive);
        assert_eq!(d.lines(0, 1), vec!["secret text"]);
        assert!(!info.view_only, "ZIP のテキストエントリは編集可能");
        assert!(d.edit(p(0, 0), p(0, 0), p(0, 0), "X", false).is_some());
        assert_eq!(d.lines(0, 1), vec!["Xsecret text"]);
        let outcome = d
            .save(&zpath, Encoding::Utf8 { bom: false }, Eol::Lf)
            .unwrap();
        assert!(matches!(outcome, SaveOutcome::Saved));
        let saved = std::fs::read(&zpath).unwrap();
        assert_eq!(
            crate::archive::decode_one(&saved, "memo.txt").as_deref(),
            Some("Xsecret text")
        );

        drop(d);
        std::fs::remove_dir_all(&root).unwrap();
    }

    // フォルダ閲覧中に見つかった zip も同様に遅延展開する。エントリ選択後も
    // フォルダの一覧 (ツリー) はそのまま維持される。
    #[test]
    fn folder_browsing_lists_and_opens_nested_zip_entries_without_full_expand() {
        let root =
            std::env::temp_dir().join(format!("wasabipad_doctest_zip3_{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a_note.txt"), "hello").unwrap();
        std::fs::write(
            root.join("data.zip"),
            crate::ziptext::build_stored_zip(&[("b/c.txt", b"x"), ("a.txt", b"ZIPCONTENT")]),
        )
        .unwrap();

        let mut d = Doc::open(&root).unwrap();
        assert_eq!(
            d.lines(0, 1),
            vec![""],
            "フォルダを開いた直後は何も選択されていない"
        );
        assert!(!d.source.is_view_only());

        let root_children = d.list_folder_entries("").unwrap().unwrap();
        let names: Vec<&str> = root_children.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["a_note.txt", "data.zip"]);

        let names = d.list_archive_entries("data.zip").unwrap().unwrap();
        assert_eq!(names, vec!["a.txt".to_string(), "b/c.txt".to_string()]);

        let info = d.select_entry("data.zip::a.txt").unwrap().unwrap();
        // フォルダ閲覧中は kind は "text" のまま (folder_entries でツリーを組み立てるため)。
        // ZIP のテキストエントリは書き戻し可能。
        assert_eq!(info.kind, DocKind::Text);
        assert!(!info.view_only);
        assert_eq!(d.lines(0, 1), vec!["ZIPCONTENT"]);
        assert!(
            d.workspace_root().is_some(),
            "フォルダルートは選択後も維持される"
        );

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

    // ファイル内検索とフォルダ検索は search::build_matcher を共有する。
    // 大小文字無視が ASCII に閉じていると、同じ語を探したのにフォルダ検索では
    // 出てファイル内検索では出ない、という説明できない差になる。
    #[test]
    fn case_insensitive_find_folds_beyond_ascii() {
        let d = doc("ＮＥＥＤＬＥ を探す");
        let found = d
            .find("ｎｅｅｄｌｅ", p(0, 0), true, false)
            .expect("全角も畳んで当てる");
        assert_eq!((found.start.col, found.end.col), (0, 6));
        assert!(
            d.find("ｎｅｅｄｌｅ", p(0, 0), true, true).is_none(),
            "区別する指定なら当てない"
        );
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

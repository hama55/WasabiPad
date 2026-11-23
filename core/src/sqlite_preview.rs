use rusqlite::{
    config::DbConfig, params, types::ValueRef, Connection, ErrorCode, OpenFlags, OptionalExtension,
};
use std::{
    fs::File,
    io::Read,
    path::Path,
    time::{Duration, Instant},
};

const MAX_TEXT_CHARS: usize = 4096;
const MAX_PREVIEW_LIMIT: usize = 10_000;
const MAX_QUERY_SQL_BYTES: usize = 64 * 1024;
const QUERY_TIMEOUT: Duration = Duration::from_secs(5);
const PROGRESS_HANDLER_STEPS: i32 = 10_000;
const SQLITE_HEADER: &[u8; 16] = b"SQLite format 3\0";
const TEMPORARY_VIEW_NAME: &str = "__wasabipad_temporary_view__";

fn is_interrupted(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(err, _) if err.code == ErrorCode::OperationInterrupted
    )
}

fn map_sqlite_error(error: rusqlite::Error) -> String {
    if is_interrupted(&error) {
        "SQLiteクエリがタイムアウトしました".to_string()
    } else {
        error.to_string()
    }
}

#[derive(Clone, serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct SqliteObject {
    pub name: String,
    pub kind: String,
}

#[derive(Clone, serde::Serialize, ts_rs::TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum SqliteCell {
    Null,
    Integer { value: String },
    Real { value: String },
    Text { value: String, truncated: bool },
    Blob { bytes: u64 },
}

#[derive(Clone, serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct SqlitePreview {
    pub objects: Vec<SqliteObject>,
    pub selected_name: Option<String>,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<SqliteCell>>,
    pub has_more: bool,
    pub total_rows: Option<u64>,
    pub view_definition: Option<String>,
    pub metadata_error: Option<String>,
}

pub fn read_sqlite_preview(
    path: &Path,
    selected_name: Option<&str>,
    offset: usize,
    limit: usize,
    include_metadata: bool,
    query_sql: Option<&str>,
) -> Result<SqlitePreview, String> {
    read_sqlite_preview_with_timeout(
        path,
        selected_name,
        offset,
        limit,
        include_metadata,
        query_sql,
        QUERY_TIMEOUT,
    )
}

fn read_sqlite_preview_with_timeout(
    path: &Path,
    selected_name: Option<&str>,
    offset: usize,
    limit: usize,
    include_metadata: bool,
    query_sql: Option<&str>,
    timeout: Duration,
) -> Result<SqlitePreview, String> {
    if !is_sqlite_preview_eligible(path) {
        return Err("SQLiteプレビューの対象ファイルではありません".to_string());
    }
    if limit == 0 || limit > MAX_PREVIEW_LIMIT {
        return Err(format!("表示行数は1〜{MAX_PREVIEW_LIMIT}の範囲で指定してください"));
    }
    if query_sql.is_some_and(|sql| sql.len() > MAX_QUERY_SQL_BYTES) {
        return Err("SQLが長すぎます".to_string());
    }
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(map_sqlite_error)?;
    let deadline = Instant::now() + timeout;
    connection
        .progress_handler(
            PROGRESS_HANDLER_STEPS,
            Some(move || Instant::now() >= deadline),
        )
        .map_err(map_sqlite_error)?;
    let _ = connection.set_db_config(DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true);
    let _ = connection.set_db_config(DbConfig::SQLITE_DBCONFIG_TRUSTED_SCHEMA, false);
    connection
        .execute_batch("PRAGMA temp_store=MEMORY; PRAGMA trusted_schema=OFF;")
        .map_err(map_sqlite_error)?;
    let mut objects = sqlite_objects(&connection).map_err(map_sqlite_error)?;
    let temporary_view_name = if let Some(query_sql) = query_sql {
        if !starts_with_select(query_sql) {
            return Err("入力はSELECTで始まるSQLにしてください".to_string());
        }
        let mut name = TEMPORARY_VIEW_NAME.to_string();
        let mut suffix = 0usize;
        while objects.iter().any(|object| object.name == name) {
            suffix += 1;
            name = format!("{TEMPORARY_VIEW_NAME}{suffix}");
        }
        connection
            .execute(
                &format!(
                    "CREATE TEMP VIEW {} AS {query_sql}",
                    quote_identifier(&name)
                ),
                [],
            )
            .map_err(|error| format!("一時ビューを作成できませんでした: {error}"))?;
        objects.push(SqliteObject {
            name: name.clone(),
            kind: "temporary view".to_string(),
        });
        Some(name)
    } else {
        None
    };
    connection
        .execute_batch("PRAGMA query_only=ON;")
        .map_err(map_sqlite_error)?;
    let selected_name = if let Some(name) = temporary_view_name {
        Some(name)
    } else {
        select_object(&objects, selected_name)?.map(|object| object.name.clone())
    };
    let Some(selected_name) = selected_name else {
        return Ok(SqlitePreview {
            objects,
            selected_name: None,
            columns: Vec::new(),
            rows: Vec::new(),
            has_more: false,
            total_rows: None,
            view_definition: None,
            metadata_error: None,
        });
    };

    let is_view = query_sql.is_some()
        || objects
            .iter()
            .find(|object| object.name == selected_name)
            .is_some_and(|object| object.kind == "view");
    let identifier = quote_identifier(&selected_name);
    let (total_rows, view_definition, metadata_error) = if include_metadata {
        let (total_rows, count_error) =
            match connection.query_row(&format!("SELECT COUNT(*) FROM {identifier}"), [], |row| {
                row.get::<_, i64>(0)
            }) {
                Ok(value) => match u64::try_from(value) {
                    Ok(value) => (Some(value), None),
                    Err(_) => (None, Some("総行数を解釈できません".to_string())),
                },
                Err(error) if is_interrupted(&error) => return Err(map_sqlite_error(error)),
                Err(error) => (None, Some(format!("総行数を取得できませんでした: {error}"))),
            };
        let (view_definition, definition_error) = if let Some(query_sql) = query_sql {
            (Some(query_sql.to_string()), None)
        } else if is_view {
            match connection
                .query_row(
                    "SELECT sql FROM sqlite_schema WHERE type = 'view' AND name = ?1",
                    params![selected_name],
                    |row| row.get::<_, String>(0),
                )
                .optional()
            {
                Ok(definition) => (definition, None),
                Err(error) if is_interrupted(&error) => return Err(map_sqlite_error(error)),
                Err(error) => (
                    None,
                    Some(format!("ビュー定義を取得できませんでした: {error}")),
                ),
            }
        } else {
            (None, None)
        };
        (
            total_rows,
            view_definition,
            count_error.or(definition_error),
        )
    } else {
        (None, None, None)
    };
    let sql = format!("SELECT * FROM {identifier} LIMIT ?1 OFFSET ?2");
    let fetch_limit = limit.saturating_add(1);
    let fetch_limit =
        i64::try_from(fetch_limit).map_err(|_| "表示行数が大きすぎます".to_string())?;
    let offset = i64::try_from(offset).map_err(|_| "表示位置が大きすぎます".to_string())?;
    let mut statement = connection
        .prepare(&sql)
        .map_err(map_sqlite_error)?;
    let columns = statement
        .column_names()
        .into_iter()
        .map(str::to_string)
        .collect::<Vec<_>>();
    let mut result_rows = Vec::new();
    let mut rows = statement
        .query(params![fetch_limit, offset])
        .map_err(map_sqlite_error)?;
    while let Some(row) = rows.next().map_err(map_sqlite_error)? {
        let values = (0..columns.len())
            .map(|index| value_from_ref(row.get_ref(index)))
            .collect::<Result<Vec<_>, _>>()?;
        result_rows.push(values);
    }
    let has_more = result_rows.len() > limit;
    result_rows.truncate(limit);
    Ok(SqlitePreview {
        objects,
        selected_name: Some(selected_name),
        columns,
        rows: result_rows,
        has_more,
        total_rows,
        view_definition,
        metadata_error,
    })
}

pub fn is_sqlite_preview_eligible(path: &Path) -> bool {
    if !is_sqlite_candidate_path(path) || !path.is_file() {
        return false;
    }
    let mut header = [0; SQLITE_HEADER.len()];
    File::open(path)
        .and_then(|mut file| file.read_exact(&mut header))
        .is_ok()
        && &header == SQLITE_HEADER
}

fn is_sqlite_candidate_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("db")
                || extension.eq_ignore_ascii_case("sqlite")
                || extension.eq_ignore_ascii_case("sqlite3")
        })
}

fn starts_with_select(sql: &str) -> bool {
    let mut remaining = sql.trim_start();
    loop {
        if let Some(comment) = remaining.strip_prefix("--") {
            remaining = comment.split_once('\n').map_or("", |(_, rest)| rest);
        } else if let Some(comment) = remaining.strip_prefix("/*") {
            let Some((_, rest)) = comment.split_once("*/") else {
                return false;
            };
            remaining = rest;
        } else {
            break;
        }
        remaining = remaining.trim_start();
    }

    remaining
        .get(..6)
        .is_some_and(|keyword| keyword.eq_ignore_ascii_case("SELECT"))
        && remaining
            .get(6..)
            .and_then(|tail| tail.chars().next())
            .is_none_or(|character| !character.is_ascii_alphanumeric() && character != '_')
}

fn sqlite_objects(connection: &Connection) -> rusqlite::Result<Vec<SqliteObject>> {
    let mut objects = vec![SqliteObject {
        name: "sqlite_schema".to_string(),
        kind: "table".to_string(),
    }];
    let mut statement = connection
        .prepare("SELECT name, type FROM sqlite_schema WHERE type IN ('table', 'view')")?;
    let rows = statement.query_map([], |row| {
        Ok(SqliteObject {
            name: row.get(0)?,
            kind: row.get(1)?,
        })
    })?;
    for row in rows {
        objects.push(row?);
    }
    Ok(objects)
}

fn select_object<'a>(
    objects: &'a [SqliteObject],
    selected_name: Option<&str>,
) -> Result<Option<&'a SqliteObject>, String> {
    if let Some(name) = selected_name {
        return objects
            .iter()
            .find(|object| object.name == name)
            .ok_or_else(|| "選択したSQLiteオブジェクトが見つかりません".to_string())
            .map(Some);
    }
    Ok(objects
        .iter()
        .find(|object| object.kind == "table" && !object.name.starts_with("sqlite_"))
        .or_else(|| objects.first()))
}

fn quote_identifier(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

fn value_from_ref(value: rusqlite::Result<ValueRef<'_>>) -> Result<SqliteCell, String> {
    let value = value.map_err(|error| error.to_string())?;
    Ok(match value {
        ValueRef::Null => SqliteCell::Null,
        ValueRef::Integer(value) => SqliteCell::Integer {
            value: value.to_string(),
        },
        ValueRef::Real(value) => SqliteCell::Real {
            value: value.to_string(),
        },
        ValueRef::Text(value) => {
            let max_scan_bytes = MAX_TEXT_CHARS.saturating_mul(4).saturating_add(4);
            let slice_len = if value.len() > max_scan_bytes {
                let mut end = max_scan_bytes;
                while end > 0 && (value[end] & 0b1100_0000) == 0b1000_0000 {
                    end -= 1;
                }
                end
            } else {
                value.len()
            };
            let decoded = String::from_utf8_lossy(&value[..slice_len]);
            let mut chars = decoded.chars();
            let prefix: String = chars.by_ref().take(MAX_TEXT_CHARS).collect();
            let truncated = slice_len < value.len() || chars.next().is_some();
            SqliteCell::Text {
                value: prefix,
                truncated,
            }
        }
        ValueRef::Blob(value) => SqliteCell::Blob {
            bytes: value.len() as u64,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::{is_sqlite_preview_eligible, read_sqlite_preview, SqliteCell};
    use rusqlite::Connection;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_path() -> PathBuf {
        std::env::temp_dir().join(format!(
            "wasabipad-sqlite-preview-{}-{}.sqlite",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ))
    }

    fn test_path_with_extension(extension: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "wasabipad-sqlite-preview-{}-{}.{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            extension,
        ))
    }

    // Feature: SQLite候補拡張子の実ファイルを内容で選別する
    // Scenario: 候補拡張子とSQLiteヘッダーが一致する
    // Given: SQLiteの16バイトヘッダーを持つ通常ファイル
    // When: プレビュー適格性を調べる
    // Then: .db、.sqlite、.sqlite3を大文字小文字を問わず適格とする
    #[test]
    fn accepts_sqlite_header_for_candidate_extensions() {
        for extension in ["db", "sqlite", "sqlite3", "DB", "SQLITE", "SQLITE3"] {
            let path = test_path_with_extension(extension);
            std::fs::write(&path, b"SQLite format 3\0rest").unwrap();

            assert!(is_sqlite_preview_eligible(&path), "{extension}");
            let _ = std::fs::remove_file(path);
        }
    }

    // Feature: SQLite候補拡張子の実ファイルを内容で選別する
    // Scenario: ヘッダー不一致、短いファイル、対象外拡張子、非ファイル
    // Given: 候補拡張子の不正ファイルと、対象外拡張子のSQLiteヘッダーファイル
    // When: プレビュー適格性を調べる
    // Then: SQLite対象外として扱う
    #[test]
    fn rejects_non_sqlite_or_non_file_candidates() {
        let mismatch = test_path_with_extension("db");
        std::fs::write(&mismatch, b"not sqlite format").unwrap();
        assert!(!is_sqlite_preview_eligible(&mismatch));
        let _ = std::fs::remove_file(mismatch);

        let short = test_path_with_extension("sqlite");
        std::fs::write(&short, b"SQLite format 3").unwrap();
        assert!(!is_sqlite_preview_eligible(&short));
        let _ = std::fs::remove_file(short);

        let other_extension = test_path_with_extension("bin");
        std::fs::write(&other_extension, b"SQLite format 3\0rest").unwrap();
        assert!(!is_sqlite_preview_eligible(&other_extension));
        let _ = std::fs::remove_file(other_extension);

        let directory = std::env::temp_dir().join(format!(
            "wasabipad-sqlite-preview-{}-{}.db",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        std::fs::create_dir(&directory).unwrap();
        assert!(!is_sqlite_preview_eligible(&directory));
        let _ = std::fs::remove_dir(directory);
    }

    // Feature: SQLite形式の通常実ファイルをプレビューする
    // Scenario: 保存済みSQLiteを読み取り専用で開き、内部オブジェクトと値を表示する
    // Given: 通常テーブル、ビュー、NULL、BLOB、4096文字を超える文字列を持つDB
    // When: SQLiteプレビューを取得する
    // Then: 通常テーブルを初期選択し、値の種類を保った行とsqlite_schemaを返す
    #[test]
    fn reads_sqlite_objects_and_display_values_without_writing() {
        let path = test_path();
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE items (id INTEGER, note TEXT, data BLOB);\
                 INSERT INTO items VALUES (1, NULL, X'0102');\
                 INSERT INTO items VALUES (2, printf('%.*c', 4100, 'x'), NULL);\
                 CREATE VIEW item_view AS SELECT id FROM items;",
            )
            .unwrap();
        drop(connection);
        let before = std::fs::read(&path).unwrap();

        let preview = read_sqlite_preview(&path, None, 0, 100, true, None).unwrap();

        assert_eq!(preview.selected_name.as_deref(), Some("items"));
        assert!(preview
            .objects
            .iter()
            .any(|object| object.name == "sqlite_schema"));
        assert!(preview
            .objects
            .iter()
            .any(|object| object.name == "item_view"));
        assert!(matches!(preview.rows[0][1], SqliteCell::Null));
        assert!(matches!(preview.rows[0][2], SqliteCell::Blob { bytes: 2 }));
        assert!(matches!(
            preview.rows[1][1],
            SqliteCell::Text {
                truncated: true,
                ..
            }
        ));
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(preview.total_rows, Some(2));
        assert_eq!(preview.view_definition, None);

        let view = read_sqlite_preview(&path, Some("item_view"), 0, 100, true, None).unwrap();
        assert_eq!(view.columns, ["id"]);
        assert_eq!(view.rows.len(), 2);
        assert_eq!(view.total_rows, Some(2));
        assert!(view
            .view_definition
            .as_deref()
            .is_some_and(|sql| sql.contains("CREATE VIEW item_view")));

        let schema = read_sqlite_preview(&path, Some("sqlite_schema"), 0, 100, true, None).unwrap();
        assert!(schema.columns.iter().any(|column| column == "sql"));
        assert!(schema.rows.iter().any(|row| row.iter().any(|cell| {
            matches!(cell, SqliteCell::Text { value, .. } if value == "item_view")
        })));

        let _ = std::fs::remove_file(path);
    }

    // Feature: SQLite候補拡張子の実ファイルを内容で選別する
    // Scenario: SQLiteヘッダーを持つ.dbファイルをプレビューする
    // Given: .db拡張子の読み取り可能なSQLiteファイル
    // When: SQLiteプレビューを取得する
    // Then: 既存の読み取り専用SQLite表示を返す
    #[test]
    fn reads_sqlite_database_with_db_extension() {
        let path = test_path_with_extension("db");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch("CREATE TABLE items (id INTEGER); INSERT INTO items VALUES (7);")
            .unwrap();
        drop(connection);

        let preview = read_sqlite_preview(&path, Some("items"), 0, 100, false, None).unwrap();

        assert_eq!(preview.columns, ["id"]);
        assert!(matches!(&preview.rows[0][0], SqliteCell::Integer { value } if value == "7"));
        let _ = std::fs::remove_file(path);
    }

    // Feature: SQLite形式の通常実ファイルをプレビューする
    // Scenario: 指定したテーブルと表示範囲だけを読む
    // Given: itemsテーブルを持つSQLite
    // When: item_viewを選び、1行だけ取得する
    // Then: 選択したビューの列と行だけを返す
    #[test]
    fn reads_the_requested_object_and_page() {
        let path = test_path();
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch("CREATE TABLE items (id INTEGER); INSERT INTO items VALUES (1), (2);")
            .unwrap();
        drop(connection);

        let preview = read_sqlite_preview(&path, Some("items"), 1, 1, false, None).unwrap();

        assert_eq!(preview.columns, ["id"]);
        assert!(matches!(&preview.rows[0][0], SqliteCell::Integer { value } if value == "2"));
        assert!(!preview.has_more);
        assert_eq!(preview.total_rows, None);
        let _ = std::fs::remove_file(path);
    }

    // Feature: SQLiteプレビューのメタデータを必要なときだけ取得する
    // Scenario: JOINを含むビューの結果と定義SQLを同じ読取で取得する
    // Given: price_historyが複数テーブルをJOINするSQLiteビュー
    // When: ビューのメタデータ付きページを取得する
    // Then: 結果行、総行数、元のCREATE VIEW SQLを返す
    #[test]
    fn reads_view_definition_and_total_rows_with_metadata() {
        let path = test_path();
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                r#"
                    CREATE TABLE price_history (id INTEGER);
                    CREATE TABLE trading_days (id INTEGER);
                    CREATE TABLE instruments (id INTEGER);
                    CREATE TABLE quote_statuses (id INTEGER);
                    INSERT INTO price_history VALUES (1), (2);
                    INSERT INTO trading_days VALUES (1), (2);
                    INSERT INTO instruments VALUES (1), (2);
                    INSERT INTO quote_statuses VALUES (1), (2);
                    CREATE VIEW price_history_view AS
                    SELECT price_history.id
                    FROM price_history
                    JOIN trading_days ON trading_days.id = price_history.id
                    JOIN instruments ON instruments.id = price_history.id
                    JOIN quote_statuses ON quote_statuses.id = price_history.id;
                "#,
            )
            .unwrap();
        drop(connection);

        let preview =
            read_sqlite_preview(&path, Some("price_history_view"), 0, 100, true, None).unwrap();

        assert_eq!(preview.total_rows, Some(2));
        assert_eq!(preview.rows.len(), 2);
        assert!(preview.view_definition.as_deref().is_some_and(|sql| sql
            .contains("JOIN trading_days")
            && sql.contains("JOIN quote_statuses")));
        let _ = std::fs::remove_file(path);
    }

    // Feature: SQLite形式の通常実ファイルをプレビューする
    // Scenario: ヘッダーが一致しないファイルをSQLiteとして読まない
    // Given: `.db`の通常ファイル
    // When: SQLiteプレビューを取得する
    // Then: SQLite接続を開始せず対象外として失敗する
    #[test]
    fn rejects_candidate_file_without_sqlite_header() {
        let path = std::env::temp_dir().join(format!(
            "wasabipad-sqlite-preview-{}-{}.db",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        std::fs::write(&path, b"not sqlite").unwrap();

        let result = read_sqlite_preview(&path, None, 0, 100, false, None);
        assert!(result.is_err());
        let error = result.err().unwrap();

        assert!(error.contains("対象ファイルではありません"));
        let _ = std::fs::remove_file(path);
    }

    // Feature: SQLiteプレビューで一時ビューを確認する
    // Scenario: SELECTをページ単位で読み、元DBへ定義やデータを保存しない
    // Given: 読み取り対象のitemsテーブル
    // When: 単一のSELECTを一時ビューとして複数ページ読む
    // Then: 結果、総行数、SQL定義を返し、元DBの内容は変わらない
    #[test]
    fn reads_ephemeral_select_as_a_paged_view_without_writing_database() {
        let path = test_path();
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE items (id INTEGER); INSERT INTO items VALUES (1), (2), (3), (4);",
            )
            .unwrap();
        drop(connection);
        let before = std::fs::read(&path).unwrap();
        let query = "SELECT id FROM items ORDER BY id DESC";

        let first = read_sqlite_preview(&path, None, 0, 2, true, Some(query)).unwrap();
        assert_eq!(
            first.selected_name.as_deref(),
            Some("__wasabipad_temporary_view__")
        );
        assert_eq!(first.columns, ["id"]);
        assert_eq!(first.total_rows, Some(4));
        assert_eq!(first.view_definition.as_deref(), Some(query));
        assert!(matches!(&first.rows[0][0], SqliteCell::Integer { value } if value == "4"));
        assert!(first.objects.iter().any(|object| {
            object.name == "__wasabipad_temporary_view__" && object.kind == "temporary view"
        }));

        let second = read_sqlite_preview(
            &path,
            first.selected_name.as_deref(),
            2,
            2,
            false,
            Some(query),
        )
        .unwrap();
        assert!(matches!(&second.rows[0][0], SqliteCell::Integer { value } if value == "2"));
        assert_eq!(std::fs::read(&path).unwrap(), before);

        let connection = Connection::open(&path).unwrap();
        let saved_views: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'view' AND name = '__wasabipad_temporary_view__'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(saved_views, 0);
        let _ = std::fs::remove_file(path);
    }

    // Feature: SQLiteプレビューで一時ビューを確認する
    // Scenario: SELECT以外や複数ステートメントを拒否する
    // Given: 読み取り対象のitemsテーブル
    // When: DMLまたは追加ステートメントを含むSQLを渡す
    // Then: SQLを拒否し、元DBの内容を変えない
    #[test]
    fn rejects_writes_and_multiple_statements_for_ephemeral_views() {
        let path = test_path();
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch("CREATE TABLE items (id INTEGER); INSERT INTO items VALUES (1);")
            .unwrap();
        drop(connection);
        let before = std::fs::read(&path).unwrap();

        for query in [
            "DELETE FROM items",
            "VALUES (1)",
            "SELECT id FROM items; DROP TABLE items",
        ] {
            assert!(
                read_sqlite_preview(&path, None, 0, 10, true, Some(query)).is_err(),
                "{query}"
            );
            assert_eq!(std::fs::read(&path).unwrap(), before, "{query}");
        }

        let _ = std::fs::remove_file(path);
    }

    // Feature: SQLiteプレビューのクエリタイムアウト
    // Scenario: 無限再帰CTEの一時クエリおよび悪意あるVIEWを時間制限で中断する
    // Given: 無限再帰CTEを含むVIEWを持つSQLiteデータベース
    // When: 短いタイムアウトで一時クエリまたはVIEWのプレビューを実行する
    // Then: ハングせずタイムアウトエラーで終了する
    #[test]
    fn infinite_recursive_cte_query_and_view_time_out_safely() {
        let path = test_path();
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE VIEW endless AS WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM cnt) SELECT x FROM cnt;",
            )
            .unwrap();
        drop(connection);

        let timeout = std::time::Duration::from_millis(50);
        let view_err = super::read_sqlite_preview_with_timeout(&path, Some("endless"), 0, 10, true, None, timeout)
            .err()
            .expect("infinite view should time out");
        assert!(view_err.contains("タイムアウト"), "unexpected error: {view_err}");

        let query = "SELECT COUNT(*) FROM (WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM cnt) SELECT x FROM cnt)";
        let query_err = super::read_sqlite_preview_with_timeout(&path, None, 0, 10, false, Some(query), timeout)
            .err()
            .expect("infinite query should time out");
        assert!(query_err.contains("タイムアウト"), "unexpected error: {query_err}");

        let _ = std::fs::remove_file(path);
    }
}

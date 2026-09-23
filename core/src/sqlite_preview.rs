use rusqlite::{params, types::ValueRef, Connection, OpenFlags, OptionalExtension};
use std::path::Path;

const MAX_TEXT_CHARS: usize = 4096;

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
) -> Result<SqlitePreview, String> {
    if !is_sqlite_path(path) || !path.is_file() {
        return Err("SQLiteプレビューの対象ファイルではありません".to_string());
    }
    if limit == 0 {
        return Err("表示行数は1以上で指定してください".to_string());
    }
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| error.to_string())?;
    let objects = sqlite_objects(&connection).map_err(|error| error.to_string())?;
    let selected_name = select_object(&objects, selected_name)?.map(|object| object.name.clone());
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

    let is_view = objects
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
                Err(error) => (None, Some(format!("総行数を取得できませんでした: {error}"))),
            };
        let (view_definition, definition_error) = if is_view {
            match connection
                .query_row(
                    "SELECT sql FROM sqlite_schema WHERE type = 'view' AND name = ?1",
                    params![selected_name],
                    |row| row.get::<_, String>(0),
                )
                .optional()
            {
                Ok(definition) => (definition, None),
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
        .map_err(|error| error.to_string())?;
    let columns = statement
        .column_names()
        .into_iter()
        .map(str::to_string)
        .collect::<Vec<_>>();
    let mut result_rows = Vec::new();
    let mut rows = statement
        .query(params![fetch_limit, offset])
        .map_err(|error| error.to_string())?;
    while let Some(row) = rows.next().map_err(|error| error.to_string())? {
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

fn is_sqlite_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("sqlite") || extension.eq_ignore_ascii_case("sqlite3")
        })
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
            let value = String::from_utf8_lossy(value).into_owned();
            let truncated = value.chars().count() > MAX_TEXT_CHARS;
            SqliteCell::Text {
                value: value.chars().take(MAX_TEXT_CHARS).collect(),
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
    use super::{read_sqlite_preview, SqliteCell};
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

        let preview = read_sqlite_preview(&path, None, 0, 100, true).unwrap();

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

        let view = read_sqlite_preview(&path, Some("item_view"), 0, 100, true).unwrap();
        assert_eq!(view.columns, ["id"]);
        assert_eq!(view.rows.len(), 2);
        assert_eq!(view.total_rows, Some(2));
        assert!(view
            .view_definition
            .as_deref()
            .is_some_and(|sql| sql.contains("CREATE VIEW item_view")));

        let schema = read_sqlite_preview(&path, Some("sqlite_schema"), 0, 100, true).unwrap();
        assert!(schema.columns.iter().any(|column| column == "sql"));
        assert!(schema.rows.iter().any(|row| row.iter().any(|cell| {
            matches!(cell, SqliteCell::Text { value, .. } if value == "item_view")
        })));

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

        let preview = read_sqlite_preview(&path, Some("items"), 1, 1, false).unwrap();

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

        let preview = read_sqlite_preview(&path, Some("price_history_view"), 0, 100, true).unwrap();

        assert_eq!(preview.total_rows, Some(2));
        assert_eq!(preview.rows.len(), 2);
        assert!(preview.view_definition.as_deref().is_some_and(|sql| sql
            .contains("JOIN trading_days")
            && sql.contains("JOIN quote_statuses")));
        let _ = std::fs::remove_file(path);
    }

    // Feature: SQLite形式の通常実ファイルをプレビューする
    // Scenario: 対象外拡張子をSQLiteとして読まない
    // Given: `.db`のファイル
    // When: SQLiteプレビューを取得する
    // Then: SQLite接続を開始せず対象外として失敗する
    #[test]
    fn rejects_non_sqlite_extension() {
        let path = std::env::temp_dir().join(format!(
            "wasabipad-sqlite-preview-{}-{}.db",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        std::fs::write(&path, []).unwrap();

        let result = read_sqlite_preview(&path, None, 0, 100, false);
        assert!(result.is_err());
        let error = result.err().unwrap();

        assert!(error.contains("対象ファイルではありません"));
        let _ = std::fs::remove_file(path);
    }
}

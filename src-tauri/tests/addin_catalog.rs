#[path = "../src/addin_catalog.rs"]
mod addin_catalog;
#[path = "../src/addin_manager.rs"]
mod addin_manager;

use addin_manager::{install_verified_archive, list_local_status};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

struct TestRoot(PathBuf);

impl TestRoot {
    fn new() -> Self {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock is after UNIX epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "wasabipad-addin-catalog-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("create isolated app data root");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn local_response(body: Vec<u8>) -> (String, thread::JoinHandle<()>) {
    let length = body.len() as u64;
    local_response_declared(body, length, None)
}

fn local_response_declared(
    body: Vec<u8>,
    declared_length: u64,
    bytes_to_send: Option<usize>,
) -> (String, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind local catalog server");
    let address = listener.local_addr().unwrap();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept catalog request");
        read_request(&mut stream);
        write_response(
            &mut stream,
            200,
            &body,
            Some(declared_length),
            bytes_to_send,
        );
    });
    (format!("http://{address}/file"), server)
}

fn read_request(stream: &mut TcpStream) {
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(2)))
        .unwrap();
    let mut request = Vec::new();
    let mut buffer = [0; 1024];
    while !request.windows(4).any(|window| window == b"\r\n\r\n") {
        let read = stream.read(&mut buffer).expect("read HTTP request");
        if read == 0 {
            break;
        }
        request.extend_from_slice(&buffer[..read]);
    }
}

fn write_response(
    stream: &mut TcpStream,
    status: u16,
    body: &[u8],
    content_length: Option<u64>,
    bytes_to_send: Option<usize>,
) {
    let reason = if status == 200 { "OK" } else { "Error" };
    let length = content_length.unwrap_or(body.len() as u64);
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n"
    )
    .expect("write HTTP response headers");
    let body_len = bytes_to_send.unwrap_or(body.len()).min(body.len());
    stream
        .write_all(&body[..body_len])
        .expect("write HTTP response body");
}

fn valid_catalog() -> Vec<u8> {
    valid_catalog_with("1.0.0", &"a".repeat(64))
}

fn valid_catalog_with(version: &str, digest: &str) -> Vec<u8> {
    format!(
        r#"{{"schema":1,"addons":[{{"id":"abc","version":"{version}","minimumAppVersion":"1.7.0","archiveUrl":"https://github.com/hama55/WasabiPad/releases/download/v{version}/abc-{version}.zip","sha256":"{digest}"}}]}}"#,
    )
    .into_bytes()
}

fn catalog_with_compatible_and_future_addons() -> Vec<u8> {
    format!(
        r#"{{"schema":1,"addons":[{{"id":"abc","version":"1.1.0","minimumAppVersion":"1.7.0","archiveUrl":"https://github.com/hama55/WasabiPad/releases/download/v1.1.0/abc-1.1.0.zip","sha256":"{}"}},{{"id":"lilypond","version":"1.1.0","minimumAppVersion":"9.0.0","archiveUrl":"https://github.com/hama55/WasabiPad/releases/download/v1.1.0/lilypond-1.1.0.zip","sha256":"{}"}}]}}"#,
        "a".repeat(64),
        "b".repeat(64),
    )
    .into_bytes()
}

fn make_archive(root: &Path, id: &str, version: &str) -> (Vec<u8>, String) {
    let file = fs::File::create(root.join("package.zip")).expect("create archive fixture");
    let mut archive = ZipWriter::new(file);
    archive
        .start_file("addon.json", SimpleFileOptions::default())
        .unwrap();
    write!(archive, r#"{{"id":"{id}","version":"{version}","entry":"dist/entry.js","minimumAppVersion":"1.7.0"}}"#).unwrap();
    archive
        .start_file("dist/entry.js", SimpleFileOptions::default())
        .unwrap();
    archive.write_all(b"export const entry = true;").unwrap();
    archive.finish().unwrap();
    let bytes = fs::read(root.join("package.zip")).unwrap();
    let digest = format!("{:x}", Sha256::digest(&bytes));
    (bytes, digest)
}

fn install_initial_abc(root: &Path) {
    let (archive, digest) = make_archive(root, "abc", "1.0.0");
    let path = root.join("initial.zip");
    fs::write(&path, archive).unwrap();
    install_verified_archive(root, "abc", "1.0.0", &path, &digest).unwrap();
}

// Feature: 公式アドインカタログを取得する
// Scenario: 互換性と公式URLを満たすカタログを読む
// Given: schema 1でABCを1件記載したHTTP応答
// When: テスト用URLからカタログを取得する
// Then: ABCの版・URL・SHA-256を含む項目を返す
#[test]
fn fetches_and_parses_valid_catalog_from_local_server() {
    let (url, server) = local_response(valid_catalog());

    let catalog = addin_catalog::fetch_official_catalog_at(&url).unwrap();

    assert_eq!(catalog.len(), 1);
    assert_eq!(catalog[0].id, "abc");
    assert_eq!(catalog[0].version, "1.0.0");
    assert_eq!(catalog[0].minimum_app_version, "1.7.0");
    assert_eq!(
        catalog[0].archive_url,
        "https://github.com/hama55/WasabiPad/releases/download/v1.0.0/abc-1.0.0.zip"
    );
    assert_eq!(catalog[0].sha256, "a".repeat(64));
    server.join().unwrap();
}

// Feature: 公式アドインカタログの互換性表示
// Scenario: 互換版と将来版を同時に返す
// Given: 現在版に互換なABCと、より新しいWasabiPadを必要とするLilyPondを含むカタログ
// When: テスト用URLからカタログを取得する
// Then: 一覧全体を返し、各項目に互換性を示す
#[test]
fn returns_compatible_and_future_addons_together() {
    let (url, server) = local_response(catalog_with_compatible_and_future_addons());

    let catalog = addin_catalog::fetch_official_catalog_at(&url).unwrap();

    assert_eq!(catalog.len(), 2);
    assert_eq!(catalog[0].id, "abc");
    assert!(catalog[0].compatible);
    assert_eq!(catalog[1].id, "lilypond");
    assert!(!catalog[1].compatible);
    server.join().unwrap();
}

// Feature: 公式アドインカタログを取得する
// Scenario: GitHub Releases以外の配布元を拒否する
// Given: カタログのarchiveUrlが任意ホストを指す
// When: テスト用URLからカタログを取得する
// Then: カタログ全体を不正として拒否する
#[test]
fn rejects_non_official_archive_url() {
    let catalog = String::from_utf8(valid_catalog()).unwrap().replace(
        "https://github.com/hama55/WasabiPad/releases/download/",
        "https://evil.example/releases/download/",
    );
    let (url, server) = local_response(catalog.into_bytes());

    assert!(addin_catalog::fetch_official_catalog_at(&url).is_err());
    server.join().unwrap();
}

// Feature: 公式アドインカタログを取得する
// Scenario: 1 MiBを超える応答を拒否する
// Given: 上限より1 byte大きいHTTPカタログ
// When: カタログ取得を実行する
// Then: JSON解析前にサイズ超過として失敗する
#[test]
fn rejects_catalog_larger_than_one_mib() {
    let (url, server) = local_response(vec![b' '; 1024 * 1024 + 1]);

    assert!(addin_catalog::fetch_official_catalog_at(&url)
        .unwrap_err()
        .contains("size limit"));
    server.join().unwrap();
}

// Feature: 公式アドインを取得して導入する
// Scenario: 正しい配布物を取得して旧版を更新する
// Given: 公式カタログとSHA-256が一致する1.1.0 ZIP
// When: ローカルHTTP応答を使ってABCを更新する
// Then: 1.1.0のready packageと有効な状態を保存する
#[test]
fn downloads_and_installs_verified_update() {
    let root = TestRoot::new();
    install_initial_abc(root.path());
    let (archive, digest) = make_archive(root.path(), "abc", "1.1.0");
    let (catalog_url, catalog_server) = local_response(valid_catalog_with("1.1.0", &digest));
    let (archive_url, archive_server) = local_response(archive);

    addin_catalog::install_or_update_official_at(root.path(), "abc", &catalog_url, &archive_url)
        .unwrap();

    catalog_server.join().unwrap();
    archive_server.join().unwrap();
    let status = list_local_status(root.path()).unwrap();
    let abc = status.iter().find(|addon| addon.id == "abc").unwrap();
    assert_eq!(abc.version.as_deref(), Some("1.1.0"));
    assert!(abc.installed && abc.enabled);
    assert!(root.path().join("addins/abc/1.1.0/.ready").is_file());
}

// Feature: 非互換な公式アドインの導入拒否
// Scenario: 将来版を選んでも既存版を維持する
// Given: LilyPond 1.0.0が導入済みで、カタログのLilyPond 1.1.0は将来のWasabiPadを必要とする
// When: LilyPondを公式カタログから更新する
// Then: ダウンロード前に拒否し、導入済み1.0.0を保持する
#[test]
fn rejects_future_addon_before_download_and_keeps_installed_version() {
    let root = TestRoot::new();
    let (archive, digest) = make_archive(root.path(), "lilypond", "1.0.0");
    let path = root.path().join("initial-lilypond.zip");
    fs::write(&path, archive).unwrap();
    install_verified_archive(root.path(), "lilypond", "1.0.0", &path, &digest).unwrap();
    let (catalog_url, catalog_server) = local_response(catalog_with_compatible_and_future_addons());

    let error = addin_catalog::install_or_update_official_at(
        root.path(),
        "lilypond",
        &catalog_url,
        "http://127.0.0.1:1/unreachable.zip",
    )
    .expect_err("future addin must not download");

    assert!(error.contains("requires a newer WasabiPad version"));
    catalog_server.join().unwrap();
    let lilypond = list_local_status(root.path())
        .unwrap()
        .into_iter()
        .find(|addon| addon.id == "lilypond")
        .unwrap();
    assert_eq!(lilypond.version.as_deref(), Some("1.0.0"));
    assert!(lilypond.installed && lilypond.enabled);
}

// Feature: 公式アドインを取得して導入する
// Scenario: SHA-256不一致時に既存版を保持する
// Given: 有効な1.0.0と、内容が不一致の1.1.0 ZIP応答
// When: 公式カタログから1.1.0へ更新する
// Then: 更新に失敗し1.0.0の状態とファイルを保持する
#[test]
fn keeps_previous_version_when_archive_hash_mismatches() {
    let root = TestRoot::new();
    install_initial_abc(root.path());
    let (_expected_archive, digest) = make_archive(root.path(), "abc", "1.1.0");
    let (catalog_url, catalog_server) = local_response(valid_catalog_with("1.1.0", &digest));
    let (archive_url, archive_server) = local_response(b"not the expected ZIP".to_vec());

    let result = addin_catalog::install_or_update_official_at(
        root.path(),
        "abc",
        &catalog_url,
        &archive_url,
    );

    assert!(result.is_err());
    catalog_server.join().unwrap();
    archive_server.join().unwrap();
    let status = list_local_status(root.path()).unwrap();
    let abc = status.iter().find(|addon| addon.id == "abc").unwrap();
    assert_eq!(abc.version.as_deref(), Some("1.0.0"));
    assert!(abc.installed && abc.enabled);
}

// Feature: 公式アドインを取得して導入する
// Scenario: ダウンロードが途中で切れた場合に既存版を保持する
// Given: 有効な1.0.0とContent-Lengthに届かない1.1.0応答
// When: 公式カタログから1.1.0へ更新する
// Then: 更新に失敗し1.0.0の状態を保持する
#[test]
fn keeps_previous_version_when_archive_download_is_interrupted() {
    let root = TestRoot::new();
    install_initial_abc(root.path());
    let (archive, digest) = make_archive(root.path(), "abc", "1.1.0");
    let (catalog_url, catalog_server) = local_response(valid_catalog_with("1.1.0", &digest));
    let (archive_url, archive_server) =
        local_response_declared(archive.clone(), archive.len() as u64 + 500, Some(10));

    let result = addin_catalog::install_or_update_official_at(
        root.path(),
        "abc",
        &catalog_url,
        &archive_url,
    );

    assert!(result.is_err());
    catalog_server.join().unwrap();
    archive_server.join().unwrap();
    let status = list_local_status(root.path()).unwrap();
    let abc = status.iter().find(|addon| addon.id == "abc").unwrap();
    assert_eq!(abc.version.as_deref(), Some("1.0.0"));
    assert!(abc.installed && abc.enabled);
}

// Feature: 公式アドインを取得して導入する
// Scenario: 256 MiBを超えるarchive応答を拒否する
// Given: 上限を超えるContent-Lengthを返す公式カタログとHTTP応答
// When: ダウンロード導入を実行する
// Then: archive bodyを保存せずサイズ超過として失敗する
#[test]
fn rejects_archive_larger_than_256_mib() {
    let root = TestRoot::new();
    let (catalog_url, catalog_server) = local_response(valid_catalog());
    let (archive_url, archive_server) =
        local_response_declared(Vec::new(), 256 * 1024 * 1024 + 1, Some(0));

    let result = addin_catalog::install_or_update_official_at(
        root.path(),
        "abc",
        &catalog_url,
        &archive_url,
    );

    assert!(result.unwrap_err().contains("size limit"));
    catalog_server.join().unwrap();
    archive_server.join().unwrap();
    assert!(list_local_status(root.path())
        .unwrap()
        .iter()
        .all(|addon| !addon.installed));
}

use std::fs;
use std::path::{Component, Path};

use tauri::http::{header, Method, Request, Response, StatusCode};

pub(crate) fn handle_request(app_data_root: &Path, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    if request.method() == Method::OPTIONS {
        return response(StatusCode::NO_CONTENT, None, Vec::new(), true);
    }
    if request.method() != Method::GET {
        return forbidden_response();
    }
    let uri = request.uri();
    if uri.scheme_str() != Some("http")
        || !uri.host().map_or(false, |host| {
            host.eq_ignore_ascii_case("wasabi-addin.localhost")
        })
    {
        return not_found_response();
    }

    let decoded_path = match percent_decode_path(uri.path()) {
        Some(path) => path,
        None => return forbidden_response(),
    };
    let Some(path) = decoded_path.strip_prefix('/') else {
        return forbidden_response();
    };
    let segments: Vec<&str> = path.split('/').collect();
    if segments.len() < 3 || segments.iter().any(|segment| segment.is_empty()) {
        return not_found_response();
    }

    let addon_id = segments[0];
    if !crate::addin_manager::ADDON_IDS.contains(&addon_id) {
        return not_found_response();
    }
    let version = segments[1];
    if !is_safe_version_segment(version)
        || !segments[2..]
            .iter()
            .all(|segment| is_safe_asset_segment(segment))
    {
        return forbidden_response();
    }

    if !matches!(
        crate::addin_manager::is_enabled_version(app_data_root, addon_id, version),
        Ok(true)
    ) {
        return not_found_response();
    }

    let addins_root = app_data_root.join("addins");
    let canonical_addins_root = match fs::canonicalize(addins_root) {
        Ok(path) => path,
        Err(_) => return not_found_response(),
    };
    let package_root = match fs::canonicalize(canonical_addins_root.join(addon_id).join(version)) {
        Ok(path) => path,
        Err(_) => return not_found_response(),
    };
    if !package_root.starts_with(&canonical_addins_root) {
        return forbidden_response();
    }
    if !package_root.is_dir() {
        return not_found_response();
    }

    if !matches!(
        fs::symlink_metadata(package_root.join(".ready")),
        Ok(metadata) if metadata.file_type().is_file()
    ) {
        return not_found_response();
    }

    let requested_path = segments[2..]
        .iter()
        .fold(package_root.clone(), |mut path, segment| {
            path.push(segment);
            path
        });
    let canonical_file = match fs::canonicalize(requested_path) {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            return forbidden_response();
        }
        Err(_) => return not_found_response(),
    };
    if !canonical_file.starts_with(&package_root) {
        return forbidden_response();
    }
    match fs::metadata(&canonical_file) {
        Ok(metadata) if metadata.is_file() => {}
        _ => return not_found_response(),
    }

    let Some(content_type) = content_type(&canonical_file) else {
        return not_found_response();
    };
    match fs::read(canonical_file) {
        Ok(body) => response(StatusCode::OK, Some(content_type), body, false),
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => forbidden_response(),
        Err(_) => not_found_response(),
    }
}

pub(crate) fn not_found_response() -> Response<Vec<u8>> {
    response(StatusCode::NOT_FOUND, None, Vec::new(), false)
}

fn forbidden_response() -> Response<Vec<u8>> {
    response(StatusCode::FORBIDDEN, None, Vec::new(), false)
}

fn response(
    status: StatusCode,
    content_type: Option<&'static str>,
    body: Vec<u8>,
    preflight: bool,
) -> Response<Vec<u8>> {
    let mut builder = Response::builder()
        .status(status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff");
    if let Some(content_type) = content_type {
        builder = builder.header(header::CONTENT_TYPE, content_type);
    }
    if preflight {
        builder = builder.header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, OPTIONS");
    }
    builder
        .body(body)
        .expect("static response headers are valid")
}

fn percent_decode_path(path: &str) -> Option<String> {
    let encoded = path.as_bytes();
    let mut decoded = Vec::with_capacity(encoded.len());
    let mut index = 0;
    while index < encoded.len() {
        if encoded[index] != b'%' {
            decoded.push(encoded[index]);
            index += 1;
            continue;
        }
        let high = hex_nibble(*encoded.get(index + 1)?)?;
        let low = hex_nibble(*encoded.get(index + 2)?)?;
        decoded.push((high << 4) | low);
        index += 3;
    }
    String::from_utf8(decoded).ok()
}

fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn is_safe_version_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment != "."
        && segment != ".."
        && segment.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '+')
        })
}

fn is_safe_asset_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment != "."
        && segment != ".."
        && !segment
            .chars()
            .any(|character| character == '\\' || character == ':' || character.is_control())
        && Path::new(segment)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn content_type(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "js" | "mjs" => Some("text/javascript; charset=utf-8"),
        "css" => Some("text/css; charset=utf-8"),
        "json" => Some("application/json"),
        "mp3" => Some("audio/mpeg"),
        "ogg" => Some("audio/ogg"),
        "sf2" | "sf3" => Some("application/octet-stream"),
        "wasm" => Some("application/wasm"),
        "svg" => Some("image/svg+xml"),
        "png" => Some("image/png"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    use tauri::http::{header, Method, Request, StatusCode};

    use super::handle_request;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock is after UNIX epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "wasabipad-addin-assets-{}-{unique}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create test directory");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn get_request(uri: &str) -> Request<Vec<u8>> {
        Request::builder()
            .method(Method::GET)
            .uri(uri)
            .body(Vec::new())
            .expect("valid test request")
    }

    fn ready_package(app_data_root: &Path, addon_id: &str) -> PathBuf {
        let addins_root = app_data_root.join("addins");
        let package_root = addins_root.join(addon_id).join("1.0.0");
        fs::create_dir_all(&package_root).expect("create package directory");
        fs::write(package_root.join(".ready"), b"ready").expect("write ready marker");
        fs::write(
            addins_root.join("state.json"),
            format!(r#"{{"{addon_id}":{{"version":"1.0.0","enabled":true}}}}"#),
        )
        .expect("write enabled addin state");
        package_root
    }

    // Feature: 公式アドインの静的資産をローカル配信する
    // Scenario: 導入済みパッケージの許可されたJavaScriptを返す
    // Given: .readyがあり、パッケージ内にmain.jsがある
    // When: 対応するwasabi-addin URLへGETする
    // Then: JavaScript本文、MIME、CORS許可、nosniffを返す
    #[test]
    fn serves_allowed_javascript_asset() {
        let fixture = TestDirectory::new();
        let package_root = ready_package(fixture.path(), "abc");
        fs::write(package_root.join("main.js"), b"export const ready = true;")
            .expect("write JavaScript fixture");

        let response = handle_request(
            fixture.path(),
            get_request("http://wasabi-addin.localhost/abc/1.0.0/main.js"),
        );

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "text/javascript; charset=utf-8"
        );
        assert_eq!(response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
        assert_eq!(
            response.headers()[header::X_CONTENT_TYPE_OPTIONS],
            "nosniff"
        );
        assert_eq!(response.body(), b"export const ready = true;");
    }

    // Feature: 公式アドインIDの資産配信
    // Scenario: managerで許可する公式IDの資産を配信する
    // Given: managerが列挙する各公式IDの有効なパッケージがある
    // When: 各IDのwasabi-addin URLへGETする
    // Then: IDを個別に重複列挙せず、すべてJavaScript資産を返す
    #[test]
    fn serves_assets_for_each_official_addon_id() {
        for addon_id in crate::addin_manager::ADDON_IDS {
            let fixture = TestDirectory::new();
            let package_root = ready_package(fixture.path(), addon_id);
            fs::write(package_root.join("main.js"), b"export const ready = true;")
                .expect("write JavaScript fixture");

            let response = handle_request(
                fixture.path(),
                get_request(&format!(
                    "http://wasabi-addin.localhost/{addon_id}/1.0.0/main.js"
                )),
            );

            assert_eq!(response.status(), StatusCode::OK, "addon id: {addon_id}");
        }
    }

    // Feature: 公式アドイン資産の配信を有効状態へ連動させる
    // Scenario: .readyがあっても無効化済みの版は配信しない
    // Given: assetと.readyがありstate.jsonでabcが無効
    // When: 対応URLへGETする
    // Then: Not Foundとなりasset本文を返さない
    #[test]
    fn does_not_serve_disabled_addin_version() {
        let fixture = TestDirectory::new();
        let package_root = ready_package(fixture.path(), "abc");
        fs::write(package_root.join("main.js"), b"export const ready = true;")
            .expect("write JavaScript fixture");
        fs::write(
            fixture.path().join("addins/state.json"),
            br#"{"abc":{"version":"1.0.0","enabled":false}}"#,
        )
        .expect("disable addin state");

        let response = handle_request(
            fixture.path(),
            get_request("http://wasabi-addin.localhost/abc/1.0.0/main.js"),
        );

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert!(response.body().is_empty());
    }

    // Feature: 公式アドインの静的資産をパッケージ境界内に制限する
    // Scenario: percent-encoded traversalと外部へ向くシンボリックリンクを拒否する
    // Given: 有効なパッケージと、その外にあるJavaScript資産
    // When: traversalまたは外向きリンクを含むURLをGETする
    // Then: どちらもForbiddenで拒否し、パッケージ外の本文を返さない
    #[test]
    fn rejects_traversal_and_symlinks_escaping_package_root() {
        let fixture = TestDirectory::new();
        let package_root = ready_package(fixture.path(), "abc");
        let outside_path = fixture.path().join("outside.js");
        fs::write(&outside_path, b"outside package").expect("write outside fixture");

        let traversal = handle_request(
            fixture.path(),
            get_request("http://wasabi-addin.localhost/abc/1.0.0/%2e%2e/%2e%2e/%2e%2e/outside.js"),
        );
        assert_eq!(traversal.status(), StatusCode::FORBIDDEN);
        assert!(traversal.body().is_empty());

        #[cfg(windows)]
        let symlink_result =
            std::os::windows::fs::symlink_file(&outside_path, package_root.join("link.js"));
        #[cfg(unix)]
        let symlink_result =
            std::os::unix::fs::symlink(&outside_path, package_root.join("link.js"));
        if let Err(error) = symlink_result {
            #[cfg(windows)]
            let permission_unavailable = error.kind() == std::io::ErrorKind::PermissionDenied
                || error.raw_os_error() == Some(1314); // ERROR_PRIVILEGE_NOT_HELD
            #[cfg(unix)]
            let permission_unavailable = error.kind() == std::io::ErrorKind::PermissionDenied;
            if permission_unavailable {
                eprintln!("Skipping symlink assertion: creating a symlink requires unavailable permission: {error}");
                return;
            }
            panic!("create file symlink fixture: {error}");
        }

        let symlink = handle_request(
            fixture.path(),
            get_request("http://wasabi-addin.localhost/abc/1.0.0/link.js"),
        );
        assert_eq!(symlink.status(), StatusCode::FORBIDDEN);
        assert!(symlink.body().is_empty());
    }
}

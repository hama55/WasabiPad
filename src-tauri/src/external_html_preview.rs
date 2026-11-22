use std::{
    collections::HashMap,
    io::Read,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::http::{Method, Request, Response};

const MAX_EXTERNAL_ASSET_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Default)]
pub(crate) struct ExternalHtmlPreviews(Mutex<HashMap<String, Arc<ExternalHtmlPreview>>>);

struct ExternalHtmlPreview {
    root: PathBuf,
}

fn validate_preview_id(id: &str) -> Result<(), String> {
    if id.len() != 36
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
    {
        return Err("Invalid external HTML preview id".into());
    }
    Ok(())
}

impl ExternalHtmlPreviews {
    pub(crate) fn register(&self, id: String, entry_path: PathBuf) -> Result<(), String> {
        validate_preview_id(&id)?;
        if !entry_path.is_absolute() {
            return Err("External HTML preview entry path must be absolute".into());
        }
        let canonical_entry = entry_path
            .canonicalize()
            .map_err(|error| format!("External HTML preview entry could not be resolved: {error}"))?;
        if !canonical_entry.is_file() {
            return Err("External HTML preview entry is not a regular file".into());
        }
        let ext = canonical_entry
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase());
        if !matches!(ext.as_deref(), Some("html" | "htm")) {
            return Err("External HTML preview entry must be an HTML file".into());
        }
        let root = canonical_entry
            .parent()
            .ok_or_else(|| "External HTML preview entry has no parent directory".to_owned())?
            .canonicalize()
            .map_err(|error| format!("External HTML preview root could not be resolved: {error}"))?;
        if !canonical_entry.starts_with(&root) {
            return Err("External HTML preview entry escaped its root directory".into());
        }
        self.0
            .lock()
            .map_err(|error| error.to_string())?
            .insert(id, Arc::new(ExternalHtmlPreview { root }));
        Ok(())
    }

    pub(crate) fn remove(&self, id: &str) -> Result<(), String> {
        self.0.lock().map_err(|error| error.to_string())?.remove(id);
        Ok(())
    }

    pub(crate) fn serve(&self, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
        let method = request.method().clone();
        let data = (|| {
            if method != Method::GET && method != Method::HEAD {
                return None;
            }
            let (id, raw_path) = request.uri().path().strip_prefix('/')?.split_once('/')?;
            let preview = self.0.lock().ok()?.get(id)?.clone();
            let decoded = percent_encoding::percent_decode_str(raw_path)
                .decode_utf8()
                .ok()?;
            let path = scoped_asset(&preview.root, &decoded)?;
            let file = std::fs::File::open(&path).ok()?;
            let len = file.metadata().ok()?.len();
            if len > MAX_EXTERNAL_ASSET_BYTES {
                return None;
            }
            let bytes = if method == Method::HEAD {
                Vec::new()
            } else {
                let mut buf = Vec::with_capacity(len.min(1024 * 1024) as usize);
                file.take(MAX_EXTERNAL_ASSET_BYTES + 1)
                    .read_to_end(&mut buf)
                    .ok()?;
                if buf.len() as u64 > MAX_EXTERNAL_ASSET_BYTES {
                    return None;
                }
                buf
            };
            let mime = external_asset_type(&path);
            Response::builder()
                .status(200)
                .header("Content-Type", mime)
                .header("Content-Length", len.to_string())
                .header("Access-Control-Allow-Origin", "*")
                .header("X-Content-Type-Options", "nosniff")
                .header("Cache-Control", "no-store")
                .body(bytes)
                .ok()
        })();
        data.unwrap_or_else(|| Response::builder().status(404).body(Vec::new()).unwrap())
    }
}

fn scoped_asset(root: &Path, relative: &str) -> Option<PathBuf> {
    if relative.is_empty() || relative.contains(['\\', ':', '\0']) {
        return None;
    }
    let relative_path = Path::new(relative);
    let mut has_component = false;
    for component in relative_path.components() {
        match component {
            Component::Normal(_) => has_component = true,
            _ => return None,
        }
    }
    if !has_component {
        return None;
    }
    let path = root.join(relative_path).canonicalize().ok()?;
    (path.starts_with(root) && path.is_file()).then_some(path)
}

fn external_asset_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("html" | "htm") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json" | "map") => "application/json; charset=utf-8",
        Some("wasm") => "application/wasm",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("avif") => "image/avif",
        Some("ico") => "image/x-icon",
        Some("bmp") => "image/bmp",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("ogg") => "audio/ogg",
        Some("flac") => "audio/flac",
        Some("m4a") => "audio/mp4",
        Some("aac") => "audio/aac",
        Some("mid" | "midi") => "audio/midi",
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("vtt") => "text/vtt; charset=utf-8",
        Some("xml" | "musicxml" | "mei") => "application/xml; charset=utf-8",
        Some("txt" | "csv") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "wasabipad-ext-html-{label}-{}-{nanos}",
            std::process::id()
        ))
    }

    // Feature: 外部HTMLプレビュー専用プロトコル wasabi-ext:
    // Scenario: 登録ディレクトリ配下のHTMLと資産だけを配信し、上位ディレクトリと未登録IDを拒否する
    // Given: 登録済み外部HTML出力と同じフォルダの資産および親フォルダの機密ファイル
    // When: wasabi-ext: 経由で入口HTML・相対資産・トラバーサルパス・解除後パスを要求する
    // Then: 配下のファイルだけ200で返し、親フォルダ参照や解除後IDは404を返す
    #[test]
    fn serves_registered_directory_only_and_rejects_traversal() {
        let parent = unique_dir("scope");
        let job = parent.join("job");
        let assets = job.join("assets");
        std::fs::create_dir_all(&assets).unwrap();
        let entry = job.join("score #1.html");
        std::fs::write(&entry, "<!doctype html><p>score</p>").unwrap();
        std::fs::write(assets.join("player.js"), "console.log(1)").unwrap();
        std::fs::write(parent.join("secret.txt"), "top-secret").unwrap();

        let previews = ExternalHtmlPreviews::default();
        let id = "835b41d8-d3a4-40af-979c-e9feb50e9ee2";
        previews.register(id.into(), entry).unwrap();

        let req = |path: &str| {
            Request::builder()
                .uri(format!("/{id}/{path}"))
                .body(Vec::new())
                .unwrap()
        };

        let html = previews.serve(req("score%20%231.html"));
        assert_eq!(html.status(), 200);
        assert_eq!(
            html.headers().get("Content-Type").unwrap(),
            "text/html; charset=utf-8"
        );
        assert_eq!(
            html.headers().get("Access-Control-Allow-Origin").unwrap(),
            "*"
        );
        assert_eq!(html.body(), b"<!doctype html><p>score</p>");

        let js = previews.serve(req("assets/player.js"));
        assert_eq!(js.status(), 200);
        assert_eq!(
            js.headers().get("Content-Type").unwrap(),
            "text/javascript; charset=utf-8"
        );
        assert_eq!(js.body(), b"console.log(1)");

        assert_eq!(previews.serve(req("../secret.txt")).status(), 404);
        assert_eq!(previews.serve(req("%2e%2e/secret.txt")).status(), 404);
        assert_eq!(previews.serve(req("assets%5cplayer.js")).status(), 404);

        previews.remove(id).unwrap();
        assert_eq!(previews.serve(req("assets/player.js")).status(), 404);

        std::fs::remove_dir_all(parent).unwrap();
    }

    // Feature: 外部HTMLプレビュー登録時の形式検証
    // Scenario: HTML以外のファイルや不正IDの登録を拒否する
    // Given: SVGファイルおよび不正形式のID
    // When: ExternalHtmlPreviews::registerを呼ぶ
    // Then: エラーで拒否される
    #[test]
    fn rejects_non_html_entry_and_invalid_id() {
        let dir = unique_dir("reject");
        std::fs::create_dir_all(&dir).unwrap();
        let svg = dir.join("diagram.svg");
        std::fs::write(&svg, "<svg></svg>").unwrap();

        let previews = ExternalHtmlPreviews::default();
        assert!(previews.register("bad-id".into(), svg.clone()).is_err());
        assert!(previews
            .register("835b41d8-d3a4-40af-979c-e9feb50e9ee2".into(), svg)
            .is_err());

        std::fs::remove_dir_all(dir).unwrap();
    }
}

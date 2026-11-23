use std::{
    collections::HashMap,
    io::Read,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::http::{Request, Response};

#[derive(Default)]
pub(crate) struct HtmlPreviews(Mutex<HashMap<String, Arc<Preview>>>);

struct Preview {
    html: String,
    root: Option<PathBuf>,
    owner_label: String,
}

impl HtmlPreviews {
    pub(crate) fn register(
        &self,
        id: String,
        html: String,
        source_path: Option<String>,
        owner_label: String,
    ) -> Result<(), String> {
        if id.len() != 36
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
        {
            return Err("Invalid HTML preview id".into());
        }
        let root = source_path
            .as_deref()
            .and_then(|path| Path::new(path).parent())
            .filter(|path| path.is_absolute())
            .and_then(|path| path.canonicalize().ok());
        self.0
            .lock()
            .map_err(|error| error.to_string())?
            .insert(id, Arc::new(Preview { html, root, owner_label }));
        Ok(())
    }

    pub(crate) fn remove(&self, id: &str) -> Result<(), String> {
        self.0.lock().map_err(|error| error.to_string())?.remove(id);
        Ok(())
    }

    pub(crate) fn remove_for_owner(&self, owner_label: &str) {
        if let Ok(mut map) = self.0.lock() {
            map.retain(|_, entry| entry.owner_label != owner_label);
        }
    }

    pub(crate) fn clear(&self) {
        if let Ok(mut map) = self.0.lock() {
            map.clear();
        }
    }

    pub(crate) fn serve(&self, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
        let data = (|| {
            if request.method() != tauri::http::Method::GET {
                return None;
            }
            let (id, path) = request.uri().path().strip_prefix('/')?.split_once('/')?;
            let preview = self.0.lock().ok()?.get(id)?.clone();
            let (mime, bytes) = if path == "__wasabipad_document__.html" {
                ("text/html; charset=utf-8", preview.html.as_bytes().to_vec())
            } else {
                let root = preview.root.as_ref()?;
                let path = percent_encoding::percent_decode_str(path)
                    .decode_utf8()
                    .ok()?;
                let path = scoped_asset(root, &path)?;
                let mime = asset_type(&path)?;
                let file = std::fs::File::open(path).ok()?;
                const MAX_ASSET_BYTES: u64 = 32 * 1024 * 1024;
                if file.metadata().ok()?.len() > MAX_ASSET_BYTES {
                    return None;
                }
                let mut bytes = Vec::new();
                file.take(MAX_ASSET_BYTES + 1)
                    .read_to_end(&mut bytes)
                    .ok()?;
                if bytes.len() as u64 > MAX_ASSET_BYTES {
                    return None;
                }
                (mime, bytes)
            };
            let scheme = if cfg!(windows) {
                "http://wasabi-html.localhost"
            } else {
                "wasabi-html:"
            };
            // On Windows, limit the CSP to this preview's path as well as to the local protocol.
            let local = if cfg!(windows) {
                format!("{scheme}/{id}/")
            } else {
                scheme.to_owned()
            };
            let csp = format!(
                "default-src 'none'; script-src {local} 'unsafe-inline'; style-src {local} 'unsafe-inline'; \
                 img-src {local} data:; font-src {local} data:; media-src {local}; \
                 base-uri 'none'; form-action 'none'; frame-src 'none'; connect-src 'none'"
            );
            Response::builder()
                .header("Content-Type", mime)
                .header("Content-Security-Policy", csp)
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
    if relative.contains(['\\', ':']) {
        return None;
    }
    let relative = Path::new(relative);
    if !relative
        .components()
        .all(|component| matches!(component, Component::Normal(_)))
    {
        return None;
    }
    let path = root.join(relative).canonicalize().ok()?;
    (path.starts_with(root) && path.is_file()).then_some(path)
}

fn asset_type(path: &Path) -> Option<&'static str> {
    Some(
        match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
            "js" | "mjs" => "text/javascript",
            "css" => "text/css",
            "svg" => "image/svg+xml",
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "avif" => "image/avif",
            "ico" => "image/x-icon",
            "bmp" => "image/bmp",
            "woff" => "font/woff",
            "woff2" => "font/woff2",
            "ttf" => "font/ttf",
            "otf" => "font/otf",
            "mp3" => "audio/mpeg",
            "wav" => "audio/wav",
            "ogg" => "audio/ogg",
            "mp4" => "video/mp4",
            "webm" => "video/webm",
            _ => return None,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    // Given: HTML が子フォルダの JS を参照し、親フォルダにも別の JS がある
    // When: 専用プロトコルで本文と資産を読み込む
    // Then: 子フォルダは配信し、親フォルダを拒否し、外部通信を CSP で禁止する
    #[test]
    fn serves_local_assets_under_the_registered_root() {
        let parent =
            std::env::temp_dir().join(format!("wasabipad-html-preview-{}", std::process::id()));
        let root = parent.join("document");
        let assets = root.join("site");
        std::fs::create_dir_all(&assets).unwrap();
        std::fs::write(assets.join("app.js"), "console.log('local')").unwrap();
        std::fs::write(parent.join("private.js"), "console.log('private')").unwrap();
        let previews = HtmlPreviews::default();
        let id = "725b41d8-d3a4-40af-979c-e9feb50e9ee2";
        previews
            .register(
                id.into(),
                "<script src='site/app.js'></script>".into(),
                Some(root.join("index.html").to_string_lossy().into_owned()),
                "main".into(),
            )
            .unwrap();
        let request = |path: &str| {
            Request::builder()
                .uri(format!("/{id}/{path}"))
                .body(Vec::new())
                .unwrap()
        };
        let html = previews.serve(request("__wasabipad_document__.html"));
        assert_eq!(html.status(), 200);
        let csp = html
            .headers()
            .get("Content-Security-Policy")
            .unwrap()
            .to_str()
            .unwrap();
        assert!(csp.contains("connect-src 'none'"));
        assert!(csp.contains("default-src 'none'"));
        let script = previews.serve(request("site/app.js"));
        assert_eq!(
            script.headers().get("Content-Type").unwrap(),
            "text/javascript"
        );
        assert_eq!(script.body(), b"console.log('local')");
        assert_eq!(previews.serve(request("%2e%2e/private.js")).status(), 404);
        previews.remove(id).unwrap();
        assert_eq!(previews.serve(request("site/app.js")).status(), 404);
        std::fs::remove_dir_all(parent).unwrap();
    }

    // Feature: HTML プレビュー登録のライフサイクル解放
    // Scenario: ウィンドウ破棄とアプリ終了で所有プレビューのみ・または全プレビューを解放する
    // Given: viewer-1 と viewer-2 がそれぞれ HTML プレビューを登録している
    // When: remove_for_owner("viewer-1") と clear() を順に呼ぶ
    // Then: remove_for_owner 後は viewer-1 のみ 404・viewer-2 は 200 を維持し、clear 後は全件 404 になる
    #[test]
    fn cleans_up_registered_html_previews_by_owner_and_clear() {
        let previews = HtmlPreviews::default();
        let id1 = "725b41d8-d3a4-40af-979c-e9feb50e9ee1";
        let id2 = "725b41d8-d3a4-40af-979c-e9feb50e9ee2";
        previews.register(id1.into(), "<p>1</p>".into(), None, "viewer-1".into()).unwrap();
        previews.register(id2.into(), "<p>2</p>".into(), None, "viewer-2".into()).unwrap();
        let req = |id: &str| {
            Request::builder()
                .uri(format!("/{id}/__wasabipad_document__.html"))
                .body(Vec::new())
                .unwrap()
        };
        previews.remove_for_owner("viewer-1");
        assert_eq!(previews.serve(req(id1)).status(), 404);
        assert_eq!(previews.serve(req(id2)).status(), 200);
        previews.clear();
        assert_eq!(previews.serve(req(id2)).status(), 404);
    }
}

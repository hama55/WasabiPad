use std::{
    collections::HashMap,
    io::{Read, Seek, SeekFrom},
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::http::{Method, Request, Response};

const MAX_PDF_RESPONSE_BYTES: u64 = 256 * 1024 * 1024;
const PDF_DOCUMENT_SEGMENT: &str = "document.pdf";

#[derive(Default)]
pub(crate) struct PdfPreviews(Mutex<HashMap<String, Arc<PathBuf>>>);

fn validate_preview_id(id: &str) -> Result<(), String> {
    if id.len() != 36
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
    {
        return Err("Invalid PDF preview id".into());
    }
    Ok(())
}

impl PdfPreviews {
    pub(crate) fn register(&self, id: String, path: PathBuf) -> Result<(), String> {
        validate_preview_id(&id)?;
        if !path.is_absolute() {
            return Err("PDF preview path must be absolute".into());
        }
        let canonical = path
            .canonicalize()
            .map_err(|error| format!("PDF preview path could not be resolved: {error}"))?;
        if !canonical.is_file() {
            return Err("PDF preview path is not a regular file".into());
        }
        self.0
            .lock()
            .map_err(|error| error.to_string())?
            .insert(id, Arc::new(canonical));
        Ok(())
    }

    pub(crate) fn remove(&self, id: &str) -> Result<(), String> {
        self.0.lock().map_err(|error| error.to_string())?.remove(id);
        Ok(())
    }

    pub(crate) fn serve(&self, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
        let method = request.method().clone();
        if method != Method::GET && method != Method::HEAD {
            return not_found();
        }
        let Some((id, segment)) = request
            .uri()
            .path()
            .strip_prefix('/')
            .and_then(|rest| rest.split_once('/'))
        else {
            return not_found();
        };
        if segment != PDF_DOCUMENT_SEGMENT {
            return not_found();
        }
        let Some(path) = self.0.lock().ok().and_then(|map| map.get(id).cloned()) else {
            return not_found();
        };
        let Ok(mut file) = std::fs::File::open(path.as_ref()) else {
            return not_found();
        };
        let Ok(total_len) = file.metadata().map(|m| m.len()) else {
            return not_found();
        };

        if let Some(range_header) = request
            .headers()
            .get("range")
            .and_then(|value| value.to_str().ok())
        {
            let Some((start, end)) = parse_byte_range(range_header, total_len) else {
                return Response::builder()
                    .status(416)
                    .header("Accept-Ranges", "bytes")
                    .header("Content-Range", format!("bytes */{total_len}"))
                    .body(Vec::new())
                    .unwrap();
            };
            let slice_len = end - start + 1;
            if slice_len > MAX_PDF_RESPONSE_BYTES {
                return payload_too_large();
            }
            let bytes = if method == Method::HEAD {
                Vec::new()
            } else {
                if file.seek(SeekFrom::Start(start)).is_err() {
                    return not_found();
                }
                let mut buf = Vec::with_capacity(slice_len.min(1024 * 1024) as usize);
                if file.take(slice_len).read_to_end(&mut buf).is_err()
                    || buf.len() as u64 != slice_len
                {
                    return not_found();
                }
                buf
            };
            return Response::builder()
                .status(206)
                .header("Content-Type", "application/pdf")
                .header("Content-Disposition", "inline")
                .header("Accept-Ranges", "bytes")
                .header("Content-Range", format!("bytes {start}-{end}/{total_len}"))
                .header("Content-Length", slice_len.to_string())
                .header("X-Content-Type-Options", "nosniff")
                .header("Cache-Control", "no-store")
                .body(bytes)
                .unwrap_or_else(|_| not_found());
        }

        if total_len > MAX_PDF_RESPONSE_BYTES {
            return payload_too_large();
        }
        let bytes = if method == Method::HEAD {
            Vec::new()
        } else {
            let mut buf = Vec::with_capacity(total_len.min(1024 * 1024) as usize);
            if file
                .take(MAX_PDF_RESPONSE_BYTES + 1)
                .read_to_end(&mut buf)
                .is_err()
                || buf.len() as u64 > MAX_PDF_RESPONSE_BYTES
            {
                return payload_too_large();
            }
            buf
        };
        Response::builder()
            .status(200)
            .header("Content-Type", "application/pdf")
            .header("Content-Disposition", "inline")
            .header("Accept-Ranges", "bytes")
            .header("Content-Length", total_len.to_string())
            .header("X-Content-Type-Options", "nosniff")
            .header("Cache-Control", "no-store")
            .body(bytes)
            .unwrap_or_else(|_| not_found())
    }
}

fn parse_byte_range(header: &str, total_len: u64) -> Option<(u64, u64)> {
    if total_len == 0 {
        return None;
    }
    let spec = header.trim().strip_prefix("bytes=")?;
    if spec.contains(',') {
        return None;
    }
    let (start_str, end_str) = spec.split_once('-')?;
    let start_str = start_str.trim();
    let end_str = end_str.trim();
    if start_str.is_empty() {
        let suffix: u64 = end_str.parse().ok()?;
        if suffix == 0 {
            return None;
        }
        let start = total_len.saturating_sub(suffix);
        return Some((start, total_len - 1));
    }
    let start: u64 = start_str.parse().ok()?;
    if start >= total_len {
        return None;
    }
    let end = if end_str.is_empty() {
        total_len - 1
    } else {
        let parsed: u64 = end_str.parse().ok()?;
        parsed.min(total_len - 1)
    };
    (start <= end).then_some((start, end))
}

fn not_found() -> Response<Vec<u8>> {
    Response::builder().status(404).body(Vec::new()).unwrap()
}

fn payload_too_large() -> Response<Vec<u8>> {
    Response::builder().status(413).body(Vec::new()).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_pdf(label: &str) -> (PathBuf, PathBuf) {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "wasabipad-pdf-preview-{label}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("sample.pdf");
        std::fs::write(&file, b"%PDF-1.7\n0123456789").unwrap();
        (dir, file)
    }

    // Feature: ローカルPDF専用プロトコル wasabi-pdf:
    // Scenario: 登録済みPDFの全文取得・HEAD・Range部分取得を処理し、未登録や不正パスを拒否する
    // Given: 登録済みのPDFファイル
    // When: 全文GET・HEAD・Range指定GET・範囲外Range・不正パス・解除後アクセスを送る
    // Then: 正しいステータスとContent-Range/本文を返し、不正要求は404/416になる
    #[test]
    fn serves_registered_pdf_with_range_support_and_rejects_unregistered() {
        let (dir, pdf) = unique_pdf("range");
        let previews = PdfPreviews::default();
        let id = "935b41d8-d3a4-40af-979c-e9feb50e9ee2";
        previews.register(id.into(), pdf).unwrap();

        let full = previews.serve(
            Request::builder()
                .uri(format!("/{id}/document.pdf"))
                .body(Vec::new())
                .unwrap(),
        );
        assert_eq!(full.status(), 200);
        assert_eq!(full.headers().get("Content-Type").unwrap(), "application/pdf");
        assert_eq!(full.body(), b"%PDF-1.7\n0123456789");

        let head = previews.serve(
            Request::builder()
                .method(Method::HEAD)
                .uri(format!("/{id}/document.pdf"))
                .body(Vec::new())
                .unwrap(),
        );
        assert_eq!(head.status(), 200);
        assert!(head.body().is_empty());
        assert_eq!(head.headers().get("Content-Length").unwrap(), "19");

        let partial = previews.serve(
            Request::builder()
                .uri(format!("/{id}/document.pdf"))
                .header("Range", "bytes=0-7")
                .body(Vec::new())
                .unwrap(),
        );
        assert_eq!(partial.status(), 206);
        assert_eq!(
            partial.headers().get("Content-Range").unwrap(),
            "bytes 0-7/19"
        );
        assert_eq!(partial.body(), b"%PDF-1.7");

        let suffix = previews.serve(
            Request::builder()
                .uri(format!("/{id}/document.pdf"))
                .header("Range", "bytes=-4")
                .body(Vec::new())
                .unwrap(),
        );
        assert_eq!(suffix.status(), 206);
        assert_eq!(suffix.body(), b"6789");

        let invalid_range = previews.serve(
            Request::builder()
                .uri(format!("/{id}/document.pdf"))
                .header("Range", "bytes=100-200")
                .body(Vec::new())
                .unwrap(),
        );
        assert_eq!(invalid_range.status(), 416);

        let wrong_segment = previews.serve(
            Request::builder()
                .uri(format!("/{id}/other.pdf"))
                .body(Vec::new())
                .unwrap(),
        );
        assert_eq!(wrong_segment.status(), 404);

        previews.remove(id).unwrap();
        let after_remove = previews.serve(
            Request::builder()
                .uri(format!("/{id}/document.pdf"))
                .body(Vec::new())
                .unwrap(),
        );
        assert_eq!(after_remove.status(), 404);

        std::fs::remove_dir_all(dir).unwrap();
    }
}

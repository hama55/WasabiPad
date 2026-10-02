use wasabipad_core::{Doc, Encoding, PosC};

#[test]
fn video_files_are_view_only_without_decoding_their_body() {
    // Feature: 通常ファイルの動画プレビュー
    // Scenario: MOV・MP4を開き直しても動画の内容を本文として読み込まない
    // Given: 拡張子の大文字小文字が異なる、テキストとしても読める動画ファイル
    for extension in ["MOV", "mp4"] {
        let path = std::env::temp_dir().join(format!("wasabipad-video-{}.{extension}", std::process::id()));
        std::fs::write(&path, b"video body must not become editor text").unwrap();
        // When: 通常の文書読込と文字コード指定再読込を行う
        let mut doc = Doc::open(&path).unwrap();
        let info = doc.info(path.to_string_lossy().into_owned()).unwrap();
        // Then: 本文を持たず、実ファイルの容量を保持し、編集できない
        assert_eq!(doc.lines(0, 1), vec![""]);
        assert!(info.view_only && info.is_binary);
        assert_eq!(info.byte_len, 38);
        let p = PosC { line: 0, col: 0 };
        assert!(doc.edit(p, p, p, "overwrite", false).is_none());
        let reloaded = doc.reload_with_encoding(Encoding::Utf8 { bom: false }).unwrap();
        assert!(reloaded.view_only);
        assert_eq!(doc.lines(0, 1), vec![""]);
        drop(doc);
        std::fs::remove_file(path).unwrap();
    }
}

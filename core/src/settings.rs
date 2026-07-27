// アプリ設定の永続化。設定の構造はフロント (ui/settings.ts) だけが持ち、
// core は JSON 文字列を丸ごと運ぶだけにして、項目追加で backend を触らずに済ませる。
use std::io;
use std::path::PathBuf;

// インストーラは exe を %LOCALAPPDATA%\WasabiPad\ へ置く。設定もそこへ揃えると
// インストール版では従来の「exe 隣」と同じ場所になり、保存先が分かれない。
pub(crate) fn config_path(file: &str) -> io::Result<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA")
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "LOCALAPPDATA が取得できません"))?;
    Ok(PathBuf::from(local).join("WasabiPad").join(file))
}

pub(crate) fn write_config(path: PathBuf, contents: &str) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, contents)
}

pub fn load() -> String {
    config_path("settings.json")
        .and_then(std::fs::read_to_string)
        .unwrap_or_else(|_| "{}".to_string())
}

pub fn save(json: &str) -> io::Result<()> {
    write_config(config_path("settings.json")?, json)
}

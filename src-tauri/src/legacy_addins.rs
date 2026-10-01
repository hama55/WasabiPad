use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

const MIGRATION_MARKER: &str = ".legacy-music-addins-moved";

pub fn move_to_pending(app_data_root: &Path) -> Result<(), String> {
    let addins = app_data_root.join("addins");
    let metadata = match fs::symlink_metadata(&addins) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(&addins).map_err(|error| format!("create addins folder: {error}"))?;
            fs::symlink_metadata(&addins).map_err(|error| format!("inspect addins folder: {error}"))?
        }
        Err(error) => return Err(format!("inspect addins folder: {error}")),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("addins folder must be a regular directory".into());
    }

    let marker = addins.join(MIGRATION_MARKER);
    match fs::symlink_metadata(&marker) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err("legacy addins migration marker must be a regular file".into());
        }
        Ok(_) => {
            let contents =
                fs::read(&marker).map_err(|error| format!("read addins migration marker: {error}"))?;
            if contents.as_slice() == b"moved\n" {
                return Ok(());
            }
            fs::remove_file(&marker)
                .map_err(|error| format!("remove incomplete addins migration marker: {error}"))?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("inspect addins migration marker: {error}")),
    }

    let pending = addins.join("pending");
    match fs::symlink_metadata(&pending) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err("pending addins folder must be a regular directory".into());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&pending).map_err(|error| format!("create pending addins folder: {error}"))?;
        }
        Err(error) => return Err(format!("inspect pending addins folder: {error}")),
    }

    for entry in fs::read_dir(&addins).map_err(|error| format!("list addins folder: {error}"))? {
        let entry = entry.map_err(|error| format!("read addins folder entry: {error}"))?;
        let name = entry.file_name();
        if name == "pending" || name == MIGRATION_MARKER {
            continue;
        }
        let destination = unused_destination(&pending, &name)?;
        fs::rename(entry.path(), &destination)
            .map_err(|error| format!("move old addin to pending folder: {error}"))?;
    }

    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&marker)
        .map_err(|error| format!("write addins migration marker: {error}"))?;
    file.write_all(b"moved\n")
        .map_err(|error| format!("write addins migration marker: {error}"))
}

fn unused_destination(directory: &Path, name: &std::ffi::OsStr) -> Result<PathBuf, String> {
    for suffix in 0..u32::MAX {
        let candidate = if suffix == 0 {
            directory.join(name)
        } else {
            directory.join(format!("{}.legacy-{suffix}", name.to_string_lossy()))
        };
        match fs::symlink_metadata(&candidate) {
            Ok(_) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(candidate),
            Err(error) => return Err(format!("inspect pending addin destination: {error}")),
        }
    }
    Err("no unused pending addin destination remains".into())
}

//! UWP `.appx` extraction.
//!
//! An `.appx` is a plain OPC/ZIP container, so we unzip it directly; no native
//! decryptor is needed. (GDK `.msixvc` packages are encrypted and download-only.)

use std::path::Path;

/// Extract a UWP `.appx` into `out_dir`, reporting `(current, total, file)` per
/// entry. If it's an `.appxbundle` (no game exe, but a nested x64 `.appx`), the
/// inner package is unpacked too.
pub fn extract_appx_with_progress(
    appx_path: &str,
    out_dir: &str,
    mut on_progress: impl FnMut(u64, u64, &str),
) -> Result<(), String> {
    unzip_cb(appx_path, out_dir, &mut on_progress)?;

    let out = Path::new(out_dir);
    if out.join("Minecraft.Windows.exe").exists() {
        return Ok(());
    }
    let inner = std::fs::read_dir(out)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().map(|x| x.eq_ignore_ascii_case("appx")).unwrap_or(false))
        .min_by_key(|p| {
            let n = p.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
            if n.contains("x64") { 0 } else { 1 }
        });
    if let Some(inner_appx) = inner {
        unzip_cb(&inner_appx.to_string_lossy(), out_dir, &mut on_progress)?;
    }
    Ok(())
}

fn unzip_cb(
    zip_path: &str,
    out_dir: &str,
    on_progress: &mut dyn FnMut(u64, u64, &str),
) -> Result<(), String> {
    std::fs::create_dir_all(out_dir).map_err(|e| e.to_string())?;
    let file = std::fs::File::open(zip_path).map_err(|e| format!("ERR_OPEN_APPX: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("ERR_BAD_APPX: {e}"))?;
    let base = Path::new(out_dir);
    let total = archive.len() as u64;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let rel = match entry.enclosed_name() {
            Some(p) => p.to_owned(),
            None => continue, // skip unsafe/absolute paths (zip-slip guard)
        };
        let out_path = base.join(&rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut out_file = std::fs::File::create(&out_path).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut out_file).map_err(|e| e.to_string())?;
        }
        on_progress(i as u64 + 1, total, &rel.to_string_lossy());
    }
    Ok(())
}

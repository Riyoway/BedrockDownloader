//! Filesystem layout, with a user-configurable base directory.
//!
//! Default base = %APPDATA%\BedrockDownloader
//!   ├─ installers\      downloaded *.msixvc / *.appx packages
//!   └─ versions\        extracted game folders (one per install)
//!
//! The base can be moved to any writable folder (e.g. another drive) via
//! `set_base_root`; the choice is persisted in config.json, which always lives
//! in the *default* AppData location so it can be found regardless of override.

use std::path::PathBuf;
use std::sync::Mutex;

static OVERRIDE: Mutex<Option<PathBuf>> = Mutex::new(None);

/// `%APPDATA%` (roaming) with a sensible fallback.
fn app_data() -> PathBuf {
    if let Ok(v) = std::env::var("APPDATA") {
        if !v.trim().is_empty() {
            return PathBuf::from(v);
        }
    }
    if let Ok(v) = std::env::var("USERPROFILE") {
        return PathBuf::from(v).join("AppData").join("Roaming");
    }
    std::env::temp_dir()
}

/// The fixed default base, independent of any override.
fn default_base() -> PathBuf {
    app_data().join("BedrockDownloader")
}

/// config.json always lives under the default base.
fn config_path() -> PathBuf {
    let dir = default_base();
    let _ = std::fs::create_dir_all(&dir);
    dir.join("config.json")
}

/// Load a persisted base-root override at startup.
pub fn load_config() {
    if let Ok(txt) = std::fs::read_to_string(config_path()) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
            if let Some(s) = v.get("baseRoot").and_then(|x| x.as_str()) {
                let s = s.trim();
                if !s.is_empty() {
                    *OVERRIDE.lock().unwrap() = Some(PathBuf::from(s));
                }
            }
        }
    }
}

fn persist() -> Result<(), String> {
    let base = OVERRIDE.lock().unwrap().clone();
    let json = serde_json::json!({
        "baseRoot": base.map(|p| p.to_string_lossy().to_string()).unwrap_or_default()
    });
    std::fs::write(
        config_path(),
        serde_json::to_string_pretty(&json).unwrap_or_default(),
    )
    .map_err(|e| format!("ERR_WRITE_CONFIG: {e}"))
}

/// Whether a custom base root is currently set.
pub fn is_custom() -> bool {
    OVERRIDE.lock().unwrap().is_some()
}

/// The active base directory (override if set, else default).
pub fn base_root() -> PathBuf {
    let dir = OVERRIDE
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(default_base);
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Change the base directory to `path` (validated writable) and persist it.
pub fn set_base_root(path: &str) -> Result<(), String> {
    let p = PathBuf::from(path.trim());
    if p.as_os_str().is_empty() {
        return Err("ERR_EMPTY_PATH".into());
    }
    std::fs::create_dir_all(&p).map_err(|e| format!("ERR_CREATE_DIR: {e}"))?;
    // Writability probe.
    let probe = p.join(".bdl_write_test");
    std::fs::write(&probe, b"ok").map_err(|e| format!("ERR_NOT_WRITABLE: {e}"))?;
    let _ = std::fs::remove_file(&probe);

    *OVERRIDE.lock().unwrap() = Some(p);
    persist()
}

/// Reset the base directory back to the default AppData location.
pub fn reset_base_root() -> Result<(), String> {
    *OVERRIDE.lock().unwrap() = None;
    persist()
}

/// Directory holding the downloaded `.msixvc` / `.appx` installers.
pub fn installers_dir() -> PathBuf {
    let dir = base_root().join("installers");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Directory holding extracted/installed game versions.
pub fn versions_dir() -> PathBuf {
    let dir = base_root().join("versions");
    let _ = std::fs::create_dir_all(&dir);
    dir
}


//! BedrockDownloader: a Tauri app for downloading Minecraft Bedrock packages.
//! See docs/MECHANISM.md for how it works.

mod download;
mod extract;
mod fe3;
mod paths;
mod versiondb;

use std::path::PathBuf;
use std::sync::Arc;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// User-agent used for all HTTP traffic.
pub const USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) BedrockDownloader/0.1";

/// Progress channel for extraction/install.
const INSTALL_EVENT: &str = "install-event";

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum InstallEvent {
    Started { folder: String },
    Progress { folder: String, current: u64, total: u64, file: String },
    Done { folder: String },
    Error { folder: String, message: String },
}

fn emit_install(app: &AppHandle, ev: InstallEvent) {
    let _ = app.emit(INSTALL_EVENT, ev);
}

#[derive(Serialize)]
pub struct AppPaths {
    base: String,
    installers: String,
    versions: String,
    #[serde(rename = "isCustom")]
    is_custom: bool,
}

// ---- catalog ---------------------------------------------------------------

#[tauri::command]
async fn fetch_versions(prefer_cn: bool) -> Result<versiondb::VersionCatalog, String> {
    versiondb::fetch(prefer_cn).await
}

#[tauri::command]
async fn test_mirrors(urls: Vec<String>, timeout_ms: u64) -> Vec<versiondb::MirrorResult> {
    versiondb::test_mirrors(urls, timeout_ms).await
}

// ---- download --------------------------------------------------------------

/// Begin (or resume) a download. Returns the destination path immediately;
/// progress is reported through the `download-event` channel.
///
/// GDK versions pass a direct mirror `url`. UWP versions pass an `update_id`
/// instead — the link is resolved live via FE3 just before downloading.
#[tauri::command]
fn start_download(
    app: AppHandle,
    state: State<'_, Arc<download::DownloadState>>,
    kind: String,
    short: String,
    package_type: String,
    url: Option<String>,
    update_id: Option<String>,
    md5: Option<String>,
) -> Result<String, String> {
    let filename = download::installer_filename(&kind, &short, &package_type);
    let dest = paths::installers_dir().join(filename);
    let dest_str = dest.to_string_lossy().to_string();

    let state = state.inner().clone();
    let app2 = app.clone();
    let dest_for_task = dest_str.clone();
    tauri::async_runtime::spawn(async move {
        // Resolve the URL: direct for GDK, FE3 lookup for UWP.
        let resolved = match url {
            Some(u) if !u.trim().is_empty() => Ok(u),
            _ => match update_id {
                Some(id) if !id.trim().is_empty() => fe3::resolve_download_url(&id, 1).await,
                _ => Err("ERR_NO_URL_OR_UPDATE_ID".to_string()),
            },
        };
        match resolved {
            Ok(final_url) => {
                let _ = download::run(app2, state, final_url, dest, md5).await;
            }
            Err(e) => download::emit_error(&app2, &dest_for_task, e),
        }
    });
    Ok(dest_str)
}

#[tauri::command]
fn cancel_download(state: State<'_, Arc<download::DownloadState>>, dest: String) {
    state.cancel(&dest);
}

// ---- installer inventory ---------------------------------------------------

/// Find a downloaded installer matching `<kind> <short>.<ext>` (returns base name).
fn resolve_installer(kind: &str, short: &str, package_type: &str) -> Option<String> {
    let want = download::installer_filename(kind, short, package_type).to_lowercase();
    let dir = paths::installers_dir();
    let entries = std::fs::read_dir(dir).ok()?;
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.to_lowercase() == want {
            return Some(name);
        }
    }
    None
}

#[tauri::command]
fn resolve_downloaded(kind: String, short: String, package_type: String) -> Option<String> {
    resolve_installer(&kind, &short, &package_type)
}

#[tauri::command]
fn list_downloaded() -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(paths::installers_dir()) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let lower = name.to_lowercase();
            if lower.ends_with(".msixvc") || lower.ends_with(".appx") {
                out.push(name);
            }
        }
    }
    out
}

#[tauri::command]
fn delete_downloaded(kind: String, short: String, package_type: String) -> Result<(), String> {
    let name = resolve_installer(&kind, &short, &package_type).ok_or("ERR_INSTALLER_NOT_FOUND")?;
    let path = paths::installers_dir().join(name);
    std::fs::remove_file(path).map_err(|e| e.to_string())
}

// ---- install / extract -----------------------------------------------------

/// Extract a downloaded **UWP** package into `versions/`. Runs off the main
/// thread and streams progress on the `install-event` channel.
///
/// GDK (`.msixvc`) is download-only: it is encrypted and we don't bundle a
/// decryptor, so it can't be extracted here.
#[tauri::command]
async fn install_version(
    app: AppHandle,
    kind: String,
    short: String,
    package_type: String,
    folder_name: String,
) -> Result<String, String> {
    if !package_type.eq_ignore_ascii_case("UWP") {
        return Err("ERR_GDK_DOWNLOAD_ONLY".into());
    }

    let installer_name =
        resolve_installer(&kind, &short, &package_type).ok_or("ERR_INSTALLER_NOT_FOUND")?;
    let installer_path = paths::installers_dir().join(&installer_name);

    let folder = if folder_name.trim().is_empty() {
        format!("{kind} {short}")
    } else {
        folder_name
    };
    let out_dir: PathBuf = paths::versions_dir().join(&folder);

    emit_install(&app, InstallEvent::Started { folder: folder.clone() });

    let appx = installer_path.to_string_lossy().to_string();
    let out = out_dir.to_string_lossy().to_string();
    let app2 = app.clone();
    let folder2 = folder.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        extract::extract_appx_with_progress(&appx, &out, |current, total, file| {
            emit_install(
                &app2,
                InstallEvent::Progress {
                    folder: folder2.clone(),
                    current,
                    total,
                    file: file.to_string(),
                },
            );
        })
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);

    match &result {
        Ok(_) => emit_install(&app, InstallEvent::Done { folder: folder.clone() }),
        Err(e) => emit_install(&app, InstallEvent::Error { folder: folder.clone(), message: e.clone() }),
    }
    result.map(|_| out_dir.to_string_lossy().to_string())
}

// ---- installed versions ----------------------------------------------------

fn version_folder(kind: &str, short: &str) -> PathBuf {
    paths::versions_dir().join(format!("{kind} {short}"))
}

/// Pull `Executable="…"` out of an AppxManifest.xml.
fn manifest_exe(xml: &str) -> Option<String> {
    let key = "Executable=\"";
    let start = xml.find(key)? + key.len();
    let rest = &xml[start..];
    let end = rest.find('"')?;
    let exe = rest[..end].trim();
    if exe.is_empty() {
        None
    } else {
        Some(exe.replace('\\', "/"))
    }
}

/// Locate the game executable inside an extracted version folder. Works across
/// editions/ages: preferred name → AppxManifest → any top-level `.exe`.
fn find_game_exe(dir: &std::path::Path) -> Option<PathBuf> {
    let preferred = dir.join("Minecraft.Windows.exe");
    if preferred.exists() {
        return Some(preferred);
    }
    if let Ok(xml) = std::fs::read_to_string(dir.join("AppxManifest.xml")) {
        if let Some(exe) = manifest_exe(&xml) {
            let p = dir.join(exe);
            if p.exists() {
                return Some(p);
            }
        }
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().map(|x| x.eq_ignore_ascii_case("exe")).unwrap_or(false) {
                return Some(p);
            }
        }
    }
    None
}

/// A version folder counts as installed if it has a manifest or a runnable exe.
fn is_version_installed(dir: &std::path::Path) -> bool {
    dir.is_dir() && (dir.join("AppxManifest.xml").exists() || find_game_exe(dir).is_some())
}

/// Folder names under `versions/` that hold an extracted game.
#[tauri::command]
fn list_installed() -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(paths::versions_dir()) {
        for e in entries.flatten() {
            if is_version_installed(&e.path()) {
                out.push(e.file_name().to_string_lossy().to_string());
            }
        }
    }
    out
}

/// Read an attribute value from the first occurrence of an XML element.
fn attr_in_element(xml: &str, element: &str, attr: &str) -> Option<String> {
    let start = xml.find(element)?;
    let rest = &xml[start..];
    let end = rest.find('>')?;
    let tag = &rest[..end];
    let key = format!("{attr}=\"");
    let ki = tag.find(&key)? + key.len();
    let vrest = &tag[ki..];
    let ve = vrest.find('"')?;
    Some(vrest[..ve].to_string())
}

/// Package family Name from a version's AppxManifest.xml (falls back by edition).
fn package_name(kind: &str, dir: &std::path::Path) -> String {
    let default_name = if kind.eq_ignore_ascii_case("Preview") {
        "Microsoft.MinecraftWindowsBeta"
    } else {
        "Microsoft.MinecraftUWP"
    };
    let xml = std::fs::read_to_string(dir.join("AppxManifest.xml")).unwrap_or_default();
    attr_in_element(&xml, "<Identity", "Name").unwrap_or_else(|| default_name.to_string())
}

/// Launch an installed version. UWP/GDK packages must be *registered* with an
/// app identity, then activated via the `minecraft://` protocol — they can't run
/// by double-clicking the exe. Requires Windows Developer Mode (loose register).
#[tauri::command]
async fn launch_version(kind: String, short: String) -> Result<(), String> {
    let dir = version_folder(&kind, &short);
    if !dir.join("AppxManifest.xml").exists() {
        return Err("ERR_NOT_INSTALLED".into());
    }
    let name = package_name(&kind, &dir);
    let protocol = if kind.eq_ignore_ascii_case("Preview") {
        "minecraft-preview://"
    } else {
        "minecraft://"
    }
    .to_string();
    tauri::async_runtime::spawn_blocking(move || register_and_launch(&dir, &name, &protocol))
        .await
        .map_err(|e| e.to_string())?
}

/// The Microsoft Store Engagement framework Minecraft depends on, and a public
/// mirror of the signed package.
#[cfg(windows)]
const STORE_ENGAGEMENT_MIN: &str = "10.0.19011.0";
#[cfg(windows)]
const STORE_ENGAGEMENT_URL: &str = "https://github.com/RaythCo-Creations/downloads/raw/main/Microsoft.Services.Store.Engagement_10.0.19011.0_x64__8wekyb3d8bbwe.Appx";

#[cfg(windows)]
fn register_and_launch(dir: &std::path::Path, name: &str, protocol: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let manifest = dir.join("AppxManifest.xml");
    // A Store-signed package reports "Windows Store origin" and refuses to be
    // sideloaded (0x80073CFF). Deleting the signature makes the folder a plain
    // loose package that registers under developer mode.
    let _ = std::fs::remove_file(dir.join("AppxSignature.p7x"));
    // Steps:
    //  1. Ensure the Microsoft.Services.Store.Engagement framework is present —
    //     Minecraft declares it as a dependency, and registration fails with
    //     0x80073CF3 ("a framework could not be found") when it's missing. It's
    //     a signed framework, so a plain Add-AppxPackage installs it (no dev mode).
    //  2. Unregister any existing package of this identity (Store copy / previous
    //     version) with -PreserveRoamableApplicationData so worlds/settings stay.
    //  3. Register our folder (-ForceUpdateFromAnyVersion allows downgrades).
    //  4. Activate via the minecraft:// URI the registration installs.
    let script = format!(
        "$ErrorActionPreference='Stop'; \
         $name='{name}'; \
         $eng = Get-AppxPackage -Name 'Microsoft.Services.Store.Engagement' | Sort-Object Version -Descending | Select-Object -First 1; \
         if (-not $eng -or ([version]$eng.Version -lt [version]'{eng_min}')) {{ \
           $tmp = Join-Path $env:TEMP 'Microsoft.Services.Store.Engagement.Appx'; \
           Invoke-WebRequest -UseBasicParsing -Uri '{eng_url}' -OutFile $tmp; \
           Add-AppxPackage -Path $tmp \
         }}; \
         Get-AppxPackage -Name $name | ForEach-Object {{ try {{ Remove-AppxPackage -Package $_.PackageFullName -PreserveRoamableApplicationData -ErrorAction Stop }} catch {{}} }}; \
         Add-AppxPackage -Register \"{manifest}\" -ForceApplicationShutdown -ForceUpdateFromAnyVersion; \
         Start-Process '{protocol}'",
        manifest = manifest.display(),
        name = name,
        protocol = protocol,
        eng_min = STORE_ENGAGEMENT_MIN,
        eng_url = STORE_ENGAGEMENT_URL,
    );

    let output = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-WindowStyle",
            "Hidden",
            "-Command",
            &script,
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("ERR_LAUNCH: {e}"))?;

    if output.status.success() {
        return Ok(());
    }
    // Surface the real error verbatim (HRESULT + reason). We deliberately do NOT
    // pattern-match "developer mode" here: Add-AppxPackage appends that hint to
    // almost every failure, which previously masked the true cause.
    let combine = |bytes: &[u8]| -> String {
        String::from_utf8_lossy(bytes)
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    };
    let mut detail = combine(&output.stderr);
    if detail.is_empty() {
        detail = combine(&output.stdout);
    }
    // 0x80073CFF is specifically "needs a developer license / sideloading" —
    // i.e. Developer Mode is off. Flag it precisely (the HRESULT, not the generic
    // "developer mode" hint text) so the UI can offer to enable it.
    if detail.to_lowercase().contains("0x80073cff") {
        return Err("ERR_DEVELOPER_MODE".into());
    }
    if detail.is_empty() {
        detail = "register failed (no error text)".into();
    }
    let detail: String = detail.chars().take(500).collect();
    Err(format!("ERR_REGISTER: {detail}"))
}

#[cfg(not(windows))]
fn register_and_launch(_dir: &std::path::Path, _name: &str, _protocol: &str) -> Result<(), String> {
    Err("ERR_WINDOWS_ONLY".into())
}

/// Open an installed version's folder in Explorer.
#[tauri::command]
fn open_version_folder(kind: String, short: String) -> Result<(), String> {
    let dir = version_folder(&kind, &short);
    if !dir.exists() {
        return Err("ERR_NOT_INSTALLED".into());
    }
    open_path(dir.to_string_lossy().to_string())
}

/// Remove an installed (extracted) version. Does not touch the downloaded installer.
#[tauri::command]
fn uninstall_version(kind: String, short: String) -> Result<(), String> {
    let dir = version_folder(&kind, &short);
    if !dir.exists() {
        return Err("ERR_NOT_INSTALLED".into());
    }
    std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())
}

// ---- developer mode --------------------------------------------------------

#[cfg(windows)]
const APPMODEL_UNLOCK_KEY: &str =
    r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock";

/// Whether Windows Developer Mode is on (needed to register loose packages).
#[cfg(windows)]
fn dev_mode_enabled() -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("reg")
        .args(["query", APPMODEL_UNLOCK_KEY, "/v", "AllowDevelopmentWithoutDevLicense"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|o| {
            let s = String::from_utf8_lossy(&o.stdout);
            // value line looks like "...REG_DWORD    0x1"
            s.contains("0x1")
        })
        .unwrap_or(false)
}

#[tauri::command]
fn is_developer_mode() -> bool {
    #[cfg(windows)]
    {
        dev_mode_enabled()
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Turn on Developer Mode by writing the AppModelUnlock registry value. This
/// needs admin, so it elevates `reg.exe` via UAC (`-Verb RunAs`). Returns whether
/// Developer Mode is enabled afterwards.
#[tauri::command]
async fn enable_developer_mode() -> Result<bool, String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(|| {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            // Elevate reg.exe to write the HKLM value (shows a UAC prompt).
            const SCRIPT: &str = r#"$ErrorActionPreference='Stop'; $p = Start-Process reg -Verb RunAs -WindowStyle Hidden -PassThru -Wait -ArgumentList 'add','HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock','/v','AllowDevelopmentWithoutDevLicense','/t','REG_DWORD','/d','1','/f'; if ($p.ExitCode -ne 0) { throw ('reg exit ' + $p.ExitCode) }"#;
            let out = std::process::Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", SCRIPT])
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .map_err(|e| e.to_string())?;
            if out.status.success() {
                return Ok(dev_mode_enabled());
            }
            let err = String::from_utf8_lossy(&out.stderr).to_lowercase();
            if err.contains("cancel") || err.contains("denied") || err.contains("operation was") {
                Err("ERR_UAC_DECLINED".into())
            } else {
                Err("ERR_ENABLE_DEVMODE".into())
            }
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    {
        Err("ERR_WINDOWS_ONLY".into())
    }
}

// ---- misc ------------------------------------------------------------------

#[tauri::command]
fn get_paths() -> AppPaths {
    AppPaths {
        base: paths::base_root().to_string_lossy().to_string(),
        installers: paths::installers_dir().to_string_lossy().to_string(),
        versions: paths::versions_dir().to_string_lossy().to_string(),
        is_custom: paths::is_custom(),
    }
}

/// Change where downloads/installs are stored (validated writable, persisted).
/// Note: existing files are not moved; new downloads use the new location.
#[tauri::command]
fn set_base_root(path: String) -> Result<AppPaths, String> {
    paths::set_base_root(&path)?;
    Ok(get_paths())
}

#[tauri::command]
fn reset_base_root() -> Result<AppPaths, String> {
    paths::reset_base_root()?;
    Ok(get_paths())
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    paths::load_config();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(download::DownloadState::default()))
        .invoke_handler(tauri::generate_handler![
            fetch_versions,
            test_mirrors,
            start_download,
            cancel_download,
            resolve_downloaded,
            list_downloaded,
            delete_downloaded,
            install_version,
            list_installed,
            launch_version,
            open_version_folder,
            uninstall_version,
            get_paths,
            set_base_root,
            reset_base_root,
            is_developer_mode,
            enable_developer_mode,
            open_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running BedrockDownloader");
}

//! Resumable, MD5-verified package downloader.
//!
//!   * streams to `<dest>.download`, renames to `<dest>` on success
//!   * resumes with a `Range: bytes=<have>-` header when a partial file exists
//!   * verifies MD5 against the catalog value, retrying up to 3 times
//!   * emits progress/status events the UI listens to
//!   * supports cancellation per task

use futures_util::StreamExt;
use md5::{Digest, Md5};
use serde::Serialize;
use std::collections::HashMap;
use std::io::SeekFrom;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

/// Single event channel the frontend subscribes to.
pub const EVENT: &str = "download-event";

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum DownloadEvent {
    Started { dest: String },
    Progress { dest: String, downloaded: u64, total: u64 },
    Verifying { dest: String },
    Done { dest: String },
    Cancelled { dest: String },
    Error { dest: String, message: String },
}

/// Shared cancellation registry keyed by destination path.
#[derive(Default)]
pub struct DownloadState {
    pub tasks: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl DownloadState {
    fn register(&self, dest: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.tasks
            .lock()
            .unwrap()
            .insert(dest.to_string(), flag.clone());
        flag
    }
    fn remove(&self, dest: &str) {
        self.tasks.lock().unwrap().remove(dest);
    }
    pub fn cancel(&self, dest: &str) {
        if let Some(flag) = self.tasks.lock().unwrap().get(dest) {
            flag.store(true, Ordering::SeqCst);
        }
    }
}

fn emit(app: &AppHandle, ev: DownloadEvent) {
    let _ = app.emit(EVENT, ev);
}

/// Drive a full download with resume + MD5 retry. Returns the final path.
pub async fn run(
    app: AppHandle,
    state: Arc<DownloadState>,
    url: String,
    dest: PathBuf,
    md5: Option<String>,
) -> Result<String, String> {
    let dest_str = dest.to_string_lossy().to_string();
    let cancel = state.register(&dest_str);
    let result = run_inner(&app, &cancel, &url, &dest, md5.as_deref()).await;
    state.remove(&dest_str);

    match &result {
        Ok(_) => emit(&app, DownloadEvent::Done { dest: dest_str.clone() }),
        Err(msg) if msg == "ERR_CANCELLED" => {
            emit(&app, DownloadEvent::Cancelled { dest: dest_str.clone() })
        }
        Err(msg) => emit(
            &app,
            DownloadEvent::Error {
                dest: dest_str.clone(),
                message: msg.clone(),
            },
        ),
    }
    result.map(|_| dest_str)
}

async fn run_inner(
    app: &AppHandle,
    cancel: &Arc<AtomicBool>,
    url: &str,
    dest: &PathBuf,
    md5: Option<&str>,
) -> Result<(), String> {
    let dest_str = dest.to_string_lossy().to_string();
    let download_path = PathBuf::from(format!("{dest_str}.download"));
    let client = reqwest::Client::builder()
        .user_agent(crate::USER_AGENT)
        .build()
        .map_err(|e| e.to_string())?;

    emit(app, DownloadEvent::Started { dest: dest_str.clone() });

    let mut retries: u8 = 0;
    loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = tokio::fs::remove_file(&download_path).await;
            return Err("ERR_CANCELLED".into());
        }

        // Resume: how many bytes do we already have?
        let mut have: u64 = tokio::fs::metadata(&download_path)
            .await
            .map(|m| m.len())
            .unwrap_or(0);

        let mut req = client.get(url);
        if have > 0 {
            req = req.header(reqwest::header::RANGE, format!("bytes={have}-"));
        }
        let resp = req.send().await.map_err(|e| e.to_string())?;
        let status = resp.status();
        if status != reqwest::StatusCode::OK && status != reqwest::StatusCode::PARTIAL_CONTENT {
            return Err(format!("HTTP {status}"));
        }
        // Server ignored our Range -> restart from scratch.
        if have > 0 && status == reqwest::StatusCode::OK {
            let _ = tokio::fs::remove_file(&download_path).await;
            have = 0;
        }

        let total = match resp.content_length() {
            Some(len) if have > 0 && status == reqwest::StatusCode::PARTIAL_CONTENT => have + len,
            Some(len) => len,
            None => 0,
        };

        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(have == 0)
            .open(&download_path)
            .await
            .map_err(|e| e.to_string())?;
        if have > 0 {
            file.seek(SeekFrom::Start(have))
                .await
                .map_err(|e| e.to_string())?;
        }

        let mut downloaded = have;
        emit(
            app,
            DownloadEvent::Progress {
                dest: dest_str.clone(),
                downloaded,
                total,
            },
        );

        let mut stream = resp.bytes_stream();
        let mut last_emit = Instant::now();
        let throttle = Duration::from_millis(250);

        while let Some(chunk) = stream.next().await {
            if cancel.load(Ordering::SeqCst) {
                drop(file);
                let _ = tokio::fs::remove_file(&download_path).await;
                return Err("ERR_CANCELLED".into());
            }
            let bytes = chunk.map_err(|e| e.to_string())?;
            file.write_all(&bytes).await.map_err(|e| e.to_string())?;
            downloaded += bytes.len() as u64;
            if last_emit.elapsed() >= throttle {
                emit(
                    app,
                    DownloadEvent::Progress {
                        dest: dest_str.clone(),
                        downloaded,
                        total,
                    },
                );
                last_emit = Instant::now();
            }
        }
        file.flush().await.map_err(|e| e.to_string())?;
        drop(file);

        emit(
            app,
            DownloadEvent::Progress {
                dest: dest_str.clone(),
                downloaded,
                total,
            },
        );

        // MD5 verification, with up to 3 attempts.
        if let Some(expected) = md5 {
            if !expected.trim().is_empty() {
                emit(app, DownloadEvent::Verifying { dest: dest_str.clone() });
                let got = md5_file(&download_path).await?;
                if !got.eq_ignore_ascii_case(expected.trim()) {
                    let _ = tokio::fs::remove_file(&download_path).await;
                    retries += 1;
                    if retries < 3 {
                        tokio::time::sleep(Duration::from_secs(1)).await;
                        continue;
                    }
                    return Err("ERR_MD5_MISMATCH".into());
                }
            }
        }

        tokio::fs::rename(&download_path, dest)
            .await
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
}

async fn md5_file(path: &PathBuf) -> Result<String, String> {
    let data = tokio::fs::read(path).await.map_err(|e| e.to_string())?;
    let mut hasher = Md5::new();
    hasher.update(&data);
    Ok(hex::encode(hasher.finalize()))
}

/// File extension for a package type ("GDK" -> msixvc, "UWP" -> appx).
pub fn ext_for(package_type: &str) -> &'static str {
    if package_type.eq_ignore_ascii_case("UWP") {
        "appx"
    } else {
        "msixvc"
    }
}

/// Build the destination filename, e.g. "Release 1.21.0.msixvc" / "Release 1.16.0.appx".
pub fn installer_filename(kind: &str, short: &str, package_type: &str) -> String {
    format!("{kind} {short}.{}", ext_for(package_type))
}

/// Emit a download error event for a destination (used before run() starts,
/// e.g. when FE3 link resolution fails).
pub fn emit_error(app: &AppHandle, dest: &str, message: String) {
    emit(
        app,
        DownloadEvent::Error {
            dest: dest.to_string(),
            message,
        },
    );
}

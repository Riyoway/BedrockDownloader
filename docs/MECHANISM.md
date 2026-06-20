# How it works (mechanism)

BedrockDownloader catalogs Microsoft's own package URLs and downloads them
directly. No third-party binaries are bundled; GDK `.msixvc` files are
download-only (decrypting them would need a licensed MSIXVC decryptor, which
isn't included).

## 1. GDK (modern, `.msixvc`)

1. **Catalog** - fetch `historical_versions.json` from the community DB
   [`LiteLDev/minecraft-windows-gdk-version-db`](https://github.com/LiteLDev/minecraft-windows-gdk-version-db)
   (GitHub, proxy, and GitCode mirrors). Each entry: `version`, `urls[]`,
   `timestamp`, `md5`.

   ```jsonc
   {
     "releaseVersions": [{
       "version": "Release 1.21.120.04",
       "urls": ["http://assets1.xboxlive.com/.../MICROSOFT.MINECRAFTUWP_..._x64__8wekyb3d8bbwe.msixvc"],
       "timestamp": 1757433615,
       "md5": "…"
     }],
     "previewVersions": [ … ]
   }
   ```

   The `urls` are **Microsoft's own Xbox Live CDN links**; the DB is just a
   catalog of direct package URLs + MD5.

2. **Mirror pick** - each URL is latency-tested (HEAD); the fastest is selected.
3. **Download** - plain HTTP GET, resumable via `Range` + a `.download` temp
   file, MD5-verified (retry ×3), saved to `installers/`.
4. **Install - not done here.** A `.msixvc` is an *encrypted* MSIXVC package;
   decrypting it needs a licensed MSIXVC decryptor that this project does not
   include. GDK is download-only - in-app install/launch isn't supported.

## 2. UWP (legacy, `.appx`)

UWP packages aren't catalogued with direct URLs - only with a Windows Update
`UpdateID`. So:

1. **Catalog** - version + `UpdateID` from the
   [raythnetwork](https://www.raythnetwork.co.uk) DB (JSON `[version, updateId,
   type, arch]` where type 0/1/2 = Release/Beta/Preview, plus a categorized TXT
   variant), merged by `UpdateID`.
2. **Resolve** - a single `GetExtendedUpdateInfo2` SOAP call to Microsoft's
   **FE3** service (`fe3.delivery.mp.microsoft.com/.../secured`) with the
   `UpdateID` + `RevisionNumber=1` returns a fresh
   `tlu.dl.delivery.mp.microsoft.com` link. **Release and Preview resolve
   anonymously** (no Microsoft account). **Beta** needs an MSA token and is
   skipped.
3. **Download** - same resumable downloader (no MD5 for this path).
4. **Install** - an `.appx` is a plain ZIP, so it is unzipped directly (Rust
   `zip` crate); `.appxbundle` nesting is handled.

## Editions summary

| Edition | Format | URL source | In-app install | Auth |
|---|---|---|---|---|
| **GDK** (modern) | `.msixvc` (encrypted) | community catalog, direct CDN URLs + MD5 | **download-only** (encrypted) | none |
| **UWP** (legacy) | `.appx` (ZIP) | FE3 live resolve via `UpdateID` | unzip, install, launch | none (Release + Preview) |

## Source map (Rust)

| Concern | File |
|---|---|
| Catalog fetch (GDK + UWP) + mirror latency | `src-tauri/src/versiondb.rs` |
| FE3 link resolution (UWP) | `src-tauri/src/fe3.rs` |
| Resumable, MD5-verified downloader | `src-tauri/src/download.rs` |
| UWP `.appx` unzip | `src-tauri/src/extract.rs` |
| Storage layout / configurable base | `src-tauri/src/paths.rs` |
| Tauri commands + wiring | `src-tauri/src/lib.rs` |
| UI | `src/` (React + HeroUI) |

## Tauri commands

`fetch_versions`, `test_mirrors`, `start_download`, `cancel_download`,
`list_downloaded`, `resolve_downloaded`, `delete_downloaded`, `install_version`
(UWP only), `list_installed`, `launch_version`, `open_version_folder`,
`uninstall_version`, `get_paths`, `set_base_root`, `reset_base_root`, `open_path`.

Download progress is reported on the `download-event` channel - a tagged union:
`{ kind: "started" | "progress" | "verifying" | "done" | "cancelled" | "error",
dest, downloaded, total, message }`.

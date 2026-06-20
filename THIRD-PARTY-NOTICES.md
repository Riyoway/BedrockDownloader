# Third-Party Notices

BedrockDownloader's own source code is MIT-licensed (see `LICENSE`). It bundles
**no third-party binaries** - everything it ships is its own code plus the
open-source dependencies listed below. UWP `.appx` extraction is implemented in
Rust (a ZIP unzip). GDK `.msixvc` packages are **download-only** (they're
encrypted and we don't bundle a decryptor).

## Data sources (network services, not bundled)
- `LiteLDev/minecraft-windows-gdk-version-db` - GDK version catalog (URLs + MD5).
- `raythnetwork.co.uk` - legacy UWP version database (UpdateIDs).
- Microsoft FE3 delivery service (`fe3.delivery.mp.microsoft.com`) - resolves
  UWP download links.
- The Microsoft Store Engagement framework, if missing, is fetched on first UWP
  launch from a public mirror and installed via the signed Microsoft package.

## Open-source dependencies
- **Tauri** (Apache-2.0 / MIT) - desktop runtime.
- **React**, **lucide-react** (MIT) - UI.
- **HeroUI** (MIT) - UI components.
- **reqwest**, **tokio**, **zip**, **md-5**, **serde** (MIT / Apache-2.0) - Rust crates.
- **@south-paw/typeface-minecraft** - a fan-made "Minecraft"-style font used for
  the UI. Not affiliated with Mojang/Microsoft; use within its own terms.

See each project's repository for full license text.

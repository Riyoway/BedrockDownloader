import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

export interface AppPaths {
  base: string;
  installers: string;
  versions: string;
  isCustom: boolean;
}

export type VersionKind = "Release" | "Preview";
export type PackageType = "GDK" | "UWP";

export interface VersionItem {
  version: string;
  short: string;
  kind: VersionKind;
  packageType: PackageType;
  urls: string[];
  updateId?: string;
  timestamp?: number;
  md5?: string;
}

export interface VersionCatalog {
  items: VersionItem[];
  source: string;
}

export interface MirrorResult {
  url: string;
  label: string;
  latencyMs: number;
  ok: boolean;
}

export type DownloadEvent =
  | { kind: "started"; dest: string }
  | { kind: "progress"; dest: string; downloaded: number; total: number }
  | { kind: "verifying"; dest: string }
  | { kind: "done"; dest: string }
  | { kind: "cancelled"; dest: string }
  | { kind: "error"; dest: string; message: string };

export const api = {
  fetchVersions: (preferCn: boolean) =>
    invoke<VersionCatalog>("fetch_versions", { preferCn }),

  testMirrors: (urls: string[], timeoutMs = 7000) =>
    invoke<MirrorResult[]>("test_mirrors", { urls, timeoutMs }),

  startDownload: (item: VersionItem, url?: string | null, md5?: string | null) =>
    invoke<string>("start_download", {
      kind: item.kind,
      short: item.short,
      packageType: item.packageType,
      url: url ?? null,
      updateId: item.updateId ?? null,
      md5: md5 ?? null,
    }),

  cancelDownload: (dest: string) => invoke<void>("cancel_download", { dest }),

  listDownloaded: () => invoke<string[]>("list_downloaded"),

  deleteDownloaded: (item: VersionItem) =>
    invoke<void>("delete_downloaded", {
      kind: item.kind,
      short: item.short,
      packageType: item.packageType,
    }),

  installVersion: (item: VersionItem, folderName: string) =>
    invoke<string>("install_version", {
      kind: item.kind,
      short: item.short,
      packageType: item.packageType,
      folderName,
    }),

  listInstalled: () => invoke<string[]>("list_installed"),

  launchVersion: (item: VersionItem) =>
    invoke<void>("launch_version", { kind: item.kind, short: item.short }),

  openVersionFolder: (item: VersionItem) =>
    invoke<void>("open_version_folder", { kind: item.kind, short: item.short }),

  uninstallVersion: (item: VersionItem) =>
    invoke<void>("uninstall_version", { kind: item.kind, short: item.short }),

  isDeveloperMode: () => invoke<boolean>("is_developer_mode"),

  enableDeveloperMode: () => invoke<boolean>("enable_developer_mode"),

  openPath: (path: string) => invoke<void>("open_path", { path }),

  getPaths: () => invoke<AppPaths>("get_paths"),

  setBaseRoot: (path: string) => invoke<AppPaths>("set_base_root", { path }),

  resetBaseRoot: () => invoke<AppPaths>("reset_base_root"),

  /// Open a folder picker; returns the chosen path or null if cancelled.
  pickFolder: async (defaultPath?: string): Promise<string | null> => {
    const res = await openDialog({ directory: true, multiple: false, defaultPath });
    return typeof res === "string" ? res : null;
  },
};

export function onDownloadEvent(cb: (e: DownloadEvent) => void): Promise<UnlistenFn> {
  return listen<DownloadEvent>("download-event", (event) => cb(event.payload));
}

export type InstallEvent =
  | { kind: "started"; folder: string }
  | { kind: "progress"; folder: string; current: number; total: number; file: string }
  | { kind: "done"; folder: string }
  | { kind: "error"; folder: string; message: string };

export function onInstallEvent(cb: (e: InstallEvent) => void): Promise<UnlistenFn> {
  return listen<InstallEvent>("install-event", (event) => cb(event.payload));
}

// ---- small formatting helpers ----
export function fmtBytes(n: number): string {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function fmtDate(ts?: number): string {
  if (!ts) return "-";
  try {
    return new Date(ts * 1000).toISOString().slice(0, 10);
  } catch {
    return "-";
  }
}

export function hostOf(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return u;
  }
}

export function installerName(item: VersionItem): string {
  const ext = item.packageType === "UWP" ? "appx" : "msixvc";
  return `${item.kind} ${item.short}.${ext}`.toLowerCase();
}

export const isChinaUser = (() => {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    const lang = (navigator.language || "").toLowerCase();
    return (
      tz === "Asia/Shanghai" ||
      tz === "Asia/Urumqi" ||
      lang.startsWith("zh-cn")
    );
  } catch {
    return false;
  }
})();

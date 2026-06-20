import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Input,
  Select,
  SelectItem,
  Button,
  Table,
  TableHeader,
  TableColumn,
  TableBody,
  TableRow,
  TableCell,
  Chip,
  Tooltip,
  addToast,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  useDisclosure,
  Snippet,
  Card,
  CardBody,
  Progress,
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@heroui/react";
import {
  Search,
  RefreshCw,
  Download,
  Trash2,
  Package,
  Loader2,
  Settings,
  FolderOpen,
  RotateCcw,
  Github,
  Play,
  Copy,
  Link as LinkIcon,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import { ContextMenu, type CtxItem } from "./components/ContextMenu";

const GITHUB_URL = "https://github.com/Riyoway/BedrockDownloader";
import {
  api,
  fmtDate,
  installerName,
  isChinaUser,
  onDownloadEvent,
  onInstallEvent,
  type VersionItem,
  type AppPaths,
} from "./api";
import { MirrorModal } from "./components/MirrorModal";
import { DownloadTray, type ActiveDownload } from "./components/DownloadTray";

type TypeFilter = "all" | "Release" | "Preview";
type StatusFilter = "all" | "downloaded" | "not" | "installed";
type EditionFilter = "all" | "GDK" | "UWP";
type GameEdition = "win10" | "bedrock";
type EditionNameFilter = "all" | GameEdition;

/// The game was "Minecraft: Windows 10 Edition" up to 1.1.5; from 1.2.0 on it's
/// "Bedrock Edition". Classify by comparing the version's major.minor to 1.2.
function gameEdition(short: string): GameEdition {
  const [maj = 0, min = 0] = short.split(".").map((n) => parseInt(n, 10) || 0);
  return maj < 1 || (maj === 1 && min < 2) ? "win10" : "bedrock";
}

function shortFromDest(dest: string): { kind: string; short: string } {
  const base = dest.replace(/\\/g, "/").split("/").pop() ?? "";
  const m = base.replace(/\.(msixvc|appx)$/i, "").match(/^(Release|Preview)\s+(.+)$/);
  return m ? { kind: m[1], short: m[2] } : { kind: "", short: base };
}

export default function App() {
  const [items, setItems] = useState<VersionItem[]>([]);
  const [downloaded, setDownloaded] = useState<Set<string>>(new Set());
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [editionFilter, setEditionFilter] = useState<EditionFilter>("all");
  const [editionNameFilter, setEditionNameFilter] = useState<EditionNameFilter>("all");

  const activeFilterCount =
    (typeFilter !== "all" ? 1 : 0) +
    (editionFilter !== "all" ? 1 : 0) +
    (editionNameFilter !== "all" ? 1 : 0) +
    (statusFilter !== "all" ? 1 : 0);

  function resetFilters() {
    setTypeFilter("all");
    setEditionFilter("all");
    setEditionNameFilter("all");
    setStatusFilter("all");
  }

  const [modalItem, setModalItem] = useState<VersionItem | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const [active, setActive] = useState<Record<string, ActiveDownload>>({});
  const [installing, setInstalling] = useState<Set<string>>(new Set());
  const [launching, setLaunching] = useState<Set<string>>(new Set());
  const [installProgress, setInstallProgress] = useState<{
    folder: string;
    current: number;
    total: number;
    file: string;
    status: "started" | "progress" | "done" | "error";
    message?: string;
  } | null>(null);

  const [devModeItem, setDevModeItem] = useState<VersionItem | null>(null);
  const [enablingDev, setEnablingDev] = useState(false);

  const settings = useDisclosure();
  const [paths, setPaths] = useState<AppPaths | null>(null);
  const refreshPaths = useCallback(async () => {
    try {
      setPaths(await api.getPaths());
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    refreshPaths();
  }, [refreshPaths]);

  async function changeFolder() {
    try {
      const picked = await api.pickFolder(paths?.base);
      if (!picked) return;
      const p = await api.setBaseRoot(picked);
      setPaths(p);
      await refreshDownloaded();
      addToast({ title: "Download location updated", description: p.base, color: "success" });
    } catch (e) {
      addToast({ title: "Could not change location", description: String(e), color: "danger" });
    }
  }

  async function resetFolder() {
    try {
      const p = await api.resetBaseRoot();
      setPaths(p);
      await refreshDownloaded();
      addToast({ title: "Reset to default location", description: p.base, color: "default" });
    } catch (e) {
      addToast({ title: "Reset failed", description: String(e), color: "danger" });
    }
  }

  const refreshDownloaded = useCallback(async () => {
    try {
      const names = await api.listDownloaded();
      setDownloaded(new Set(names.map((n) => n.toLowerCase())));
    } catch {
      /* ignore */
    }
  }, []);

  const refreshInstalled = useCallback(async () => {
    try {
      const names = await api.listInstalled();
      setInstalled(new Set(names.map((n) => n.toLowerCase())));
    } catch {
      /* ignore */
    }
  }, []);

  const loadCatalog = useCallback(async () => {
    setLoading(true);
    try {
      const cat = await api.fetchVersions(isChinaUser);
      setItems(cat.items);
      await Promise.all([refreshDownloaded(), refreshInstalled()]);
    } catch (e) {
      addToast({ title: "Failed to load catalog", description: String(e), color: "danger" });
    } finally {
      setLoading(false);
    }
  }, [refreshDownloaded, refreshInstalled]);

  // Subscribe to backend download events.
  const downloadedRef = useRef(refreshDownloaded);
  downloadedRef.current = refreshDownloaded;
  useEffect(() => {
    const unlisten = onDownloadEvent((e) => {
      setActive((prev) => {
        const cur = prev[e.dest] ?? {
          dest: e.dest,
          ...shortFromDest(e.dest),
          downloaded: 0,
          total: 0,
          status: e.kind,
        };
        const next: ActiveDownload = { ...cur, status: e.kind };
        if (e.kind === "progress") {
          next.downloaded = e.downloaded;
          next.total = e.total;
        }
        if (e.kind === "error") next.message = e.message;
        return { ...prev, [e.dest]: next };
      });

      if (e.kind === "done") {
        const { kind, short } = shortFromDest(e.dest);
        addToast({ title: `Downloaded ${kind} ${short}`, color: "success" });
        downloadedRef.current();
        setTimeout(() => setActive((p) => dropKey(p, e.dest)), 2500);
      } else if (e.kind === "cancelled") {
        setTimeout(() => setActive((p) => dropKey(p, e.dest)), 1200);
      } else if (e.kind === "error") {
        addToast({ title: "Download failed", description: e.message, color: "danger" });
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Install/extract progress.
  useEffect(() => {
    const unlisten = onInstallEvent((e) => {
      if (e.kind === "started") {
        setInstallProgress({ folder: e.folder, current: 0, total: 0, file: "", status: "started" });
      } else if (e.kind === "progress") {
        setInstallProgress({ folder: e.folder, current: e.current, total: e.total, file: e.file, status: "progress" });
      } else if (e.kind === "done") {
        setInstallProgress({ folder: e.folder, current: 1, total: 1, file: "", status: "done" });
        refreshInstalled();
        setTimeout(() => setInstallProgress((p) => (p?.status === "done" ? null : p)), 1800);
      } else if (e.kind === "error") {
        setInstallProgress((p) => (p ? { ...p, status: "error", message: e.message } : null));
        setTimeout(() => setInstallProgress((p) => (p?.status === "error" ? null : p)), 4000);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadCatalog();
  }, [loadCatalog]);

  const isDownloaded = useCallback(
    (it: VersionItem) => downloaded.has(installerName(it)),
    [downloaded],
  );

  const isInstalled = useCallback(
    (it: VersionItem) => installed.has(`${it.kind} ${it.short}`.toLowerCase()),
    [installed],
  );

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((it) => {
      if (typeFilter !== "all" && it.kind !== typeFilter) return false;
      if (editionFilter !== "all" && it.packageType !== editionFilter) return false;
      if (editionNameFilter !== "all" && gameEdition(it.short) !== editionNameFilter) return false;
      const dl = isDownloaded(it);
      if (statusFilter === "downloaded" && !dl) return false;
      if (statusFilter === "not" && dl) return false;
      if (statusFilter === "installed" && !isInstalled(it)) return false;
      if (q && !`${it.kind} ${it.short}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [items, query, typeFilter, statusFilter, editionFilter, editionNameFilter, isDownloaded, isInstalled]);

  function registerActive(dest: string, it: VersionItem) {
    setActive((p) => ({
      ...p,
      [dest]: { dest, kind: it.kind, short: it.short, downloaded: 0, total: 0, status: "started" },
    }));
  }

  // GDK has multiple CDN mirrors -> show the picker. UWP resolves a single
  // link via FE3 on the backend, so download starts directly.
  function onDownloadClick(it: VersionItem) {
    if (it.packageType === "UWP") {
      startUwpDownload(it);
    } else {
      setModalItem(it);
      setModalOpen(true);
    }
  }

  async function startUwpDownload(it: VersionItem) {
    try {
      const dest = await api.startDownload(it);
      registerActive(dest, it);
    } catch (e) {
      addToast({ title: "Could not start download", description: String(e), color: "danger" });
    }
  }

  async function confirmDownload(url: string) {
    if (!modalItem) return;
    const it = modalItem;
    setModalOpen(false);
    try {
      const dest = await api.startDownload(it, url, it.md5);
      registerActive(dest, it);
    } catch (e) {
      addToast({ title: "Could not start download", description: String(e), color: "danger" });
    }
  }

  async function install(it: VersionItem) {
    const key = `${it.kind} ${it.short}`;
    setInstalling((s) => new Set(s).add(key));
    try {
      await api.installVersion(it, key);
      await refreshInstalled();
    } catch (e) {
      addToast({ title: "Install failed", description: String(e), color: "danger" });
    } finally {
      setInstalling((s) => {
        const n = new Set(s);
        n.delete(key);
        return n;
      });
    }
  }

  async function launchVersion(it: VersionItem) {
    const key = `${it.kind} ${it.short}`;
    if (launching.size > 0) return; // one launch at a time
    setLaunching((s) => new Set(s).add(key));
    try {
      await api.launchVersion(it);
    } catch (e) {
      const s = String(e);
      if (s.includes("ERR_DEVELOPER_MODE")) {
        setDevModeItem(it); // open the "enable Developer Mode" dialog
      } else {
        addToast({
          title: "Could not launch",
          description: s.replace(/^ERR_REGISTER:\s*/, ""),
          color: "danger",
          timeout: 15000,
        });
      }
    } finally {
      setLaunching((s) => {
        const n = new Set(s);
        n.delete(key);
        return n;
      });
    }
  }

  async function enableDevModeAndRetry() {
    if (!devModeItem) return;
    const it = devModeItem;
    setEnablingDev(true);
    try {
      const ok = await api.enableDeveloperMode();
      if (ok) {
        setDevModeItem(null);
        addToast({ title: "Developer Mode enabled", color: "success" });
        launchVersion(it); // retry
      } else {
        addToast({ title: "Developer Mode is still off", color: "warning" });
      }
    } catch (e) {
      const s = String(e);
      addToast({
        title: s.includes("ERR_UAC_DECLINED") ? "Permission was declined" : "Could not enable Developer Mode",
        description: s.includes("ERR_UAC_DECLINED")
          ? "Approve the Windows prompt to enable it, or turn it on manually in Settings."
          : s,
        color: "danger",
      });
    } finally {
      setEnablingDev(false);
    }
  }

  async function openVersionFolder(it: VersionItem) {
    try {
      await api.openVersionFolder(it);
    } catch (e) {
      addToast({ title: "Could not open folder", description: String(e), color: "danger" });
    }
  }

  function copyText(text: string, what: string) {
    navigator.clipboard?.writeText(text);
    addToast({ title: `Copied ${what}`, color: "default" });
  }

  // Right-click menu.
  const [menu, setMenu] = useState<{ x: number; y: number; item: VersionItem } | null>(null);

  function menuItems(it: VersionItem): CtxItem[] {
    const dl = isDownloaded(it);
    const inst = isInstalled(it);
    const isUwp = it.packageType === "UWP"; // only UWP can be installed/launched here
    const out: CtxItem[] = [];

    if (inst && launching.size === 0) {
      out.push({ key: "launch", label: "Launch", icon: <Play size={15} />, onSelect: () => launchVersion(it) });
    } else if (dl && isUwp) {
      out.push({ key: "install", label: "Install", icon: <Package size={15} />, onSelect: () => install(it) });
    } else if (!dl) {
      out.push({ key: "download", label: "Download", icon: <Download size={15} />, onSelect: () => onDownloadClick(it) });
    }

    out.push("divider");
    if (inst) {
      out.push({ key: "openfolder", label: "Open install folder", icon: <FolderOpen size={15} />, onSelect: () => openVersionFolder(it) });
    }
    if (dl) {
      out.push({ key: "openinst", label: "Open installer location", icon: <FolderOpen size={15} />, onSelect: () => paths && api.openPath(paths.installers) });
    }
    out.push({ key: "copyver", label: "Copy version", icon: <Copy size={15} />, onSelect: () => copyText(`${it.kind} ${it.short}`, "version") });
    if (it.packageType === "GDK" && it.urls.length > 0) {
      out.push({ key: "copyurl", label: "Copy download URL", icon: <LinkIcon size={15} />, onSelect: () => copyText(it.urls[0], "URL") });
    }

    const danger: CtxItem[] = [];
    if (inst) danger.push({ key: "uninstall", label: "Uninstall", icon: <Trash2 size={15} />, danger: true, onSelect: () => uninstall(it) });
    if (dl) danger.push({ key: "delinst", label: "Delete installer", icon: <Trash2 size={15} />, danger: true, onSelect: () => remove(it) });
    if (danger.length) {
      out.push("divider", ...danger);
    }
    return out;
  }

  function onRowContextMenu(e: React.MouseEvent) {
    const tr = (e.target as HTMLElement).closest("tr");
    const tbody = tr?.closest("tbody");
    if (!tr || !tbody) return; // not a body row (e.g. header)
    const bodyRows = Array.from(tbody.querySelectorAll(":scope > tr"));
    const idx = bodyRows.indexOf(tr);
    if (idx < 0 || idx >= rows.length) return;
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, item: rows[idx] });
  }

  async function uninstall(it: VersionItem) {
    try {
      await api.uninstallVersion(it);
      await refreshInstalled();
      addToast({ title: `Uninstalled ${it.kind} ${it.short}`, color: "default" });
    } catch (e) {
      addToast({ title: "Uninstall failed", description: String(e), color: "danger" });
    }
  }

  async function remove(it: VersionItem) {
    try {
      await api.deleteDownloaded(it);
      await refreshDownloaded();
      addToast({ title: `Deleted ${it.kind} ${it.short}`, color: "default" });
    } catch (e) {
      addToast({ title: "Delete failed", description: String(e), color: "danger" });
    }
  }

  // Memoized table rows - rebuilt only when row data changes, so opening the
  // context menu (or other UI state) doesn't re-render the whole table.
  const tableRows = useMemo(
    () =>
      rows.map((it) => {
        const dl = isDownloaded(it);
        const inst = isInstalled(it);
        const isUwp = it.packageType === "UWP"; // only UWP can be installed/launched
        const key = `${it.kind} ${it.short}`;
        const isInstalling = installing.has(key);
        const isLaunching = launching.has(key);
        const anyLaunching = launching.size > 0; // block parallel launches
        return (
          <TableRow key={`${it.packageType} ${key}`}>
            <TableCell>
              <span className="font-mono text-sm">{it.short}</span>
            </TableCell>
            <TableCell>
              <Chip size="sm" variant="flat" color={it.packageType === "GDK" ? "primary" : "default"}>
                {it.packageType}
              </Chip>
            </TableCell>
            <TableCell>
              <Chip size="sm" variant="flat" color={it.kind === "Release" ? "warning" : "secondary"}>
                {it.kind}
              </Chip>
            </TableCell>
            <TableCell>
              <span className="text-default-400 text-sm">{fmtDate(it.timestamp)}</span>
            </TableCell>
            <TableCell>
              <Chip
                size="sm"
                variant="dot"
                color={inst ? "primary" : dl ? "success" : "default"}
                classNames={{ content: "ps-1.5" }}
              >
                {inst ? "Installed" : dl ? "Downloaded" : "Not downloaded"}
              </Chip>
            </TableCell>
            <TableCell>
              <div className="flex justify-end gap-2">
                {inst ? (
                  <>
                    <Button
                      size="sm"
                      radius="full"
                      color="primary"
                      variant="solid"
                      className="font-medium shadow-sm shadow-primary-500/20"
                      isLoading={isLaunching}
                      isDisabled={anyLaunching && !isLaunching}
                      startContent={!isLaunching && <Play size={14} className="fill-current" />}
                      onPress={() => launchVersion(it)}
                    >
                      {isLaunching ? "Launching…" : "Launch"}
                    </Button>
                    <Tooltip content="Uninstall" closeDelay={0}>
                      <Button
                        isIconOnly
                        size="sm"
                        radius="full"
                        variant="flat"
                        color="danger"
                        onPress={() => uninstall(it)}
                      >
                        <Trash2 size={15} />
                      </Button>
                    </Tooltip>
                  </>
                ) : dl ? (
                  <>
                    {isUwp ? (
                      <Button
                        size="sm"
                        radius="full"
                        color="primary"
                        variant="solid"
                        className="font-medium shadow-sm shadow-primary-500/20"
                        isLoading={isInstalling}
                        startContent={!isInstalling && <Package size={15} />}
                        onPress={() => install(it)}
                      >
                        Install
                      </Button>
                    ) : (
                      <Tooltip content="GDK is download-only (in-app install isn't supported)" closeDelay={0}>
                        <span className="inline-flex">
                          <Button
                            size="sm"
                            radius="full"
                            variant="flat"
                            isDisabled
                            startContent={<Package size={15} />}
                          >
                            Install
                          </Button>
                        </span>
                      </Tooltip>
                    )}
                    <Tooltip content="Delete installer" closeDelay={0}>
                      <Button
                        isIconOnly
                        size="sm"
                        radius="full"
                        variant="flat"
                        color="danger"
                        onPress={() => remove(it)}
                      >
                        <Trash2 size={15} />
                      </Button>
                    </Tooltip>
                  </>
                ) : (
                  <Button
                    size="sm"
                    radius="full"
                    variant="flat"
                    startContent={<Download size={15} />}
                    onPress={() => onDownloadClick(it)}
                  >
                    Download
                  </Button>
                )}
              </div>
            </TableCell>
          </TableRow>
        );
      }),
    // handlers are stable function declarations; intentionally excluded
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, downloaded, installed, installing, launching],
  );

  const activeList = Object.values(active);

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <header className="px-6 pt-5 pb-4 border-b border-default-100">
        <div className="flex items-center gap-3">
          <img
            src="/icon.png"
            alt="Bedrock Downloader"
            className="w-11 h-11 rounded-2xl border border-default-100"
          />
          <div>
            <h1 className="text-lg font-semibold leading-tight">Bedrock Downloader</h1>
            <p className="text-xs text-default-400">Minecraft Bedrock packages</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 mt-4">
          <Input
            aria-label="Search"
            size="sm"
            radius="full"
            placeholder="Search version…"
            value={query}
            onValueChange={setQuery}
            isClearable
            onClear={() => setQuery("")}
            startContent={<Search size={15} className="text-default-400" />}
            className="w-full sm:flex-1 sm:max-w-md"
          />
          <Popover placement="bottom-start">
            <PopoverTrigger>
              <Button
                size="sm"
                radius="full"
                variant="flat"
                startContent={<SlidersHorizontal size={15} />}
                endContent={
                  activeFilterCount > 0 ? (
                    <span
                      className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/20 text-[11px] font-semibold leading-none text-primary"
                      style={{ fontFamily: "system-ui, sans-serif" }}
                    >
                      {activeFilterCount}
                    </span>
                  ) : null
                }
              >
                Filters
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-60 gap-3 p-3">
              <Select
                label="Type"
                labelPlacement="outside"
                aria-label="Type filter"
                size="sm"
                disallowEmptySelection
                selectionMode="single"
                selectedKeys={[typeFilter]}
                onSelectionChange={(keys) => setTypeFilter(Array.from(keys)[0] as TypeFilter)}
                className="w-full"
              >
                <SelectItem key="all">All types</SelectItem>
                <SelectItem key="Release">Release</SelectItem>
                <SelectItem key="Preview">Preview</SelectItem>
              </Select>
              <Select
                label="Format"
                labelPlacement="outside"
                aria-label="Format filter"
                size="sm"
                disallowEmptySelection
                selectionMode="single"
                selectedKeys={[editionFilter]}
                onSelectionChange={(keys) => setEditionFilter(Array.from(keys)[0] as EditionFilter)}
                className="w-full"
              >
                <SelectItem key="all">All formats</SelectItem>
                <SelectItem key="GDK">Modern (GDK)</SelectItem>
                <SelectItem key="UWP">Legacy (UWP)</SelectItem>
              </Select>
              <Select
                label="Edition"
                labelPlacement="outside"
                aria-label="Edition filter"
                size="sm"
                disallowEmptySelection
                selectionMode="single"
                selectedKeys={[editionNameFilter]}
                onSelectionChange={(keys) => setEditionNameFilter(Array.from(keys)[0] as EditionNameFilter)}
                className="w-full"
              >
                <SelectItem key="all">All editions</SelectItem>
                <SelectItem key="win10">Windows 10 Edition</SelectItem>
                <SelectItem key="bedrock">Bedrock Edition</SelectItem>
              </Select>
              <Select
                label="Status"
                labelPlacement="outside"
                aria-label="Status filter"
                size="sm"
                disallowEmptySelection
                selectionMode="single"
                selectedKeys={[statusFilter]}
                onSelectionChange={(keys) => setStatusFilter(Array.from(keys)[0] as StatusFilter)}
                className="w-full"
              >
                <SelectItem key="all">All status</SelectItem>
                <SelectItem key="downloaded">Downloaded</SelectItem>
                <SelectItem key="not">Not downloaded</SelectItem>
                <SelectItem key="installed">Installed</SelectItem>
              </Select>
              {activeFilterCount > 0 && (
                <Button
                  size="sm"
                  variant="light"
                  startContent={<RotateCcw size={14} />}
                  onPress={resetFilters}
                  className="self-start"
                >
                  Reset filters
                </Button>
              )}
            </PopoverContent>
          </Popover>
          <Tooltip content="Refresh" closeDelay={0}>
            <Button
              size="sm"
              radius="full"
              variant="flat"
              isIconOnly
              isLoading={loading}
              onPress={loadCatalog}
            >
              {!loading && <RefreshCw size={15} />}
            </Button>
          </Tooltip>
          <Tooltip content="Settings" closeDelay={0}>
            <Button
              size="sm"
              radius="full"
              variant="flat"
              isIconOnly
              onPress={() => {
                refreshPaths();
                settings.onOpen();
              }}
            >
              <Settings size={15} />
            </Button>
          </Tooltip>
          <Tooltip content="View on GitHub" closeDelay={0}>
            <Button
              size="sm"
              radius="full"
              variant="flat"
              isIconOnly
              onPress={() => api.openPath(GITHUB_URL)}
            >
              <Github size={15} />
            </Button>
          </Tooltip>
        </div>
      </header>

      {/* Table */}
      <div className="flex-1 min-h-0 px-6 py-4" onContextMenu={onRowContextMenu}>
        <Table
          aria-label="Minecraft Bedrock versions"
          removeWrapper
          isHeaderSticky
          classNames={{
            base: "h-full overflow-auto",
            table: "min-w-full border-separate border-spacing-0",
            th: "bg-background text-default-500 border-b border-default-200 h-10",
            td: "border-b border-default-100/70 py-3",
            tr: "transition-colors hover:bg-content2/50",
          }}
        >
          <TableHeader>
            <TableColumn key="version">VERSION</TableColumn>
            <TableColumn key="edition">EDITION</TableColumn>
            <TableColumn key="type">TYPE</TableColumn>
            <TableColumn key="date">DATE</TableColumn>
            <TableColumn key="status">STATUS</TableColumn>
            <TableColumn key="actions" align="end">
              {""}
            </TableColumn>
          </TableHeader>
          <TableBody emptyContent={loading ? "Loading…" : "No versions match."}>
            {tableRows}
          </TableBody>
        </Table>
      </div>

      <footer className="shrink-0 px-6 py-1.5 border-t border-default-100 text-[11px] leading-tight text-default-400 text-center">
        Not affiliated with, associated with, or approved by Mojang or Microsoft.
      </footer>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.item)}
          onClose={() => setMenu(null)}
        />
      )}

      {installProgress && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 w-[440px] max-w-[90vw] z-40">
          <Card className="bg-content1/95 backdrop-blur border border-default-100 shadow-2xl">
            <CardBody className="gap-2">
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="font-medium truncate">
                  {installProgress.status === "error"
                    ? "Install failed"
                    : installProgress.status === "done"
                      ? "Installed"
                      : "Installing"}{" "}
                  {installProgress.folder}
                </span>
                {installProgress.total > 0 && installProgress.status === "progress" && (
                  <span className="text-default-400 text-xs font-mono">
                    {Math.round((installProgress.current / installProgress.total) * 100)}%
                  </span>
                )}
              </div>
              <Progress
                size="sm"
                aria-label="install progress"
                isIndeterminate={installProgress.status === "started" || (installProgress.status === "progress" && !installProgress.total)}
                value={installProgress.total ? (installProgress.current / installProgress.total) * 100 : installProgress.status === "done" ? 100 : 0}
                color={installProgress.status === "error" ? "danger" : "primary"}
              />
              <div className="text-xs text-default-400 truncate h-4">
                {installProgress.status === "error" ? installProgress.message : installProgress.file}
              </div>
            </CardBody>
          </Card>
        </div>
      )}

      <MirrorModal
        item={modalItem}
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        onConfirm={confirmDownload}
      />

      <Modal isOpen={settings.isOpen} onClose={settings.onClose} size="lg" backdrop="blur">
        <ModalContent>
          {() => (
            <>
              <ModalHeader className="flex items-center gap-2">
                <Settings size={18} className="text-primary" />
                Settings
              </ModalHeader>
              <ModalBody>
                <div className="text-sm font-semibold text-default-600">Download location</div>
                <p className="text-xs text-default-400 -mt-1">
                  Where packages are downloaded and installed. Large game files can be
                  put on another drive. Existing files are not moved automatically.
                </p>
                <Snippet
                  hideSymbol
                  variant="flat"
                  className="w-full"
                  classNames={{ pre: "whitespace-pre-wrap break-all text-xs" }}
                >
                  {paths?.base ?? "…"}
                </Snippet>
                <div className="grid grid-cols-2 gap-2 text-xs text-default-500">
                  <div>
                    <div className="font-semibold text-default-600">Installers</div>
                    <div className="break-all">{paths?.installers ?? "…"}</div>
                  </div>
                  <div>
                    <div className="font-semibold text-default-600">Versions</div>
                    <div className="break-all">{paths?.versions ?? "…"}</div>
                  </div>
                </div>
                {paths?.isCustom && (
                  <Chip size="sm" variant="flat" color="primary" className="w-fit">
                    custom location
                  </Chip>
                )}
              </ModalBody>
              <ModalFooter className="flex-wrap">
                <Button
                  variant="flat"
                  startContent={<FolderOpen size={16} />}
                  onPress={() => paths && api.openPath(paths.installers)}
                >
                  Open folder
                </Button>
                {paths?.isCustom && (
                  <Button
                    variant="light"
                    startContent={<RotateCcw size={16} />}
                    onPress={resetFolder}
                  >
                    Reset to default
                  </Button>
                )}
                <Button color="primary" startContent={<FolderOpen size={16} />} onPress={changeFolder}>
                  Change folder…
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>

      <Modal isOpen={!!devModeItem} onClose={() => setDevModeItem(null)} size="md" backdrop="blur">
        <ModalContent>
          {() => (
            <>
              <ModalHeader className="flex items-center gap-2">
                <ShieldCheck size={18} className="text-primary" />
                Developer Mode required
              </ModalHeader>
              <ModalBody>
                <p className="text-sm text-default-600">
                  Launching{" "}
                  <span className="font-medium">
                    {devModeItem?.kind} {devModeItem?.short}
                  </span>{" "}
                  registers it as an unsigned (sideloaded) package, which Windows
                  only allows in <span className="font-medium">Developer Mode</span>.
                </p>
                <p className="text-xs text-default-400">
                  Enabling it writes one Windows setting and needs admin, so you'll
                  see a Windows permission prompt. Then the launch retries automatically.
                </p>
              </ModalBody>
              <ModalFooter className="flex-wrap">
                <Button variant="light" onPress={() => setDevModeItem(null)}>
                  Cancel
                </Button>
                <Button
                  variant="flat"
                  onPress={() => api.openPath("ms-settings:developers")}
                >
                  Open Settings
                </Button>
                <Button
                  color="primary"
                  isLoading={enablingDev}
                  startContent={!enablingDev && <ShieldCheck size={16} />}
                  onPress={enableDevModeAndRetry}
                >
                  Enable & launch
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>

      <DownloadTray items={activeList} />

      {loading && items.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <Loader2 className="animate-spin text-default-400" size={28} />
        </div>
      )}
    </div>
  );
}

function dropKey(obj: Record<string, ActiveDownload>, key: string) {
  const rest = { ...obj };
  delete rest[key];
  return rest;
}

import { useEffect, useState } from "react";
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Chip,
  Spinner,
} from "@heroui/react";
import { Download, Gauge, RefreshCw, Zap } from "lucide-react";
import { api, hostOf, type MirrorResult, type VersionItem } from "../api";

interface Props {
  item: VersionItem | null;
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (url: string) => void;
}

function latColor(ms: number | null): "success" | "warning" | "danger" | "default" {
  if (ms == null) return "default";
  if (ms < 120) return "success";
  if (ms < 350) return "warning";
  return "danger";
}

export function MirrorModal({ item, isOpen, onClose, onConfirm }: Props) {
  const [results, setResults] = useState<MirrorResult[]>([]);
  const [testing, setTesting] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  async function runTests(urls: string[]) {
    setTesting(true);
    setResults(urls.map((url) => ({ url, label: hostOf(url), latencyMs: 0, ok: false })));
    let res: MirrorResult[] = [];
    try {
      res = await api.testMirrors(urls);
    } catch {
      res = urls.map((url) => ({ url, label: hostOf(url), latencyMs: 0, ok: false }));
    }
    setResults(res);
    // Auto-select fastest reachable mirror.
    const reachable = res.filter((r) => r.ok);
    const pool = (reachable.length ? reachable : res).slice().sort((a, b) => a.latencyMs - b.latencyMs);
    setSelected((cur) => cur ?? pool[0]?.url ?? null);
    setTesting(false);
  }

  useEffect(() => {
    if (isOpen && item) {
      setSelected(null);
      runTests(item.urls);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, item?.version]);

  if (!item) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg" backdrop="blur" scrollBehavior="inside">
      <ModalContent>
        {() => (
          <>
            <ModalHeader className="flex items-center gap-2">
              <Download size={18} className="text-primary" />
              <span>Download</span>
              <Chip size="sm" variant="flat" color={item.kind === "Release" ? "warning" : "secondary"}>
                {item.kind}
              </Chip>
              <span className="font-mono text-default-500 text-sm">{item.short}</span>
            </ModalHeader>

            <ModalBody>
              <div className="flex items-center justify-between text-xs text-default-500">
                <span>Pick the fastest mirror</span>
                {testing && (
                  <span className="flex items-center gap-1">
                    <Spinner size="sm" /> testing…
                  </span>
                )}
              </div>

              <div className="flex flex-col gap-2">
                {results.map((m) => {
                  const sel = selected === m.url;
                  return (
                    <button
                      key={m.url}
                      onClick={() => setSelected(m.url)}
                      className={`flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left transition-colors ${
                        sel
                          ? "border-primary bg-primary/10"
                          : "border-default-200 bg-content2 hover:bg-content3"
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <Zap size={16} className={sel ? "text-primary" : "text-default-400"} />
                        <span className="font-medium truncate">{m.label}</span>
                      </div>
                      <Chip
                        size="sm"
                        variant="flat"
                        color={latColor(testing && m.latencyMs === 0 ? null : m.latencyMs)}
                        startContent={<Gauge size={12} className="ml-1" />}
                      >
                        {testing && m.latencyMs === 0
                          ? "…"
                          : m.ok
                            ? `${Math.round(m.latencyMs)} ms`
                            : "unreachable"}
                      </Chip>
                    </button>
                  );
                })}
              </div>
            </ModalBody>

            <ModalFooter>
              <Button variant="light" onPress={onClose}>
                Cancel
              </Button>
              <Button
                variant="flat"
                startContent={<RefreshCw size={16} />}
                onPress={() => runTests(item.urls)}
              >
                Re-test
              </Button>
              <Button
                color="primary"
                isDisabled={!selected}
                startContent={<Download size={16} />}
                onPress={() => selected && onConfirm(selected)}
              >
                Download
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}

import { Card, CardBody, Progress, Button, Chip } from "@heroui/react";
import { X, CheckCircle2, AlertCircle, ShieldCheck } from "lucide-react";
import { api, fmtBytes } from "../api";
import type { DownloadEvent } from "../api";

export interface ActiveDownload {
  dest: string;
  kind: string;
  short: string;
  downloaded: number;
  total: number;
  status: DownloadEvent["kind"];
  message?: string;
}

interface Props {
  items: ActiveDownload[];
}

export function DownloadTray({ items }: Props) {
  if (items.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 w-[360px] z-40">
      <Card className="bg-content1/95 backdrop-blur border border-default-100 shadow-2xl">
        <CardBody className="gap-3">
          <div className="text-sm font-semibold text-default-600">Downloads</div>
          {items.map((d) => {
            const pct = d.total ? Math.min(100, (d.downloaded / d.total) * 100) : 0;
            const indeterminate = !d.total && d.status === "progress";
            const cancellable = d.status === "progress" || d.status === "started";
            return (
              <div key={d.dest} className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium truncate">
                    {d.kind} {d.short}
                  </span>
                  {d.status === "done" && (
                    <Chip size="sm" color="success" variant="flat" startContent={<CheckCircle2 size={13} className="ml-1" />}>
                      done
                    </Chip>
                  )}
                  {d.status === "verifying" && (
                    <Chip size="sm" color="primary" variant="flat" startContent={<ShieldCheck size={13} className="ml-1" />}>
                      verifying
                    </Chip>
                  )}
                  {d.status === "error" && (
                    <Chip size="sm" color="danger" variant="flat" startContent={<AlertCircle size={13} className="ml-1" />}>
                      error
                    </Chip>
                  )}
                  {cancellable && (
                    <Button
                      isIconOnly
                      size="sm"
                      variant="light"
                      className="h-6 w-6 min-w-6"
                      onPress={() => api.cancelDownload(d.dest)}
                    >
                      <X size={14} />
                    </Button>
                  )}
                </div>
                <Progress
                  size="sm"
                  aria-label={`${d.kind} ${d.short} progress`}
                  isIndeterminate={indeterminate}
                  value={pct}
                  color={d.status === "error" ? "danger" : "primary"}
                />
                <div className="text-xs text-default-400">
                  {d.status === "error"
                    ? d.message
                    : d.total
                      ? `${fmtBytes(d.downloaded)} / ${fmtBytes(d.total)} · ${pct.toFixed(0)}%`
                      : fmtBytes(d.downloaded)}
                </div>
              </div>
            );
          })}
        </CardBody>
      </Card>
    </div>
  );
}

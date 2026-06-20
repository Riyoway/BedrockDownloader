import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export type CtxItem =
  | "divider"
  | {
      key: string;
      label: string;
      icon?: ReactNode;
      danger?: boolean;
      disabled?: boolean;
      onSelect: () => void;
    };

interface Props {
  x: number;
  y: number;
  items: CtxItem[];
  onClose: () => void;
}

/** Lightweight right-click menu, positioned at the cursor and clamped to the viewport. */
export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const nx = Math.max(8, Math.min(x, window.innerWidth - r.width - 8));
    const ny = Math.max(8, Math.min(y, window.innerHeight - r.height - 8));
    setPos({ x: nx, y: ny });
  }, [x, y]);

  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", close);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    document.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      document.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-[100] min-w-[210px] py-1 rounded-xl border border-default-200 bg-content1/95 backdrop-blur shadow-2xl"
      style={{ left: pos.x, top: pos.y }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) =>
        it === "divider" ? (
          <div key={`d${i}`} className="my-1 h-px bg-default-200/70" />
        ) : (
          <button
            key={it.key}
            role="menuitem"
            disabled={it.disabled}
            onClick={() => {
              it.onSelect();
              onClose();
            }}
            className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              it.danger
                ? "text-danger hover:bg-danger/10"
                : "text-default-700 hover:bg-content2"
            }`}
          >
            <span className="shrink-0 opacity-80">{it.icon}</span>
            {it.label}
          </button>
        ),
      )}
    </div>
  );
}

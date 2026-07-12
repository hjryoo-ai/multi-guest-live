"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";

/* ────────────────────────────────────────────────────────────
 * Phase 6.6 공용 컴포넌트 (자체 경량 구현 — shadcn 미도입).
 * 전부 토큰 참조 · 키보드 접근 · reduced-motion 존중.
 * ──────────────────────────────────────────────────────────── */

// ── Button ───────────────────────────────────────────────────
type BtnVariant = "primary" | "secondary" | "danger" | "ghost";
const BTN_BG: Record<BtnVariant, string> = {
  primary: "var(--brand)",
  secondary: "var(--surface-2)",
  danger: "var(--danger)",
  ghost: "transparent",
};
export function Button({
  variant = "primary",
  size = "md",
  style,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: BtnVariant;
  size?: "sm" | "md";
}) {
  const pad = size === "sm" ? "6px 12px" : "10px 16px";
  const fs = size === "sm" ? 13 : 15;
  return (
    <button
      className="btn"
      style={{
        background: BTN_BG[variant],
        color: variant === "primary" ? "var(--brand-on)" : "var(--text)",
        padding: pad,
        fontSize: fs,
        border:
          variant === "ghost" ? "1px solid var(--border)" : "1px solid transparent",
        ...style,
      }}
      {...rest}
    />
  );
}

// ── Badge ────────────────────────────────────────────────────
type BadgeKind = "live" | "brand" | "warn" | "ok" | "neutral";
export function Badge({
  kind = "neutral",
  children,
  style,
}: {
  kind?: BadgeKind;
  children: ReactNode;
  style?: React.CSSProperties;
}) {
  const color =
    kind === "live"
      ? "var(--live)"
      : kind === "warn"
        ? "var(--warn)"
        : kind === "ok"
          ? "var(--ok)"
          : kind === "brand"
            ? "var(--brand)"
            : "var(--text-muted)";
  return (
    <span
      className="tnum"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 10px",
        borderRadius: "var(--radius-pill)",
        fontSize: 12,
        fontWeight: 700,
        letterSpacing: 0.3,
        background: `color-mix(in srgb, ${color} 18%, transparent)`,
        color,
        ...style,
      }}
    >
      {kind === "live" && (
        <span
          aria-hidden
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: "var(--live)",
            animation: "ml-pulse 1.4s ease-in-out infinite",
          }}
        />
      )}
      {children}
    </span>
  );
}

// ── Skeleton ─────────────────────────────────────────────────
export function Skeleton({
  w = "100%",
  h = 16,
  radius,
  style,
}: {
  w?: number | string;
  h?: number | string;
  radius?: number | string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className="skeleton"
      style={{ width: w, height: h, borderRadius: radius, ...style }}
    />
  );
}
export function SkeletonVideo() {
  return <Skeleton w="100%" h="auto" style={{ aspectRatio: "16 / 9" }} />;
}
export function SkeletonChat({ lines = 3 }: { lines?: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} w={`${60 + ((i * 13) % 35)}%`} h={12} />
      ))}
    </div>
  );
}

// ── 포커스 트랩(다이얼로그·시트 공용) ──────────────────────────
function useFocusTrap(active: boolean, onEscape?: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (!el) return;
    const prev = document.activeElement as HTMLElement | null;
    const focusables = () =>
      Array.from(
        el.querySelectorAll<HTMLElement>(
          'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((n) => !n.hasAttribute("disabled"));
    focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onEscape?.();
        return;
      }
      if (e.key !== "Tab") return;
      const f = focusables();
      if (f.length === 0) return;
      const first = f[0]!;
      const last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    el.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [active, onEscape]);
  return ref;
}

function Backdrop({
  onClick,
  align,
  children,
}: {
  onClick: () => void;
  align: "center" | "flex-end";
  children: ReactNode;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.72)",
        display: "flex",
        alignItems: align,
        justifyContent: "center",
        padding: align === "center" ? 20 : 0,
        zIndex: 50,
      }}
    >
      {children}
    </div>
  );
}

// ── ConfirmDialog (promise 기반 useConfirm) ───────────────────
type ConfirmOpts = {
  title: string;
  body?: ReactNode;
  confirmLabel: string; // 액션명 그대로("강퇴하기")
  cancelLabel?: string;
  danger?: boolean;
};
const ConfirmCtx = createContext<(o: ConfirmOpts) => Promise<boolean>>(
  async () => false,
);
export const useConfirm = () => useContext(ConfirmCtx);

function ConfirmDialog({
  opts,
  onResolve,
}: {
  opts: ConfirmOpts;
  onResolve: (v: boolean) => void;
}) {
  const ref = useFocusTrap(true, () => onResolve(false));
  return (
    <Backdrop onClick={() => onResolve(false)} align="center">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={opts.title}
        data-testid="confirm-dialog"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--surface-2)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          padding: 22,
          width: "min(420px, 100%)",
          boxShadow: "0 24px 70px rgba(0,0,0,0.6)",
          animation: "ml-toast-in 160ms var(--ease)",
        }}
      >
        <h3 style={{ margin: "0 0 8px" }}>{opts.title}</h3>
        {opts.body && (
          <div className="muted" style={{ fontSize: 14, lineHeight: 1.5 }}>
            {opts.body}
          </div>
        )}
        <div
          style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 20 }}
        >
          <Button variant="ghost" size="sm" onClick={() => onResolve(false)}>
            {opts.cancelLabel ?? "취소"}
          </Button>
          <Button
            variant={opts.danger ? "danger" : "primary"}
            size="sm"
            onClick={() => onResolve(true)}
          >
            {opts.confirmLabel}
          </Button>
        </div>
      </div>
    </Backdrop>
  );
}

// ── Toast ────────────────────────────────────────────────────
type ToastKind = "success" | "error" | "info";
type ToastItem = { id: number; kind: ToastKind; message: ReactNode };
const ToastCtx = createContext<(kind: ToastKind, message: ReactNode) => void>(
  () => {},
);
export const useToast = () => useContext(ToastCtx);

const TOAST_ICON: Record<ToastKind, string> = {
  success: "✓",
  error: "✕",
  info: "ⓘ",
};
const TOAST_COLOR: Record<ToastKind, string> = {
  success: "var(--ok)",
  error: "var(--danger)",
  info: "var(--brand)",
};

// ── BottomSheet ──────────────────────────────────────────────
export function BottomSheet({
  open,
  onClose,
  title,
  children,
  testid,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  testid?: string;
}) {
  const ref = useFocusTrap(open, onClose);
  if (!open) return null;
  return (
    <Backdrop onClick={onClose} align="flex-end">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid={testid}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--surface-2)",
          borderTopLeftRadius: "var(--radius-lg)",
          borderTopRightRadius: "var(--radius-lg)",
          borderTop: "1px solid var(--border)",
          padding: 16,
          width: "100%",
          maxHeight: "80vh",
          overflowY: "auto",
          boxShadow: "0 -20px 60px rgba(0,0,0,0.5)",
          animation: "ml-toast-in 200ms var(--ease)",
        }}
      >
        <div
          aria-hidden
          style={{
            width: 40,
            height: 4,
            borderRadius: 2,
            background: "var(--border)",
            margin: "0 auto 12px",
          }}
        />
        {title && <h3 style={{ margin: "0 0 12px" }}>{title}</h3>}
        {children}
      </div>
    </Backdrop>
  );
}

// ── Providers (Toast + Confirm) ──────────────────────────────
export function UiProviders({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [confirm, setConfirm] = useState<{
    opts: ConfirmOpts;
    resolve: (v: boolean) => void;
  } | null>(null);
  const idRef = useRef(1);

  const pushToast = useCallback((kind: ToastKind, message: ReactNode) => {
    const id = idRef.current++;
    setToasts((t) => [...t, { id, kind, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);

  const askConfirm = useCallback(
    (opts: ConfirmOpts) =>
      new Promise<boolean>((resolve) => setConfirm({ opts, resolve })),
    [],
  );

  const resolveConfirm = (v: boolean) => {
    confirm?.resolve(v);
    setConfirm(null);
  };

  return (
    <ConfirmCtx.Provider value={askConfirm}>
      <ToastCtx.Provider value={pushToast}>
        {children}
        {/* 토스트 스택(상단 중앙, aria-live) */}
        <div
          aria-live="polite"
          style={{
            position: "fixed",
            top: 16,
            left: "50%",
            transform: "translateX(-50%)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
            zIndex: 60,
            pointerEvents: "none",
          }}
        >
          {toasts.map((t) => (
            <div
              key={t.id}
              data-testid="toast"
              data-kind={t.kind}
              role="status"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderLeft: `3px solid ${TOAST_COLOR[t.kind]}`,
                borderRadius: "var(--radius-sm)",
                padding: "10px 14px",
                fontSize: 14,
                boxShadow: "var(--shadow)",
                animation: "ml-toast-in 160ms var(--ease)",
                maxWidth: "86vw",
              }}
            >
              <span style={{ color: TOAST_COLOR[t.kind] }}>
                {TOAST_ICON[t.kind]}
              </span>
              <span>{t.message}</span>
            </div>
          ))}
        </div>
        {confirm && (
          <ConfirmDialog opts={confirm.opts} onResolve={resolveConfirm} />
        )}
      </ToastCtx.Provider>
    </ConfirmCtx.Provider>
  );
}

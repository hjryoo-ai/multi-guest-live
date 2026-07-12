"use client";

import { useEffect, useState } from "react";
import { apiGetViewerCount } from "../lib/api";

/** 시청자 수 배지 — 5초 폴링. 모드 A=참가자−publisher, 모드 B=HLS heartbeat 집계. */
export function ViewerCount({ roomId }: { roomId: string }) {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = () =>
      apiGetViewerCount(roomId)
        .then((r) => alive && setCount(r.count))
        .catch(() => {});
    void tick();
    const t = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [roomId]);

  return (
    <span
      data-testid="viewer-count"
      style={{
        background: "var(--surface-2)",
        borderRadius: 999,
        padding: "4px 12px",
        fontSize: 13,
      }}
    >
      👁 {count ?? "—"}
    </span>
  );
}

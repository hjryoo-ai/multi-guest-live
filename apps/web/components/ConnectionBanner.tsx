"use client";

import { useConnectionState } from "@livekit/components-react";
import { ConnectionState } from "livekit-client";

/**
 * 연결 상태 배너. reconnecting/disconnected 를 사용자에게 노출.
 * LiveKit 자동 reconnect 를 사용하며, 토큰 만료로 인한 재접속은 페이지의
 * 토큰 재발급 로직(GuestUpgrade / broadcast)이 담당.
 */
export function ConnectionBanner() {
  const state = useConnectionState();
  if (state === ConnectionState.Connected || state === ConnectionState.Connecting) {
    return null;
  }
  const label =
    state === ConnectionState.Reconnecting
      ? "재연결 중…"
      : state === ConnectionState.Disconnected
        ? "연결이 끊어졌습니다"
        : String(state);
  return (
    <div
      style={{
        position: "fixed",
        top: 16,
        right: 16,
        background: "var(--surface)",
        border: "1px solid var(--warn)",
        color: "var(--warn)",
        padding: "8px 14px",
        borderRadius: "var(--radius-sm)",
        fontSize: 13,
        fontWeight: 600,
        boxShadow: "var(--shadow)",
        zIndex: 20,
      }}
    >
      {label}
    </div>
  );
}

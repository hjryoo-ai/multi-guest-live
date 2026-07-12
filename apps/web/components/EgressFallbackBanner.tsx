"use client";

import { useEffect, useState } from "react";
import { useRoomContext } from "@livekit/components-react";
import { RoomEvent } from "livekit-client";
import { DATA_TOPICS, SIGNAL_EVENTS } from "@multi-live/shared";
import { rejectSpoofedSignal } from "../lib/signal";

/**
 * HLS egress 실패 → 모드 A 폴백 알림 (host 전용).
 * 서버가 EGRESS_FALLBACK 시그널(topic=signal)을 host 에게 보낼 때 배너 노출.
 */
export function EgressFallbackBanner() {
  const room = useRoomContext();
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!room) return;
    const onData = (
      payload: Uint8Array,
      participant: Parameters<typeof rejectSpoofedSignal>[0],
      _k: unknown,
      topic?: string,
    ) => {
      if (topic !== DATA_TOPICS.signal) return;
      if (rejectSpoofedSignal(participant, topic)) return; // A-1: 위조 신호 차단
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload));
        if (msg?.event === SIGNAL_EVENTS.EGRESS_FALLBACK) setShown(true);
      } catch {
        /* 무시 */
      }
    };
    room.on(RoomEvent.DataReceived, onData);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
    };
  }, [room]);

  if (!shown) return null;

  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--warn)",
        color: "var(--warn)",
        padding: "8px 16px",
        borderRadius: "var(--radius-sm)",
        fontSize: 13,
        margin: "12px 0",
        display: "flex",
        gap: 12,
        alignItems: "center",
      }}
    >
      <span>
        HLS 송출(egress)을 시작하지 못해 WebRTC 모드로 자동 전환되었습니다. 시청자는
        WebRTC 로 계속 시청할 수 있습니다.
      </span>
      <button
        className="btn"
        style={{ padding: "4px 10px", fontSize: 12 }}
        onClick={() => setShown(false)}
      >
        확인
      </button>
    </div>
  );
}

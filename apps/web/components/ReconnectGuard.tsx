"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRoomContext } from "@livekit/components-react";
import { RoomEvent } from "livekit-client";
import {
  DATA_TOPICS,
  DISCONNECT_REASON,
  MAX_RECONNECT_ATTEMPTS,
  SIGNAL_EVENTS,
  shouldReconnectOnDisconnect,
} from "@multi-live/shared";
import { rejectSpoofedSignal } from "../lib/signal";

/**
 * 재접속 가드(Phase 5) — Phase 3 "모든 (재)접속은 서버가 발급한 새 토큰" 원칙의 실현.
 * Disconnected(토큰 만료 등 일시적 단절)에서 서버에서 새 토큰을 받아 재접속한다.
 *
 * 제외(핑퐁·오작동 방지):
 *   - 의도적 종료(CLIENT_INITIATED), 강퇴(PARTICIPANT_REMOVED), 방 종료(ROOM_DELETED)
 *   - DUPLICATE_IDENTITY: 재접속하면 두 기기가 서로 끊는 무한 핑퐁 → 안내만
 *   - ROOM_ENDING 신호 수신 후: 곧 종료되므로 재접속 안 함
 * 백오프 + 상한 3회, 초과 시 수동 재접속 버튼.
 */
export function ReconnectGuard({
  issueToken,
  onToken,
  onTerminated,
}: {
  issueToken: () => Promise<string>;
  onToken: (token: string) => void;
  /** 재접속 불가한 종료(강퇴/방 종료)를 상위 화면으로 라우팅(선택). */
  onTerminated?: (reason: "kicked" | "ended") => void;
}) {
  const room = useRoomContext();
  const roomEndingRef = useRef(false);
  const attemptsRef = useRef(0);
  const [duplicate, setDuplicate] = useState(false);
  const [manual, setManual] = useState(false);

  const reissue = useCallback(async () => {
    try {
      const token = await issueToken();
      onToken(token);
      setManual(false);
    } catch {
      setManual(true); // 재발급 실패 → 수동 버튼
    }
  }, [issueToken, onToken]);

  useEffect(() => {
    if (!room) return;

    // 연결 성공 시 시도 카운터 리셋.
    const onConnected = () => {
      attemptsRef.current = 0;
      setManual(false);
    };

    // ROOM_ENDING 신호 감지 → 이후 Disconnected 는 재접속하지 않는다.
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
        if (msg?.event === SIGNAL_EVENTS.ROOM_ENDING) roomEndingRef.current = true;
      } catch {
        /* 무시 */
      }
    };

    const onDisconnected = (reason?: number) => {
      if (reason === DISCONNECT_REASON.DUPLICATE_IDENTITY) {
        setDuplicate(true);
        return;
      }
      // 강퇴/방 종료(및 ROOM_ENDING 신호 후 종료)는 재접속 불가 → 상위 화면으로 라우팅.
      if (reason === DISCONNECT_REASON.PARTICIPANT_REMOVED) {
        onTerminated?.("kicked");
        return;
      }
      if (reason === DISCONNECT_REASON.ROOM_DELETED || roomEndingRef.current) {
        onTerminated?.("ended");
        return;
      }
      if (!shouldReconnectOnDisconnect(reason, roomEndingRef.current)) return;
      if (attemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
        setManual(true);
        return;
      }
      attemptsRef.current += 1;
      const backoff = 500 * 2 ** (attemptsRef.current - 1);
      setTimeout(() => void reissue(), backoff);
    };

    room.on(RoomEvent.Connected, onConnected);
    room.on(RoomEvent.DataReceived, onData);
    room.on(RoomEvent.Disconnected, onDisconnected);
    return () => {
      room.off(RoomEvent.Connected, onConnected);
      room.off(RoomEvent.DataReceived, onData);
      room.off(RoomEvent.Disconnected, onDisconnected);
    };
  }, [room, reissue, onTerminated]);

  if (duplicate) {
    return (
      <Banner tone="var(--danger)" testid="duplicate-banner">
        다른 기기에서 접속되어 이 세션이 종료되었습니다.
      </Banner>
    );
  }
  if (manual) {
    return (
      <Banner tone="var(--warn)" testid="reconnect-manual">
        재접속에 실패했습니다.{" "}
        <button
          className="btn"
          style={{ padding: "4px 10px", fontSize: 12, marginLeft: 8 }}
          onClick={() => {
            attemptsRef.current = 0;
            void reissue();
          }}
        >
          다시 접속
        </button>
      </Banner>
    );
  }
  return null;
}

function Banner({
  children,
  tone,
  testid,
}: {
  children: React.ReactNode;
  tone: string;
  testid: string;
}) {
  return (
    <div
      data-testid={testid}
      style={{
        position: "fixed",
        top: 56,
        left: "50%",
        transform: "translateX(-50%)",
        background: tone,
        color: "var(--brand-on)",
        fontWeight: 600,
        padding: "8px 16px",
        borderRadius: "var(--radius-sm)",
        fontSize: 13,
        zIndex: 21,
      }}
    >
      {children}
    </div>
  );
}

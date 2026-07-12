"use client";

import { useEffect, useRef } from "react";
import { useRoomContext } from "@livekit/components-react";
import { RoomEvent, type Participant } from "livekit-client";

/** 참가자 metadata 의 role 파싱. */
function roleOf(p: Participant): string {
  try {
    return (JSON.parse(p.metadata || "{}") as { role?: string }).role ?? "";
  } catch {
    return "";
  }
}

/**
 * 게스트/스피커 승격 — 단일 경로(재연결 없음):
 *   host 승인 → 서버 updateParticipant(백그라운드 재시도로 신뢰화) →
 *   클라이언트 canPublish/metadata 라이브 반영 → 마이크(+role 이 guest 면 카메라) enable.
 *
 * Phase 6: role(guest/speaker)에 반응.
 *   - speaker: 마이크만, 카메라는 항상 disable(강등 시 방어적 로컬 정리 — 서버도 자동 unpublish).
 *   - guest: 마이크+카메라.
 *   role 은 세션 중 전환될 수 있으므로 permission/metadata 변경마다 재평가한다.
 */
export function GuestUpgrade({
  roomId: _roomId,
  onUpgraded,
}: {
  roomId: string;
  onUpgraded: (role: "guest" | "speaker") => void;
}) {
  const room = useRoomContext();
  const upgradedRef = useRef(false);

  useEffect(() => {
    if (!room) return;

    async function sync() {
      const lp = room.localParticipant;
      if (!lp.permissions?.canPublish) return;
      const speaker = roleOf(lp) === "speaker";

      await lp.setMicrophoneEnabled(true);
      // guest 는 카메라 on, speaker 는 카메라 off(회수).
      await lp.setCameraEnabled(!speaker);

      if (!upgradedRef.current) {
        upgradedRef.current = true;
      }
      onUpgraded(speaker ? "speaker" : "guest");
    }

    const onEvent = () => void sync();
    room.on(RoomEvent.ParticipantPermissionsChanged, onEvent);
    room.on(RoomEvent.ParticipantMetadataChanged, onEvent);
    room.on(RoomEvent.Connected, onEvent);

    const t = setInterval(() => void sync(), 2000);
    void sync();

    return () => {
      room.off(RoomEvent.ParticipantPermissionsChanged, onEvent);
      room.off(RoomEvent.ParticipantMetadataChanged, onEvent);
      room.off(RoomEvent.Connected, onEvent);
      clearInterval(t);
    };
  }, [room, onUpgraded]);

  // 상태 표시는 페이지의 status-pill 이 담당 — 이 컴포넌트는 승격 로직만 수행.
  return null;
}

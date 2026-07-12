"use client";

import { useEffect, useState } from "react";
import { useRoomContext } from "@livekit/components-react";
import { RoomEvent, Track } from "livekit-client";

/**
 * 마이크 음소거 배너 (guest).
 * 비대칭성: 서버(호스트)는 mute 만 가능하고 원격 unmute 는 불가하므로,
 * "다시 켜기"는 반드시 guest 본인이 수행한다. "호스트가 켜줌" 버튼은 존재할 수 없음.
 */
export function MuteBanner() {
  const room = useRoomContext();
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    if (!room) return;
    const sync = () => {
      const pub = room.localParticipant.getTrackPublication(
        Track.Source.Microphone,
      );
      setMuted(!!pub && pub.isMuted);
    };
    sync();
    const evs: RoomEvent[] = [
      RoomEvent.TrackMuted,
      RoomEvent.TrackUnmuted,
      RoomEvent.LocalTrackPublished,
    ];
    evs.forEach((e) => room.on(e, sync));
    return () => evs.forEach((e) => room.off(e, sync));
  }, [room]);

  if (!muted) return null;

  return (
    <div
      style={{
        position: "fixed",
        top: 16,
        left: "50%",
        transform: "translateX(-50%)",
        background: "var(--danger)",
        padding: "8px 16px",
        borderRadius: 8,
        fontSize: 13,
        display: "flex",
        gap: 12,
        alignItems: "center",
        zIndex: 20,
      }}
    >
      <span>마이크가 음소거되었습니다 (호스트가 껐을 수 있음).</span>
      <button
        className="btn"
        style={{ padding: "4px 10px", fontSize: 12 }}
        onClick={() =>
          room?.localParticipant.setMicrophoneEnabled(true).catch(() => {})
        }
      >
        다시 켜기
      </button>
    </div>
  );
}

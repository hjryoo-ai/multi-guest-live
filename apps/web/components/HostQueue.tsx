"use client";

import { useCallback, useEffect, useState } from "react";
import { useRoomContext } from "@livekit/components-react";
import { RoomEvent } from "livekit-client";
import {
  DATA_TOPICS,
  SIGNAL_EVENTS,
  type JoinRequestDto,
  type SignalMessage,
} from "@multi-live/shared";
import {
  apiApprove,
  apiGetRoom,
  apiListJoinRequests,
  apiReject,
} from "../lib/api";
import { rejectSpoofedSignal } from "../lib/signal";

/**
 * 승인 대기 큐 (host 전용).
 *   실시간화: 서버가 QUEUE_UPDATED 신호를 host 에게 보내면 즉시 재조회(트리거).
 *   진실 소스는 GET /join-requests. 신호를 놓친 구간은 20초 저빈도 폴링이 메꿈.
 *   슬롯(max_guests) 초과 시 승인 버튼 비활성.
 */
export function HostQueue({
  roomId,
  maxGuests,
  maxSpeakers,
  onCount,
}: {
  roomId: string;
  maxGuests: number;
  maxSpeakers: number;
  onCount?: (n: number) => void;
}) {
  const room = useRoomContext();
  const [requests, setRequests] = useState<JoinRequestDto[]>([]);
  const [approvedGuests, setApprovedGuests] = useState(0);
  const [approvedSpeakers, setApprovedSpeakers] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [{ requests }, detail] = await Promise.all([
        apiListJoinRequests(roomId),
        apiGetRoom(roomId),
      ]);
      setRequests(requests);
      onCount?.(requests.length);
      const approved = detail.participants.filter((p) => p.state === "approved");
      setApprovedGuests(approved.filter((p) => p.role === "guest").length);
      setApprovedSpeakers(approved.filter((p) => p.role === "speaker").length);
    } catch {
      /* 다음 트리거/폴링에서 회복 */
    }
  }, [roomId, onCount]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 20_000); // 저빈도 fallback
    return () => clearInterval(t);
  }, [refresh]);

  // QUEUE_UPDATED 신호 → 즉시 재조회
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
        const msg = JSON.parse(new TextDecoder().decode(payload)) as SignalMessage;
        if (msg.event === SIGNAL_EVENTS.QUEUE_UPDATED) void refresh();
      } catch {
        /* ignore */
      }
    };
    room.on(RoomEvent.DataReceived, onData);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
    };
  }, [room, refresh]);

  const guestFull = approvedGuests >= maxGuests;
  const speakerFull = approvedSpeakers >= maxSpeakers;

  async function approve(userId: string, role: "guest" | "speaker") {
    setBusy(userId);
    setNote("");
    try {
      await apiApprove(roomId, userId, role);
      setRequests((r) => r.filter((x) => x.userId !== userId));
      void refresh();
    } catch (e: any) {
      const err = e?.body?.error;
      setNote(
        err === "max_guests_reached"
          ? `게스트 슬롯(${maxGuests})이 가득 찼습니다.`
          : err === "max_speakers_reached"
            ? `스피커 슬롯(${maxSpeakers})이 가득 찼습니다.`
            : "처리 실패",
      );
    } finally {
      setBusy(null);
    }
  }

  async function reject(userId: string) {
    setBusy(userId);
    setNote("");
    try {
      await apiReject(roomId, userId);
      setRequests((r) => r.filter((x) => x.userId !== userId));
      void refresh();
    } catch {
      setNote("처리 실패");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <h3 style={{ marginTop: 0 }}>
        승인 대기 {requests.length > 0 ? `(${requests.length})` : ""}
      </h3>
      <p className="muted" style={{ fontSize: 12, marginTop: -8 }}>
        게스트 {approvedGuests}/{maxGuests} · 스피커 {approvedSpeakers}/{maxSpeakers}
      </p>
      {note && <p style={{ color: "var(--danger)", fontSize: 13 }}>{note}</p>}
      {requests.length === 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>
          대기 중인 요청이 없습니다.
        </p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {requests.map((r) => (
            <li
              key={r.userId}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                padding: "10px 0",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <span style={{ fontWeight: 600, fontSize: 14 }}>{r.nickname}</span>
              <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button
                  className="btn"
                  style={queueBtn}
                  disabled={busy === r.userId || guestFull}
                  title={guestFull ? "게스트 슬롯이 가득 찼습니다" : undefined}
                  onClick={() => approve(r.userId, "guest")}
                >
                  게스트로 승인
                </button>
                <button
                  className="btn"
                  style={{
                    ...queueBtn,
                    background: "var(--brand-strong)",
                    color: "var(--brand-on)",
                  }}
                  disabled={busy === r.userId || speakerFull}
                  title={speakerFull ? "스피커 슬롯이 가득 찼습니다" : undefined}
                  onClick={() => approve(r.userId, "speaker")}
                >
                  스피커로 승인
                </button>
                <button
                  className="btn"
                  style={{ ...queueBtn, background: "var(--surface-2)", color: "var(--text)" }}
                  disabled={busy === r.userId}
                  onClick={() => reject(r.userId)}
                >
                  거절
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const queueBtn: React.CSSProperties = {
  fontSize: 13,
  padding: "6px 12px",
  flex: "1 1 auto",
  whiteSpace: "nowrap",
};

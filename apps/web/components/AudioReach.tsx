"use client";

import { useEffect } from "react";
import { useRoomContext } from "@livekit/components-react";
import { RoomEvent, Track, type RemoteTrackPublication } from "livekit-client";
import {
  DATA_TOPICS,
  SIGNAL_EVENTS,
  type SignalMessage,
} from "@multi-live/shared";
import { apiAudioReport } from "../lib/api";
import { rejectSpoofedSignal } from "../lib/signal";

const REPORT_INTERVAL_MS = 10_000; // Phase 3: 10초 주기
const MAX_RESUBSCRIBE_ATTEMPTS = 3; // 트랙당 재구독 재시도 상한(무한 토글 방지)

/**
 * 오디오 전수 도달 장치(클라이언트 측, Phase 2 최소본):
 *   1) 주기적으로 '현재 구독 중인 원격 오디오 트랙 sid' 목록을 서버에 HTTP 보고.
 *   2) 서버가 RESUBSCRIBE_AUDIO 신호를 보내면 미구독 오디오 트랙을 강제 재구독.
 * 서버는 room 참가자가 아니므로 (1)은 HTTP, (2)는 LiveKit data channel 로 도착.
 */
export function AudioReach({ roomId }: { roomId: string }) {
  const room = useRoomContext();

  useEffect(() => {
    if (!room) return;
    // E2E 검증용: 테스트가 방의 구독 상태를 직접 확인할 수 있도록 노출(무해).
    (window as unknown as { __lkRoom?: unknown }).__lkRoom = room;

    function subscribedAudioSids(): string[] {
      const sids: string[] = [];
      room.remoteParticipants.forEach((p) => {
        p.audioTrackPublications.forEach((pub) => {
          if (pub.isSubscribed && pub.trackSid) sids.push(pub.trackSid);
        });
      });
      return sids;
    }

    // 트랙 sid → 재구독 시도 횟수. 무한 토글 방지용 상한.
    const attempts = new Map<string, number>();

    function resubscribe(missingSids?: string[]) {
      const want = missingSids ? new Set(missingSids) : null;
      room.remoteParticipants.forEach((p) => {
        p.audioTrackPublications.forEach((pub) => {
          const sid = pub.trackSid;
          if (want && sid && !want.has(sid)) return;
          if (pub.isSubscribed) return;
          const n = attempts.get(sid) ?? 0;
          if (n >= MAX_RESUBSCRIBE_ATTEMPTS) return; // 상한 도달 → 다음 주기 SFU 시그널링에 맡김
          attempts.set(sid, n + 1);
          // 토글 재구독: 명시적으로 false→true 로 재요청.
          const p2 = pub as RemoteTrackPublication;
          p2.setSubscribed(false);
          p2.setSubscribed(true);
        });
      });
    }

    const timer = setInterval(() => {
      apiAudioReport(roomId, subscribedAudioSids()).catch(() => {
        /* 네트워크 순단은 다음 주기에 회복 */
      });
    }, REPORT_INTERVAL_MS);

    const onData = (
      payload: Uint8Array,
      participant: Parameters<typeof rejectSpoofedSignal>[0],
      _kind: unknown,
      topic?: string,
    ) => {
      if (topic !== DATA_TOPICS.signal) return;
      if (rejectSpoofedSignal(participant, topic)) return; // A-1: 위조 신호 차단
      try {
        const msg = JSON.parse(
          new TextDecoder().decode(payload),
        ) as SignalMessage;
        if (msg.event === SIGNAL_EVENTS.RESUBSCRIBE_AUDIO) {
          const sids = (msg.payload?.missingTrackSids as string[]) ?? undefined;
          resubscribe(sids);
        }
      } catch {
        /* ignore malformed */
      }
    };

    room.on(RoomEvent.DataReceived, onData);

    // 오디오 불변식: 새 오디오 트랙이 publish 되면 항상 구독 (autoSubscribe 보강).
    const onPublished = (pub: RemoteTrackPublication) => {
      if (pub.kind === Track.Kind.Audio && !pub.isSubscribed) {
        pub.setSubscribed(true);
      }
    };
    room.on(RoomEvent.TrackPublished, onPublished);

    // 구독 성공 시 재시도 카운터 리셋 → 이후 재손실에 다시 재시도 가능.
    const onSubscribed = (_t: unknown, pub: RemoteTrackPublication) => {
      if (pub.trackSid) attempts.delete(pub.trackSid);
    };
    room.on(RoomEvent.TrackSubscribed, onSubscribed);

    return () => {
      clearInterval(timer);
      room.off(RoomEvent.DataReceived, onData);
      room.off(RoomEvent.TrackPublished, onPublished);
      room.off(RoomEvent.TrackSubscribed, onSubscribed);
    };
  }, [room, roomId]);

  return null;
}

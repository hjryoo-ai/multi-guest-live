import {
  AccessToken,
  RoomServiceClient,
  WebhookReceiver,
  TrackType,
  TrackSource,
  DataPacket_Kind,
  type VideoGrant,
  type WebhookEvent,
} from "livekit-server-sdk";
import { config } from "../config.js";
import {
  ROLE_GRANTS,
  DATA_TOPICS,
  type Role,
  type SignalMessage,
  type ChatMessageDto,
} from "@multi-live/shared";

const roomService = new RoomServiceClient(
  config.livekit.url,
  config.livekit.apiKey,
  config.livekit.apiSecret,
);

export { roomService };

const webhookReceiver = new WebhookReceiver(
  config.livekit.apiKey,
  config.livekit.apiSecret,
);

// LiveKit room 이름 = DB room.id(uuid). 매핑을 단순·명시적으로 유지.
export function livekitRoomName(roomId: string): string {
  return roomId;
}

/**
 * LiveKit room 을 명시적으로 생성. join 시 자동 생성에 의존하지 않는다(유령 방 차단).
 * emptyTimeout: 마지막 참가자 이탈 후 방 유지 시간(초).
 */
export async function createLiveKitRoom(
  roomId: string,
  maxGuests: number,
): Promise<void> {
  await roomService.createRoom({
    name: livekitRoomName(roomId),
    emptyTimeout: 300,
    // host(1) + guest(maxGuests) + viewer 여유분
    maxParticipants: 1 + maxGuests + 200,
  });
}

export async function deleteLiveKitRoom(roomId: string): Promise<void> {
  try {
    await roomService.deleteRoom(livekitRoomName(roomId));
  } catch (err) {
    // 이미 없는 방은 무시 (멱등).
    console.warn(
      `[livekit] deleteRoom(${roomId}) ignored:`,
      (err as Error).message,
    );
  }
}

export async function listRoomParticipants(roomId: string) {
  return roomService.listParticipants(livekitRoomName(roomId));
}

/**
 * LiveKit 도달성 확인 (Phase 6.5 C-4-2, /health/ready 용).
 * 존재하지 않는 이름으로 listRooms → 빈 배열이 즉시 반환(연결·인증 검증). 타임아웃 상한.
 */
export async function checkLiveKitReachable(timeoutMs = 5000): Promise<boolean> {
  try {
    await Promise.race([
      roomService.listRooms(["__healthcheck__"]),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("livekit timeout")), timeoutMs),
      ),
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * role 별 AccessToken 발급.
 *   - identity 는 반드시 user.id(uuid) → webhook participant 이벤트를 DB user 와 매핑하는 키.
 *   - name 은 닉네임, metadata 에 role 을 실어 클라이언트/운영 도구가 참조.
 * TTL 10분. (TODO Phase 2: 웹 클라이언트가 Disconnected 시 이 엔드포인트를 재호출해
 *  새 토큰으로 재접속하는 로직 필요 — 만료 토큰으로는 재연결이 실패함.)
 */
export async function issueAccessToken(params: {
  roomId: string;
  userId: string;
  nickname: string;
  role: Role;
}): Promise<{ token: string; expiresAt: number }> {
  const grantSpec = ROLE_GRANTS[params.role];
  // 기본 10분. 재접속 통합 테스트를 위해 TOKEN_TTL_SEC 로 짧게 오버라이드 가능.
  const ttlSec = Number(process.env.TOKEN_TTL_SEC ?? 10 * 60);

  const at = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
    identity: params.userId,
    name: params.nickname,
    ttl: `${ttlSec}s`,
    metadata: JSON.stringify({ role: params.role }),
  });

  const grant: VideoGrant = {
    roomJoin: true,
    room: livekitRoomName(params.roomId),
    canPublish: grantSpec.canPublish,
    canSubscribe: grantSpec.canSubscribe,
    canPublishData: grantSpec.canPublishData,
  };
  // speaker: 마이크(오디오)만 publish 허용
  if (grantSpec.audioOnly) {
    grant.canPublishSources = [TrackSource.MICROPHONE];
  }
  at.addGrant(grant);

  const token = await at.toJwt();
  return { token, expiresAt: Math.floor(Date.now() / 1000) + ttlSec };
}

// ── 운영(moderation) — Phase 2/3 에서 사용 ────────────────────
export async function muteParticipantTrack(
  roomId: string,
  identity: string,
  trackSid: string,
  muted: boolean,
) {
  return roomService.mutePublishedTrack(
    livekitRoomName(roomId),
    identity,
    trackSid,
    muted,
  );
}

export async function removeParticipant(roomId: string, identity: string) {
  return roomService.removeParticipant(livekitRoomName(roomId), identity);
}

/**
 * 참가자의 오디오 트랙 전체를 서버측 음소거.
 * 주의(비대칭): 서버는 mute 만 가능하고 원격 unmute 는 불가 — 다시 켜는 것은
 * 해당 클라이언트 본인만 할 수 있다(마이크 재활성). UI 는 이를 반영해야 함.
 * @returns 음소거한 트랙 sid 수
 */
export async function muteParticipantAudio(
  roomId: string,
  identity: string,
): Promise<number> {
  const room = livekitRoomName(roomId);
  const info = await roomService.getParticipant(room, identity);
  const audioSids = (info.tracks ?? [])
    .filter((t) => t.type === TrackType.AUDIO)
    .map((t) => t.sid);
  await Promise.all(
    audioSids.map((sid) => roomService.mutePublishedTrack(room, identity, sid, true)),
  );
  return audioSids.length;
}

/** 참가자의 현재 비디오 트랙 sid 목록(A-4 강등 검증용). */
export async function getParticipantVideoTrackSids(
  roomId: string,
  identity: string,
): Promise<string[]> {
  const info = await roomService.getParticipant(
    livekitRoomName(roomId),
    identity,
  );
  return (info.tracks ?? [])
    .filter((t) => t.type === TrackType.VIDEO)
    .map((t) => t.sid);
}

/**
 * 참가자의 비디오 트랙을 서버측 강제 음소거(A-4 강등 enforcement).
 * 서버 SDK 에는 원격 unpublish API 가 없어 mute 가 가장 강한 서버 조치다.
 * @returns 음소거한 비디오 트랙 sid 수
 */
export async function muteParticipantVideo(
  roomId: string,
  identity: string,
): Promise<string[]> {
  const room = livekitRoomName(roomId);
  const info = await roomService.getParticipant(room, identity);
  const sids = (info.tracks ?? [])
    .filter((t) => t.type === TrackType.VIDEO)
    .map((t) => t.sid);
  await Promise.all(
    sids.map((sid) => roomService.mutePublishedTrack(room, identity, sid, true)),
  );
  return sids;
}

export async function updateParticipantPermission(
  roomId: string,
  identity: string,
  role: Role,
) {
  const g = ROLE_GRANTS[role];
  return roomService.updateParticipant(
    livekitRoomName(roomId),
    identity,
    JSON.stringify({ role }),
    {
      canPublish: g.canPublish,
      canSubscribe: g.canSubscribe,
      canPublishData: g.canPublishData,
      canPublishSources: g.audioOnly ? [TrackSource.MICROPHONE] : undefined,
    },
  );
}

/**
 * 서버 → 특정 클라이언트(들) 로 제어 신호 전송 (LiveKit data channel, topic=signal).
 * 서버는 room 참가자가 아니므로 수신은 못 하지만, RoomServiceClient 로 송신은 가능.
 */
export async function sendSignal(
  roomId: string,
  identities: string[],
  message: SignalMessage,
) {
  const data = new TextEncoder().encode(JSON.stringify(message));
  await roomService.sendData(livekitRoomName(roomId), data, DataPacket_Kind.RELIABLE, {
    // 빈 배열 = 전체 브로드캐스트(destinationIdentities 생략).
    ...(identities.length > 0 ? { destinationIdentities: identities } : {}),
    topic: DATA_TOPICS.signal,
  });
}

/**
 * 서버 → room 전체로 신규 채팅 메시지 push (topic=chat, RELIABLE).
 * 모드 A(webrtc) 시청자·host·guest 는 이 push 로 실시간 수신.
 * 모드 B(HLS) 시청자는 room 참가자가 아니므로 이 push 가 닿지 않음 → GET 폴링으로 수신.
 * (destinationIdentities 미지정 = 전체 브로드캐스트)
 */
export async function sendChat(roomId: string, message: ChatMessageDto) {
  const payload = JSON.stringify({ type: "CHAT", message });
  const data = new TextEncoder().encode(payload);
  await roomService.sendData(livekitRoomName(roomId), data, DataPacket_Kind.RELIABLE, {
    topic: DATA_TOPICS.chat,
  });
}

/**
 * 방의 시청자 수 = 전체 참가자 − publish 권한 보유자(host/guest/speaker).
 * (모드 A 전용. numParticipants 는 host/guest 를 포함하므로 순수 시청자만 세려면 차감.)
 */
export async function countWebrtcViewers(roomId: string): Promise<number> {
  const parts = await roomService.listParticipants(livekitRoomName(roomId));
  let viewers = 0;
  for (const p of parts) {
    if (!p.permission?.canPublish) viewers++;
  }
  return viewers;
}

// ── webhook ──────────────────────────────────────────────────
export async function receiveWebhook(
  body: string,
  authHeader: string | undefined,
): Promise<WebhookEvent> {
  return webhookReceiver.receive(body, authHeader);
}

export function isAudioTrack(type: TrackType | undefined): boolean {
  return type === TrackType.AUDIO;
}

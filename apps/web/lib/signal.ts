import type { Participant } from "livekit-client";

/**
 * A-1 (신호 스푸핑 차단): DataReceived 메시지가 '서버 발신'인지 판별.
 *
 * 실측(probe, Phase 6.5 A-1): LiveKit data channel 은 참가자도 발신할 수 있어,
 * 악의적 참가자가 서버 제어 신호(topic=signal: RESUBSCRIBE_AUDIO/QUEUE_UPDATED/
 * CHAT_MODERATED/ROOM_ENDING/EGRESS_FALLBACK)나 채팅 push(topic=chat: CHAT)를
 * 위조 브로드캐스트할 수 있다. 확인 결과:
 *   - 서버(RoomServiceClient.sendData) 발신 → DataReceived 의 participant = undefined
 *   - 참가자(localParticipant.publishData) 발신 → 발신 참가자로 채워짐(identity/kind)
 * 따라서 participant 가 존재하면 서버 신호 topic 은 신뢰하지 않는다.
 */
export function isServerSignal(participant?: Participant | null): boolean {
  return participant == null;
}

/**
 * 서버 발신이 아니면(=참가자 위조) 경고 후 true 반환 → 호출측은 즉시 return.
 * topic 은 로깅용.
 */
export function rejectSpoofedSignal(
  participant: Participant | null | undefined,
  topic?: string,
): boolean {
  if (isServerSignal(participant)) return false;
  console.warn(
    `[security] 참가자 발신 신호 무시(위조 가능): topic=${topic} from=${participant?.identity}`,
  );
  return true;
}

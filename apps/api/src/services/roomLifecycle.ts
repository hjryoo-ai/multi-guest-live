import { SIGNAL_EVENTS } from "@multi-live/shared";
import { sendSignal, deleteLiveKitRoom } from "./livekit.js";

/**
 * 방 종료 단일 경로 — hostGrace 스위퍼·demoSweeper(수명 만료)가 공유.
 * ROOM_ENDING 브로드캐스트 → 짧은 유예 → deleteLiveKitRoom(room_finished webhook 경유:
 * egress stop + markRoomEnded). 프리미티브를 각자 조합하면 egress stop 을 빠뜨리는 두 번째
 * 종료 경로가 생기므로(Phase 3 원칙), 종료는 반드시 이 함수를 통한다.
 */
const ENDING_GRACE_MS = 2_500; // ROOM_ENDING 신호 후 정리까지 유예
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function endRoomGracefully(roomId: string): Promise<void> {
  try {
    await sendSignal(roomId, [], { event: SIGNAL_EVENTS.ROOM_ENDING });
  } catch {
    /* 미접속 무시 */
  }
  await sleep(ENDING_GRACE_MS);
  await deleteLiveKitRoom(roomId); // → room_finished webhook: egress stop + markRoomEnded
}

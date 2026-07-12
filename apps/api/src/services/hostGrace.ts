import { SIGNAL_EVENTS } from "@multi-live/shared";
import { redis, scanKeys } from "./redis.js";
import { getRoom } from "./rooms.js";
import { sendSignal, deleteLiveKitRoom } from "./livekit.js";

/**
 * host 이탈 유예(Phase 5): host 가 participant_left 하면 유예를 걸고, HOST_GRACE_SEC 안에
 * 복귀하지 않으면 방을 자동 종료한다(egress stop 포함 — deleteRoom→room_finished 경유).
 * host 승계는 범위 밖(설계문서 향후 과제).
 *
 * 레이스 방어: 종료 직전 Redis presence 로 host 부재를 재확인(재접속 webhook 과의 순서 역전 대비).
 * 다중 인스턴스 대비 SETNX 락(현재 단일 인스턴스지만 미리 방어).
 */
const HOST_GRACE_MS = Number(process.env.HOST_GRACE_SEC ?? 60) * 1000;
const SWEEP_INTERVAL_MS = Number(process.env.HOST_SWEEP_MS ?? 15_000);
const ENDING_GRACE_MS = 2_500; // ROOM_ENDING 신호 후 정리까지 유예

const kHostGone = (roomId: string) => `room:${roomId}:host_gone`;
const kPresent = (roomId: string) => `room:${roomId}:present`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function markHostGone(roomId: string, nowMs: number) {
  await redis.set(kHostGone(roomId), String(nowMs));
}

export async function clearHostGone(roomId: string) {
  await redis.del(kHostGone(roomId));
}

/**
 * 유예 만료+미복귀 방을 1회 스윕해 종료. 테스트에서 제어된 nowMs 로 직접 호출 가능.
 * @returns 이번 스윕에서 종료 처리한 roomId 목록
 */
export async function sweepHostGraceOnce(
  nowMs: number,
  graceMs = HOST_GRACE_MS,
): Promise<string[]> {
  const keys = await scanKeys("room:*:host_gone");
  const ended: string[] = [];
  for (const key of keys) {
    const roomId = key.split(":")[1];
    if (!roomId) continue;
    const raw = await redis.get(key);
    const ts = Number(raw);
    if (!Number.isFinite(ts)) {
      await redis.del(key);
      continue;
    }
    if (nowMs - ts < graceMs) continue; // 아직 유예 중

    const room = await getRoom(roomId);
    if (!room || room.status === "ended") {
      await redis.del(key);
      continue;
    }
    // 레이스 방어: host 가 실제로 부재인가 재확인(복귀했으면 취소).
    const present = await redis.sismember(kPresent(roomId), room.hostId);
    if (present) {
      await redis.del(key);
      continue;
    }
    // 다중 인스턴스 대비 락(단일 인스턴스에선 항상 획득).
    const lock = await redis.set(`${key}:lock`, "1", "PX", 30_000, "NX");
    if (lock !== "OK") continue;

    // 종료 절차: ROOM_ENDING 브로드캐스트 → 짧은 유예 → deleteRoom(room_finished 경유 정리).
    try {
      await sendSignal(roomId, [], { event: SIGNAL_EVENTS.ROOM_ENDING });
    } catch {
      /* 미접속 무시 */
    }
    await sleep(ENDING_GRACE_MS);
    await deleteLiveKitRoom(roomId); // → room_finished webhook: egress stop + markRoomEnded
    await redis.del(key);
    ended.push(roomId);
  }
  return ended;
}

let timer: NodeJS.Timeout | undefined;
export function startHostGraceSweeper() {
  if (timer) return;
  timer = setInterval(() => {
    void sweepHostGraceOnce(Date.now()).catch((err) =>
      console.warn("[hostGrace] sweep failed:", (err as Error).message),
    );
  }, SWEEP_INTERVAL_MS);
  // 프로세스 종료를 막지 않도록 unref.
  timer.unref?.();
}
export function stopHostGraceSweeper() {
  if (timer) clearInterval(timer);
  timer = undefined;
}

import { and, eq, inArray, lt } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  rooms,
  chatMessages,
  moderationLogs,
  roomParticipants,
  users,
} from "../db/schema.js";
import { redis } from "./redis.js";
import { config } from "../config.js";
import { endRoomGracefully } from "./roomLifecycle.js";

/**
 * 데모 가드 스위퍼(§7-lite 1-4) — 두 책임을 1회 스윕으로 처리한다:
 *   (1) 수명 만료: 생성 후 MAX_ROOM_LIFETIME_MIN 초과한 활성 방을 종료(hostGrace 와 동일한
 *       공유 종료 경로 endRoomGracefully → egress stop 포함).
 *   (2) 데이터 보존: 종료 후 DATA_RETENTION_HOURS 초과한 방·채팅·로그·참가자와, 어느 방에도
 *       안 남은 익명 user 를 삭제(프라이버시 위생). 별도 cron 대신 스위퍼 내장 → 시간 주입 테스트 가능.
 * 두 값 모두 0(비활성)이면 startDemoSweeper 는 인터벌을 아예 걸지 않는다(dev/E2E 무영향).
 * nowMs·opts 주입으로 결정적 검증 가능(verify:phase7demo).
 */
const SWEEP_INTERVAL_MS = Number(process.env.DEMO_SWEEP_MS ?? 60_000);

export interface DemoSweepOpts {
  lifetimeMs?: number;
  retentionMs?: number;
}

export async function sweepDemoOnce(
  nowMs: number,
  opts: DemoSweepOpts = {},
): Promise<{ expired: string[]; purgedRooms: number; purgedUsers: number }> {
  const lifetimeMs = opts.lifetimeMs ?? config.demo.maxRoomLifetimeMs;
  const retentionMs = opts.retentionMs ?? config.demo.dataRetentionMs;
  const expired: string[] = [];
  let purgedRooms = 0;
  let purgedUsers = 0;

  // (1) 수명 만료 → 공유 종료 경로.
  if (lifetimeMs > 0) {
    const cutoff = new Date(nowMs - lifetimeMs);
    const stale = await db
      .select({ id: rooms.id })
      .from(rooms)
      .where(
        and(inArray(rooms.status, ["created", "live"]), lt(rooms.createdAt, cutoff)),
      );
    for (const { id } of stale) {
      // 중복 종료 방지 락(hostGrace 와 동일 SETNX 패턴).
      const lock = await redis.set(`demo:expire:${id}:lock`, "1", "PX", 30_000, "NX");
      if (lock !== "OK") continue;
      await endRoomGracefully(id);
      expired.push(id);
    }
  }

  // (2) 보존기간 초과 → 방·연관·고아 user 삭제.
  if (retentionMs > 0) {
    const cutoff = new Date(nowMs - retentionMs);
    const old = await db
      .select({ id: rooms.id })
      .from(rooms)
      .where(and(eq(rooms.status, "ended"), lt(rooms.endedAt, cutoff)));
    const ids = old.map((r) => r.id);
    if (ids.length > 0) {
      // FK 순서 명시 삭제(트랜잭션) — cascade 에 의존하지 않고 삭제 범위를 감사 가능하게.
      await db.transaction(async (tx) => {
        await tx.delete(chatMessages).where(inArray(chatMessages.roomId, ids));
        await tx.delete(moderationLogs).where(inArray(moderationLogs.roomId, ids));
        await tx
          .delete(roomParticipants)
          .where(inArray(roomParticipants.roomId, ids));
        await tx.delete(rooms).where(inArray(rooms.id, ids));
      });
      purgedRooms = ids.length;
    }

    // 어느 방에도 안 남은 익명 user 정리(생성도 보존기간 지난 것만 → 신규 user 보호).
    const active = new Set<string>();
    for (const r of await db
      .select({ uid: roomParticipants.userId })
      .from(roomParticipants))
      active.add(r.uid);
    for (const r of await db.select({ hid: rooms.hostId }).from(rooms))
      active.add(r.hid);
    const oldUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(lt(users.createdAt, cutoff));
    const orphan = oldUsers.filter((u) => !active.has(u.id)).map((u) => u.id);
    if (orphan.length > 0) {
      try {
        await db.delete(users).where(inArray(users.id, orphan));
        purgedUsers = orphan.length;
      } catch (err) {
        // 잔여 FK 참조 등으로 실패해도 방 삭제는 이미 커밋됨 — 다음 스윕에서 재시도.
        console.warn("[demoSweeper] orphan user 정리 실패:", (err as Error).message);
      }
    }
  }

  return { expired, purgedRooms, purgedUsers };
}

let timer: NodeJS.Timeout | undefined;
export function startDemoSweeper() {
  if (timer) return;
  // 가드가 하나도 활성이 아니면 스위퍼를 돌리지 않는다(기본 상태 = 완전 무동작).
  if (config.demo.maxRoomLifetimeMs <= 0 && config.demo.dataRetentionMs <= 0)
    return;
  timer = setInterval(() => {
    void sweepDemoOnce(Date.now()).catch((err) =>
      console.warn("[demoSweeper] sweep failed:", (err as Error).message),
    );
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
}
export function stopDemoSweeper() {
  if (timer) clearInterval(timer);
  timer = undefined;
}

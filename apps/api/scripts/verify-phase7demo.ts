/**
 * Phase 7-lite §1-4 검증 — 데모 가드(방 상한·수명 만료·데이터 보존).
 *   실행: pnpm --filter @multi-live/api verify:phase7demo
 *   전제: redis/postgres/livekit 실행 중.
 *
 * 혼합 방식:
 *   - 상한: MAX_CONCURRENT_ROOMS 를 준 격리 인스턴스(verify-phase7 spawn 패턴)에 방을 만들어 503 확인.
 *           공유 DB 라 전역 활성 방을 세므로 cap = (현재 활성 수)+2 로 잡아 사전 방과 무관하게 결정적.
 *   - 수명/보존: in-process sweepDemoOnce(nowMs·opts 주입) — 픽스처를 far-past 로 aging + 1h 윈도우로
 *           다른 CI 레코드와 격리해 결정적. 종료는 공유 경로(endRoomGracefully) 그대로 사용.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq, inArray } from "drizzle-orm";
import { db, closeDb } from "../src/db/index.js";
import { rooms, chatMessages, users } from "../src/db/schema.js";
import { redis } from "../src/services/redis.js";
import { countActiveRooms, createRoomRecord } from "../src/services/rooms.js";
import { createUser } from "../src/services/users.js";
import { createLiveKitRoom } from "../src/services/livekit.js";
import { sweepDemoOnce } from "../src/services/demoSweeper.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(__dirname, "..");
const FAR_PAST = new Date("2020-01-01T00:00:00Z");
const HOUR_MS = 3_600_000;

let pass = 0;
let fail = 0;
function assert(cond: boolean, label: string, detail?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.error(`  ✗ ${label}`, detail !== undefined ? detail : "");
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function spawnServer(
  port: number,
  extraEnv: Record<string, string>,
): Promise<{ base: string; stop: () => void }> {
  const child = spawn("pnpm", ["exec", "tsx", "src/index.ts"], {
    cwd: apiDir,
    env: { ...process.env, ...extraEnv, API_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logbuf = "";
  let exited: number | null = null;
  child.stdout.on("data", (d) => (logbuf += d));
  child.stderr.on("data", (d) => (logbuf += d));
  child.on("exit", (code) => (exited = code ?? -1));
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 80; i++) {
    if (exited !== null)
      throw new Error(`cap 인스턴스 부팅 중 종료(exit=${exited})\n${logbuf}`);
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return { base, stop: () => void child.kill("SIGKILL") };
    } catch {
      /* 대기 */
    }
    await sleep(250);
  }
  child.kill("SIGKILL");
  throw new Error(`cap 인스턴스 /health 타임아웃\n${logbuf}`);
}

async function partCap() {
  console.log("── 방 상한(MAX_CONCURRENT_ROOMS) ──────────────");
  const base = await countActiveRooms();
  const cap = base + 2;
  const inst = await spawnServer(4073, { MAX_CONCURRENT_ROOMS: String(cap) });
  try {
    const sess = await fetch(`${inst.base}/auth/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nickname: "상한호스트" }),
    });
    const token = ((await sess.json()) as { token: string }).token;
    const mkRoom = () =>
      fetch(`${inst.base}/rooms`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ title: "데모상한", maxGuests: 4 }),
      });
    const r1 = await mkRoom();
    const r2 = await mkRoom();
    assert(
      r1.status === 201 && r2.status === 201,
      `상한 이내 방 생성 통과(201, cap=${cap})`,
      [r1.status, r2.status],
    );
    const r3 = await mkRoom();
    const body = (await r3.json()) as { error?: string };
    assert(
      r3.status === 503 &&
        body?.error === "demo_room_cap" &&
        r3.headers.get("retry-after") !== null,
      "상한 초과 방 생성 → 503 demo_room_cap + Retry-After",
      { status: r3.status, body, retry: r3.headers.get("retry-after") },
    );
  } finally {
    inst.stop();
  }
}

async function partLifetime() {
  console.log("── 방 수명 만료(MAX_ROOM_LIFETIME_MIN) ─────────");
  const host = await createUser("수명호스트");
  const stale = await createRoomRecord(host.id, {
    title: "수명테스트",
    maxGuests: 4,
    maxSpeakers: 20,
    viewerMode: "webrtc",
  });
  await createLiveKitRoom(stale.id, stale.maxGuests); // 종료 경로가 deleteRoom 하도록 실제 생성.
  // createdAt 을 far-past 로 aging → 1h 수명 윈도우에서 이 방만 만료 대상.
  await db.update(rooms).set({ createdAt: FAR_PAST }).where(eq(rooms.id, stale.id));
  // 최근(비-aging) 방 — 윈도우 밖이라 만료되면 안 됨(격리 확인).
  const recent = await createRoomRecord(host.id, {
    title: "최근방",
    maxGuests: 4,
    maxSpeakers: 20,
    viewerMode: "webrtc",
  });

  const res = await sweepDemoOnce(Date.now(), { lifetimeMs: HOUR_MS });
  assert(
    res.expired.includes(stale.id),
    "far-past 활성 방이 수명 스윕에서 만료 종료 대상(expired)",
    res.expired,
  );
  assert(
    !res.expired.includes(recent.id),
    "최근 활성 방은 수명 윈도우 밖 → 만료 안 됨(격리)",
    res.expired,
  );
}

async function partRetention() {
  console.log("── 데이터 보존(DATA_RETENTION_HOURS) ───────────");
  const host = await createUser("보존호스트");
  const orphan = await createUser("고아유저");
  const room = await createRoomRecord(host.id, {
    title: "보존테스트",
    maxGuests: 4,
    maxSpeakers: 20,
    viewerMode: "webrtc",
  });
  await db.insert(chatMessages).values({
    roomId: room.id,
    userId: host.id,
    nickname: "보존호스트",
    text: "삭제될 메시지",
  });
  // 방: ended + endedAt far-past(보존 초과). user: host·orphan 을 far-past(고아 정리 대상).
  await db
    .update(rooms)
    .set({ status: "ended", endedAt: FAR_PAST })
    .where(eq(rooms.id, room.id));
  await db
    .update(users)
    .set({ createdAt: FAR_PAST })
    .where(inArray(users.id, [host.id, orphan.id]));

  const res = await sweepDemoOnce(Date.now(), { retentionMs: HOUR_MS, lifetimeMs: 0 });

  const roomGone = await db
    .select({ id: rooms.id })
    .from(rooms)
    .where(eq(rooms.id, room.id));
  const chatGone = await db
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(eq(chatMessages.roomId, room.id));
  const usersGone = await db
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.id, [host.id, orphan.id]));
  assert(
    roomGone.length === 0 && res.purgedRooms >= 1,
    "보존기간 초과 방 삭제됨",
    { roomGone, purgedRooms: res.purgedRooms },
  );
  assert(
    chatGone.length === 0,
    "방 삭제 시 채팅 메시지도 삭제(FK 순서)",
    chatGone,
  );
  assert(
    usersGone.length === 0 && res.purgedUsers >= 2,
    "어느 방에도 안 남은 far-past 익명 user 정리",
    { usersGone, purgedUsers: res.purgedUsers },
  );
}

async function main() {
  try {
    await partCap();
    await partLifetime();
    await partRetention();
  } finally {
    console.log("──────────────────────────────────────────");
    console.log(`통과 ${pass} / 실패 ${fail}`);
    await redis.quit();
    await closeDb();
  }
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => {
  console.error(e);
  try {
    await redis.quit();
    await closeDb();
  } catch {
    /* ignore */
  }
  process.exit(1);
});

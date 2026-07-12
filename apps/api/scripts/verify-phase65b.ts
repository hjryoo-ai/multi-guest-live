/**
 * Phase 6.5 Track B(성능) 서버 검증 — API 가 :4000 에서 실행 중이어야 함.
 *   실행: pnpm --filter @multi-live/api verify:phase65b
 *
 * B-1 채팅 마이크로 캐시(연속 GET → DB 조회 1회, 나머지 캐시 히트 · TTL 만료 후 재조회) ·
 * B-3 HLS 캐싱 헤더(세그먼트 immutable / 매니페스트 no-cache).
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../src/config.js";
import { redis } from "../src/services/redis.js";

const BASE = `http://localhost:${config.port}`;
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

async function api(
  p: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  const res = await fetch(`${BASE}${p}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-json */
  }
  return { status: res.status, json, headers: res.headers };
}
async function session(nickname: string) {
  const r = await api("/auth/session", { method: "POST", body: { nickname } });
  return { token: r.json.token as string, userId: r.json.userId as string };
}

// /metrics 에서 ml_chat_cache_total{result="hit|miss"} 값 파싱.
async function cacheCounts(): Promise<{ hit: number; miss: number }> {
  const res = await fetch(`${BASE}/metrics`);
  const text = await res.text();
  const get = (result: string) => {
    const m = text.match(
      new RegExp(`ml_chat_cache_total\\{result="${result}"\\}\\s+(\\d+)`),
    );
    return m ? Number(m[1]) : 0;
  };
  return { hit: get("hit"), miss: get("miss") };
}

async function partCache() {
  console.log("── B-1 채팅 마이크로 캐시 ─────────────────────");
  const host = await session("성능호스트");
  const room = await api("/rooms", {
    method: "POST",
    token: host.token,
    body: { title: "cache 방", maxGuests: 4 },
  });
  const roomId = room.json.id as string;
  await api(`/rooms/${roomId}/chat`, {
    method: "POST",
    token: host.token,
    body: { text: "첫 메시지" },
  });

  // 동일 파라미터로 즉시 6회 연속 GET(1초 창) → 1 miss + 5 hit 근사.
  const before = await cacheCounts();
  const N = 6;
  for (let i = 0; i < N; i++) {
    await api(`/rooms/${roomId}/chat`, { token: host.token });
  }
  const after = await cacheCounts();
  const dMiss = after.miss - before.miss;
  const dHit = after.hit - before.hit;
  assert(
    dHit >= N - 2 && dMiss <= 2,
    `연속 ${N} GET → 대부분 캐시 히트(hit+${dHit}, miss+${dMiss}) = DB 조회 상한`,
    { dHit, dMiss },
  );

  // TTL(1초) 만료 후 GET → 다시 miss(신선도 갱신).
  await sleep(1200);
  const b2 = await cacheCounts();
  await api(`/rooms/${roomId}/chat`, { token: host.token });
  const a2 = await cacheCounts();
  assert(
    a2.miss - b2.miss === 1,
    "TTL(1초) 만료 후 GET → miss 1회(캐시 갱신)",
    { d: a2.miss - b2.miss },
  );

  // 캐시가 신규 메시지를 ≤1초 내 반영(정합성): 새 메시지 후 1.2초 뒤 조회에 포함.
  await api(`/rooms/${roomId}/chat`, {
    method: "POST",
    token: host.token,
    body: { text: "두번째 메시지" },
  });
  await sleep(1200);
  const list = await api(`/rooms/${roomId}/chat`, { token: host.token });
  const texts = (list.json.messages as any[]).map((m) => m.text);
  assert(
    texts.includes("두번째 메시지"),
    "캐시 TTL 경과 후 신규 메시지 반영(정합성)",
    texts,
  );
  await api(`/rooms/${roomId}/end`, { method: "POST", token: host.token });
}

async function partHlsHeaders() {
  console.log("── B-3 HLS 캐싱 헤더 ─────────────────────────");
  const roomId = randomUUID();
  const dir = path.join(config.egressOutDir, roomId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "index.m3u8"), "#EXTM3U\n");
  writeFileSync(path.join(dir, "seg0.ts"), "\x00\x00");
  try {
    const man = await api(`/hls/${roomId}/index.m3u8`);
    assert(
      man.status === 200 &&
        (man.headers.get("cache-control") ?? "").includes("no-cache"),
      "매니페스트(.m3u8) → Cache-Control: no-cache",
      man.headers.get("cache-control"),
    );
    const seg = await api(`/hls/${roomId}/seg0.ts`);
    const cc = seg.headers.get("cache-control") ?? "";
    assert(
      seg.status === 200 &&
        cc.includes("max-age=86400") &&
        cc.includes("immutable"),
      "세그먼트(.ts) → Cache-Control: public, max-age=86400, immutable",
      cc,
    );
    // CORS 헤더 유지(브라우저 hls.js fetch).
    assert(
      seg.headers.get("access-control-allow-origin") === "*",
      "HLS 세그먼트 ACAO=* 유지",
      seg.headers.get("access-control-allow-origin"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  await partCache();
  await partHlsHeaders();
  console.log("──────────────────────────────────────────");
  console.log(`통과 ${pass} / 실패 ${fail}`);
  await redis.quit();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

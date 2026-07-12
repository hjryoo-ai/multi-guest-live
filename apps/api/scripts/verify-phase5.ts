/**
 * Phase 5 서버 검증 — API 가 :4000 에서 실행 중이어야 함.
 *   실행: pnpm --filter @multi-live/api verify:phase5
 *
 * Part A (관측): /metrics 노출 + 카운터 증분(채팅 429 · egress 폴백 · webhook 미등록 identity)
 * Part B (host 이탈 유예): 스위퍼가 미복귀 방을 종료 / 복귀 시 취소
 * Part C (재접속 판정): shouldReconnectOnDisconnect 제외 규칙(핑퐁 방지)
 */
import { createHash, createHmac } from "node:crypto";
import {
  shouldReconnectOnDisconnect,
  DISCONNECT_REASON,
} from "@multi-live/shared";
import { config } from "../src/config.js";
import { redis } from "../src/services/redis.js";
import { markHostGone, sweepHostGraceOnce } from "../src/services/hostGrace.js";

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

async function api(
  path: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  const res = await fetch(`${BASE}${path}`, {
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
  return { status: res.status, json };
}
async function session(nickname: string) {
  const r = await api("/auth/session", { method: "POST", body: { nickname } });
  return { token: r.json.token as string, userId: r.json.userId as string };
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");
function signWebhookJwt(sha256: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ iss: config.livekit.apiKey, iat: now, exp: now + 60, sha256 }),
  );
  const sig = b64url(
    createHmac("sha256", config.livekit.apiSecret)
      .update(`${header}.${payload}`)
      .digest(),
  );
  return `${header}.${payload}.${sig}`;
}
async function postWebhook(event: Record<string, unknown>) {
  const body = JSON.stringify(event);
  const jwt = signWebhookJwt(createHash("sha256").update(body).digest("base64"));
  const res = await fetch(`${BASE}/webhooks/livekit`, {
    method: "POST",
    headers: { "content-type": "application/webhook+json", authorization: jwt },
    body,
  });
  return res.status;
}

// /metrics 스크레이프 후 라벨 없는 카운터 값 파싱.
async function metricValue(name: string): Promise<number> {
  const res = await fetch(`${BASE}/metrics`);
  const text = await res.text();
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escaped}\\s+([0-9.e+-]+)$`, "m");
  const m = text.match(re);
  return m ? Number(m[1]) : 0;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function partA() {
  console.log("── Part A: 관측(/metrics) ──────────────────");
  const res = await fetch(`${BASE}/metrics`);
  const text = await res.text();
  assert(
    res.status === 200 && text.includes("ml_active_rooms"),
    "/metrics 노출(게이지 포함)",
    res.status,
  );

  const host = await session("호스트5");
  const room = await api("/rooms", {
    method: "POST",
    token: host.token,
    body: { title: "P5", maxGuests: 8, viewerMode: "webrtc" },
  });
  const roomId = room.json.id as string;

  // 채팅 429 → ml_chat_rate_limited_total 증가.
  const before429 = await metricValue("ml_chat_rate_limited_total");
  await api(`/rooms/${roomId}/chat`, {
    method: "POST",
    token: host.token,
    body: { text: "a" },
  });
  const r2 = await api(`/rooms/${roomId}/chat`, {
    method: "POST",
    token: host.token,
    body: { text: "b" },
  });
  assert(r2.status === 429, "즉시 재전송 → 429", r2.status);
  assert(
    (await metricValue("ml_chat_rate_limited_total")) > before429,
    "ml_chat_rate_limited_total 증가",
  );

  // webhook 미등록 identity → ml_webhook_unknown_identity_total 증가(에러 아님).
  const beforeUnknown = await metricValue("ml_webhook_unknown_identity_total");
  const beforeErr = await metricValue('ml_webhook_errors_total{event="participant_joined"}');
  await postWebhook({
    event: "participant_joined",
    room: { name: "loadtest-room" }, // non-uuid
    participant: { identity: "loadtest_pub_0" }, // non-uuid
    createdAt: Math.floor(Date.now() / 1000),
    id: "wh_unknown",
  });
  assert(
    (await metricValue("ml_webhook_unknown_identity_total")) > beforeUnknown,
    "미등록 identity → ml_webhook_unknown_identity_total 증가",
  );
  assert(
    (await metricValue('ml_webhook_errors_total{event="participant_joined"}')) === beforeErr,
    "미등록 identity 는 webhook_errors 를 오염시키지 않음",
  );

  // egress 폴백 → ml_egress_fallbacks_total 증가.
  const rB = await api("/rooms", {
    method: "POST",
    token: host.token,
    body: { title: "P5-hls", maxGuests: 8, viewerMode: "hls" },
  });
  const roomB = rB.json.id as string;
  const beforeFallback = await metricValue("ml_egress_fallbacks_total");
  await postWebhook({
    event: "egress_ended",
    egressInfo: { egressId: "EG_x", roomName: roomB, status: "EGRESS_FAILED" },
    createdAt: Math.floor(Date.now() / 1000),
    id: "wh_eg_fail5",
  });
  assert(
    (await metricValue("ml_egress_fallbacks_total")) > beforeFallback,
    "egress 실패 → ml_egress_fallbacks_total 증가",
  );

  await api(`/rooms/${roomId}/end`, { method: "POST", token: host.token });
  await api(`/rooms/${roomB}/end`, { method: "POST", token: host.token });
}

async function partB() {
  console.log("── Part B: host 이탈 유예 스위퍼 ───────────");
  const host = await session("호스트5b");

  // 종료 케이스: 방 생성+live, host 이탈 유예를 과거로 설정, host 부재 → 스위퍼가 종료.
  const r1 = await api("/rooms", {
    method: "POST",
    token: host.token,
    body: { title: "grace-end", maxGuests: 8, viewerMode: "webrtc" },
  });
  const room1 = r1.json.id as string;
  await api(`/rooms/${room1}/token`, { method: "POST", token: host.token }); // → live
  await redis.srem(`room:${room1}:present`, host.userId); // host 부재 보장
  await markHostGone(room1, Date.now() - 10 * 60 * 1000); // 10분 전 이탈
  const ended = await sweepHostGraceOnce(Date.now(), 1000); // graceMs 1s
  assert(ended.includes(room1), "유예 만료+미복귀 방을 스위퍼가 종료 처리", ended);
  // deleteRoom → room_finished webhook → markRoomEnded 반영 대기.
  let status = "";
  for (let i = 0; i < 10; i++) {
    await sleep(500);
    const g = await api(`/rooms/${room1}`);
    status = g.json?.status;
    if (status === "ended") break;
  }
  assert(status === "ended", "종료 후 방 status=ended", status);
  assert(
    (await redis.exists(`room:${room1}:host_gone`)) === 0,
    "종료 후 host_gone 키 정리",
  );

  // 복귀 케이스: host 가 present 이면 유예를 취소하고 종료하지 않음.
  const r2 = await api("/rooms", {
    method: "POST",
    token: host.token,
    body: { title: "grace-cancel", maxGuests: 8, viewerMode: "webrtc" },
  });
  const room2 = r2.json.id as string;
  await api(`/rooms/${room2}/token`, { method: "POST", token: host.token });
  await redis.sadd(`room:${room2}:present`, host.userId); // host 복귀(present)
  await markHostGone(room2, Date.now() - 10 * 60 * 1000);
  const ended2 = await sweepHostGraceOnce(Date.now(), 1000);
  assert(!ended2.includes(room2), "host 복귀(present) 방은 종료하지 않음", ended2);
  const g2 = await api(`/rooms/${room2}`);
  assert(g2.json?.status !== "ended", "복귀 방 status 유지(미종료)", g2.json?.status);
  assert(
    (await redis.exists(`room:${room2}:host_gone`)) === 0,
    "복귀 시 host_gone 키 취소",
  );

  await api(`/rooms/${room2}/end`, { method: "POST", token: host.token });
}

function partC() {
  console.log("── Part C: 재접속 판정(핑퐁 방지) ─────────");
  assert(
    shouldReconnectOnDisconnect(DISCONNECT_REASON.UNKNOWN_REASON, false) === true,
    "UNKNOWN(일시 단절) → 재접속",
  );
  assert(
    shouldReconnectOnDisconnect(undefined, false) === true,
    "reason 불명 → 재접속",
  );
  assert(
    shouldReconnectOnDisconnect(DISCONNECT_REASON.DUPLICATE_IDENTITY, false) === false,
    "DUPLICATE_IDENTITY → 재접속 안 함(핑퐁 방지)",
  );
  assert(
    shouldReconnectOnDisconnect(DISCONNECT_REASON.CLIENT_INITIATED, false) === false,
    "CLIENT_INITIATED(의도적) → 재접속 안 함",
  );
  assert(
    shouldReconnectOnDisconnect(DISCONNECT_REASON.PARTICIPANT_REMOVED, false) === false,
    "PARTICIPANT_REMOVED(강퇴) → 재접속 안 함",
  );
  assert(
    shouldReconnectOnDisconnect(DISCONNECT_REASON.ROOM_DELETED, false) === false,
    "ROOM_DELETED(방 종료) → 재접속 안 함",
  );
  assert(
    shouldReconnectOnDisconnect(DISCONNECT_REASON.UNKNOWN_REASON, true) === false,
    "ROOM_ENDING 수신 후 → 재접속 안 함",
  );
}

async function main() {
  await partA();
  await partB();
  partC();
  console.log("──────────────────────────────────────────");
  console.log(`통과 ${pass} / 실패 ${fail}`);
  await redis.quit();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

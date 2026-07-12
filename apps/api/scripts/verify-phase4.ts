/**
 * Phase 4 서버 검증 — API 가 :4000 에서 실행 중이어야 함.
 *   실행: pnpm --filter @multi-live/api verify:phase4
 *
 * Part A (채팅): 저장·조회·커서 · rate limit(429) · 길이제한(400) · 금칙어 마스킹 · hidden 제외
 * Part B (시청자 수 / HLS / egress 상태머신): viewer-count · hls info ·
 *          webhook 으로 egress_started(active)→active, egress_ended(failed)→모드 A 폴백
 */
import { createHash, createHmac } from "node:crypto";
import { config } from "../src/config.js";
import { setChatHidden } from "../src/services/chat.js";
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

const b64url = (s: string | Buffer) =>
  Buffer.from(s).toString("base64url");
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function partA() {
  console.log("── Part A: 채팅 (저장·전파·필터) ──────────");
  const host = await session("호스트4");
  const viewer = await session("시청자4");
  const room = await api("/rooms", {
    method: "POST",
    token: host.token,
    body: { title: "Phase4", maxGuests: 8, viewerMode: "webrtc" },
  });
  const roomId = room.json.id as string;

  // 전송 → 201 + id 부여
  const m1 = await api(`/rooms/${roomId}/chat`, {
    method: "POST",
    token: viewer.token,
    body: { text: "안녕하세요" },
  });
  assert(
    m1.status === 201 && typeof m1.json?.id === "number" && m1.json?.nickname === "시청자4",
    "채팅 전송 → 201, 서버가 id·nickname 부여",
    m1.json,
  );
  const firstId = m1.json.id as number;

  // rate limit: 즉시 2번째 전송 → 429
  const m2 = await api(`/rooms/${roomId}/chat`, {
    method: "POST",
    token: viewer.token,
    body: { text: "연타" },
  });
  assert(m2.status === 429, "동일 유저 즉시 재전송 → 429 rate limited", m2);

  // 창이 지나면 다시 허용
  await sleep(1100);
  const m3 = await api(`/rooms/${roomId}/chat`, {
    method: "POST",
    token: viewer.token,
    body: { text: "두번째" },
  });
  assert(m3.status === 201, "rate 창 경과 후 재전송 → 201", m3);
  const secondId = m3.json.id as number;

  // 길이 초과(>500) → 400
  const long = await api(`/rooms/${roomId}/chat`, {
    method: "POST",
    token: host.token,
    body: { text: "x".repeat(501) },
  });
  assert(long.status === 400, "500자 초과 → 400", long);

  // 금칙어 마스킹
  const bad = await api(`/rooms/${roomId}/chat`, {
    method: "POST",
    token: host.token,
    body: { text: "이건 badword 임" },
  });
  assert(
    bad.status === 201 && !bad.json.text.includes("badword") && bad.json.text.includes("*"),
    "금칙어는 마스킹되어 저장",
    bad.json,
  );

  // 조회(히스토리) — 시간순, 저장된 메시지 포함 + viewerCount 필드
  const list = await api(`/rooms/${roomId}/chat`, { token: host.token });
  assert(
    list.status === 200 &&
      Array.isArray(list.json?.messages) &&
      typeof list.json?.viewerCount === "number",
    "GET /chat → messages[] + viewerCount",
    list.json,
  );
  const ids = (list.json.messages as any[]).map((m) => m.id);
  assert(
    ids.includes(firstId) && ids.includes(secondId),
    "히스토리에 저장 메시지 포함",
    ids,
  );
  assert(
    ids.every((v: number, i: number) => i === 0 || v > ids[i - 1]),
    "메시지는 id 오름차순(순서의 단일 진실)",
    ids,
  );

  // 커서: after=firstId → firstId 이후만
  const after = await api(`/rooms/${roomId}/chat?after=${firstId}`, {
    token: host.token,
  });
  const afterIds = (after.json.messages as any[]).map((m) => m.id);
  assert(
    afterIds.length > 0 && afterIds.every((v: number) => v > firstId),
    "after 커서 → 이후 메시지만 반환",
    afterIds,
  );

  // hidden: 서비스로 숨김 → 비-host GET 에서 제외 (host 는 6B 에서 플래그와 함께 봄).
  await setChatHidden(roomId, secondId, true);
  const afterHide = await api(`/rooms/${roomId}/chat`, { token: viewer.token });
  const hiddenGone = !(afterHide.json.messages as any[]).some(
    (m) => m.id === secondId,
  );
  assert(hiddenGone, "hidden=true 메시지는 비-host GET 에서 제외", afterHide.json.messages);

  await api(`/rooms/${roomId}/end`, { method: "POST", token: host.token });
  return { hostToken: host.token };
}

async function partB() {
  console.log("── Part B: 시청자 수 · HLS · egress 상태머신 ──");
  const host = await session("호스트4b");

  // 모드 A 방
  const rA = await api("/rooms", {
    method: "POST",
    token: host.token,
    body: { title: "P4-A", maxGuests: 8, viewerMode: "webrtc" },
  });
  const roomA = rA.json.id as string;
  assert(rA.json.viewerMode === "webrtc", "모드 A 방 생성", rA.json);
  const vcA = await api(`/rooms/${roomA}/viewer-count`, { token: host.token });
  assert(
    vcA.status === 200 && vcA.json?.mode === "webrtc" && typeof vcA.json?.count === "number",
    "모드 A viewer-count → {count, mode:webrtc}",
    vcA.json,
  );

  // 모드 B 방
  const rB = await api("/rooms", {
    method: "POST",
    token: host.token,
    body: { title: "P4-B", maxGuests: 8, viewerMode: "hls" },
  });
  const roomB = rB.json.id as string;
  assert(
    rB.json.viewerMode === "hls" && rB.json.egressStatus === "none",
    "모드 B 방 생성 → viewerMode=hls, egressStatus=none",
    rB.json,
  );

  // HLS 정보: 아직 egress active 아님 → playlistUrl null
  const hls0 = await api(`/rooms/${roomB}/hls`);
  assert(
    hls0.status === 200 && hls0.json?.mode === "hls" && hls0.json?.playlistUrl === null,
    "egress 미활성 시 playlistUrl=null",
    hls0.json,
  );

  // webhook: egress_started(active) → egressStatus active + playlistUrl 노출
  const st = await postWebhook({
    event: "egress_started",
    egressInfo: {
      egressId: "EG_test_1",
      roomName: roomB,
      status: "EGRESS_ACTIVE",
    },
    createdAt: Math.floor(Date.now() / 1000),
    id: "wh_eg_start",
  });
  assert(st === 200, "egress_started webhook 수신 → 200", st);
  const roomBActive = await api(`/rooms/${roomB}`);
  assert(
    roomBActive.json?.egressStatus === "active",
    "egress_started 후 egressStatus=active",
    roomBActive.json?.egressStatus,
  );
  const hls1 = await api(`/rooms/${roomB}/hls`);
  assert(
    hls1.json?.playlistUrl && String(hls1.json.playlistUrl).endsWith(`/hls/${roomB}/index.m3u8`),
    "active 시 playlistUrl 노출",
    hls1.json,
  );

  // webhook: egress_ended(failed) → 모드 A 자동 폴백
  const en = await postWebhook({
    event: "egress_ended",
    egressInfo: {
      egressId: "EG_test_1",
      roomName: roomB,
      status: "EGRESS_FAILED",
    },
    createdAt: Math.floor(Date.now() / 1000),
    id: "wh_eg_end",
  });
  assert(en === 200, "egress_ended(failed) webhook 수신 → 200", en);
  const roomBFallback = await api(`/rooms/${roomB}`);
  assert(
    roomBFallback.json?.viewerMode === "webrtc" &&
      roomBFallback.json?.egressStatus === "failed",
    "egress 실패 → viewerMode 자동 폴백(webrtc) + egressStatus=failed",
    roomBFallback.json,
  );

  await api(`/rooms/${roomA}/end`, { method: "POST", token: host.token });
  await api(`/rooms/${roomB}/end`, { method: "POST", token: host.token });
}

async function main() {
  await partA();
  await partB();
  console.log("──────────────────────────────────────────");
  console.log(`통과 ${pass} / 실패 ${fail}`);
  await redis.quit();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

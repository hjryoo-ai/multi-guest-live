/**
 * Phase 1 검증 스크립트 — API 가 :4000 에서 실행 중이어야 함.
 *   실행: pnpm --filter @multi-live/api verify:phase1
 *
 * 커버리지:
 *   REST     세션발급 / 방생성 / 방조회 / role 서버결정 / guest 자기선언 403 /
 *            유령 방 404 / host 전용 end 403
 *   Webhook  서명검증 통과(joined→DB반영) / 멱등 / left 반영 / 잘못된 서명 401
 */
import { createHash, createHmac } from "node:crypto";
import { config } from "../src/config.js";

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// LiveKit TokenVerifier(jose.jwtVerify, issuer=apiKey) 를 통과하는 HS256 JWT 생성.
function signWebhookJwt(sha256: string, secret: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ iss: config.livekit.apiKey, iat: now, exp: now + 60, sha256 }),
  );
  const sig = b64url(
    createHmac("sha256", secret).update(`${header}.${payload}`).digest(),
  );
  return `${header}.${payload}.${sig}`;
}

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

// LiveKit webhook 과 동일한 방식으로 서명된 요청 생성.
async function postWebhook(event: Record<string, unknown>, tamper = false) {
  const body = JSON.stringify(event);
  const hash = createHash("sha256").update(body).digest("base64");
  const jwt = signWebhookJwt(
    hash,
    tamper ? "wrong_secret_0123456789" : config.livekit.apiSecret,
  );
  const res = await fetch(`${BASE}/webhooks/livekit`, {
    method: "POST",
    headers: { "content-type": "application/webhook+json", authorization: jwt },
    body,
  });
  return res.status;
}

async function main() {
  console.log("── REST 계약 ──────────────────────────────");
  const host = await api("/auth/session", {
    method: "POST",
    body: { nickname: "호스트" },
  });
  assert(host.status === 200 && !!host.json?.token, "host 세션 발급", host);
  const viewer = await api("/auth/session", {
    method: "POST",
    body: { nickname: "시청자" },
  });
  assert(viewer.status === 200 && !!viewer.json?.token, "viewer 세션 발급");

  const created = await api("/rooms", {
    method: "POST",
    token: host.json.token,
    body: { title: "Phase1 테스트 방", maxGuests: 8 },
  });
  assert(created.status === 201 && !!created.json?.id, "방 생성(201)", created);
  const roomId: string = created.json.id;
  assert(created.json.status === "created", "생성 직후 status=created");

  const detail = await api(`/rooms/${roomId}`);
  assert(
    detail.status === 200 &&
      detail.json.participants.some(
        (p: any) => p.userId === host.json.userId && p.role === "host",
      ),
    "GET /rooms/:id 에 host 참가자 포함",
    detail.json?.participants,
  );

  const hostTok = await api(`/rooms/${roomId}/token`, {
    method: "POST",
    token: host.json.token,
    body: {},
  });
  assert(
    hostTok.status === 200 && hostTok.json.role === "host",
    "host 토큰: 서버가 role=host 결정",
    hostTok.json,
  );
  assert(
    hostTok.json?.identity === host.json.userId,
    "토큰 identity = user.id",
  );

  const viewerTok = await api(`/rooms/${roomId}/token`, {
    method: "POST",
    token: viewer.json.token,
    body: {},
  });
  assert(
    viewerTok.status === 200 && viewerTok.json.role === "viewer",
    "viewer 토큰: 서버가 role=viewer 결정",
    viewerTok.json,
  );

  // ★ 자기선언 차단
  const selfGuest = await api(`/rooms/${roomId}/token`, {
    method: "POST",
    token: viewer.json.token,
    body: { role: "guest" },
  });
  assert(
    selfGuest.status === 403 && selfGuest.json?.error === "approval_required",
    "viewer 가 guest role 요청 → 403 approval_required",
    selfGuest,
  );
  const selfSpeaker = await api(`/rooms/${roomId}/token`, {
    method: "POST",
    token: viewer.json.token,
    body: { role: "speaker" },
  });
  assert(
    selfSpeaker.status === 403,
    "viewer 가 speaker role 요청 → 403",
    selfSpeaker,
  );

  // 유령 방 차단
  const ghost = await api(
    `/rooms/00000000-0000-0000-0000-000000000000/token`,
    { method: "POST", token: viewer.json.token, body: {} },
  );
  assert(ghost.status === 404, "존재하지 않는 방 토큰 요청 → 404", ghost);

  // host 전용 end
  const badEnd = await api(`/rooms/${roomId}/end`, {
    method: "POST",
    token: viewer.json.token,
  });
  assert(badEnd.status === 403, "viewer 의 방 종료 시도 → 403 host_only", badEnd);

  console.log("── Webhook 동기화 ─────────────────────────");
  const tsBase = Math.floor(Date.now() / 1000);
  const joined = await postWebhook({
    event: "participant_joined",
    createdAt: tsBase,
    room: { name: roomId },
    participant: { identity: viewer.json.userId, name: "시청자" },
  });
  assert(joined === 200, "participant_joined 서명검증 통과(200)", joined);

  // 멱등: 동일 이벤트 재전송
  const joinedDup = await postWebhook({
    event: "participant_joined",
    createdAt: tsBase,
    room: { name: roomId },
    participant: { identity: viewer.json.userId, name: "시청자" },
  });
  assert(joinedDup === 200, "participant_joined 중복 전송 멱등(200)");

  const afterJoin = await api(`/rooms/${roomId}`);
  const vp = afterJoin.json.participants.find(
    (p: any) => p.userId === viewer.json.userId,
  );
  assert(!!vp && vp.joinedAt !== null, "webhook joined → DB joinedAt 반영", vp);

  // track_published(audio)
  const pub = await postWebhook({
    event: "track_published",
    createdAt: tsBase + 1,
    room: { name: roomId },
    participant: { identity: viewer.json.userId },
    track: { sid: "TR_test_audio_1", type: 0 /* AUDIO */ },
  });
  assert(pub === 200, "track_published(audio) 처리(200)");

  // participant_left
  const left = await postWebhook({
    event: "participant_left",
    createdAt: tsBase + 2,
    room: { name: roomId },
    participant: { identity: viewer.json.userId },
  });
  assert(left === 200, "participant_left 처리(200)");
  const afterLeft = await api(`/rooms/${roomId}`);
  const vp2 = afterLeft.json.participants.find(
    (p: any) => p.userId === viewer.json.userId,
  );
  assert(!!vp2 && vp2.leftAt !== null, "webhook left → DB leftAt 반영", vp2);

  // 잘못된 서명
  const bad = await postWebhook(
    {
      event: "participant_joined",
      createdAt: tsBase + 3,
      room: { name: roomId },
      participant: { identity: viewer.json.userId },
    },
    true,
  );
  assert(bad === 401, "잘못된 서명 webhook → 401", bad);

  // 정리
  await api(`/rooms/${roomId}/end`, { method: "POST", token: host.json.token });

  console.log("──────────────────────────────────────────");
  console.log(`통과 ${pass} / 실패 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

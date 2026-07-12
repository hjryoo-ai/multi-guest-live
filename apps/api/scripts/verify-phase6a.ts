/**
 * Phase 6A 서버 검증 — speaker 역할. API 가 :4000 에서 실행 중이어야 함.
 *   실행: pnpm --filter @multi-live/api verify:phase6a
 *
 * approve role 분기(speaker grant=audio-only) · 슬롯 분리 · 다른 role approve 409 ·
 * role 전환(양방향·멱등·로그·비승인 409) · kicked speaker 403 · 재입장 role 유지
 */
import { createHash, createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { config } from "../src/config.js";
import { db } from "../src/db/index.js";
import { moderationLogs } from "../src/db/schema.js";
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

// LiveKit AccessToken(JWT) 의 video grant 를 디코드.
function decodeGrant(jwt: string): any {
  const payload = JSON.parse(
    Buffer.from(jwt.split(".")[1]!, "base64").toString("utf8"),
  );
  return payload.video ?? {};
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

async function main() {
  console.log("── Phase 6A: speaker 역할 ─────────────────");
  const host = await session("호스트6a");
  // guest 1슬롯 / speaker 1슬롯 으로 슬롯 분리를 강하게 검증.
  const room = await api("/rooms", {
    method: "POST",
    token: host.token,
    body: { title: "P6A", maxGuests: 1, maxSpeakers: 1, viewerMode: "webrtc" },
  });
  const roomId = room.json.id as string;
  assert(room.json.maxSpeakers === 1, "max_speakers 방 생성 반영", room.json);
  const invite = await api(`/rooms/${roomId}/invite`, {
    method: "POST",
    token: host.token,
  });
  const code = invite.json.code as string;

  const g1 = await session("게스트6a");
  const s1 = await session("스피커6a");
  const s2 = await session("스피커6a2");
  for (const u of [g1, s1, s2]) {
    await api(`/rooms/${roomId}/join-requests`, {
      method: "POST",
      token: u.token,
      body: { code },
    });
  }

  // guest 승인(guest 슬롯 1 소진).
  const ag = await api(`/rooms/${roomId}/guests/${g1.userId}/approve`, {
    method: "POST",
    token: host.token,
    body: { role: "guest" },
  });
  assert(ag.status === 200 && ag.json.role === "guest", "guest 승인", ag.json);

  // speaker 승인(guest 슬롯 가득해도 speaker 슬롯은 별개 → 성공).
  const as1 = await api(`/rooms/${roomId}/guests/${s1.userId}/approve`, {
    method: "POST",
    token: host.token,
    body: { role: "speaker" },
  });
  assert(
    as1.status === 200 && as1.json.role === "speaker",
    "guest 슬롯 가득해도 speaker 승인 성공(슬롯 분리)",
    as1.json,
  );

  // speaker 토큰 grant = 오디오 전용.
  const stok = await api(`/rooms/${roomId}/token`, {
    method: "POST",
    token: s1.token,
    body: { role: "speaker" },
  });
  const sgrant = decodeGrant(stok.json.token);
  assert(
    stok.status === 200 &&
      stok.json.role === "speaker" &&
      Array.isArray(sgrant.canPublishSources) &&
      sgrant.canPublishSources.length === 1 &&
      String(sgrant.canPublishSources[0]).toLowerCase().includes("microphone"),
    "speaker 토큰 grant = canPublishSources=[microphone]",
    sgrant,
  );
  // guest 토큰 grant = 소스 제한 없음.
  const gtok = await api(`/rooms/${roomId}/token`, {
    method: "POST",
    token: g1.token,
    body: { role: "guest" },
  });
  const ggrant = decodeGrant(gtok.json.token);
  assert(
    gtok.json.role === "guest" &&
      (ggrant.canPublishSources === undefined ||
        ggrant.canPublishSources.length === 0),
    "guest 토큰 grant = 소스 제한 없음",
    ggrant,
  );

  // speaker 슬롯 초과 → 409.
  const as2 = await api(`/rooms/${roomId}/guests/${s2.userId}/approve`, {
    method: "POST",
    token: host.token,
    body: { role: "speaker" },
  });
  assert(
    as2.status === 409 && as2.json.error === "max_speakers_reached",
    "speaker 슬롯 초과 → 409 max_speakers_reached",
    as2.json,
  );

  // 이미 approved(guest)에 role=speaker approve 재호출 → 409.
  const reApprove = await api(`/rooms/${roomId}/guests/${g1.userId}/approve`, {
    method: "POST",
    token: host.token,
    body: { role: "speaker" },
  });
  assert(
    reApprove.status === 409 && reApprove.json.error === "already_approved_other_role",
    "approved guest 에 다른 role approve → 409(전환 API 안내)",
    reApprove.json,
  );

  // ── role 전환(슬롯 상한도 전환에 적용) ──
  // s1 이 speaker 1슬롯 사용 중이므로 g1(guest)→speaker 는 max_speakers=1 초과로 409.
  const overSpk = await api(
    `/rooms/${roomId}/participants/${g1.userId}/role`,
    { method: "POST", token: host.token, body: { role: "speaker" } },
  );
  assert(
    overSpk.status === 409 && overSpk.json.error === "max_speakers_reached",
    "전환도 슬롯 상한 적용(guest→speaker 초과 → 409)",
    overSpk.json,
  );

  // s1(speaker) → guest. guest 슬롯(1)은 g1 이 사용 중 → 초과 409.
  const overGuest = await api(
    `/rooms/${roomId}/participants/${s1.userId}/role`,
    { method: "POST", token: host.token, body: { role: "guest" } },
  );
  assert(
    overGuest.status === 409 && overGuest.json.error === "max_guests_reached",
    "speaker→guest 도 guest 슬롯 초과 시 409",
    overGuest.json,
  );

  // 슬롯을 늘려 실제 전환을 검증할 별도 방.
  const room2 = (
    await api("/rooms", {
      method: "POST",
      token: host.token,
      body: { title: "P6A-2", maxGuests: 4, maxSpeakers: 4, viewerMode: "webrtc" },
    })
  ).json;
  const rid2 = room2.id as string;
  const inv2 = (await api(`/rooms/${rid2}/invite`, { method: "POST", token: host.token }))
    .json.code as string;
  const u = await session("전환대상6a");
  await api(`/rooms/${rid2}/join-requests`, {
    method: "POST",
    token: u.token,
    body: { code: inv2 },
  });
  await api(`/rooms/${rid2}/guests/${u.userId}/approve`, {
    method: "POST",
    token: host.token,
    body: { role: "guest" },
  });
  const b2 = await logCount2(rid2, u.userId);
  // guest → speaker
  const toSpk = await api(`/rooms/${rid2}/participants/${u.userId}/role`, {
    method: "POST",
    token: host.token,
    body: { role: "speaker" },
  });
  assert(
    toSpk.status === 200 && toSpk.json.role === "speaker" && toSpk.json.from === "guest",
    "guest→speaker 전환 성공",
    toSpk.json,
  );
  // 멱등: 동일 role 재요청 → no-op.
  const idem = await api(`/rooms/${rid2}/participants/${u.userId}/role`, {
    method: "POST",
    token: host.token,
    body: { role: "speaker" },
  });
  assert(idem.status === 200 && idem.json.idempotent === true, "동일 role 전환 → 멱등 no-op", idem.json);
  // speaker → guest
  const toGuest = await api(`/rooms/${rid2}/participants/${u.userId}/role`, {
    method: "POST",
    token: host.token,
    body: { role: "guest" },
  });
  assert(toGuest.status === 200 && toGuest.json.role === "guest", "speaker→guest 전환 성공", toGuest.json);
  assert(
    (await logCount2(rid2, u.userId)) - b2 >= 2,
    "role_change moderation_logs 2건+ 기록",
  );
  // 토큰이 DB role(guest) 대로 발급되는지.
  const utok = await api(`/rooms/${rid2}/token`, {
    method: "POST",
    token: u.token,
    body: { role: "guest" },
  });
  assert(utok.json.role === "guest", "전환 후 토큰이 DB role 대로 발급", utok.json);

  // 비승인 대상 전환 → 409.
  const viewer = await session("뷰어6a");
  await api(`/rooms/${rid2}/token`, { method: "POST", token: viewer.token, body: {} }); // viewer 등록
  const badRole = await api(`/rooms/${rid2}/participants/${viewer.userId}/role`, {
    method: "POST",
    token: host.token,
    body: { role: "speaker" },
  });
  assert(
    badRole.status === 409 && badRole.json.error === "not_approved_publisher",
    "비승인(viewer) 대상 전환 → 409",
    badRole.json,
  );

  // ── kicked speaker /token 403 + 재입장 role 유지 ──
  // s1(speaker) 강퇴 → kicked.
  await api(`/rooms/${roomId}/guests/${s1.userId}/kick`, {
    method: "POST",
    token: host.token,
  });
  const ktok = await api(`/rooms/${roomId}/token`, {
    method: "POST",
    token: s1.token,
    body: { role: "speaker" },
  });
  assert(ktok.status === 403, "kicked speaker /token → 403", ktok.status);

  // 재입장 role 유지: 별도 speaker 를 승인 → left 로 만든 뒤 재요청 → speaker 유지.
  const s3 = await session("재입장스피커");
  await api(`/rooms/${rid2}/join-requests`, {
    method: "POST",
    token: s3.token,
    body: { code: inv2 },
  });
  await api(`/rooms/${rid2}/guests/${s3.userId}/approve`, {
    method: "POST",
    token: host.token,
    body: { role: "speaker" },
  });
  // participant_left webhook 으로 left 상태 만들기.
  await postWebhook({
    event: "participant_left",
    room: { name: rid2 },
    participant: { identity: s3.userId },
    createdAt: Math.floor(Date.now() / 1000),
    id: "wh_left_s3",
  });
  const reenter = await api(`/rooms/${rid2}/join-requests`, {
    method: "POST",
    token: s3.token,
    body: { code: inv2 },
  });
  assert(
    reenter.json?.state === "approved" && reenter.json?.role === "speaker",
    "left speaker 재입장 → speaker role 유지 자동 재승인",
    reenter.json,
  );

  console.log("──────────────────────────────────────────");
  console.log(`통과 ${pass} / 실패 ${fail}`);
  await redis.quit();
  process.exit(fail === 0 ? 0 : 1);
}

async function logCount2(roomId: string, uid: string) {
  return (
    await db
      .select({ id: moderationLogs.id })
      .from(moderationLogs)
      .where(
        and(
          eq(moderationLogs.roomId, roomId),
          eq(moderationLogs.targetId, uid),
          eq(moderationLogs.action, "role_change"),
        ),
      )
  ).length;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

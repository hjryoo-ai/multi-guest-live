/**
 * Phase 2 서버 검증 — API 가 :4000 에서 실행 중이어야 함.
 *   실행: pnpm --filter @multi-live/api verify:phase2
 *
 * 커버리지:
 *   초대 발급/권한 · 승인 요청(유효/무효 코드) · 대기 큐 · 승인 게이트(pre/post) ·
 *   approve 멱등 · reject 후 403 유지 · 오디오 도달 리포트(누락 감지→ok)
 */
import { createHash, createHmac } from "node:crypto";
import { config } from "../src/config.js";

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

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

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

async function session(nickname: string) {
  const r = await api("/auth/session", { method: "POST", body: { nickname } });
  return { token: r.json.token as string, userId: r.json.userId as string };
}

async function main() {
  const host = await session("호스트2");
  const guest = await session("게스트2");

  const created = await api("/rooms", {
    method: "POST",
    token: host.token,
    body: { title: "Phase2 방", maxGuests: 8 },
  });
  const roomId: string = created.json.id;

  console.log("── 초대 ───────────────────────────────────");
  const invite = await api(`/rooms/${roomId}/invite`, {
    method: "POST",
    token: host.token,
  });
  assert(invite.status === 200 && !!invite.json?.code, "host 초대코드 발급", invite);
  const code: string = invite.json.code;

  const guestInvite = await api(`/rooms/${roomId}/invite`, {
    method: "POST",
    token: guest.token,
  });
  assert(guestInvite.status === 403, "비-host 초대 발급 시도 → 403");

  console.log("── 승인 요청 ──────────────────────────────");
  const badReq = await api(`/rooms/${roomId}/join-requests`, {
    method: "POST",
    token: guest.token,
    body: { code: "wrong-code" },
  });
  assert(
    badReq.status === 403 && badReq.json?.error === "invalid_invite",
    "잘못된 초대코드 요청 → 403 invalid_invite",
    badReq,
  );

  const req1 = await api(`/rooms/${roomId}/join-requests`, {
    method: "POST",
    token: guest.token,
    body: { code },
  });
  assert(
    req1.status === 201 && req1.json?.state === "requested",
    "유효 코드 승인 요청 → 201 requested",
    req1,
  );

  const queue = await api(`/rooms/${roomId}/join-requests`, {
    token: host.token,
  });
  assert(
    queue.json?.requests?.some((r: any) => r.userId === guest.userId),
    "host 대기 큐에 guest 포함",
    queue.json,
  );

  console.log("── 승인 게이트 ────────────────────────────");
  const preTok = await api(`/rooms/${roomId}/token`, {
    method: "POST",
    token: guest.token,
    body: { role: "guest" },
  });
  assert(preTok.status === 403, "승인 전 guest 토큰 요청 → 403", preTok);

  const approve = await api(`/rooms/${roomId}/guests/${guest.userId}/approve`, {
    method: "POST",
    token: host.token,
  });
  assert(approve.status === 200 && approve.json?.state === "approved", "승인 → 200", approve);

  const approve2 = await api(`/rooms/${roomId}/guests/${guest.userId}/approve`, {
    method: "POST",
    token: host.token,
  });
  assert(
    approve2.status === 200 && approve2.json?.idempotent === true,
    "approve 멱등(2회 호출 무해)",
    approve2,
  );

  const postTok = await api(`/rooms/${roomId}/token`, {
    method: "POST",
    token: guest.token,
    body: { role: "guest" },
  });
  assert(
    postTok.status === 200 && postTok.json?.role === "guest",
    "승인 후 guest 토큰 발급 → 200 role=guest",
    postTok,
  );

  console.log("── 오디오 도달 리포트 ─────────────────────");
  const ts = Math.floor(Date.now() / 1000);
  // host, guest 각각 오디오 트랙 publish (webhook)
  await postWebhook({
    event: "track_published",
    createdAt: ts,
    room: { name: roomId },
    participant: { identity: host.userId },
    track: { sid: "TR_host_audio", type: 0 },
  });
  await postWebhook({
    event: "track_published",
    createdAt: ts,
    room: { name: roomId },
    participant: { identity: guest.userId },
    track: { sid: "TR_guest_audio", type: 0 },
  });

  // guest 가 아무것도 구독 안 했다고 보고 → host 오디오 누락 감지
  const rep1 = await api(`/rooms/${roomId}/audio-report`, {
    method: "POST",
    token: guest.token,
    body: { subscribedAudioTrackSids: [] },
  });
  assert(
    rep1.json?.ok === false &&
      rep1.json?.missingTrackSids?.includes("TR_host_audio") &&
      !rep1.json?.missingTrackSids?.includes("TR_guest_audio"),
    "구독 누락 감지: host 오디오 missing, 자기 트랙 제외",
    rep1.json,
  );

  // guest 가 host 오디오를 구독 중이라 보고 → ok
  const rep2 = await api(`/rooms/${roomId}/audio-report`, {
    method: "POST",
    token: guest.token,
    body: { subscribedAudioTrackSids: ["TR_host_audio"] },
  });
  assert(
    rep2.json?.ok === true && rep2.json?.missingTrackSids?.length === 0,
    "전수 구독 시 ok=true",
    rep2.json,
  );

  console.log("── 거절 ───────────────────────────────────");
  const reject = await api(`/rooms/${roomId}/guests/${guest.userId}/reject`, {
    method: "POST",
    token: host.token,
  });
  assert(reject.status === 200, "reject → 200", reject);

  const afterReject = await api(`/rooms/${roomId}/token`, {
    method: "POST",
    token: guest.token,
    body: { role: "guest" },
  });
  assert(
    afterReject.status === 403,
    "reject 된 guest 의 guest 토큰 요청 → 403 유지",
    afterReject,
  );

  await api(`/rooms/${roomId}/end`, { method: "POST", token: host.token });

  console.log("──────────────────────────────────────────");
  console.log(`통과 ${pass} / 실패 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

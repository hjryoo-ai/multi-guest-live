/**
 * Phase 6B 서버 검증 — 채팅 운영. API 가 :4000 에서 실행 중이어야 함.
 *   실행: pnpm --filter @multi-live/api verify:phase6b
 *
 * hide/unhide(멱등·비host 403·타방 404) · ban(403 chat_banned, unban, host 자기차단 400) ·
 * GET /chat(일반 hidden 제외+hiddenIds 스냅샷 / host hidden 포함+플래그) · 로그·메트릭
 */
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
async function metricValue(name: string): Promise<number> {
  const res = await fetch(`${BASE}/metrics`);
  const text = await res.text();
  const m = text.match(new RegExp(`^${name}\\s+([0-9.e+-]+)$`, "m"));
  return m ? Number(m[1]) : 0;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("── Phase 6B: 채팅 운영 ─────────────────────");
  const host = await session("호스트6b");
  const viewer = await session("시청자6b");
  const other = await session("타인6b");
  const room = await api("/rooms", {
    method: "POST",
    token: host.token,
    body: { title: "P6B", maxGuests: 8, viewerMode: "webrtc" },
  });
  const roomId = room.json.id as string;
  // viewer/other 를 참가자로 등록(viewer 토큰).
  await api(`/rooms/${roomId}/token`, { method: "POST", token: viewer.token, body: {} });
  await api(`/rooms/${roomId}/token`, { method: "POST", token: other.token, body: {} });

  // viewer 메시지 전송.
  const m1 = await api(`/rooms/${roomId}/chat`, {
    method: "POST",
    token: viewer.token,
    body: { text: "숨길 메시지" },
  });
  const mid = m1.json.id as number;

  // ── hide/unhide ──
  const hidBefore = await metricValue("ml_chat_hidden_total");
  const badHide = await api(`/rooms/${roomId}/chat/${mid}/hide`, {
    method: "POST",
    token: viewer.token,
  });
  assert(badHide.status === 403, "비-host 숨김 → 403", badHide.status);

  const hide = await api(`/rooms/${roomId}/chat/${mid}/hide`, {
    method: "POST",
    token: host.token,
  });
  assert(hide.status === 200 && hide.json.hidden === true, "host 숨김 → 200", hide.json);
  const hideIdem = await api(`/rooms/${roomId}/chat/${mid}/hide`, {
    method: "POST",
    token: host.token,
  });
  assert(hideIdem.status === 200, "숨김 멱등", hideIdem.status);
  assert(
    (await metricValue("ml_chat_hidden_total")) > hidBefore,
    "ml_chat_hidden_total 증가",
  );

  // 타 방 메시지 id → 404.
  const room2 = await api("/rooms", {
    method: "POST",
    token: host.token,
    body: { title: "P6B-2", maxGuests: 8, viewerMode: "webrtc" },
  });
  const wrongRoom = await api(`/rooms/${room2.json.id}/chat/${mid}/hide`, {
    method: "POST",
    token: host.token,
  });
  assert(wrongRoom.status === 404, "타 방 메시지 숨김 → 404", wrongRoom.status);

  // 일반(viewer) GET: hidden 제외 + hiddenIds 스냅샷 포함.
  const asViewer = await api(`/rooms/${roomId}/chat`, { token: viewer.token });
  assert(
    !asViewer.json.messages.some((m: any) => m.id === mid),
    "일반 GET: 숨김 메시지는 messages 에서 제외",
  );
  assert(
    Array.isArray(asViewer.json.hiddenIds) &&
      asViewer.json.hiddenIds.includes(mid) &&
      typeof asViewer.json.cursor === "number",
    "일반 GET: hiddenIds 스냅샷 + cursor 포함",
    { hiddenIds: asViewer.json.hiddenIds, cursor: asViewer.json.cursor },
  );
  // host GET: hidden 포함 + 플래그.
  const asHost = await api(`/rooms/${roomId}/chat`, { token: host.token });
  const hm = asHost.json.messages.find((m: any) => m.id === mid);
  assert(!!hm && hm.hidden === true, "host GET: 숨김 메시지 포함 + hidden 플래그", hm);

  // unhide → 일반 GET 복원.
  const unBefore = await metricValue("ml_chat_unhidden_total");
  const unhide = await api(`/rooms/${roomId}/chat/${mid}/unhide`, {
    method: "POST",
    token: host.token,
  });
  assert(unhide.status === 200 && unhide.json.hidden === false, "host 해제 → 200", unhide.json);
  assert(
    (await metricValue("ml_chat_unhidden_total")) > unBefore,
    "ml_chat_unhidden_total 증가",
  );
  const afterUnhide = await api(`/rooms/${roomId}/chat`, { token: viewer.token });
  assert(
    afterUnhide.json.messages.some((m: any) => m.id === mid) &&
      !afterUnhide.json.hiddenIds.includes(mid),
    "해제 후 일반 GET 복원 + hiddenIds 에서 제거",
  );

  // ── ban ──
  const banBefore = await metricValue("ml_chat_bans_total");
  const rejBefore = await metricValue("ml_chat_banned_rejected_total");
  // host 자기차단 → 400.
  const selfBan = await api(`/rooms/${roomId}/chat-bans/${host.userId}`, {
    method: "POST",
    token: host.token,
  });
  assert(selfBan.status === 400 && selfBan.json.error === "cannot_ban_host", "host 자기차단 → 400", selfBan.json);

  // 비-host ban → 403.
  const badBan = await api(`/rooms/${roomId}/chat-bans/${other.userId}`, {
    method: "POST",
    token: viewer.token,
  });
  assert(badBan.status === 403, "비-host 차단 → 403", badBan.status);

  const ban = await api(`/rooms/${roomId}/chat-bans/${viewer.userId}`, {
    method: "POST",
    token: host.token,
  });
  assert(ban.status === 200 && ban.json.chatBanned === true, "host 차단 → 200", ban.json);
  assert(
    (await metricValue("ml_chat_bans_total")) > banBefore,
    "ml_chat_bans_total 증가",
  );

  // 차단 유저 첫 메시지 → 403 chat_banned(rate limit 이전 평가).
  await sleep(1100); // 이전 rate 창 회피(429 가능성 제거 → 순수 ban 판정 확인)
  const blocked = await api(`/rooms/${roomId}/chat`, {
    method: "POST",
    token: viewer.token,
    body: { text: "차단된 상태" },
  });
  assert(
    blocked.status === 403 && blocked.json.error === "chat_banned",
    "차단 유저 채팅 → 403 chat_banned(rate limit 이전)",
    blocked.json,
  );
  assert(
    (await metricValue("ml_chat_banned_rejected_total")) > rejBefore,
    "ml_chat_banned_rejected_total 증가",
  );

  // unban → 정상.
  const unban = await api(`/rooms/${roomId}/chat-bans/${viewer.userId}`, {
    method: "DELETE",
    token: host.token,
  });
  assert(unban.status === 200 && unban.json.chatBanned === false, "host 차단 해제 → 200", unban.json);
  await sleep(1100);
  const ok = await api(`/rooms/${roomId}/chat`, {
    method: "POST",
    token: viewer.token,
    body: { text: "해제 후 정상" },
  });
  assert(ok.status === 201, "차단 해제 후 채팅 정상(201)", ok.status);

  console.log("──────────────────────────────────────────");
  console.log(`통과 ${pass} / 실패 ${fail}`);
  await redis.quit();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

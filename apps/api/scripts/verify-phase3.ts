/**
 * Phase 3 서버 검증 — API 가 :4000 에서 실행 중이어야 함.
 *   실행: pnpm --filter @multi-live/api verify:phase3
 *
 * Part A (HTTP): 강퇴→토큰 403 → 재요청/재승인 · mute/kick 권한 · host 전용 alerts
 * Part B (서비스 직접): 오디오 경고 lazy 평가(제어된 타임스탬프로 30초 임계 검증)
 */
import { config } from "../src/config.js";
import {
  addPublishedAudioTrack,
  removePublishedAudioTrack,
} from "../src/services/roomState.js";
import { checkAudioReach, getAudioAlerts } from "../src/services/audioReach.js";
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

async function partA() {
  console.log("── Part A: 강퇴/운영 (HTTP) ───────────────");
  const host = await session("호스트3");
  const guest = await session("게스트3");
  const room = await api("/rooms", {
    method: "POST",
    token: host.token,
    body: { title: "Phase3", maxGuests: 8 },
  });
  const roomId = room.json.id as string;
  const invite = await api(`/rooms/${roomId}/invite`, {
    method: "POST",
    token: host.token,
  });
  const code = invite.json.code as string;

  await api(`/rooms/${roomId}/join-requests`, {
    method: "POST",
    token: guest.token,
    body: { code },
  });
  await api(`/rooms/${roomId}/guests/${guest.userId}/approve`, {
    method: "POST",
    token: host.token,
  });

  // 비-host mute/kick → 403
  const badMute = await api(`/rooms/${roomId}/guests/${guest.userId}/mute`, {
    method: "POST",
    token: guest.token,
  });
  assert(badMute.status === 403, "비-host mute 시도 → 403");
  // host mute 대상 미접속 → graceful 404
  const mute = await api(`/rooms/${roomId}/guests/${guest.userId}/mute`, {
    method: "POST",
    token: host.token,
  });
  assert(
    mute.status === 404 && mute.json?.error === "participant_not_connected",
    "미접속 참가자 mute → 404 graceful",
    mute,
  );

  // host 자신 kick → 409
  const kickHost = await api(`/rooms/${roomId}/guests/${host.userId}/kick`, {
    method: "POST",
    token: host.token,
  });
  assert(kickHost.status === 409, "host 자신 강퇴 시도 → 409");

  // guest 강퇴 → 200
  const kick = await api(`/rooms/${roomId}/guests/${guest.userId}/kick`, {
    method: "POST",
    token: host.token,
  });
  assert(kick.status === 200 && kick.json?.state === "kicked", "guest 강퇴 → 200");

  // 강퇴된 user 의 토큰 요청(모든 role) → 403 kicked
  const kickedGuestTok = await api(`/rooms/${roomId}/token`, {
    method: "POST",
    token: guest.token,
    body: { role: "guest" },
  });
  assert(
    kickedGuestTok.status === 403,
    "강퇴 user 의 guest 토큰 요청 → 403",
    kickedGuestTok,
  );
  const kickedViewerTok = await api(`/rooms/${roomId}/token`, {
    method: "POST",
    token: guest.token,
    body: {},
  });
  assert(
    kickedViewerTok.status === 403 && kickedViewerTok.json?.error === "kicked",
    "강퇴 user 의 viewer 토큰 요청도 → 403 kicked",
    kickedViewerTok,
  );

  // 재요청 → 재승인 경로 복구
  const reReq = await api(`/rooms/${roomId}/join-requests`, {
    method: "POST",
    token: guest.token,
    body: { code },
  });
  assert(
    reReq.status === 201 && reReq.json?.state === "requested",
    "강퇴 후 재요청 → 201 requested(복구 가능)",
    reReq,
  );
  const reApprove = await api(
    `/rooms/${roomId}/guests/${guest.userId}/approve`,
    { method: "POST", token: host.token },
  );
  assert(reApprove.status === 200, "재승인 → 200");
  const reTok = await api(`/rooms/${roomId}/token`, {
    method: "POST",
    token: guest.token,
    body: { role: "guest" },
  });
  assert(reTok.status === 200 && reTok.json?.role === "guest", "재승인 후 guest 토큰 → 200");

  // alerts 는 host 전용
  const badAlerts = await api(`/rooms/${roomId}/alerts`, { token: guest.token });
  assert(badAlerts.status === 403, "비-host alerts 조회 → 403");
  const alerts = await api(`/rooms/${roomId}/alerts`, { token: host.token });
  assert(alerts.status === 200 && Array.isArray(alerts.json?.alerts), "host alerts 조회 → 200");

  await api(`/rooms/${roomId}/end`, { method: "POST", token: host.token });
}

async function partB() {
  console.log("── Part B: 오디오 경고 lazy 평가 ──────────");
  const rid = "verify3-alerts-room";
  // 기준선 청소
  await redis.del(
    `room:${rid}:published_audio`,
    `room:${rid}:audio_owner`,
    `room:${rid}:audio_alerts`,
    `room:${rid}:audio_last_report`,
    `room:${rid}:present`,
  );
  await addPublishedAudioTrack(rid, "hostX", "TR_hostX");
  await addPublishedAudioTrack(rid, "guestX", "TR_guestX");

  const t0 = 1_000_000_000_000;
  // guestX 가 아무것도 구독 안 함 → TR_hostX 누락, firstMissingAt=t0
  const missing = await checkAudioReach(rid, "guestX", [], t0);
  assert(
    missing.includes("TR_hostX") && !missing.includes("TR_guestX"),
    "누락 감지(자기 트랙 제외)",
    missing,
  );

  const early = await getAudioAlerts(rid, ["guestX"], () => "g", t0 + 10_000);
  assert(
    early.filter((a) => a.kind === "missing_subscription").length === 0,
    "30초 이전에는 경고 없음(lazy)",
    early,
  );

  const late = await getAudioAlerts(rid, ["guestX"], () => "g", t0 + 31_000);
  assert(
    late.some(
      (a) => a.kind === "missing_subscription" && a.trackSid === "TR_hostX",
    ),
    "30초 경과 시 missing_subscription 경고 노출",
    late,
  );
  assert(
    late.some((a) => a.kind === "stale_report" && a.participantId === "guestX"),
    "30초+ 무보고 → stale_report 경고",
    late,
  );

  // guestX 가 이제 구독 보고 → 경고 해제 + lastReport 갱신
  await checkAudioReach(rid, "guestX", ["TR_hostX"], t0 + 32_000);
  const resolved = await getAudioAlerts(rid, ["guestX"], () => "g", t0 + 33_000);
  assert(
    resolved.filter((a) => a.kind === "missing_subscription").length === 0,
    "재구독 보고 후 missing_subscription 해제",
    resolved,
  );
  assert(
    resolved.filter((a) => a.kind === "stale_report").length === 0,
    "보고 갱신 후 stale_report 해제",
    resolved,
  );

  // track_unpublished 시 관련 경고 정리 확인
  await checkAudioReach(rid, "guestX", [], t0 + 40_000); // 다시 누락 기록
  await removePublishedAudioTrack(rid, "TR_hostX"); // 트랙 언퍼블리시 → 경고 정리
  const afterUnpub = await getAudioAlerts(rid, ["guestX"], () => "g", t0 + 80_000);
  assert(
    afterUnpub.filter((a) => a.kind === "missing_subscription").length === 0,
    "track_unpublished 시 관련 경고 정리",
    afterUnpub,
  );

  await redis.del(
    `room:${rid}:published_audio`,
    `room:${rid}:audio_owner`,
    `room:${rid}:audio_alerts`,
    `room:${rid}:audio_last_report`,
    `room:${rid}:present`,
  );
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

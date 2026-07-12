/**
 * Phase 6.5 Track A(보안) 서버 검증 — API 가 :4000 에서 실행 중이어야 함.
 *   실행: pnpm --filter @multi-live/api verify:phase65a
 *
 * A-2 입력검증(UUID param · 제어문자 · 리포트 신원) · A-3 rate limit(429) ·
 * A-4 웹계층(HLS traversal · helmet · body limit · CORS) · C-3 부트 fail-fast.
 * (A-1 위조 신호 차단은 브라우저 필요 → e2e phase65a.spec.ts)
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  opts: { method?: string; token?: string; body?: unknown; raw?: string } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined || opts.raw !== undefined)
    headers["content-type"] = "application/json";
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body:
      opts.raw !== undefined
        ? opts.raw
        : opts.body !== undefined
          ? JSON.stringify(opts.body)
          : undefined,
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

async function partInput() {
  console.log("── A-2 입력 검증 ─────────────────────────────");
  // UUID 아닌 :id → 400 invalid_id (param preValidation 훅).
  const badId = await api("/rooms/not-a-uuid");
  assert(
    badId.status === 400 && badId.json?.error === "invalid_id",
    ":id 가 UUID 아니면 400 invalid_id",
    badId.json,
  );
  // 정상 UUID(미존재) 는 훅 통과 → 404 room_not_found.
  const okId = await api("/rooms/00000000-0000-4000-8000-000000000000");
  assert(
    okId.status === 404 && okId.json?.error === "room_not_found",
    "UUID 형식이면 훅 통과(→404 room_not_found)",
    okId.json,
  );
  // 제어문자 닉네임 → 400.
  const ctrlNick = await api("/auth/session", {
    method: "POST",
    body: { nickname: "a\nb" },
  });
  assert(ctrlNick.status === 400, "제어문자 닉네임 → 400", ctrlNick.json);
  // 제어문자 방 제목 → 400.
  const host = await session("보안호스트");
  const ctrlTitle = await api("/rooms", {
    method: "POST",
    token: host.token,
    body: { title: "제목경보", maxGuests: 4 },
  });
  assert(ctrlTitle.status === 400, "제어문자 방 제목 → 400", ctrlTitle.json);
  // 정상 제목(대시 포함) 은 통과 — 회귀 방어("P4-A" 류).
  const okTitle = await api("/rooms", {
    method: "POST",
    token: host.token,
    body: { title: "P4-A 정상", maxGuests: 4 },
  });
  assert(okTitle.status === 201, "대시·공백 포함 정상 제목 → 201", okTitle.json);
  const roomId = okTitle.json.id as string;

  // A-2-2: audio-report 는 body identity 를 신뢰하지 않음(스키마에 identity 필드 없음).
  //   위조 identity 를 넣어도 무시되고 토큰 사용자 기준으로 처리 → 200.
  await api(`/rooms/${roomId}/token`, {
    method: "POST",
    token: host.token,
    body: { role: "host" },
  });
  const rep = await api(`/rooms/${roomId}/audio-report`, {
    method: "POST",
    token: host.token,
    body: { subscribedAudioTrackSids: [], participantIdentity: "victim-uuid" },
  });
  assert(
    rep.status === 200,
    "audio-report body 의 위조 identity 무시(토큰 사용자 기준) → 200",
    rep.json,
  );
  return { host, roomId };
}

async function partRateLimit(host: {
  token: string;
  userId: string;
}, roomId: string) {
  console.log("── A-3 rate limit ────────────────────────────");
  const invite = await api(`/rooms/${roomId}/invite`, {
    method: "POST",
    token: host.token,
  });
  const code = invite.json.code as string;
  // join-requests 유저당 10/분 → 한 유저가 12회 연타 시 429 발생.
  const attacker = await session("스팸유저");
  let got429 = 0;
  for (let i = 0; i < 13; i++) {
    const r = await api(`/rooms/${roomId}/join-requests`, {
      method: "POST",
      token: attacker.token,
      body: { code },
    });
    if (r.status === 429) got429++;
  }
  assert(
    got429 > 0,
    `join-requests 유저당 10/분 초과 → 429 (관측 429=${got429})`,
    got429,
  );
  // E2E 안전성의 핵심: 키가 user 기준이라 서로 다른 유저는 같은 IP(로컬)여도 합산되지 않는다.
  //   userA 8회 + userB 8회 = 16회(>10) 지만 각자 상한(10) 미만 → 429 없음.
  const uA = await session("무해유저A");
  const uB = await session("무해유저B");
  let aggregated429 = 0;
  for (let i = 0; i < 8; i++) {
    const ra = await api(`/rooms/${roomId}/join-requests`, {
      method: "POST",
      token: uA.token,
      body: { code },
    });
    const rb = await api(`/rooms/${roomId}/join-requests`, {
      method: "POST",
      token: uB.token,
      body: { code },
    });
    if (ra.status === 429) aggregated429++;
    if (rb.status === 429) aggregated429++;
  }
  assert(
    aggregated429 === 0,
    "서로 다른 유저는 같은 IP 여도 rate limit 합산 안 됨(per-user 키 · E2E 무간섭)",
    aggregated429,
  );
  // invite 미인증(/auth/session)은 loopback 예외로 로컬에서 429 안 뜸(설계) — 프로덕션 활성.
}

async function partWeb(roomId: string) {
  console.log("── A-4 웹 계층 ───────────────────────────────");
  // HLS traversal / 비UUID → 400 invalid_hls_path.
  const trav = await api("/hls/..%2f..%2fetc%2fpasswd");
  assert(
    trav.status === 400 && trav.json?.error === "invalid_hls_path",
    "HLS traversal 시도 → 400 invalid_hls_path",
    trav.json,
  );
  const nonUuid = await api("/hls/notauuid/index.m3u8");
  assert(
    nonUuid.status === 400 && nonUuid.json?.error === "invalid_hls_path",
    "HLS 비UUID roomId → 400",
    nonUuid.json,
  );
  // 정상 UUID 는 격리 훅 통과(파일 없으면 404, 400 아님).
  const okUuid = await api(`/hls/${roomId}/index.m3u8`);
  assert(
    okUuid.status !== 400,
    "정상 UUID roomId 는 격리 훅 통과(400 아님)",
    okUuid.status,
  );
  // A-4-3: helmet 기본 보안 헤더.
  const h = await api("/health");
  assert(
    h.headers.get("x-content-type-options") === "nosniff",
    "helmet: x-content-type-options=nosniff",
    h.headers.get("x-content-type-options"),
  );
  // A-4-4: body 상한(1MB) 초과 → 413.
  const big = "x".repeat(1_100_000);
  const tooBig = await api("/auth/session", {
    method: "POST",
    raw: JSON.stringify({ nickname: big }),
  });
  assert(tooBig.status === 413, "1MB 초과 body → 413", tooBig.status);
}

function runBoot(env: Record<string, string>): Promise<{
  code: number;
  out: string;
}> {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const apiDir = path.resolve(__dirname, "..");
  return new Promise((resolve) => {
    const child = spawn("pnpm", ["exec", "tsx", "scripts/_bootcheck.ts"], {
      cwd: apiDir,
      env: { ...process.env, ...env },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
}

async function partBoot() {
  console.log("── C-3 부트 fail-fast ────────────────────────");
  // 유효한 프로덕션 기준 env — Cloud 주소(TLS·비로컬)까지 명시(§7-lite 1-2).
  const prodBase = {
    NODE_ENV: "production",
    AUTH_SECRET: "x".repeat(40),
    LIVEKIT_API_SECRET: "y".repeat(40),
    LIVEKIT_API_KEY: "prodkey",
    CORS_ORIGINS: "https://app.example.com",
    LIVEKIT_URL: "https://demo.livekit.cloud",
    NEXT_PUBLIC_LIVEKIT_URL: "wss://demo.livekit.cloud",
    NEXT_PUBLIC_API_URL: "https://api.example.com",
  } as const;

  // 프로덕션 + 약한 시크릿 → 부트 실패(exit≠0) + 원인 출력.
  const weak = await runBoot({
    ...prodBase,
    AUTH_SECRET: "devkey",
    LIVEKIT_API_SECRET: "devsecret_change_me_0123456789abcdef",
  });
  assert(
    weak.code !== 0 && /환경변수 검증 실패|AUTH_SECRET/.test(weak.out),
    "프로덕션 약한 시크릿 → 부트 실패(exit≠0)",
    weak.out.slice(0, 200),
  );
  // 프로덕션 + CORS '*' → 부트 실패.
  const star = await runBoot({ ...prodBase, CORS_ORIGINS: "*" });
  assert(
    star.code !== 0 && /CORS_ORIGINS/.test(star.out),
    "프로덕션 CORS '*' → 부트 실패",
    star.out.slice(0, 200),
  );
  // §7-lite 1-2: 프로덕션 + self-host/dev LiveKit 주소 → 부트 실패(은연중 self-host 차단).
  const wsUrl = await runBoot({
    ...prodBase,
    NEXT_PUBLIC_LIVEKIT_URL: "ws://livekit.example.com:7880",
  });
  assert(
    wsUrl.code !== 0 && /NEXT_PUBLIC_LIVEKIT_URL/.test(wsUrl.out),
    "프로덕션 ws://(비TLS) LiveKit URL → 부트 실패",
    wsUrl.out.slice(0, 200),
  );
  const lkLocal = await runBoot({
    ...prodBase,
    LIVEKIT_URL: "http://localhost:7880",
  });
  assert(
    lkLocal.code !== 0 && /LIVEKIT_URL/.test(lkLocal.out),
    "프로덕션 localhost LiveKit URL → 부트 실패",
    lkLocal.out.slice(0, 200),
  );
  const apiMissing = await runBoot({ ...prodBase, NEXT_PUBLIC_API_URL: "" });
  assert(
    apiMissing.code !== 0 && /NEXT_PUBLIC_API_URL/.test(apiMissing.out),
    "프로덕션 공개 API URL 미설정 → 부트 실패",
    apiMissing.out.slice(0, 200),
  );
  // 프로덕션 + 강한 시크릿 + 명시 CORS + Cloud(TLS) 주소 → 부트 성공.
  const strong = await runBoot({ ...prodBase });
  assert(
    strong.code === 0 && /BOOT_OK true/.test(strong.out),
    "프로덕션 강한 시크릿 + CORS + Cloud(TLS) 주소 → 부트 성공",
    strong.out.slice(0, 200),
  );
}

async function main() {
  const { host, roomId } = await partInput();
  await partRateLimit(host, roomId);
  await partWeb(roomId);
  await partBoot();
  console.log("──────────────────────────────────────────");
  console.log(`통과 ${pass} / 실패 ${fail}`);
  await redis.quit();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

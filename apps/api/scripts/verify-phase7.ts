/**
 * Phase 7-lite §1-1 검증 — 리버스 프록시 신뢰(TRUST_PROXY)와 rate limit IP 키.
 *   실행: pnpm --filter @multi-live/api verify:phase7
 *   전제: redis/postgres 가 실행 중이어야 함(스크립트가 서버 인스턴스를 직접 spawn).
 *
 * 격리 방식 — 라이브 :4000(공유 dev 서버)이 아니라 서로 다른 trustProxy 설정의
 * 서버를 별도 포트에 spawn 해 매트릭스 "양쪽"을 검증한다:
 *   A) TRUST_PROXY=1 (프록시 뒤): 오른쪽 1홉만 신뢰 → leftmost XFF 위조 무력화 + IP 버킷 분리.
 *   B) TRUST_PROXY 미설정(false) · production: XFF 완전 무시(직결) + 프로덕션 loopback 비예외.
 * (B 는 "누군가 기본값을 true 로 되돌리는 회귀"를 잡는 가드이기도 하다.)
 *
 * 배경(보안): 이전 index.ts 는 trustProxy:true 하드코딩 → leftmost XFF 를 취해
 *   클라이언트가 IP 를 위조 → 6.5 A-3 의 IP 키 rate limit(/auth/session·초대코드 무차별
 *   대입 방어)이 헤더 한 줄로 우회 가능했다. 이 스크립트가 수정을 회귀 가드로 고정한다.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(__dirname, "..");

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

interface Server {
  base: string;
  stop: () => void;
}

/** 실제 API 를 별도 포트에 spawn(env 오버라이드) 후 /health 200 까지 대기. */
async function spawnServer(
  label: string,
  port: number,
  extraEnv: Record<string, string>,
): Promise<Server> {
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
      throw new Error(`[${label}] 서버가 부팅 중 종료(exit=${exited})\n${logbuf}`);
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return { base, stop: () => void child.kill("SIGKILL") };
    } catch {
      /* 아직 미기동 */
    }
    await sleep(250);
  }
  child.kill("SIGKILL");
  throw new Error(`[${label}] /health 대기 타임아웃(20s)\n${logbuf}`);
}

/** /auth/session(limitPerIp(10)) 1회 호출 → 상태코드. */
async function hit(base: string, xff?: string): Promise<number> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (xff) headers["x-forwarded-for"] = xff;
  const res = await fetch(`${base}/auth/session`, {
    method: "POST",
    headers,
    body: JSON.stringify({ nickname: "프록시검증" }),
  });
  return res.status;
}
async function hitN(base: string, n: number, xff?: string): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(await hit(base, xff));
  return out;
}
const c429 = (arr: number[]) => arr.filter((s) => s === 429).length;

async function main() {
  // 런마다 다른 IP 네임스페이스(로컬 재실행 시 redis 잔여 카운터 회피). 60s TTL.
  const t = (Date.now() % 250) + 1;
  const A = {
    fill: `198.51.${t}.11`,
    sep: `198.51.${t}.22`,
    spoof: `198.51.${t}.33`,
    ctl: `198.51.${t}.44`,
  };
  const B = { x1: `203.0.${t}.51`, x2: `203.0.${t}.52` };

  let a: Server | null = null;
  let b: Server | null = null;
  try {
    // ── A) TRUST_PROXY=1 — XFF 오른쪽 1홉만 신뢰 ──────────────
    console.log("── A) TRUST_PROXY=1 (프록시 1홉 뒤) ───────────");
    a = await spawnServer("trust=1", 4071, {
      TRUST_PROXY: "1",
      NODE_ENV: "development",
    });

    const fill = await hitN(a.base, 12, A.fill);
    assert(fill[0] === 200, "새 XFF IP 첫 요청 통과(200)", fill[0]);
    assert(c429(fill) >= 1, `IP당 10/분 초과 → 429 (429=${c429(fill)})`, fill);

    const sep = await hitN(a.base, 5, A.sep);
    assert(c429(sep) === 0, "다른 XFF IP 는 독립 버킷(429 없음 · 버킷 분리)", sep);

    // 같은 rightmost, 다른 leftmost 12회 → 한 버킷(위조 leftmost 무시)
    const spoofL = await hitN(a.base, 6, `1.2.3.4, ${A.spoof}`);
    const spoofR = await hitN(a.base, 6, `9.9.9.9, ${A.spoof}`);
    assert(
      c429([...spoofL, ...spoofR]) >= 1,
      "leftmost 주입값이 달라도 같은 rightmost=한 버킷(위조 XFF 무력화) → 429",
      { spoofL, spoofR },
    );
    const ctl = await hit(a.base, `5.5.5.5, ${A.ctl}`);
    assert(ctl !== 429, "다른 rightmost(신규 IP)는 신선한 버킷 → 통과", ctl);

    // ── B) TRUST_PROXY 미설정(false) · production ────────────
    console.log("── B) TRUST_PROXY 미설정 · production ──────────");
    b = await spawnServer("trust=off/prod", 4072, {
      NODE_ENV: "production",
      AUTH_SECRET: "x".repeat(40),
      LIVEKIT_API_SECRET: "y".repeat(40),
      LIVEKIT_API_KEY: "prodkey",
      CORS_ORIGINS: "https://app.example.com",
      // §7-lite 1-2: 프로덕션 부트는 self-host/dev URL 을 거부하므로 Cloud(TLS) 주소 명시.
      LIVEKIT_URL: "https://demo.livekit.cloud",
      NEXT_PUBLIC_LIVEKIT_URL: "wss://demo.livekit.cloud",
      NEXT_PUBLIC_API_URL: "https://api.example.com",
      TRUST_PROXY: "", // 명시적 미신뢰(직결)
    });

    // 서로 다른 XFF 12회 → trust=false 라 전부 소켓(loopback) 한 버킷으로 합산.
    //   429 관측 ⟹ (b) XFF 완전 무시 + ② production 은 loopback 을 예외하지 않음.
    //   (XFF 를 신뢰했다면 6+6 두 버킷 <10 → 429 없음. loopback 을 예외했다면 429 없음.)
    const bx1 = await hitN(b.base, 6, B.x1);
    const bx2 = await hitN(b.base, 6, B.x2);
    assert(
      c429([...bx1, ...bx2]) >= 1,
      "trust=off/prod: 다른 XFF 12회가 소켓(loopback) 한 버킷으로 합산 → 429 (XFF 무시 + prod loopback 비예외)",
      { bx1, bx2 },
    );
  } finally {
    a?.stop();
    b?.stop();
  }

  console.log("──────────────────────────────────────────");
  console.log(`통과 ${pass} / 실패 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

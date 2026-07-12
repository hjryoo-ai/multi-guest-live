/**
 * Phase 6.5 Track C(안정성·운영) 서버 검증.
 *   실행: pnpm --filter @multi-live/api verify:phase65c
 *
 * C-4-2 /health/ready(livekit 포함) · C-2 에러 응답 단일 flat 스키마 ·
 * C-1 graceful shutdown(SIGTERM → 무중단 drain + exit 0 + 이후 접속 거부).
 * (C-3 부트 fail-fast 는 verify-phase65a 에서 검증.)
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api(p: string, opts: { method?: string; token?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  const res = await fetch(`${BASE}${p}`, {
    method: opts.method ?? "GET",
    headers,
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

async function partHealth() {
  console.log("── C-4-2 /health/ready (db·redis·livekit) ────");
  const r = await api("/health/ready");
  assert(
    r.status === 200 && r.json?.status === "ready",
    "/health/ready → 200 ready",
    r.json,
  );
  assert(
    r.json?.checks?.livekit === "ok" &&
      r.json?.checks?.db === "ok" &&
      r.json?.checks?.redis === "ok",
    "checks 에 db·redis·livekit 모두 ok",
    r.json?.checks,
  );
}

async function partErrorShape() {
  console.log("── C-2 에러 응답 단일 flat 스키마 ────────────");
  const cases: Array<{ p: string; method?: string; code: number; err: string }> =
    [
      {
        p: "/rooms/00000000-0000-4000-8000-000000000000",
        code: 404,
        err: "room_not_found",
      },
      { p: "/rooms/not-a-uuid", code: 400, err: "invalid_id" },
      { p: "/rooms", method: "POST", code: 401, err: "unauthorized" },
    ];
  for (const c of cases) {
    const r = await api(c.p, { method: c.method });
    assert(
      r.status === c.code &&
        typeof r.json?.error === "string" &&
        r.json.error === c.err,
      `${c.method ?? "GET"} ${c.p} → ${c.code} {error:"${c.err}"} (flat)`,
      r.json,
    );
  }
}

function spawnApi(port: string) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const apiDir = path.resolve(__dirname, "..");
  // node 를 tsx 로더로 직접 실행 → child 가 곧 앱 프로세스라 SIGTERM 이 핸들러에 도달한다
  //   (pnpm/tsx CLI 래퍼로 감싸면 시그널이 앱 프로세스까지 전달되지 않아 exit code 가 왜곡됨).
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/index.ts"],
    { cwd: apiDir, env: { ...process.env, API_PORT: port } },
  );
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  return { child, getErr: () => stderr };
}

async function partShutdown() {
  console.log("── C-1 graceful shutdown ─────────────────────");
  const port = "4111";
  const { child, getErr } = spawnApi(port);
  const base = `http://localhost:${port}`;
  // 기동 대기.
  let up = false;
  for (let i = 0; i < 40; i++) {
    try {
      const h = await fetch(`${base}/health`);
      if (h.ok) {
        up = true;
        break;
      }
    } catch {
      /* not yet */
    }
    await sleep(500);
  }
  assert(up, "4111 인스턴스 기동");
  if (!up) {
    child.kill("SIGKILL");
    return;
  }

  // 진행 중 요청을 띄운 직후 SIGTERM → drain 되어 5xx 없이 완료되는지.
  const inflight = fetch(`${base}/health/ready`).then(
    (r) => r.status,
    () => -1, // 연결 거부/리셋(정상 — LB 재시도 대상, 5xx 크래시 아님)
  );
  await sleep(100); // 연결 수립 여유
  const exited = new Promise<number>((resolve) =>
    child.on("exit", (code) => resolve(code ?? -1)),
  );
  child.kill("SIGTERM");

  const inflightStatus = await inflight;
  // 불변식: 종료 중 요청은 완료(200)·degraded(503)·정상 거부(-1) 중 하나 — 5xx 크래시는 없어야 함.
  assert(
    [200, 503, -1].includes(inflightStatus),
    "SIGTERM 중 요청에 5xx 크래시 없음(drain 완료 또는 정상 거부)",
    inflightStatus,
  );

  const code = await Promise.race([
    exited,
    sleep(12_000).then(() => -99),
  ]);
  assert(code === 0, "SIGTERM → exit code 0 (정상 종료)", {
    code,
    err: getErr().slice(-300),
  });
  if (code === -99) child.kill("SIGKILL");

  // 종료 후 접속 거부(리스너 닫힘).
  await sleep(300);
  let refused = false;
  try {
    await fetch(`${base}/health`);
  } catch {
    refused = true;
  }
  assert(refused, "종료 후 신규 요청 접속 거부(리스너 닫힘)");
}

async function main() {
  await partHealth();
  await partErrorShape();
  await partShutdown();
  console.log("──────────────────────────────────────────");
  console.log(`통과 ${pass} / 실패 ${fail}`);
  await redis.quit();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

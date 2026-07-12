/**
 * Phase 7-lite 검증 — LiveKit 업스트림 호출 타임아웃(chore/livekit-timeouts).
 *   실행: pnpm --filter @multi-live/api verify:phase7timeout
 *   전제: 없음 — 인프라(redis/pg/livekit) 불필요한 순수 in-process 검증.
 *
 * 확인 항목:
 *   1. 상한 초과 프라미스 → LivekitTimeoutError(code=livekit_timeout, statusCode=504) 로 reject.
 *   2. 상한 이내 프라미스 → 값 그대로 통과(정상 경로 오탐 없음).
 *   3. 넉넉한 상한에서 지연(그러나 상한 이내) 프라미스 → 통과(느린 CI 오탐 방지).
 *   4. 중앙 에러 핸들러가 LivekitTimeoutError → 504 { error: "livekit_timeout" } 로 매핑
 *      (5xx 마스킹으로 internal_error 가 되지 않음).
 */
import Fastify from "fastify";
import { ERROR_CODES } from "@multi-live/shared";
import {
  withLivekitTimeout,
  LivekitTimeoutError,
} from "../src/lib/livekitTimeout.js";
import { registerErrorHandler } from "../src/plugins/errorHandler.js";

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

async function partHelper() {
  console.log("── withLivekitTimeout 동작 ─────────────────────");

  // 1. 초과 → LivekitTimeoutError.
  const never = new Promise<number>(() => {}); // 절대 resolve 안 함
  let caught: unknown;
  try {
    await withLivekitTimeout(never, "neverResolves", 10);
  } catch (e) {
    caught = e;
  }
  assert(
    caught instanceof LivekitTimeoutError &&
      (caught as LivekitTimeoutError).code === ERROR_CODES.livekitTimeout &&
      (caught as LivekitTimeoutError).statusCode === 504,
    "상한 초과 → LivekitTimeoutError(code=livekit_timeout·statusCode=504)",
    caught,
  );

  // 2. 이내(즉시 resolve) → 값 통과.
  const v = await withLivekitTimeout(Promise.resolve(42), "instant");
  assert(v === 42, "상한 이내 즉시 resolve → 값 그대로 통과", v);

  // 3. 지연(그러나 상한 이내) → 통과(오탐 없음).
  const delayed = (async () => {
    await sleep(20);
    return "ok";
  })();
  const dv = await withLivekitTimeout(delayed, "delayed", 1_000);
  assert(dv === "ok", "지연 프라미스도 상한 이내면 통과(느린 CI 오탐 방지)", dv);
}

async function partErrorHandler() {
  console.log("── 중앙 에러 핸들러 매핑(504 livekit_timeout) ──");
  const app = Fastify();
  registerErrorHandler(app);
  app.get("/boom", async () => {
    // 라우트로 전파된 타임아웃 에러를 흉내.
    throw new LivekitTimeoutError("createRoom", 10_000);
  });
  const res = await app.inject({ method: "GET", url: "/boom" });
  const body = res.json() as { error?: string };
  assert(
    res.statusCode === 504 && body.error === ERROR_CODES.livekitTimeout,
    "라우트로 전파된 타임아웃 → 504 { error: 'livekit_timeout' } (internal_error 아님)",
    { status: res.statusCode, body },
  );
  await app.close();
}

async function main() {
  // withLivekitTimeout 의 타임아웃 타이머는 프로덕션 셧다운을 막지 않도록 unref 된다.
  // 이 격리 검증에는 다른 ref 작업이 없어 이벤트 루프가 조기 배수될 수 있으므로 keep-alive 를 건다.
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    await partHelper();
    await partErrorHandler();
  } finally {
    clearInterval(keepAlive);
    console.log("──────────────────────────────────────────");
    console.log(`통과 ${pass} / 실패 ${fail}`);
  }
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

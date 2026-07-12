import { mkdirSync } from "node:fs";
import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import fastifyStatic from "@fastify/static";
import { config } from "./config.js";
import { authGuard } from "./plugins/authGuard.js";
import { registerRateLimit } from "./plugins/rateLimit.js";
import { registerErrorHandler } from "./plugins/errorHandler.js";
import { healthRoutes } from "./routes/health.js";
import { authRoutes } from "./routes/auth.js";
import { roomRoutes } from "./routes/rooms.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { metricsRoutes } from "./routes/metrics.js";
import {
  startHostGraceSweeper,
  stopHostGraceSweeper,
} from "./services/hostGrace.js";
import { redis } from "./services/redis.js";
import { closeDb } from "./db/index.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function buildServer() {
  const app = Fastify({
    // A-4-4: 요청 body 상한(webhook raw body 포함 전역 적용).
    bodyLimit: config.bodyLimit,
    // 프록시 뒤(프로덕션)에서 req.ip 를 XFF 기준으로 — rate limit IP 키 정확도.
    trustProxy: true,
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      // A-5-1: 토큰·시크릿이 로그에 남지 않도록 민감 헤더 마스킹.
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          'res.headers["set-cookie"]',
        ],
        censor: "[redacted]",
      },
      transport: config.isProduction
        ? undefined
        : { target: "pino-pretty", options: { colorize: true } },
    },
  });

  // A-4-3: 기본 보안 헤더. API 는 JSON+HLS 를 서빙하므로 CSP·CORP 는 비활성
  //   (CORP same-origin 기본값이 크로스 오리진 HLS fetch 를 막으므로).
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: false,
  });

  // A-4-1: CORS 화이트리스트. 프로덕션은 config.corsOrigins('*' 는 부트 검증에서 거부),
  //   개발/테스트는 편의상 반사 허용.
  await app.register(cors, {
    origin: config.isProduction ? config.corsOrigins : true,
    credentials: true,
  });

  // authGuard 를 rate limit 보다 먼저 등록 → keyGenerator(userKey)가 req.user 를 볼 수 있음
  //   (per-user 키가 성립해야 로컬 E2E 의 서로 다른 참가자가 한 IP 로 합산되지 않는다).
  await app.register(authGuard);

  // A-3: 엔드포인트별 rate limit(라우트에서 opt-in).
  await registerRateLimit(app);

  // A-5-2 / C-2: 중앙 에러 핸들러(프로덕션 5xx 내부정보 미노출).
  registerErrorHandler(app);

  // A-4-2: HLS 경로 격리 — 첫 세그먼트(roomId)가 UUID 가 아니면 거부(traversal/오접근 차단).
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/hls/")) return;
    const rest = req.url.slice("/hls/".length);
    const firstSeg = decodeURIComponent((rest.split(/[/?#]/)[0] ?? "").trim());
    if (!UUID_RE.test(firstSeg)) {
      return reply.code(400).send({ error: "invalid_hls_path" });
    }
  });

  // HLS egress 산출물 정적 서빙(/hls/<roomId>/index.m3u8). 없으면 디렉터리 생성.
  mkdirSync(config.egressOutDir, { recursive: true });
  await app.register(fastifyStatic, {
    root: config.egressOutDir,
    prefix: "/hls/",
    decorateReply: false,
    // @fastify/static 기본 cacheControl(public, max-age=0)이 아래 setHeaders 를 덮으므로 비활성.
    cacheControl: false,
    // HLS 세그먼트는 CORS 로 브라우저 hls.js 가 가져간다.
    setHeaders: (res, filePath) => {
      res.setHeader("access-control-allow-origin", "*");
      // B-3: 세그먼트는 장기 immutable 캐시, 매니페스트는 no-cache(그대로 CDN 정책이 됨).
      if (filePath.endsWith(".m3u8")) {
        res.setHeader("cache-control", "no-cache");
      } else if (
        filePath.endsWith(".ts") ||
        filePath.endsWith(".m4s") ||
        filePath.endsWith(".mp4")
      ) {
        res.setHeader("cache-control", "public, max-age=86400, immutable");
      } else {
        res.setHeader("cache-control", "no-cache");
      }
    },
  });

  await app.register(healthRoutes);
  await app.register(metricsRoutes);
  await app.register(authRoutes);
  await app.register(roomRoutes);
  await app.register(webhookRoutes);

  return app;
}

async function main() {
  const app = await buildServer();

  // C-1: graceful shutdown — 신규 요청 거부 → 스위퍼 정지 → 진행 요청 drain → 연결 종료.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`${signal} 수신 — graceful shutdown 시작`);
    // 종료가 매달리면 강제 탈출(상한 10초).
    const hardExit = setTimeout(() => {
      app.log.error("graceful shutdown 10s 초과 — 강제 종료");
      process.exit(1);
    }, 10_000);
    hardExit.unref?.();
    try {
      stopHostGraceSweeper(); // 종료 중 방을 잘못 닫지 않도록 스위퍼부터 정지.
      await app.close(); // 신규 요청 거부 + 진행 요청 drain.
      await Promise.allSettled([redis.quit(), closeDb()]);
      app.log.info("graceful shutdown 완료");
      clearTimeout(hardExit);
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, "shutdown 중 오류");
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  try {
    await app.listen({ port: config.port, host: "0.0.0.0" });
    app.log.info(`api listening on :${config.port}`);
    // host 이탈 유예 스위퍼 기동(미복귀 방 자동 종료).
    startHostGraceSweeper();
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();

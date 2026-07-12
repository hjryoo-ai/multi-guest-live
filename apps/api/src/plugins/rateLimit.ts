import type { FastifyInstance, FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { config } from "../config.js";
import { redis } from "../services/redis.js";
import { metrics } from "../services/metrics.js";

/**
 * 엔드포인트별 rate limit (Phase 6.5 A-3).
 *   - Redis 스토어 공유(다중 인스턴스에서도 카운터 일관).
 *   - global:false — 명시적으로 config.rateLimit 을 단 라우트만 제한.
 *   - 키 전략: 인증 라우트는 user(sub) 기준(로컬 E2E 는 참가자마다 다른 user 라 무간섭),
 *     비인증(/auth/session)만 IP 기준 + 개발/테스트 loopback 예외(로컬 간섭 방지).
 */

function isLoopback(ip: string): boolean {
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip === "::ffff:127.0.0.1" ||
    ip === "localhost"
  );
}

/** 인증 사용자 기준 키(없으면 IP fallback). */
export const userKey = (req: FastifyRequest): string => req.user?.sub ?? req.ip;

export async function registerRateLimit(app: FastifyInstance): Promise<void> {
  await app.register(rateLimit, {
    global: false,
    redis,
    // 429 응답을 기존 문자열 error 스타일로 통일 + 메트릭 증분.
    errorResponseBuilder: (req, ctx) => {
      metrics.httpRateLimited(req.routeOptions?.url ?? req.url);
      // statusCode 를 포함해야 중앙 에러 핸들러(setErrorHandler)가 429 로 처리한다.
      return {
        statusCode: 429,
        error: "rate_limited",
        message: `요청이 너무 많습니다. ${Math.ceil(ctx.ttl / 1000)}초 후 다시 시도하세요.`,
      };
    },
  });
}

/** 사용자 단위 제한(인증 라우트용). */
export const limitPerUser = (max: number, timeWindow = "1 minute") => ({
  rateLimit: { max, timeWindow, keyGenerator: userKey },
});

/** IP 단위 제한(비인증). 개발/테스트 loopback 은 제외 — 로컬 E2E·verify 간섭 방지. */
export const limitPerIp = (max: number, timeWindow = "1 minute") => ({
  rateLimit: {
    max,
    timeWindow,
    allowList: (req: FastifyRequest) =>
      !config.isProduction && isLoopback(req.ip),
  },
});

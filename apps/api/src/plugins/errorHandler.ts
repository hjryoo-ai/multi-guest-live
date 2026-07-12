import type { FastifyError, FastifyInstance } from "fastify";
import { config } from "../config.js";

/**
 * 중앙 에러 핸들러 (Phase 6.5 A-5-2).
 *   - 5xx: 스택·내부 메시지를 클라이언트에 노출하지 않음(프로덕션). 서버 로그에만 상세.
 *   - 4xx(throw 된 것): 메시지 노출 허용(스택 제외). 라우트가 명시적으로 reply.send 한
 *     기존 {error:"..."} 응답은 이 핸들러를 거치지 않으므로 계약이 유지된다.
 *   - 검증 오류(fastify schema)는 400 으로 표준화.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode ?? 500;

    // rate limit(@fastify/rate-limit 이 throw) → 표준 429 응답으로 통일.
    if (status === 429) {
      return reply.code(429).send({ error: "rate_limited" });
    }

    if (status >= 500) {
      req.log.error({ err }, "unhandled error");
      return reply.code(500).send({
        error: "internal_error",
        ...(config.isProduction ? {} : { message: err.message }),
      });
    }

    // 검증 실패(스키마) → invalid_body 로 일관화.
    if (err.validation) {
      return reply.code(400).send({ error: "invalid_body" });
    }

    return reply.code(status).send({
      error: err.code ?? "error",
      message: err.message,
    });
  });
}

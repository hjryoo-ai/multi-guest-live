import type { FastifyInstance } from "fastify";
import { registry } from "../services/metrics.js";

/**
 * GET /metrics — Prometheus 스크레이프.
 * 선택적 인증: METRICS_TOKEN env 가 있으면 Bearer 검증, 없으면 무인증(운영망 전제 · README 경고).
 */
export async function metricsRoutes(app: FastifyInstance) {
  app.get("/metrics", async (req, reply) => {
    const token = process.env.METRICS_TOKEN;
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    reply.header("content-type", registry.contentType);
    return registry.metrics();
  });
}

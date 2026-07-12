import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { redis } from "../services/redis.js";
import { checkLiveKitReachable } from "../services/livekit.js";

export async function healthRoutes(app: FastifyInstance) {
  // 얕은 헬스체크 — 프로세스 생존 여부만.
  app.get("/health", async () => ({ status: "ok" }));

  // 깊은 헬스체크 — 의존 서비스 연결까지 확인(db·redis·livekit).
  app.get("/health/ready", async (_req, reply) => {
    const checks: Record<string, "ok" | "fail"> = {
      db: "fail",
      redis: "fail",
      livekit: "fail",
    };
    const [, ,] = await Promise.all([
      (async () => {
        try {
          await db.execute(sql`select 1`);
          checks.db = "ok";
        } catch (e) {
          app.log.error({ err: e }, "db health check failed");
        }
      })(),
      (async () => {
        try {
          const pong = await redis.ping();
          checks.redis = pong === "PONG" ? "ok" : "fail";
        } catch (e) {
          app.log.error({ err: e }, "redis health check failed");
        }
      })(),
      (async () => {
        // LiveKit 미도달은 not-ready(SFU 없이는 서비스 불가).
        if (await checkLiveKitReachable()) checks.livekit = "ok";
        else app.log.error("livekit health check failed");
      })(),
    ]);
    const allOk = Object.values(checks).every((v) => v === "ok");
    reply.code(allOk ? 200 : 503);
    return { status: allOk ? "ready" : "degraded", checks };
  });
}

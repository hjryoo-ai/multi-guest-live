import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import fp from "fastify-plugin";
import { verifySession, type SessionClaims } from "../services/auth.js";

declare module "fastify" {
  interface FastifyRequest {
    user: SessionClaims | null;
  }
}

function parseBearer(req: FastifyRequest): SessionClaims | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith("Bearer ")) return null;
  return verifySession(h.slice("Bearer ".length).trim());
}

/**
 * 모든 요청에 대해 Bearer 를 선택적으로 파싱해 request.user 에 주입.
 * 강제는 requireAuth preHandler 에서 수행.
 */
export const authGuard = fp(async (app: FastifyInstance) => {
  app.decorateRequest("user", null);
  app.addHook("onRequest", async (req) => {
    req.user = parseBearer(req);
  });
});

/** 로그인 필수 라우트용 preHandler. */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  if (!req.user) {
    reply.code(401).send({ error: "unauthorized" });
  }
}

import type { FastifyInstance } from "fastify";
import { createUserSchema } from "@multi-live/shared";
import { createUser } from "../services/users.js";
import { issueSession } from "../services/auth.js";
import { limitPerIp } from "../plugins/rateLimit.js";

export async function authRoutes(app: FastifyInstance) {
  // 간이 세션 발급: 닉네임 → user 생성 + 세션 JWT.
  //   A-3: IP당 10/분(익명 user 레코드 폭증 차단). 비프로덕션 loopback 은 예외.
  app.post(
    "/auth/session",
    { config: limitPerIp(10) },
    async (req, reply) => {
    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
    }
    const user = await createUser(parsed.data.nickname);
    const token = issueSession(user.id, user.nickname);
    return { userId: user.id, nickname: user.nickname, token };
  });
}

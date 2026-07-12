import { randomBytes } from "node:crypto";
import { redis } from "./redis.js";

/**
 * 초대코드 — multi-use, TTL 1시간. 코드→roomId 매핑 + 사용자(userId) 사용 기록.
 * Phase 3 에서 그대로 확장(동시 대기열 등).
 */
const TTL_SEC = 60 * 60;

const kCode = (code: string) => `invite:${code}`;
const kUsed = (code: string) => `invite:${code}:used`;

export async function createInvite(roomId: string): Promise<{
  code: string;
  expiresAt: number;
}> {
  const code = randomBytes(6).toString("base64url"); // 8자 내외
  await redis.set(kCode(code), roomId, "EX", TTL_SEC);
  return { code, expiresAt: Math.floor(Date.now() / 1000) + TTL_SEC };
}

/** 코드 검증 → 대상 roomId 반환(불일치/만료 시 null). */
export async function resolveInvite(
  code: string,
  roomId: string,
): Promise<boolean> {
  const target = await redis.get(kCode(code));
  return target === roomId;
}

export async function recordInviteUse(code: string, userId: string) {
  await redis.sadd(kUsed(code), userId);
  await redis.expire(kUsed(code), TTL_SEC);
}

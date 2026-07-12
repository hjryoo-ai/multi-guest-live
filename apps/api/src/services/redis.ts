import Redis from "ioredis";
import { config } from "../config.js";

export const redis = new Redis(config.redisUrl, {
  lazyConnect: false,
  maxRetriesPerRequest: 3,
});

redis.on("error", (err) => {
  // 개발 편의: 연결 오류를 치명적으로 취급하지 않고 로깅만.
  console.error("[redis] error:", err.message);
});

/**
 * KEYS 대체(B-2-3) — KEYS 는 단일 스레드를 블로킹하므로 프로덕션 금지.
 * SCAN 으로 커서 순회하며 패턴 매칭 키를 모은다(논블로킹).
 */
export async function scanKeys(pattern: string, count = 200): Promise<string[]> {
  const found: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(
      cursor,
      "MATCH",
      pattern,
      "COUNT",
      count,
    );
    found.push(...batch);
    cursor = next;
  } while (cursor !== "0");
  return found;
}

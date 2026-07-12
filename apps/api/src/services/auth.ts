import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

/**
 * 간이 세션 인증 — 닉네임 기반 HMAC-SHA256 JWT.
 * 실서비스 인증(OAuth/비밀번호 등)은 범위 외이며, 이 모듈 인터페이스만 교체하면 된다.
 */

export interface SessionClaims {
  sub: string; // userId
  nickname: string;
  iat: number;
  exp: number;
}

const DEFAULT_TTL_SEC = 60 * 60 * 24 * 7; // 7일

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlJson(obj: unknown): string {
  return b64url(JSON.stringify(obj));
}

function sign(data: string): string {
  return b64url(createHmac("sha256", config.authSecret).update(data).digest());
}

export function issueSession(
  userId: string,
  nickname: string,
  ttlSec = DEFAULT_TTL_SEC,
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlJson({ alg: "HS256", typ: "JWT" });
  const payload = b64urlJson({
    sub: userId,
    nickname,
    iat: now,
    exp: now + ttlSec,
  } satisfies SessionClaims);
  const sig = sign(`${header}.${payload}`);
  return `${header}.${payload}.${sig}`;
}

export function verifySession(token: string): SessionClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts as [string, string, string];
  const expected = sign(`${header}.${payload}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const claims = JSON.parse(
      Buffer.from(payload, "base64").toString("utf8"),
    ) as SessionClaims;
    if (claims.exp * 1000 < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

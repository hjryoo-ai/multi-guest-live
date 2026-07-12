import "dotenv/config";
import path from "node:path";
import { isIP } from "node:net";
import { z } from "zod";

/**
 * 부트 타임 env 검증(fail-fast) — Phase 6.5 C-3 + A-2-3 + A-4-1.
 *   - 모든 핵심 env 를 zod 로 1회 검증. 누락·형식 오류 시 어떤 키가 왜 틀렸는지 출력 후 즉시 종료.
 *   - 프로덕션(NODE_ENV=production)에서는 약한 시크릿·CORS `*` 를 부트에서 거부.
 * "기동은 됐는데 첫 요청에서 죽는" 유형을 제거한다.
 */

// 개발 기본값(코드에 박힌) — 프로덕션에서 이 값이면 부트 실패.
const DEV_LIVEKIT_KEY = "devkey";
const DEV_LIVEKIT_SECRET = "devsecret_change_me_0123456789abcdef";
const DEV_AUTH_SECRET = "dev_auth_secret_change_me";
const KNOWN_WEAK = new Set<string>([
  DEV_LIVEKIT_KEY,
  DEV_LIVEKIT_SECRET,
  DEV_AUTH_SECRET,
  "secret",
  "changeme",
  "change_me",
  "devsecret",
]);

/**
 * TRUST_PROXY — Fastify trustProxy 로 넘길 값(§7-lite 1-1).
 *   미설정/"false" → false (직결: XFF 불신, req.ip=소켓 — 가장 안전한 기본값)
 *   "true"         → true  (전 홉 신뢰 · 비권장 — leftmost XFF 위조 가능)
 *   정수 "1"       → 홉 수  (프로덕션 Caddy 1대 뒤 권장 — 오른쪽 1홉만 신뢰 → 위조 무력화)
 *   IP/CIDR CSV    → 배열   (특정 프록시만 신뢰: "10.0.0.0/8,127.0.0.1")
 */
function trustProxyError(raw: string): string | null {
  const v = raw.trim();
  if (v === "" || v === "true" || v === "false" || /^\d+$/.test(v)) return null;
  for (const item of v.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [addr, suffix, ...rest] = item.split("/");
    if (rest.length > 0 || !addr || isIP(addr) === 0)
      return `'${item}' 는 IP/CIDR 형식이 아닙니다`;
    if (suffix !== undefined) {
      const bits = Number(suffix);
      const max = isIP(addr) === 6 ? 128 : 32;
      if (!/^\d+$/.test(suffix) || bits < 0 || bits > max)
        return `'${item}' 의 CIDR 접두길이가 범위를 벗어남(0–${max})`;
    }
  }
  return null;
}
function parseTrustProxy(raw?: string): boolean | number | string[] {
  const v = (raw ?? "").trim();
  if (v === "" || v === "false") return false;
  if (v === "true") return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

const envSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    API_PORT: z.coerce.number().int().positive().default(4000),
    DATABASE_URL: z
      .string()
      .min(1)
      .default("postgres://multilive:multilive@localhost:5432/multilive"),
    REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
    LIVEKIT_API_KEY: z.string().min(1).default(DEV_LIVEKIT_KEY),
    LIVEKIT_API_SECRET: z.string().min(1).default(DEV_LIVEKIT_SECRET),
    LIVEKIT_URL: z.string().min(1).default("http://localhost:7880"),
    // LiveKit REST 호출 상한(ms). 기본 10s — CI/로컬 정상 경로 오탐 방지 여유.
    LIVEKIT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    AUTH_SECRET: z.string().min(1).default(DEV_AUTH_SECRET),
    // 브라우저 노출용(옵션).
    NEXT_PUBLIC_API_URL: z.string().optional(),
    PUBLIC_API_URL: z.string().optional(),
    NEXT_PUBLIC_LIVEKIT_URL: z.string().optional(),
    // CORS 허용 오리진(콤마 구분). 프로덕션 필수 · `*` 금지.
    CORS_ORIGINS: z.string().optional(),
    EGRESS_OUT_DIR: z.string().optional(),
    TOKEN_TTL_SEC: z.coerce.number().int().positive().optional(),
    METRICS_TOKEN: z.string().optional(),
    // 요청 body 상한(바이트). 기본 1MB.
    BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1_048_576),
    // 리버스 프록시 신뢰 설정(위 parseTrustProxy 참조). 미설정=직결(false).
    TRUST_PROXY: z.string().optional(),
    // 데모 가드(§7-lite 1-4) — 전부 기본값이 "비활성"이라 dev/E2E 무영향.
    MAX_CONCURRENT_ROOMS: z.coerce.number().int().nonnegative().default(0), // 0=무제한
    MAX_ROOM_LIFETIME_MIN: z.coerce.number().int().nonnegative().default(0), // 0=무제한
    DATA_RETENTION_HOURS: z.coerce.number().int().nonnegative().default(0), // 0=삭제 안 함
  })
  .superRefine((env, ctx) => {
    // 형식 fail-fast(전 환경) — 잘못된 CIDR/IP 는 부트에서 즉시 거부(C-3 원칙).
    if (env.TRUST_PROXY !== undefined) {
      const err = trustProxyError(env.TRUST_PROXY);
      if (err)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["TRUST_PROXY"],
          message: `TRUST_PROXY ${err}`,
        });
    }
    if (env.NODE_ENV !== "production") return;
    // 프로덕션 강제: 시크릿 강도 + CORS 명시.
    const strongSecret = (name: "AUTH_SECRET" | "LIVEKIT_API_SECRET") => {
      const v = env[name];
      if (KNOWN_WEAK.has(v) || v.length < 32) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message:
            "프로덕션에서는 32자 이상의 강한 비밀값이어야 하며 기본/약한 값(devkey 등)은 금지됩니다.",
        });
      }
    };
    strongSecret("AUTH_SECRET");
    strongSecret("LIVEKIT_API_SECRET");
    if (KNOWN_WEAK.has(env.LIVEKIT_API_KEY)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["LIVEKIT_API_KEY"],
        message: "프로덕션에서는 기본 LIVEKIT_API_KEY(devkey)를 사용할 수 없습니다.",
      });
    }
    if (!env.CORS_ORIGINS || env.CORS_ORIGINS.trim() === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["CORS_ORIGINS"],
        message:
          "프로덕션에서는 CORS_ORIGINS(허용 오리진 목록)를 반드시 지정해야 합니다.",
      });
    } else if (
      env.CORS_ORIGINS.split(",")
        .map((s) => s.trim())
        .includes("*")
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["CORS_ORIGINS"],
        message: "프로덕션에서는 CORS_ORIGINS 에 와일드카드('*')를 허용하지 않습니다.",
      });
    }
    // Cloud 전제(§7-lite 1-2): LiveKit·공개 API 주소가 self-host/dev(localhost·비TLS) 면 거부.
    //   dev 기본값(http://localhost:7880·ws://…)으로 프로덕션이 "은연중" 부팅되는 것을 차단.
    const rejectSelfHostUrl = (
      name: "LIVEKIT_URL" | "NEXT_PUBLIC_LIVEKIT_URL" | "NEXT_PUBLIC_API_URL",
      val: string | undefined,
      schemes: string[],
    ) => {
      if (!val || val.trim() === "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: `프로덕션에서는 ${name} 를 명시해야 합니다(${schemes.join(" 또는 ")} · dev 기본값 사용 불가).`,
        });
        return;
      }
      const local = /localhost|127\.0\.0\.1|::1/i.test(val);
      const okScheme = schemes.some((s) => val.toLowerCase().startsWith(s));
      if (local || !okScheme) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: `프로덕션에서는 ${name} 가 ${schemes.join(" 또는 ")} 의 비-로컬 주소여야 합니다(ws://·localhost 등 self-host/dev 값 금지).`,
        });
      }
    };
    rejectSelfHostUrl("LIVEKIT_URL", env.LIVEKIT_URL, ["https://", "wss://"]);
    rejectSelfHostUrl("NEXT_PUBLIC_LIVEKIT_URL", env.NEXT_PUBLIC_LIVEKIT_URL, [
      "wss://",
    ]);
    rejectSelfHostUrl(
      "NEXT_PUBLIC_API_URL",
      env.NEXT_PUBLIC_API_URL ?? env.PUBLIC_API_URL,
      ["https://"],
    );
  });

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("❌ 환경변수 검증 실패 — 서버를 시작할 수 없습니다:");
  for (const issue of parsed.error.issues) {
    console.error(`   • ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  process.exit(1);
}
const env = parsed.data;

// CORS 오리진 목록. 프로덕션은 위에서 검증됨. 개발/테스트 기본값은 localhost 웹.
const corsOrigins: string[] = env.CORS_ORIGINS
  ? env.CORS_ORIGINS.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  : ["http://localhost:3000"];

export const config = {
  nodeEnv: env.NODE_ENV,
  isProduction: env.NODE_ENV === "production",
  port: env.API_PORT,
  // 브라우저가 API(정적 HLS 포함)에 접근하는 공개 주소. HLS 매니페스트 URL 생성에 사용.
  publicApiUrl:
    env.NEXT_PUBLIC_API_URL ?? env.PUBLIC_API_URL ?? "http://localhost:4000",
  databaseUrl: env.DATABASE_URL,
  redisUrl: env.REDIS_URL,
  livekit: {
    apiKey: env.LIVEKIT_API_KEY,
    apiSecret: env.LIVEKIT_API_SECRET,
    // 서버측 REST 호출용 (http)
    url: env.LIVEKIT_URL,
    // 브라우저가 접속할 WebSocket 주소 (토큰 응답에 포함)
    wsUrl: env.NEXT_PUBLIC_LIVEKIT_URL ?? "ws://localhost:7880",
    // RoomServiceClient/EgressClient REST 호출 상한(ms). withLivekitTimeout 기본값.
    timeoutMs: env.LIVEKIT_TIMEOUT_MS,
  },
  authSecret: env.AUTH_SECRET,
  corsOrigins,
  bodyLimit: env.BODY_LIMIT_BYTES,
  // 리버스 프록시 뒤 req.ip 산출 신뢰 정책(Fastify trustProxy 로 전달).
  trustProxy: parseTrustProxy(env.TRUST_PROXY),
  // 데모 가드(§7-lite 1-4). 값 0 = 해당 가드 비활성(데모 배포에서만 env 로 켠다).
  demo: {
    maxConcurrentRooms: env.MAX_CONCURRENT_ROOMS,
    maxRoomLifetimeMs: env.MAX_ROOM_LIFETIME_MIN * 60_000,
    dataRetentionMs: env.DATA_RETENTION_HOURS * 3_600_000,
  },
  tokenTtlSec: env.TOKEN_TTL_SEC,
  metricsToken: env.METRICS_TOKEN,
  // HLS egress 출력 디렉터리(egress 컨테이너의 /out 공유 볼륨과 대응). /hls 로 정적 서빙.
  egressOutDir:
    env.EGRESS_OUT_DIR ?? path.resolve(process.cwd(), "../../egress-out"),
} as const;

export type AppConfig = typeof config;

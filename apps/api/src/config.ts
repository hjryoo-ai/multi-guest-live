import "dotenv/config";
import path from "node:path";
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
  })
  .superRefine((env, ctx) => {
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
  },
  authSecret: env.AUTH_SECRET,
  corsOrigins,
  bodyLimit: env.BODY_LIMIT_BYTES,
  tokenTtlSec: env.TOKEN_TTL_SEC,
  metricsToken: env.METRICS_TOKEN,
  // HLS egress 출력 디렉터리(egress 컨테이너의 /out 공유 볼륨과 대응). /hls 로 정적 서빙.
  egressOutDir:
    env.EGRESS_OUT_DIR ?? path.resolve(process.cwd(), "../../egress-out"),
} as const;

export type AppConfig = typeof config;

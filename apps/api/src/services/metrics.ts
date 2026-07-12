import client from "prom-client";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { rooms } from "../db/schema.js";
import { redis, scanKeys } from "./redis.js";

/**
 * 관측(Phase 5) — prom-client 레지스트리 + 앱 메트릭.
 * 카운터는 이벤트 지점에서 증분(metrics.*), 게이지는 스크레이프 시점에 DB/Redis 로 계산.
 * 게이지 collect() 는 try-catch 로 감싸 조회 실패가 /metrics 전체 500 으로 번지지 않게 한다.
 */
export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

const c = {
  audioMissing: new client.Counter({
    name: "ml_audio_missing_detected_total",
    help: "리포트에서 누락 감지된 오디오 트랙 수",
    registers: [registry],
  }),
  resubSignals: new client.Counter({
    name: "ml_resubscribe_signals_total",
    help: "RESUBSCRIBE_AUDIO 발송 횟수",
    registers: [registry],
  }),
  resubResolved: new client.Counter({
    name: "ml_audio_resubscribe_resolved_total",
    help: "이전 누락 트랙이 재구독 보고로 해소된 횟수",
    registers: [registry],
  }),
  staleReports: new client.Counter({
    name: "ml_audio_stale_reports_total",
    help: "stale_report 경고 노출 횟수(스크레이프 무관, 평가 시)",
    registers: [registry],
  }),
  egressTransitions: new client.Counter({
    name: "ml_egress_transitions_total",
    help: "egress 상태 전이 횟수",
    labelNames: ["to"] as const,
    registers: [registry],
  }),
  egressFailures: new client.Counter({
    name: "ml_egress_failures_total",
    help: "egress 실패 횟수",
    registers: [registry],
  }),
  egressFallbacks: new client.Counter({
    name: "ml_egress_fallbacks_total",
    help: "egress 실패 → 모드 A 폴백 횟수",
    registers: [registry],
  }),
  chatRateLimited: new client.Counter({
    name: "ml_chat_rate_limited_total",
    help: "채팅 rate limit(429) 횟수",
    registers: [registry],
  }),
  webhookErrors: new client.Counter({
    name: "ml_webhook_errors_total",
    help: "webhook 핸들러 처리 오류",
    labelNames: ["event"] as const,
    registers: [registry],
  }),
  webhookUnknownIdentity: new client.Counter({
    name: "ml_webhook_unknown_identity_total",
    help: "users 에 없는 identity 로 온 webhook(외부 load-test 참가자 등) 무시 횟수",
    registers: [registry],
  }),
  chatHidden: new client.Counter({
    name: "ml_chat_hidden_total",
    help: "채팅 메시지 숨김 횟수",
    registers: [registry],
  }),
  chatUnhidden: new client.Counter({
    name: "ml_chat_unhidden_total",
    help: "채팅 메시지 숨김 해제 횟수",
    registers: [registry],
  }),
  chatBans: new client.Counter({
    name: "ml_chat_bans_total",
    help: "채팅 차단 횟수",
    registers: [registry],
  }),
  chatBannedRejected: new client.Counter({
    name: "ml_chat_banned_rejected_total",
    help: "차단 유저의 채팅 전송 거부(403) 횟수",
    registers: [registry],
  }),
  httpRateLimited: new client.Counter({
    name: "ml_http_rate_limited_total",
    help: "엔드포인트 rate limit(429) 거부 횟수",
    labelNames: ["route"] as const,
    registers: [registry],
  }),
  chatCache: new client.Counter({
    name: "ml_chat_cache_total",
    help: "채팅 조회 캐시 히트/미스(미스만 DB 조회)",
    labelNames: ["result"] as const,
    registers: [registry],
  }),
};

export const metrics = {
  audioMissing: (n: number) => n > 0 && c.audioMissing.inc(n),
  resubSignal: () => c.resubSignals.inc(),
  resubResolved: (n: number) => n > 0 && c.resubResolved.inc(n),
  staleReport: (n: number) => n > 0 && c.staleReports.inc(n),
  egressTransition: (to: string) => c.egressTransitions.inc({ to }),
  egressFailure: () => c.egressFailures.inc(),
  egressFallback: () => c.egressFallbacks.inc(),
  chatRateLimited: () => c.chatRateLimited.inc(),
  webhookError: (event: string) => c.webhookErrors.inc({ event }),
  webhookUnknownIdentity: () => c.webhookUnknownIdentity.inc(),
  chatHidden: () => c.chatHidden.inc(),
  chatUnhidden: () => c.chatUnhidden.inc(),
  chatBan: () => c.chatBans.inc(),
  chatBannedRejected: () => c.chatBannedRejected.inc(),
  httpRateLimited: (route: string) => c.httpRateLimited.inc({ route }),
  chatCacheHit: () => c.chatCache.inc({ result: "hit" }),
  chatCacheMiss: () => c.chatCache.inc({ result: "miss" }),
};

// ── 게이지(스크레이프 시점 계산, 실패는 개별 게이지만 생략) ──
new client.Gauge({
  name: "ml_active_rooms",
  help: "status=live 방 수",
  registers: [registry],
  async collect() {
    try {
      const [r] = await db
        .select({ n: sql<number>`count(*)` })
        .from(rooms)
        .where(eq(rooms.status, "live"));
      this.set(Number(r?.n ?? 0));
    } catch {
      /* 조회 실패 → 이 게이지만 생략 */
    }
  },
});

new client.Gauge({
  name: "ml_active_participants",
  help: "Redis present 집합 총합(접속 참가자 근사)",
  registers: [registry],
  async collect() {
    try {
      const keys = await scanKeys("room:*:present");
      let total = 0;
      // 다건 scard 는 파이프라인으로(왕복 절감).
      if (keys.length > 0) {
        const pipe = redis.pipeline();
        for (const k of keys) pipe.scard(k);
        const res = await pipe.exec();
        for (const [, n] of res ?? []) total += Number(n ?? 0);
      }
      this.set(total);
    } catch {
      /* 조회 실패 → 이 게이지만 생략 */
    }
  },
});

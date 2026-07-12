import { SIGNAL_EVENTS, type AudioAlertDto } from "@multi-live/shared";
import { redis } from "./redis.js";
import { sendSignal } from "./livekit.js";
import { metrics } from "./metrics.js";

const kPublishedAudio = (roomId: string) => `room:${roomId}:published_audio`;
const kAudioOwner = (roomId: string) => `room:${roomId}:audio_owner`;
// 경고 상태(진실 아님, host 배지용): 리포트 수신 시점에 lazy 평가.
const kAlerts = (roomId: string) => `room:${roomId}:audio_alerts`; // `${rx}::${sid}` → firstMissingAtMs
const kLastReport = (roomId: string) => `room:${roomId}:audio_last_report`; // identity → lastReportAtMs

export const ALERT_THRESHOLD_MS = 30_000;
const FIELD_SEP = "::";

/**
 * 오디오 전수 도달 검증 (Phase 3 강화):
 *   리포트 수신마다
 *     · lastReportAt[identity] 갱신
 *     · 기대(내 것 제외 published_audio) 대비 누락 트랙에 firstMissingAt 기록(최초 1회)
 *     · 이미 구독된 트랙의 경고는 해제
 *     · 누락이 있으면 RESUBSCRIBE_AUDIO 지시(수신측이 재구독)
 *   경고 판정은 별도 타이머 없이 host 가 읽는 시점(getAudioAlerts)에서 30초 경과 여부로 계산.
 */
export async function checkAudioReach(
  roomId: string,
  identity: string,
  reportedSids: string[],
  nowMs: number,
): Promise<string[]> {
  const [allAudio, owners] = await Promise.all([
    redis.smembers(kPublishedAudio(roomId)),
    redis.hgetall(kAudioOwner(roomId)),
  ]);

  await redis.hset(kLastReport(roomId), identity, String(nowMs));

  const expected = allAudio.filter((sid) => owners[sid] !== identity);
  const reported = new Set(reportedSids);
  const missing = expected.filter((sid) => !reported.has(sid));

  // 경고 상태 갱신: 구독된 것은 해제, 누락된 것은 firstMissingAt 최초 기록.
  const alertsKey = kAlerts(roomId);
  const results = await Promise.all(
    expected.map((sid) => {
      const field = `${identity}${FIELD_SEP}${sid}`;
      return reported.has(sid)
        ? redis.hdel(alertsKey, field) // 삭제된 필드 수(=이전 누락이 해소됨)
        : redis.hsetnx(alertsKey, field, String(nowMs));
    }),
  );
  // hdel 이 실제로 필드를 지운 경우 = 이전 누락 경고가 재구독으로 해소됨.
  const resolved = expected.reduce(
    (n, sid, i) => (reported.has(sid) ? n + Number(results[i] ?? 0) : n),
    0,
  );
  metrics.resubResolved(resolved);
  metrics.audioMissing(missing.length);

  if (missing.length > 0) {
    try {
      await sendSignal(roomId, [identity], {
        event: SIGNAL_EVENTS.RESUBSCRIBE_AUDIO,
        payload: { missingTrackSids: missing },
      });
      metrics.resubSignal();
    } catch (err) {
      console.warn("[audioReach] sendSignal failed:", (err as Error).message);
    }
  }
  return missing;
}

/**
 * host 배지용 경고 목록 — 읽기 시점 lazy 평가(별도 타이머 없음).
 *   missing_subscription: 30초+ 미구독 트랙
 *   stale_report:         present 참가자 중 30초+ 무보고(사각지대 감지)
 */
export async function getAudioAlerts(
  roomId: string,
  presentIdentities: string[],
  nickname: (id: string) => string,
  nowMs: number,
): Promise<AudioAlertDto[]> {
  const [alerts, lastReports] = await Promise.all([
    redis.hgetall(kAlerts(roomId)),
    redis.hgetall(kLastReport(roomId)),
  ]);
  const out: AudioAlertDto[] = [];

  for (const [field, firstAt] of Object.entries(alerts)) {
    const age = nowMs - Number(firstAt);
    if (age >= ALERT_THRESHOLD_MS) {
      const [rx, sid] = field.split(FIELD_SEP);
      out.push({
        kind: "missing_subscription",
        participantId: rx ?? field,
        nickname: nickname(rx ?? ""),
        trackSid: sid,
        ageMs: age,
      });
    }
  }

  let staleCount = 0;
  for (const id of presentIdentities) {
    const last = lastReports[id];
    const age = last ? nowMs - Number(last) : Infinity;
    if (age >= ALERT_THRESHOLD_MS) {
      staleCount++;
      out.push({
        kind: "stale_report",
        participantId: id,
        nickname: nickname(id),
        ageMs: Number.isFinite(age) ? age : ALERT_THRESHOLD_MS,
      });
    }
  }
  metrics.staleReport(staleCount);
  return out;
}

// ── webhook 정리(경고 기준선 오염 방지) ──────────────────────
export async function clearAlertsForReceiver(roomId: string, identity: string) {
  const alerts = await redis.hgetall(kAlerts(roomId));
  const fields = Object.keys(alerts).filter((f) =>
    f.startsWith(`${identity}${FIELD_SEP}`),
  );
  if (fields.length) await redis.hdel(kAlerts(roomId), ...fields);
  await redis.hdel(kLastReport(roomId), identity);
}

export async function clearAlertsForTrack(roomId: string, trackSid: string) {
  const alerts = await redis.hgetall(kAlerts(roomId));
  const fields = Object.keys(alerts).filter((f) =>
    f.endsWith(`${FIELD_SEP}${trackSid}`),
  );
  if (fields.length) await redis.hdel(kAlerts(roomId), ...fields);
}

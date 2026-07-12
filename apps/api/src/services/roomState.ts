import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { roomParticipants, rooms } from "../db/schema.js";
import { redis } from "./redis.js";
import { clearAlertsForReceiver, clearAlertsForTrack } from "./audioReach.js";
import type { ParticipantState, Role } from "@multi-live/shared";

/**
 * roomState — Postgres(영속: 이력·감사) + Redis(실시간 presence/오디오) 동기화 캡슐화.
 *
 * 멱등성 원칙:
 *   - 참가자 행은 (room_id, user_id) 유니크 → onConflictDoUpdate 로 upsert.
 *   - presence 는 webhook 이벤트의 createdAt(ts) 기준 max-timestamp 로 반영해
 *     join/left 순서 역전·중복 배달에도 안전. present 여부는 joined_at vs left_at 로 파생.
 */

// ── Redis 키 ─────────────────────────────────────────────────
const kPresent = (roomId: string) => `room:${roomId}:present`;
const kPublishedAudio = (roomId: string) => `room:${roomId}:published_audio`;
const kAudioOwner = (roomId: string) => `room:${roomId}:audio_owner`; // sid → identity
const kHlsViewers = (roomId: string) => `room:${roomId}:hls_viewers`; // userId → last-seen ts

// HLS 시청자는 LiveKit 참가자가 아니므로 presence 를 자체 집계한다.
// heartbeat(채팅 폴링 겸용)로 갱신되고, 이 창을 넘으면 이탈로 간주.
const HLS_VIEWER_TTL_MS = 45_000;

// ── 참가자 upsert (토큰 발급 시 역할/승인상태 기록) ───────────
export async function ensureParticipant(params: {
  roomId: string;
  userId: string;
  role: Role;
  state: ParticipantState;
}) {
  await db
    .insert(roomParticipants)
    .values({
      roomId: params.roomId,
      userId: params.userId,
      role: params.role,
      state: params.state,
    })
    .onConflictDoUpdate({
      target: [roomParticipants.roomId, roomParticipants.userId],
      set: { role: params.role, state: params.state },
    });
}

/**
 * 없을 때만 삽입(기존 역할/상태 보존). viewer 토큰 발급에 사용 —
 * 이미 guest 를 requested/approved 한 참가자를 viewer 로 강등시키지 않기 위함.
 */
export async function ensureParticipantIfAbsent(params: {
  roomId: string;
  userId: string;
  role: Role;
  state: ParticipantState;
}) {
  await db
    .insert(roomParticipants)
    .values({
      roomId: params.roomId,
      userId: params.userId,
      role: params.role,
      state: params.state,
    })
    .onConflictDoNothing({
      target: [roomParticipants.roomId, roomParticipants.userId],
    });
}

// ── webhook: 참가자 입장/퇴장 (timestamp-guarded, 멱등) ───────
export async function markParticipantJoined(
  roomId: string,
  userId: string,
  eventTsSec: number,
) {
  const ts = new Date(eventTsSec * 1000);
  // 행이 없으면(=토큰 없이 이벤트가 먼저 온 경우) viewer 로 최소 생성.
  await db
    .insert(roomParticipants)
    .values({
      roomId,
      userId,
      role: "viewer",
      state: "approved",
      joinedAt: ts,
    })
    .onConflictDoUpdate({
      target: [roomParticipants.roomId, roomParticipants.userId],
      set: { joinedAt: ts },
    });
  await redis.sadd(kPresent(roomId), userId);
}

export async function markParticipantLeft(
  roomId: string,
  userId: string,
  eventTsSec: number,
) {
  const ts = new Date(eventTsSec * 1000);
  await db
    .insert(roomParticipants)
    .values({
      roomId,
      userId,
      role: "viewer",
      state: "left",
      leftAt: ts,
    })
    .onConflictDoUpdate({
      target: [roomParticipants.roomId, roomParticipants.userId],
      // 퇴장 시 state=left 로 명시 전이. 단 kicked 는 보존(강퇴 후 이탈이 재입장 허용으로
      // 뒤집히면 안 됨).
      set: {
        leftAt: ts,
        state: sql`case when ${roomParticipants.state} = 'kicked' then 'kicked' else 'left' end`,
      },
    });
  await redis.srem(kPresent(roomId), userId);
  // 퇴장 참가자의 오디오 트랙 + 관련 경고를 도달검증 기준선에서 정리 (오염 방지).
  await cleanupParticipantAudio(roomId, userId);
  await clearAlertsForReceiver(roomId, userId);
}

// ── webhook: 오디오 트랙 publish/unpublish ────────────────────
export async function addPublishedAudioTrack(
  roomId: string,
  userId: string,
  trackSid: string,
) {
  await redis.sadd(kPublishedAudio(roomId), trackSid);
  await redis.hset(kAudioOwner(roomId), trackSid, userId);
}

export async function removePublishedAudioTrack(
  roomId: string,
  trackSid: string,
) {
  await redis.srem(kPublishedAudio(roomId), trackSid);
  await redis.hdel(kAudioOwner(roomId), trackSid);
  await clearAlertsForTrack(roomId, trackSid);
}

async function cleanupParticipantAudio(roomId: string, userId: string) {
  const owners = await redis.hgetall(kAudioOwner(roomId));
  const sids = Object.entries(owners)
    .filter(([, owner]) => owner === userId)
    .map(([sid]) => sid);
  if (sids.length === 0) return;
  await redis.srem(kPublishedAudio(roomId), ...sids);
  await redis.hdel(kAudioOwner(roomId), ...sids);
  // 이 트랙들을 기대하던 다른 수신자들의 경고도 함께 정리.
  await Promise.all(sids.map((sid) => clearAlertsForTrack(roomId, sid)));
}

export async function getPublishedAudioTracks(
  roomId: string,
): Promise<string[]> {
  return redis.smembers(kPublishedAudio(roomId));
}

export async function getPresentIdentities(roomId: string): Promise<string[]> {
  return redis.smembers(kPresent(roomId));
}

// ── 모드 B: HLS 시청자 heartbeat presence (근사 집계) ─────────
/** HLS 시청자 heartbeat 갱신 후 현재 유효 시청자 수 반환. */
export async function touchHlsViewer(
  roomId: string,
  userId: string,
  nowMs: number,
): Promise<number> {
  const key = kHlsViewers(roomId);
  await redis.zadd(key, nowMs, userId);
  await redis.zremrangebyscore(key, 0, nowMs - HLS_VIEWER_TTL_MS);
  await redis.pexpire(key, HLS_VIEWER_TTL_MS * 2);
  return redis.zcard(key);
}

/** 유효 창 내 HLS 시청자 수(heartbeat 없이 집계만). */
export async function countHlsViewers(
  roomId: string,
  nowMs: number,
): Promise<number> {
  const key = kHlsViewers(roomId);
  await redis.zremrangebyscore(key, 0, nowMs - HLS_VIEWER_TTL_MS);
  return redis.zcard(key);
}

// ── 방 종료 반영 ─────────────────────────────────────────────
export async function markRoomEnded(roomId: string, endedAt = new Date()) {
  await db
    .update(rooms)
    .set({ status: "ended", endedAt })
    .where(and(eq(rooms.id, roomId), eq(rooms.status, "live")));
  // Redis presence/오디오 상태 정리.
  await redis.del(
    kPresent(roomId),
    kPublishedAudio(roomId),
    kAudioOwner(roomId),
    kHlsViewers(roomId),
  );
}

export async function markRoomLive(roomId: string) {
  await db
    .update(rooms)
    .set({ status: "live" })
    .where(and(eq(rooms.id, roomId), eq(rooms.status, "created")));
}

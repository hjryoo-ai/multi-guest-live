import { and, eq, inArray, count } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  rooms,
  roomParticipants,
  users,
  moderationLogs,
} from "../db/schema.js";
import type { ModerationAction } from "@multi-live/shared";
import { metrics } from "./metrics.js";
import type {
  CreateRoomInput,
  RoomDetailDto,
  RoomDto,
  ParticipantDto,
  Role,
  ParticipantState,
} from "@multi-live/shared";

function toRoomDto(r: typeof rooms.$inferSelect): RoomDto {
  return {
    id: r.id,
    hostId: r.hostId,
    title: r.title,
    status: r.status as RoomDto["status"],
    maxGuests: r.maxGuests,
    maxSpeakers: r.maxSpeakers,
    viewerMode: r.viewerMode as RoomDto["viewerMode"],
    egressStatus: r.egressStatus as RoomDto["egressStatus"],
    createdAt: r.createdAt.toISOString(),
    endedAt: r.endedAt ? r.endedAt.toISOString() : null,
  };
}

/** 활성 방(created|live) 수 — 데모 방 상한(§7-lite 1-4) 판정용. */
export async function countActiveRooms(): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(rooms)
    .where(inArray(rooms.status, ["created", "live"]));
  return row?.n ?? 0;
}

export async function createRoomRecord(hostId: string, input: CreateRoomInput) {
  const [room] = await db
    .insert(rooms)
    .values({
      hostId,
      title: input.title,
      maxGuests: input.maxGuests,
      maxSpeakers: input.maxSpeakers,
      viewerMode: input.viewerMode,
      status: "created",
    })
    .returning();
  // host 를 approved 참가자로 등록.
  await db.insert(roomParticipants).values({
    roomId: room!.id,
    userId: hostId,
    role: "host",
    state: "approved",
  });
  return toRoomDto(room!);
}

export async function getRoom(roomId: string): Promise<RoomDto | null> {
  const [r] = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
  return r ? toRoomDto(r) : null;
}

export async function getRoomDetail(
  roomId: string,
): Promise<RoomDetailDto | null> {
  const room = await getRoom(roomId);
  if (!room) return null;

  const rows = await db
    .select({
      userId: roomParticipants.userId,
      nickname: users.nickname,
      role: roomParticipants.role,
      state: roomParticipants.state,
      joinedAt: roomParticipants.joinedAt,
      leftAt: roomParticipants.leftAt,
    })
    .from(roomParticipants)
    .innerJoin(users, eq(users.id, roomParticipants.userId))
    .where(eq(roomParticipants.roomId, roomId));

  const participants: ParticipantDto[] = rows.map((p) => ({
    userId: p.userId,
    nickname: p.nickname,
    role: p.role as Role,
    state: p.state as ParticipantState,
    joinedAt: p.joinedAt ? p.joinedAt.toISOString() : null,
    leftAt: p.leftAt ? p.leftAt.toISOString() : null,
  }));

  return { ...room, participants };
}

export async function endRoomRecord(roomId: string) {
  await db
    .update(rooms)
    .set({ status: "ended", endedAt: new Date() })
    .where(eq(rooms.id, roomId));
}

// ── Phase 4: HLS egress 상태 ──────────────────────────────────
export async function setEgressState(
  roomId: string,
  status: RoomDto["egressStatus"],
  egressId?: string | null,
) {
  await db
    .update(rooms)
    .set({
      egressStatus: status,
      ...(egressId !== undefined ? { egressId } : {}),
    })
    .where(eq(rooms.id, roomId));
  metrics.egressTransition(status);
}

/** egress 실행 id 조회(중지용). */
export async function getEgressId(roomId: string): Promise<string | null> {
  const [r] = await db
    .select({ egressId: rooms.egressId })
    .from(rooms)
    .where(eq(rooms.id, roomId))
    .limit(1);
  return r?.egressId ?? null;
}

/**
 * HLS egress 실패 → 모드 A(webrtc)로 자동 폴백.
 * viewer_mode 를 되돌려 신규 시청자가 WebRTC 경로로 붙게 하고 egressStatus=failed 로 표기.
 */
export async function fallbackToWebrtc(roomId: string) {
  await db
    .update(rooms)
    .set({ viewerMode: "webrtc", egressStatus: "failed", egressId: null })
    .where(eq(rooms.id, roomId));
}

// ── Phase 2: 참가자 조회 · 승인 · 감사 로그 ────────────────────
export async function getParticipant(roomId: string, userId: string) {
  const [row] = await db
    .select()
    .from(roomParticipants)
    .where(
      and(
        eq(roomParticipants.roomId, roomId),
        eq(roomParticipants.userId, userId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * 방에서 특정 role 로 승인된 참가자 수. 슬롯 검증용.
 * Phase 6: guest 슬롯(max_guests)과 speaker 슬롯(max_speakers)은 서로 침범하지 않으므로
 * role 별로 정확히 카운트한다.
 */
export async function countApprovedByRole(
  roomId: string,
  role: "guest" | "speaker",
): Promise<number> {
  const rows = await db
    .select({ id: roomParticipants.id })
    .from(roomParticipants)
    .where(
      and(
        eq(roomParticipants.roomId, roomId),
        eq(roomParticipants.state, "approved"),
        eq(roomParticipants.role, role),
      ),
    );
  return rows.length;
}

/** guest 슬롯 카운트(하위호환 별칭). */
export const countApprovedGuests = (roomId: string) =>
  countApprovedByRole(roomId, "guest");

export async function logModeration(params: {
  roomId: string;
  actorId: string;
  targetId?: string | null;
  action: ModerationAction;
  detail?: Record<string, unknown>;
}) {
  await db.insert(moderationLogs).values({
    roomId: params.roomId,
    actorId: params.actorId,
    targetId: params.targetId ?? null,
    action: params.action,
    detail: params.detail ? JSON.stringify(params.detail) : null,
  });
}

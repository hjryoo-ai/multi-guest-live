import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  bigserial,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * users — 간이 사용자 (닉네임 기반). 실서비스 인증은 범위 외.
 */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  nickname: text("nickname").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * rooms — 방 메타. status 는 created→live→ended 상태 머신.
 */
export const rooms = pgTable("rooms", {
  id: uuid("id").primaryKey().defaultRandom(),
  hostId: uuid("host_id")
    .notNull()
    .references(() => users.id),
  title: text("title").notNull(),
  // created | live | ended
  status: text("status").notNull().default("created"),
  maxGuests: integer("max_guests").notNull().default(8),
  // speaker(오디오 전용) 슬롯 상한 — guest 와 카운트 분리(Phase 6).
  maxSpeakers: integer("max_speakers").notNull().default(20),
  // webrtc | hls — 방 생성 시 고정, LIVE 중 변경 불가(Phase 4 정책).
  viewerMode: text("viewer_mode").notNull().default("webrtc"),
  // HLS egress(모드 B) 제어. none|starting|active|ending|failed.
  egressStatus: text("egress_status").notNull().default("none"),
  // 실행 중 egress id(중지·상태추적용). 실패/미기동 시 null.
  egressId: text("egress_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});

/**
 * chat_messages — 서버 경유 채팅(저장=순서의 단일 진실).
 *   id(bigserial)가 단조 증가 커서 → 모드 B 폴링의 `after` 기준.
 *   hidden: 운영 삭제(soft delete) 플래그 — GET 에서 제외.
 */
export const chatMessages = pgTable(
  "chat_messages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    nickname: text("nickname").notNull(),
    text: text("text").notNull(),
    hidden: boolean("hidden").notNull().default(false),
    // hide/unhide 시각(Phase 6B, 전파 판정·감사용).
    moderatedAt: timestamp("moderated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // (room_id, id) — 방별 커서 페이지네이션의 커버링 인덱스.
    byRoomId: index("chat_messages_room_id_idx").on(t.roomId, t.id),
    // 최근 창 hidden 스냅샷 조회용.
    byRoomHidden: index("chat_messages_room_hidden_idx").on(t.roomId, t.hidden),
  }),
);

/**
 * room_participants — 방별 참가자 역할/상태.
 * state: requested | approved | left | kicked
 */
export const roomParticipants = pgTable(
  "room_participants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    // host | guest | speaker | viewer
    role: text("role").notNull(),
    // requested | approved | left | kicked
    state: text("state").notNull().default("requested"),
    joinedAt: timestamp("joined_at", { withTimezone: true }),
    leftAt: timestamp("left_at", { withTimezone: true }),
    // 채팅 차단(Phase 6B). null=정상. 방 종료로 자연 소멸(세션 스코프).
    chatBannedAt: timestamp("chat_banned_at", { withTimezone: true }),
  },
  (t) => ({
    byRoom: index("room_participants_room_idx").on(t.roomId),
    // 방별 사용자당 1행 — webhook 멱등 upsert(onConflictDoUpdate)의 대상 키.
    uniqRoomUser: uniqueIndex("room_participants_room_user_uniq").on(
      t.roomId,
      t.userId,
    ),
  }),
);

/**
 * moderation_logs — host 운영 액션 감사 로그.
 */
export const moderationLogs = pgTable(
  "moderation_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id),
    targetId: uuid("target_id").references(() => users.id),
    // mute | unmute | kick | approve | reject | promote | demote | role_change
    action: text("action").notNull(),
    // 부가 정보(JSON 문자열). role_change 의 from/to, chat_* 의 messageId 등.
    detail: text("detail"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byRoom: index("moderation_logs_room_idx").on(t.roomId),
  }),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Room = typeof rooms.$inferSelect;
export type NewRoom = typeof rooms.$inferInsert;
export type RoomParticipant = typeof roomParticipants.$inferSelect;
export type NewRoomParticipant = typeof roomParticipants.$inferInsert;
export type ModerationLog = typeof moderationLogs.$inferSelect;
export type ChatMessageRow = typeof chatMessages.$inferSelect;
export type NewChatMessage = typeof chatMessages.$inferInsert;

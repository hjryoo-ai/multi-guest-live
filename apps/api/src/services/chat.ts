import { and, eq, gt, desc, asc, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { chatMessages, roomParticipants } from "../db/schema.js";
import { redis } from "./redis.js";
import { metrics } from "./metrics.js";
import {
  CHAT_RATE_WINDOW_MS,
  type ChatListDto,
  type ChatMessageDto,
} from "@multi-live/shared";

const HISTORY_LIMIT = 50; // 입장 시 최근 N개.
const PAGE_LIMIT = 200; // 폴링 1회 최대 반환.

/** rate limit 초과 시 던지는 신호(라우트에서 429 로 변환). */
export class ChatRateLimitedError extends Error {
  constructor() {
    super("chat_rate_limited");
    this.name = "ChatRateLimitedError";
  }
}

// ── 금칙어 필터 훅 ────────────────────────────────────────────
// 서버 경유의 이점: 저장 전 이 지점에서 마스킹. 실서비스는 외부 사전/모델로 교체.
const BANNED = ["badword", "욕설", "씨발", "개새끼"];
export function filterProfanity(text: string): string {
  let out = text;
  for (const w of BANNED) {
    if (!w) continue;
    out = out.split(w).join("*".repeat(w.length));
  }
  return out;
}

// ── 채팅 캐시 무효화(B-1) ─────────────────────────────────────
//   방별 버전을 write 시 INCR → 캐시 키에 버전을 포함시켜 즉시 무효화(스캔 불필요).
//   1초 TTL 은 백스톱. write 즉시 신선도 보장(숨김/해제/신규 메시지).
const kChatVer = (roomId: string) => `chat:ver:${roomId}`;
async function bumpChatVersion(roomId: string): Promise<void> {
  await redis.incr(kChatVer(roomId));
}

// ── rate limit (유저당 창당 1건) ──────────────────────────────
async function enforceRateLimit(roomId: string, userId: string) {
  const key = `chat:rl:${roomId}:${userId}`;
  const n = await redis.incr(key);
  if (n === 1) await redis.pexpire(key, CHAT_RATE_WINDOW_MS);
  if (n > 1) throw new ChatRateLimitedError();
}

function toDto(
  r: typeof chatMessages.$inferSelect,
  asHost = false,
): ChatMessageDto {
  const dto: ChatMessageDto = {
    id: Number(r.id),
    roomId: r.roomId,
    userId: r.userId,
    nickname: r.nickname,
    text: r.text,
    createdAt: r.createdAt.toISOString(),
  };
  // host 요청에서만 hidden 플래그를 실어 운영 UI 가 "숨겨진 메시지" 로 렌더.
  if (asHost) dto.hidden = r.hidden;
  return dto;
}

/**
 * 채팅 저장(순서의 단일 진실). rate limit → 금칙어 필터 → insert.
 * 전파(sendData / 폴링)는 호출측 책임 — 여기서는 저장·정규화만 한다.
 */
export async function postChat(params: {
  roomId: string;
  userId: string;
  nickname: string;
  text: string;
}): Promise<ChatMessageDto> {
  await enforceRateLimit(params.roomId, params.userId);
  const clean = filterProfanity(params.text);
  const [row] = await db
    .insert(chatMessages)
    .values({
      roomId: params.roomId,
      userId: params.userId,
      nickname: params.nickname,
      text: clean,
    })
    .returning();
  await bumpChatVersion(params.roomId); // 캐시 무효화(신규 메시지 즉시 반영).
  return toDto(row!);
}

/**
 * 채팅 조회.
 *   - after 지정: id > after 를 오름차순(폴링 델타).
 *   - after 없음: 최근 HISTORY_LIMIT 개(입장 시 히스토리) 를 시간순.
 * asHost=false: hidden=true 제외. asHost=true: hidden 포함 + hidden 플래그.
 */
export async function listChat(
  roomId: string,
  after?: number,
  asHost = false,
): Promise<ChatMessageDto[]> {
  const notHidden = asHost ? undefined : eq(chatMessages.hidden, false);
  if (after !== undefined && Number.isFinite(after)) {
    const rows = await db
      .select()
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.roomId, roomId),
          gt(chatMessages.id, after),
          ...(notHidden ? [notHidden] : []),
        ),
      )
      .orderBy(asc(chatMessages.id))
      .limit(PAGE_LIMIT);
    return rows.map((r) => toDto(r, asHost));
  }
  const rows = await db
    .select()
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.roomId, roomId),
        ...(notHidden ? [notHidden] : []),
      ),
    )
    .orderBy(desc(chatMessages.id))
    .limit(HISTORY_LIMIT);
  return rows.reverse().map((r) => toDto(r, asHost));
}

/** 최근 창 내 hidden=true 메시지 id 스냅샷(모드 B 수렴용). */
export async function getRecentHiddenIds(roomId: string): Promise<number[]> {
  const rows = await db
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(and(eq(chatMessages.roomId, roomId), eq(chatMessages.hidden, true)))
    .orderBy(desc(chatMessages.id))
    .limit(PAGE_LIMIT);
  return rows.map((r) => Number(r.id));
}

/**
 * 채팅 조회 스냅샷(messages+hiddenIds+cursor) — B-1 마이크로 캐시.
 * Redis 1초 TTL 로 동시 폴링을 1회 DB 조회로 합류시켜, 시청자 수와 무관하게
 * 방당 DB 조회를 ≤1/초 로 상한한다(수렴된 커서에서 다수 폴러가 같은 키 공유).
 * 신선도: 최대 1초 지연(모드 A 는 실시간 push, 모드 B 는 3초 폴링이라 체감 영향 없음).
 * viewerCount 는 폴러별 heartbeat 라 캐시하지 않고 호출측에서 라이브 계산.
 */
export type ChatSnapshot = Pick<
  ChatListDto,
  "messages" | "hiddenIds" | "cursor"
>;
export async function getChatSnapshot(
  roomId: string,
  after: number | undefined,
  asHost: boolean,
): Promise<ChatSnapshot> {
  const ver = (await redis.get(kChatVer(roomId))) ?? "0";
  const key = `chat:snap:${roomId}:${ver}:${asHost ? "h" : "v"}:${after ?? "-"}`;
  const cached = await redis.get(key);
  if (cached) {
    metrics.chatCacheHit();
    return JSON.parse(cached) as ChatSnapshot;
  }
  const [messages, hiddenIds, cursor] = await Promise.all([
    listChat(roomId, after, asHost),
    getRecentHiddenIds(roomId),
    getChatCursor(roomId),
  ]);
  const snap: ChatSnapshot = { messages, hiddenIds, cursor };
  await redis.set(key, JSON.stringify(snap), "PX", 1000);
  metrics.chatCacheMiss();
  return snap;
}

/** 방의 최신 메시지 id(폴링 cursor 힌트). 없으면 0. */
export async function getChatCursor(roomId: string): Promise<number> {
  const [r] = await db
    .select({ max: sql<number>`coalesce(max(${chatMessages.id}), 0)` })
    .from(chatMessages)
    .where(eq(chatMessages.roomId, roomId));
  return Number(r?.max ?? 0);
}

/**
 * 운영: 메시지 숨김/해제(soft delete, tombstone). roomId 스코프로 타 방 오조작 방지.
 * @returns 해당 방에 그 메시지가 존재해 갱신됐으면 true
 */
export async function setChatHidden(
  roomId: string,
  messageId: number,
  hidden: boolean,
): Promise<boolean> {
  const rows = await db
    .update(chatMessages)
    .set({ hidden, moderatedAt: new Date() })
    .where(
      and(eq(chatMessages.id, messageId), eq(chatMessages.roomId, roomId)),
    )
    .returning({ id: chatMessages.id });
  if (rows.length > 0) await bumpChatVersion(roomId); // 숨김/해제 즉시 반영.
  return rows.length > 0;
}

// ── 채팅 차단 ────────────────────────────────────────────────
export async function isChatBanned(
  roomId: string,
  userId: string,
): Promise<boolean> {
  const [r] = await db
    .select({ banned: roomParticipants.chatBannedAt })
    .from(roomParticipants)
    .where(
      and(
        eq(roomParticipants.roomId, roomId),
        eq(roomParticipants.userId, userId),
      ),
    )
    .limit(1);
  return !!r?.banned;
}

/** 채팅 차단/해제. @returns 대상 참가자 레코드가 있어 갱신됐으면 true */
export async function setChatBan(
  roomId: string,
  userId: string,
  banned: boolean,
): Promise<boolean> {
  const rows = await db
    .update(roomParticipants)
    .set({ chatBannedAt: banned ? new Date() : null })
    .where(
      and(
        eq(roomParticipants.roomId, roomId),
        eq(roomParticipants.userId, userId),
      ),
    )
    .returning({ id: roomParticipants.id });
  return rows.length > 0;
}

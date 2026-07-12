import { z } from "zod";

/* ────────────────────────────────────────────────────────────
 * 역할 & 상태 모델
 * ──────────────────────────────────────────────────────────── */

export const ROLES = ["host", "guest", "speaker", "viewer"] as const;
export type Role = (typeof ROLES)[number];
export const roleSchema = z.enum(ROLES);

export const ROOM_STATUSES = ["created", "live", "ended"] as const;
export type RoomStatus = (typeof ROOM_STATUSES)[number];
export const roomStatusSchema = z.enum(ROOM_STATUSES);

// 게스트 슬롯 상태 머신: EMPTY → REQUESTED → APPROVED → LEFT/KICKED
export const PARTICIPANT_STATES = [
  "requested",
  "approved",
  "left",
  "kicked",
] as const;
export type ParticipantState = (typeof PARTICIPANT_STATES)[number];
export const participantStateSchema = z.enum(PARTICIPANT_STATES);

export const VIEWER_MODES = ["webrtc", "hls"] as const;
export type ViewerMode = (typeof VIEWER_MODES)[number];
export const viewerModeSchema = z.enum(VIEWER_MODES);

export const MODERATION_ACTIONS = [
  "mute",
  "unmute",
  "kick",
  "approve",
  "reject",
  "promote", // speaker → guest
  "demote", // guest → speaker
  "role_change", // guest ↔ speaker (detail: from/to)
  "chat_hide",
  "chat_unhide",
  "chat_ban",
  "chat_unban",
] as const;
export type ModerationAction = (typeof MODERATION_ACTIONS)[number];

/* ────────────────────────────────────────────────────────────
 * 데이터 채널 이벤트 (LiveKit data channel payload)
 *   - 오디오 도달 보장 불변식의 핵심 채널
 * ──────────────────────────────────────────────────────────── */

export const DATA_TOPICS = {
  chat: "chat",
  signal: "signal", // 서버→클라이언트 제어 신호
  audioReport: "audio_report", // 클라이언트→서버 수신 리포트
} as const;

export const SIGNAL_EVENTS = {
  RESUBSCRIBE_AUDIO: "RESUBSCRIBE_AUDIO",
  PERMISSIONS_UPDATED: "PERMISSIONS_UPDATED",
  KICKED: "KICKED",
  ROOM_ENDED: "ROOM_ENDED",
  QUEUE_UPDATED: "QUEUE_UPDATED", // host 에게 승인 큐 갱신 트리거(진실은 GET)
  EGRESS_FALLBACK: "EGRESS_FALLBACK", // HLS egress 실패 → viewer_mode 자동 A 폴백, host 알림
  ROOM_ENDING: "ROOM_ENDING", // host 유예 만료 임박 → 곧 방 종료(재접속 금지 신호)
  CHAT_MODERATED: "CHAT_MODERATED", // 채팅 숨김/해제 실시간 반영(payload: hiddenIds/unhiddenIds)
} as const;
export type SignalEvent = (typeof SIGNAL_EVENTS)[keyof typeof SIGNAL_EVENTS];

// 클라이언트가 주기 발송하는 오디오 수신 리포트 (Phase 3 전수검증 근간)
export const audioRxReportSchema = z.object({
  type: z.literal("AUDIO_RX_REPORT"),
  participantIdentity: z.string(),
  subscribedAudioTrackSids: z.array(z.string()),
  ts: z.number(),
});
export type AudioRxReport = z.infer<typeof audioRxReportSchema>;

export const signalMessageSchema = z.object({
  event: z.enum([
    SIGNAL_EVENTS.RESUBSCRIBE_AUDIO,
    SIGNAL_EVENTS.PERMISSIONS_UPDATED,
    SIGNAL_EVENTS.KICKED,
    SIGNAL_EVENTS.ROOM_ENDED,
    SIGNAL_EVENTS.QUEUE_UPDATED,
    SIGNAL_EVENTS.EGRESS_FALLBACK,
    SIGNAL_EVENTS.ROOM_ENDING,
    SIGNAL_EVENTS.CHAT_MODERATED,
  ]),
  payload: z.record(z.unknown()).optional(),
});
export type SignalMessage = z.infer<typeof signalMessageSchema>;

/**
 * 오디오 도달 경고(host 배지용). 두 종류:
 *   - missing_subscription: 특정 참가자가 특정 오디오 트랙을 30초+ 미구독
 *   - stale_report: 참가자가 30초+ 무보고(크래시·백그라운드 등 사각지대)
 */
export interface AudioAlertDto {
  kind: "missing_subscription" | "stale_report";
  participantId: string;
  nickname: string;
  trackSid?: string;
  ageMs: number;
}

/* ────────────────────────────────────────────────────────────
 * Phase 4: 채팅 · HLS egress · 시청자 수
 * ──────────────────────────────────────────────────────────── */

// 채팅 메시지 최대 길이(서버·클라 공통 상수).
export const CHAT_MAX_LEN = 500;
// 유저당 채팅 rate limit: 이 창(ms) 안에서 1건.
export const CHAT_RATE_WINDOW_MS = 1000;

// 클라이언트 → 서버 채팅 전송 바디.
export const sendChatSchema = z.object({
  text: z.string().min(1).max(CHAT_MAX_LEN),
});
export type SendChatInput = z.infer<typeof sendChatSchema>;

/**
 * 서버가 저장·부여하는 채팅 메시지(순서의 단일 진실).
 *   - id 는 단조 증가(cursor) — 모드 B 폴링의 `after` 커서.
 *   - 전파: 모드 A = data channel(topic=chat) push, 모드 B = GET 폴링.
 */
export interface ChatMessageDto {
  id: number;
  roomId: string;
  userId: string;
  nickname: string;
  text: string;
  createdAt: string;
  hidden?: boolean; // host 요청 응답에서만 채워짐(운영 UI 표시용)
}

// data channel(topic=chat)로 실시간 push 되는 페이로드.
export const chatPushSchema = z.object({
  type: z.literal("CHAT"),
  message: z.object({
    id: z.number(),
    roomId: z.string(),
    userId: z.string(),
    nickname: z.string(),
    text: z.string(),
    createdAt: z.string(),
  }),
});
export type ChatPush = z.infer<typeof chatPushSchema>;

// GET /rooms/:id/chat 응답. viewerCount 겸용(모드 B 는 이 폴링이 heartbeat).
//   hiddenIds: 최근 창 내 hidden=true 인 id 스냅샷(모드 B 수렴용, 멱등).
//   cursor: 최신 메시지 id(다음 폴링의 after 힌트).
export interface ChatListDto {
  messages: ChatMessageDto[];
  viewerCount: number;
  hiddenIds: number[];
  cursor: number;
}

// egress 상태 머신: none→starting→active→ending / failed.
export const EGRESS_STATUSES = [
  "none",
  "starting",
  "active",
  "ending",
  "failed",
] as const;
export type EgressStatus = (typeof EGRESS_STATUSES)[number];

export interface ViewerCountDto {
  count: number;
  mode: ViewerMode;
}

// HLS 재생 정보(모드 B). playlistUrl 은 정적 서빙 경로.
export interface HlsInfoDto {
  mode: ViewerMode;
  egressStatus: EgressStatus;
  playlistUrl: string | null;
}

/* ────────────────────────────────────────────────────────────
 * API 요청/응답 스키마
 * ──────────────────────────────────────────────────────────── */

// 제어문자(개행·탭·NUL 등) 금지 — 레이아웃 깨짐/로그 인젝션 방지. (A-2-1)
const noControlChars = /^[^\u0000-\u001f\u007f]+$/;

export const createUserSchema = z.object({
  nickname: z.string().trim().min(1).max(40).regex(noControlChars, {
    message: "닉네임에 제어문자를 포함할 수 없습니다.",
  }),
});

export const createRoomSchema = z.object({
  title: z.string().trim().min(1).max(120).regex(noControlChars, {
    message: "제목에 제어문자를 포함할 수 없습니다.",
  }),
  maxGuests: z.number().int().min(1).max(16).default(8),
  maxSpeakers: z.number().int().min(0).max(50).default(20),
  viewerMode: viewerModeSchema.default("webrtc"),
});
export type CreateRoomInput = z.infer<typeof createRoomSchema>;

// 승격/전환 대상 publish 역할(host 가 결정).
export const publishRoleSchema = z.enum(["guest", "speaker"]);
export type PublishRole = z.infer<typeof publishRoleSchema>;

export const approveBodySchema = z.object({
  role: publishRoleSchema.default("guest"),
});
export const roleChangeSchema = z.object({
  role: publishRoleSchema,
});

export const issueTokenSchema = z.object({
  role: roleSchema,
  // 승인 대기실 입장 등에서 특정 방/사용자 식별
  identity: z.string().optional(),
});
export type IssueTokenInput = z.infer<typeof issueTokenSchema>;

export const tokenResponseSchema = z.object({
  token: z.string(),
  url: z.string(),
  identity: z.string(),
  role: roleSchema,
  expiresAt: z.number(),
});
export type TokenResponse = z.infer<typeof tokenResponseSchema>;

export interface RoomDto {
  id: string;
  hostId: string;
  title: string;
  status: RoomStatus;
  maxGuests: number;
  maxSpeakers: number;
  viewerMode: ViewerMode;
  egressStatus: EgressStatus;
  createdAt: string;
  endedAt: string | null;
}

export interface ParticipantDto {
  userId: string;
  nickname: string;
  role: Role;
  state: ParticipantState;
  joinedAt: string | null;
  leftAt: string | null;
}

export interface RoomDetailDto extends RoomDto {
  participants: ParticipantDto[];
}

/* ── Phase 2: 초대 · 승인 · 오디오 리포트 ─────────────────── */

export const joinRequestSchema = z.object({
  code: z.string().min(1),
});
export type JoinRequestInput = z.infer<typeof joinRequestSchema>;

export interface InviteResponse {
  code: string;
  expiresAt: number;
}

// 클라이언트 → 서버 오디오 수신 리포트 (HTTP).
// (LiveKit data channel 은 서버가 room 참가자가 아니라 수신 불가 → 리포트는 HTTP 로 보고,
//  서버→클라이언트 RESUBSCRIBE_AUDIO 지시는 RoomServiceClient.sendData 로 전송)
export const audioReportRequestSchema = z.object({
  subscribedAudioTrackSids: z.array(z.string()),
});
export type AudioReportRequest = z.infer<typeof audioReportRequestSchema>;

export interface AudioReportResult {
  ok: boolean;
  missingTrackSids: string[]; // 수신했어야 하나 누락된 오디오 트랙
}

export interface JoinRequestDto {
  userId: string;
  nickname: string;
  requestedAt: string | null;
}

/* ────────────────────────────────────────────────────────────
 * grant 매핑 (역할 → LiveKit VideoGrant 권한 요약)
 *   실제 토큰 발급은 api 의 livekit 서비스에서 수행.
 * ──────────────────────────────────────────────────────────── */

export interface RoleGrant {
  canPublish: boolean;
  canSubscribe: boolean;
  canPublishData: boolean;
  audioOnly?: boolean; // speaker: 마이크만 publish
}

export const ROLE_GRANTS: Record<Role, RoleGrant> = {
  host: { canPublish: true, canSubscribe: true, canPublishData: true },
  guest: { canPublish: true, canSubscribe: true, canPublishData: true },
  speaker: {
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    audioOnly: true,
  },
  viewer: { canPublish: false, canSubscribe: true, canPublishData: true },
};

export const DEFAULT_MAX_GUESTS = 8;
export const DEFAULT_MAX_SPEAKERS = 20;

/**
 * 에러 코드 카탈로그(C-2) — 전 엔드포인트가 `{ error: <code> }` 단일 flat 스키마를 반환한다.
 * (중첩 `{error:{code,message}}` 는 채택하지 않음: 기존 계약이 이미 flat·단일 형태로 일관되며,
 *  래핑 변경은 클라이언트 분기·검증 자산 전반을 깨뜨리는 반면 이득이 미미하기 때문.)
 * 클라이언트 분기는 이 상수를 참조한다.
 */
export const ERROR_CODES = {
  // 공통/검증
  invalidBody: "invalid_body",
  invalidId: "invalid_id",
  invalidMessageId: "invalid_message_id",
  invalidHlsPath: "invalid_hls_path",
  internalError: "internal_error",
  rateLimited: "rate_limited",
  // 인증/권한
  unauthorized: "unauthorized",
  hostOnly: "host_only",
  kicked: "kicked",
  approvalRequired: "approval_required",
  // 방/참가자
  roomNotFound: "room_not_found",
  roomEnded: "room_ended",
  demoRoomCap: "demo_room_cap",
  participantNotFound: "participant_not_found",
  participantNotConnected: "participant_not_connected",
  hostCannotRequest: "host_cannot_request",
  cannotKickHost: "cannot_kick_host",
  notApprovedPublisher: "not_approved_publisher",
  alreadyApprovedOtherRole: "already_approved_other_role",
  // 초대
  invalidInvite: "invalid_invite",
  invalidSignature: "invalid_signature",
  // 채팅
  chatBanned: "chat_banned",
  cannotBanHost: "cannot_ban_host",
  messageNotFound: "message_not_found",
} as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/* ────────────────────────────────────────────────────────────
 * Phase 5: 재접속 판정 (토큰 만료 등 일시적 단절만 재접속)
 *   livekit-client DisconnectReason 숫자값과 정합.
 * ──────────────────────────────────────────────────────────── */
export const DISCONNECT_REASON = {
  UNKNOWN_REASON: 0,
  CLIENT_INITIATED: 1, // 의도적 종료 → 재접속 금지
  DUPLICATE_IDENTITY: 2, // 다른 기기 접속이 이김 → 재접속 금지(핑퐁 방지)
  SERVER_SHUTDOWN: 3,
  PARTICIPANT_REMOVED: 4, // 강퇴 → 재접속 금지
  ROOM_DELETED: 5, // 방 종료 → 재접속 금지
  STATE_MISMATCH: 6,
  JOIN_FAILURE: 7,
  MIGRATION: 8, // 클라이언트가 자체 처리
  SIGNAL_CLOSE: 9,
} as const;

// allowlist 방식(신규 reason 코드에 대해 기본 '재접속 안 함' → 우발적 핑퐁 방지).
// 토큰 만료/일시 단절은 UNKNOWN/STATE_MISMATCH/JOIN_FAILURE/SIGNAL_CLOSE 로 표출.
const RECONNECT_ELIGIBLE: ReadonlySet<number> = new Set([
  DISCONNECT_REASON.UNKNOWN_REASON,
  DISCONNECT_REASON.STATE_MISMATCH,
  DISCONNECT_REASON.JOIN_FAILURE,
  DISCONNECT_REASON.SIGNAL_CLOSE,
]);

/**
 * Disconnected 시 서버에서 새 토큰을 받아 재접속할지 결정.
 * roomEnding(ROOM_ENDING 신호 수신) 이면 무조건 재접속 안 함.
 * DUPLICATE_IDENTITY/CLIENT_INITIATED/PARTICIPANT_REMOVED/ROOM_DELETED 는 제외(핑퐁·오작동 방지).
 */
export function shouldReconnectOnDisconnect(
  reason: number | undefined,
  roomEnding: boolean,
): boolean {
  if (roomEnding) return false;
  if (reason === undefined) return true; // 이유 불명(네트워크 단절 등) → 재접속 시도
  return RECONNECT_ELIGIBLE.has(reason);
}

export const MAX_RECONNECT_ATTEMPTS = 3;

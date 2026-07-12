import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  createRoomSchema,
  roleSchema,
  joinRequestSchema,
  audioReportRequestSchema,
  sendChatSchema,
  approveBodySchema,
  roleChangeSchema,
  SIGNAL_EVENTS,
  type PublishRole,
  type JoinRequestDto,
  type ChatListDto,
  type ViewerCountDto,
  type HlsInfoDto,
} from "@multi-live/shared";
import { config } from "../config.js";
import { requireAuth } from "../plugins/authGuard.js";
import { limitPerUser } from "../plugins/rateLimit.js";
import {
  createRoomRecord,
  getRoom,
  getRoomDetail,
  endRoomRecord,
  getParticipant,
  countApprovedGuests,
  countApprovedByRole,
  logModeration,
} from "../services/rooms.js";
import {
  createLiveKitRoom,
  deleteLiveKitRoom,
  issueAccessToken,
  updateParticipantPermission,
  muteParticipantAudio,
  muteParticipantVideo,
  removeParticipant as lkRemoveParticipant,
  sendSignal,
  sendChat,
  countWebrtcViewers,
} from "../services/livekit.js";
import {
  ensureParticipant,
  ensureParticipantIfAbsent,
  markRoomLive,
  getPresentIdentities,
  touchHlsViewer,
  countHlsViewers,
} from "../services/roomState.js";
import {
  createInvite,
  resolveInvite,
  recordInviteUse,
} from "../services/invite.js";
import { checkAudioReach, getAudioAlerts } from "../services/audioReach.js";
import {
  postChat,
  getChatSnapshot,
  setChatHidden,
  isChatBanned,
  setChatBan,
  ChatRateLimitedError,
} from "../services/chat.js";
import { metrics } from "../services/metrics.js";
import { stopEgressForRoom, hlsPlaylistUrl } from "../services/egress.js";

// host 에게만 승인 큐 갱신을 트리거(진실은 GET). 미접속이면 무시.
async function notifyQueueUpdated(roomId: string, hostId: string) {
  try {
    await sendSignal(roomId, [hostId], { event: SIGNAL_EVENTS.QUEUE_UPDATED });
  } catch {
    /* host 미접속 — 폴링 fallback 이 메꾼다 */
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 승격 fast-path 신뢰화: host 가 게스트의 LiveKit 접속 완료 전에 승인하면
 * updateParticipant 가 "no response" 로 실패한다. 게스트가 곧 접속하므로
 * 백그라운드로 재시도해 canPublish 를 라이브 반영(PermissionsChanged) 시킨다.
 * (클라이언트 token-swap 재연결 경로를 제거한 대신 서버가 이 경로를 보장)
 */
function ensurePublishPermission(
  roomId: string,
  userId: string,
  role: PublishRole,
  attempts = 8,
  delayMs = 800,
) {
  void (async () => {
    for (let i = 0; i < attempts; i++) {
      try {
        await updateParticipantPermission(roomId, userId, role);
        return;
      } catch {
        await sleep(delayMs);
      }
    }
    console.warn(
      `[approve] updateParticipant 재시도 소진: room=${roomId} user=${userId} role=${role}`,
    );
  })();
}

// 토큰 요청 바디 — role 은 선택적. 서버가 최종 결정하며, guest/speaker 자기선언은 거부.
const tokenBodySchema = z.object({
  role: roleSchema.optional(),
});

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function roomRoutes(app: FastifyInstance) {
  // A-2-1: 경로 파라미터 id/userId 는 UUID 형식 강제(비정상 입력을 400 으로 조기 차단).
  //   messageId 는 숫자라 별도(각 핸들러에서 Number 검증).
  app.addHook("preValidation", async (req, reply) => {
    const p = (req.params ?? {}) as Record<string, string>;
    for (const key of ["id", "userId"] as const) {
      const v = p[key];
      if (v !== undefined && !UUID_RE.test(v)) {
        return reply.code(400).send({ error: "invalid_id" });
      }
    }
  });

  // ── 방 생성 (host) ─────────────────────────────────────────
  app.post("/rooms", { preHandler: requireAuth }, async (req, reply) => {
    const parsed = createRoomSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_body", issues: parsed.error.issues });
    }
    const room = await createRoomRecord(req.user!.sub, parsed.data);
    await createLiveKitRoom(room.id, room.maxGuests);
    return reply.code(201).send(room);
  });

  // ── 방 조회 (공개) ─────────────────────────────────────────
  app.get("/rooms/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const detail = await getRoomDetail(id);
    if (!detail) return reply.code(404).send({ error: "room_not_found" });
    return detail;
  });

  // ── 토큰 발급 (role 은 서버가 결정) ────────────────────────
  app.post(
    "/rooms/:id/token",
    { preHandler: requireAuth, config: limitPerUser(30) }, // A-3: 유저당 30/분
    async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = tokenBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_body", issues: parsed.error.issues });
    }

    // 유령 방 차단: DB 에 존재하지 않는 room 이름으로는 토큰을 발급하지 않는다.
    const room = await getRoom(id);
    if (!room) return reply.code(404).send({ error: "room_not_found" });
    if (room.status === "ended") {
      return reply.code(409).send({ error: "room_ended" });
    }

    const requested = parsed.data.role;
    const isHost = req.user!.sub === room.hostId;
    const part = isHost ? null : await getParticipant(room.id, req.user!.sub);

    // 강퇴/거절(state=kicked)된 사용자는 재승인 전까지 어떤 토큰도 못 받는다.
    // 초대코드를 갖고 있어도 join-request 부터 다시 타야 함.
    if (!isHost && part?.state === "kicked") {
      return reply.code(403).send({ error: "kicked" });
    }

    // 서버가 role 을 결정한다(자기선언 신뢰 금지).
    //   - host 본인 → host
    //   - guest/speaker 요청 → DB 가 approved 이고 role 이 일치할 때만 발급, 아니면 403
    //   - 그 외 → viewer
    let role: "host" | "guest" | "speaker" | "viewer";
    if (isHost) {
      role = "host";
    } else if (requested === "guest" || requested === "speaker") {
      // publish 토큰 요청 → 승인 상태이면 요청값이 아니라 DB 의 role 대로 발급(서버 권위).
      // guest 로 요청했어도 DB 가 speaker 면 speaker 토큰(오디오 전용)을 준다.
      if (
        part?.state === "approved" &&
        (part.role === "guest" || part.role === "speaker")
      ) {
        role = part.role;
      } else {
        return reply.code(403).send({
          error: "approval_required",
          message: "승인된 guest/speaker 만 해당 권한 토큰을 받을 수 있습니다.",
        });
      }
    } else {
      role = "viewer";
    }

    // host 는 승인상태로 upsert(권위적). viewer 는 기존 요청/승인 레코드를 덮지 않도록
    // '없을 때만' 삽입 — 대기실 입장용 viewer 토큰이 guest 요청을 강등시키면 안 됨.
    if (role === "host") {
      await ensureParticipant({
        roomId: room.id,
        userId: req.user!.sub,
        role,
        state: "approved",
      });
      await markRoomLive(room.id);
      // 모드 B(hls) egress 기동은 host 가 실제로 접속(track publish)한 뒤에 하는 게 안전하다.
      // 빈 방에서 room-composite 를 시작하면 egress 템플릿이 "Start signal not received"
      // 로 abort 되므로, participant_joined(host) webhook 시점에 기동한다(webhooks.ts).
    } else if (role === "viewer") {
      await ensureParticipantIfAbsent({
        roomId: room.id,
        userId: req.user!.sub,
        role,
        state: "approved",
      });
    }

    const { token, expiresAt } = await issueAccessToken({
      roomId: room.id,
      userId: req.user!.sub,
      nickname: req.user!.nickname,
      role,
    });

    return {
      token,
      url: config.livekit.wsUrl,
      identity: req.user!.sub,
      role,
      expiresAt,
    };
  });

  // ── 초대코드 발급 (host 전용) ──────────────────────────────
  app.post(
    "/rooms/:id/invite",
    { preHandler: requireAuth, config: limitPerUser(20) }, // A-3: 유저(host)당 20/분
    async (req, reply) => {
    const { id } = req.params as { id: string };
    const room = await getRoom(id);
    if (!room) return reply.code(404).send({ error: "room_not_found" });
    if (room.hostId !== req.user!.sub) {
      return reply.code(403).send({ error: "host_only" });
    }
    const invite = await createInvite(id);
    return invite;
  });

  // ── 승인 요청 (guest): 초대코드로 대기실 등록 → state=requested ──
  app.post(
    "/rooms/:id/join-requests",
    { preHandler: requireAuth, config: limitPerUser(10) }, // A-3: 유저당 10/분(승인 큐 스팸)
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = joinRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "invalid_body", issues: parsed.error.issues });
      }
      const room = await getRoom(id);
      if (!room) return reply.code(404).send({ error: "room_not_found" });
      if (room.status === "ended") {
        return reply.code(409).send({ error: "room_ended" });
      }
      const ok = await resolveInvite(parsed.data.code, id);
      if (!ok) return reply.code(403).send({ error: "invalid_invite" });

      // host 는 요청 불필요.
      if (room.hostId === req.user!.sub) {
        return reply.code(409).send({ error: "host_cannot_request" });
      }
      await recordInviteUse(parsed.data.code, req.user!.sub);

      // 상태 전이를 명시(Phase 6: 이전 role 유지):
      //   - 이미 approved(guest/speaker) → no-op(approved)
      //   - left(kicked 아님) → 이전 role 로 자동 재승인(해당 role 상한 검증, 자리 없으면 큐잉)
      //   - 그 외(신규 / kicked) → requested (재승인 절차 필요; role 은 host 가 승인 시 결정)
      const existing = await getParticipant(id, req.user!.sub);
      const prevRole =
        existing?.role === "speaker" ? "speaker" : ("guest" as PublishRole);
      const isReturning =
        (existing?.role === "guest" || existing?.role === "speaker") &&
        (existing.state === "approved" || existing.state === "left");

      if (
        existing?.state === "approved" &&
        (existing.role === "guest" || existing.role === "speaker")
      ) {
        return { state: "approved", role: existing.role };
      }

      if (isReturning) {
        // left → 이전 role 로 재승인 시도. 해당 role 슬롯이 남아야 즉시 approved.
        const cap = prevRole === "guest" ? room.maxGuests : room.maxSpeakers;
        const count = await countApprovedByRole(id, prevRole);
        if (count < cap) {
          await ensureParticipant({
            roomId: id,
            userId: req.user!.sub,
            role: prevRole,
            state: "approved",
          });
          await logModeration({
            roomId: id,
            actorId: room.hostId,
            targetId: req.user!.sub,
            action: "approve",
            detail: { role: prevRole, reentry: true },
          });
          await notifyQueueUpdated(id, room.hostId);
          return { state: "approved", role: prevRole };
        }
      }

      await ensureParticipant({
        roomId: id,
        userId: req.user!.sub,
        role: "guest",
        state: "requested",
      });
      await notifyQueueUpdated(id, room.hostId);
      return reply.code(201).send({ state: "requested" });
    },
  );

  // ── 대기 큐 조회 (host 전용, 3초 폴링) ─────────────────────
  app.get(
    "/rooms/:id/join-requests",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const room = await getRoom(id);
      if (!room) return reply.code(404).send({ error: "room_not_found" });
      if (room.hostId !== req.user!.sub) {
        return reply.code(403).send({ error: "host_only" });
      }
      const detail = await getRoomDetail(id);
      const queue: JoinRequestDto[] = (detail?.participants ?? [])
        .filter((p) => p.state === "requested")
        .map((p) => ({
          userId: p.userId,
          nickname: p.nickname,
          requestedAt: p.joinedAt,
        }));
      return { requests: queue };
    },
  );

  // ── 승인 (host 전용, 멱등) ─────────────────────────────────
  app.post(
    "/rooms/:id/guests/:userId/approve",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id, userId } = req.params as { id: string; userId: string };
      const room = await getRoom(id);
      if (!room) return reply.code(404).send({ error: "room_not_found" });
      if (room.hostId !== req.user!.sub) {
        return reply.code(403).send({ error: "host_only" });
      }
      const parsedBody = approveBodySchema.safeParse(req.body ?? {});
      if (!parsedBody.success) {
        return reply
          .code(400)
          .send({ error: "invalid_body", issues: parsedBody.error.issues });
      }
      const approveRole = parsedBody.data.role; // 기본 guest(하위호환)

      const part = await getParticipant(id, userId);
      if (!part) return reply.code(404).send({ error: "participant_not_found" });

      // 멱등: 이미 같은 role 로 승인됨 → no-op.
      if (part.state === "approved" && part.role === approveRole) {
        return { state: "approved", role: approveRole, idempotent: true };
      }
      // 이미 승인됐는데 다른 role 로 approve → 경로 단일화(전환 API 로만 변경).
      if (
        part.state === "approved" &&
        (part.role === "guest" || part.role === "speaker")
      ) {
        return reply.code(409).send({
          error: "already_approved_other_role",
          message:
            "이미 승인된 참가자입니다. role 변경은 role 전환 API 를 사용하세요.",
          currentRole: part.role,
        });
      }

      // role 별 슬롯 검증(guest/speaker 상한은 서로 분리).
      const cap = approveRole === "guest" ? room.maxGuests : room.maxSpeakers;
      const count = await countApprovedByRole(id, approveRole);
      if (count >= cap) {
        return reply
          .code(409)
          .send({ error: `max_${approveRole}s_reached` });
      }

      // 순서 고정: ① DB 상태 변경 → ② LiveKit updateParticipant.
      //   역순이면 승격 직후 guest 가 /token 을 쳤을 때 아직 403 이 나오는 창이 생긴다.
      await ensureParticipant({
        roomId: id,
        userId,
        role: approveRole,
        state: "approved",
      });
      // 대기실에 접속(viewer)해 있다면 재연결 없이 publish 권한으로 라이브 승격.
      // 아직 접속 중이면 백그라운드 재시도가 접속 완료 시점에 반영한다.
      ensurePublishPermission(id, userId, approveRole);
      await logModeration({
        roomId: id,
        actorId: req.user!.sub,
        targetId: userId,
        action: "approve",
        detail: { role: approveRole },
      });
      await notifyQueueUpdated(id, room.hostId);
      return { state: "approved", role: approveRole };
    },
  );

  // ── 거절 (host 전용) ───────────────────────────────────────
  app.post(
    "/rooms/:id/guests/:userId/reject",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id, userId } = req.params as { id: string; userId: string };
      const room = await getRoom(id);
      if (!room) return reply.code(404).send({ error: "room_not_found" });
      if (room.hostId !== req.user!.sub) {
        return reply.code(403).send({ error: "host_only" });
      }
      const part = await getParticipant(id, userId);
      if (!part) return reply.code(404).send({ error: "participant_not_found" });

      // state=kicked 로 큐에서 제거 → 이후 guest role /token 요청은 403 유지.
      await ensureParticipant({
        roomId: id,
        userId,
        role: "viewer",
        state: "kicked",
      });
      // 접속 중이면 publish 권한 회수(viewer 로 강등).
      try {
        await updateParticipantPermission(id, userId, "viewer");
      } catch {
        /* 미접속이면 무시 */
      }
      await logModeration({
        roomId: id,
        actorId: req.user!.sub,
        targetId: userId,
        action: "reject",
      });
      await notifyQueueUpdated(id, room.hostId);
      return { state: "rejected" };
    },
  );

  // ── 역할 전환 guest ↔ speaker (host 전용) ──────────────────
  //   순서: 슬롯검증 → DB role → updateParticipant(grant+metadata) → (강등 시) 비디오 강제.
  app.post(
    "/rooms/:id/participants/:userId/role",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id, userId } = req.params as { id: string; userId: string };
      const parsed = roleChangeSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "invalid_body", issues: parsed.error.issues });
      }
      const toRole = parsed.data.role;
      const room = await getRoom(id);
      if (!room) return reply.code(404).send({ error: "room_not_found" });
      if (room.hostId !== req.user!.sub) {
        return reply.code(403).send({ error: "host_only" });
      }
      const part = await getParticipant(id, userId);
      if (!part) return reply.code(404).send({ error: "participant_not_found" });
      // approved 참가자만 대상.
      if (part.state !== "approved" || (part.role !== "guest" && part.role !== "speaker")) {
        return reply.code(409).send({ error: "not_approved_publisher" });
      }
      const fromRole = part.role as PublishRole;
      // 멱등: 동일 role → no-op.
      if (fromRole === toRole) {
        return { role: toRole, idempotent: true };
      }
      // 대상 role 슬롯 검증.
      const cap = toRole === "guest" ? room.maxGuests : room.maxSpeakers;
      const count = await countApprovedByRole(id, toRole);
      if (count >= cap) {
        return reply.code(409).send({ error: `max_${toRole}s_reached` });
      }

      // ① DB role 갱신(권위).
      await ensureParticipant({
        roomId: id,
        userId,
        role: toRole,
        state: "approved",
      });
      // ② LiveKit grant + metadata 교체(접속 중이면 즉시, 아니면 백그라운드 재시도).
      let connected = true;
      try {
        await updateParticipantPermission(id, userId, toRole);
      } catch {
        connected = false;
        ensurePublishPermission(id, userId, toRole);
      }
      // ③ guest→speaker 강등: 비디오 트랙을 서버가 강제 정리(클라 협조에 의존하지 않음).
      let videoEnforced: string[] = [];
      if (toRole === "speaker" && connected) {
        try {
          videoEnforced = await muteParticipantVideo(id, userId);
        } catch {
          /* 미접속/트랙없음 무시 */
        }
      }
      await logModeration({
        roomId: id,
        actorId: req.user!.sub,
        targetId: userId,
        action: "role_change",
        detail: { from: fromRole, to: toRole, videoEnforced },
      });
      return { role: toRole, from: fromRole, videoEnforced };
    },
  );

  // ── 음소거 (host 전용) ─────────────────────────────────────
  //   비대칭: 서버는 mute 만 가능, 원격 unmute 불가 → 다시 켜기는 guest 본인만.
  app.post(
    "/rooms/:id/guests/:userId/mute",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id, userId } = req.params as { id: string; userId: string };
      const room = await getRoom(id);
      if (!room) return reply.code(404).send({ error: "room_not_found" });
      if (room.hostId !== req.user!.sub) {
        return reply.code(403).send({ error: "host_only" });
      }
      let muted = 0;
      try {
        muted = await muteParticipantAudio(id, userId);
      } catch {
        return reply.code(404).send({ error: "participant_not_connected" });
      }
      await logModeration({
        roomId: id,
        actorId: req.user!.sub,
        targetId: userId,
        action: "mute",
      });
      return { muted };
    },
  );

  // ── 강퇴 (host 전용) ───────────────────────────────────────
  //   removeParticipant + DB state=kicked → 이후 /token 403(재승인 전까지).
  app.post(
    "/rooms/:id/guests/:userId/kick",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id, userId } = req.params as { id: string; userId: string };
      const room = await getRoom(id);
      if (!room) return reply.code(404).send({ error: "room_not_found" });
      if (room.hostId !== req.user!.sub) {
        return reply.code(403).send({ error: "host_only" });
      }
      if (userId === room.hostId) {
        return reply.code(409).send({ error: "cannot_kick_host" });
      }
      // 순서: DB 상태 먼저 → 강제 disconnect. (역순이면 재접속 창 발생)
      await ensureParticipant({
        roomId: id,
        userId,
        role: "viewer",
        state: "kicked",
      });
      try {
        await lkRemoveParticipant(id, userId);
      } catch {
        /* 미접속이면 무시 */
      }
      await logModeration({
        roomId: id,
        actorId: req.user!.sub,
        targetId: userId,
        action: "kick",
      });
      return { state: "kicked" };
    },
  );

  // ── 오디오 도달 경고 (host 전용, 배지용) ───────────────────
  app.get(
    "/rooms/:id/alerts",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const room = await getRoom(id);
      if (!room) return reply.code(404).send({ error: "room_not_found" });
      if (room.hostId !== req.user!.sub) {
        return reply.code(403).send({ error: "host_only" });
      }
      const detail = await getRoomDetail(id);
      const nameById = new Map(
        (detail?.participants ?? []).map((p) => [p.userId, p.nickname]),
      );
      const present = await getPresentIdentities(id);
      const alerts = await getAudioAlerts(
        id,
        present,
        (uid) => nameById.get(uid) ?? uid.slice(0, 6),
        Date.now(),
      );
      return { alerts };
    },
  );

  // ── 오디오 수신 리포트 (모든 참가자) ───────────────────────
  app.post(
    "/rooms/:id/audio-report",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = audioReportRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "invalid_body", issues: parsed.error.issues });
      }
      const missing = await checkAudioReach(
        id,
        req.user!.sub,
        parsed.data.subscribedAudioTrackSids,
        Date.now(),
      );
      return { ok: missing.length === 0, missingTrackSids: missing };
    },
  );

  // ── 채팅 전송 (모든 참가자, 서버 경유 단일화) ──────────────
  //   저장(순서의 단일 진실) → 전파 이원화: 모드 A = data channel push,
  //   모드 B 시청자는 GET 폴링으로 수신(서버가 room 참가자가 아닌 HLS 시청자에 push 불가).
  app.post("/rooms/:id/chat", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = sendChatSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_body", issues: parsed.error.issues });
    }
    const room = await getRoom(id);
    if (!room) return reply.code(404).send({ error: "room_not_found" });
    if (room.status === "ended") {
      return reply.code(409).send({ error: "room_ended" });
    }

    // 차단 유저는 rate limit 보다 먼저 평가 → 403.
    if (await isChatBanned(id, req.user!.sub)) {
      metrics.chatBannedRejected();
      return reply.code(403).send({ error: "chat_banned" });
    }

    let message;
    try {
      message = await postChat({
        roomId: id,
        userId: req.user!.sub,
        nickname: req.user!.nickname,
        text: parsed.data.text,
      });
    } catch (err) {
      if (err instanceof ChatRateLimitedError) {
        metrics.chatRateLimited();
        return reply.code(429).send({ error: "rate_limited" });
      }
      throw err;
    }

    // 모드 A(및 room 참가자 전원)에 실시간 push. HLS 시청자는 폴링이 메꾼다.
    try {
      await sendChat(id, message);
    } catch {
      /* room 미접속/전파 실패는 저장을 무효화하지 않음(폴링이 복구) */
    }
    return reply.code(201).send(message);
  });

  // ── 채팅 조회 + 시청자 수 (폴링, 모드 B heartbeat 겸용) ─────
  app.get("/rooms/:id/chat", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const room = await getRoom(id);
    if (!room) return reply.code(404).send({ error: "room_not_found" });

    const q = req.query as { after?: string };
    const after =
      q.after !== undefined && q.after !== "" ? Number(q.after) : undefined;
    // host 는 hidden 메시지를 플래그와 함께 받아 운영 UI 로 렌더(해제 경로 제공).
    const asHost = req.user!.sub === room.hostId;
    // B-1: 1초 마이크로 캐시(시청자 수 무관 방당 DB 조회 ≤1/초).
    const { messages, hiddenIds, cursor } = await getChatSnapshot(
      id,
      after,
      asHost,
    );

    // 모드 B: 이 폴링을 시청자 heartbeat 로 겸용(엔드포인트 절약).
    const now = Date.now();
    const viewerCount =
      room.viewerMode === "hls"
        ? await touchHlsViewer(id, req.user!.sub, now)
        : await countWebrtcViewers(id).catch(() => 0);

    const body: ChatListDto = { messages, viewerCount, hiddenIds, cursor };
    return body;
  });

  // ── 채팅 숨김/해제 (host 전용) ─────────────────────────────
  //   tombstone(레코드 삭제 없음). 처리 후 CHAT_MODERATED 브로드캐스트(모드 A 실시간).
  for (const kind of ["hide", "unhide"] as const) {
    app.post(
      `/rooms/:id/chat/:messageId/${kind}`,
      { preHandler: requireAuth },
      async (req, reply) => {
        const { id, messageId } = req.params as {
          id: string;
          messageId: string;
        };
        const room = await getRoom(id);
        if (!room) return reply.code(404).send({ error: "room_not_found" });
        if (room.hostId !== req.user!.sub) {
          return reply.code(403).send({ error: "host_only" });
        }
        const mid = Number(messageId);
        if (!Number.isFinite(mid)) {
          return reply.code(400).send({ error: "invalid_message_id" });
        }
        const hidden = kind === "hide";
        const ok = await setChatHidden(id, mid, hidden);
        if (!ok) return reply.code(404).send({ error: "message_not_found" });

        if (hidden) metrics.chatHidden();
        else metrics.chatUnhidden();
        await logModeration({
          roomId: id,
          actorId: req.user!.sub,
          action: hidden ? "chat_hide" : "chat_unhide",
          detail: { messageId: mid },
        });
        // 모드 A 실시간 반영(모드 B 는 GET 스냅샷으로 수렴).
        try {
          await sendSignal(id, [], {
            event: SIGNAL_EVENTS.CHAT_MODERATED,
            payload: hidden ? { hiddenIds: [mid] } : { unhiddenIds: [mid] },
          });
        } catch {
          /* 전파 실패는 히스토리 재로드로 수렴 */
        }
        return { messageId: mid, hidden };
      },
    );
  }

  // ── 채팅 차단 / 해제 (host 전용) ───────────────────────────
  app.post(
    "/rooms/:id/chat-bans/:userId",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id, userId } = req.params as { id: string; userId: string };
      const room = await getRoom(id);
      if (!room) return reply.code(404).send({ error: "room_not_found" });
      if (room.hostId !== req.user!.sub) {
        return reply.code(403).send({ error: "host_only" });
      }
      if (userId === room.hostId) {
        return reply.code(400).send({ error: "cannot_ban_host" });
      }
      const ok = await setChatBan(id, userId, true);
      if (!ok) return reply.code(404).send({ error: "participant_not_found" });
      metrics.chatBan();
      await logModeration({
        roomId: id,
        actorId: req.user!.sub,
        targetId: userId,
        action: "chat_ban",
      });
      return { userId, chatBanned: true };
    },
  );

  app.delete(
    "/rooms/:id/chat-bans/:userId",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id, userId } = req.params as { id: string; userId: string };
      const room = await getRoom(id);
      if (!room) return reply.code(404).send({ error: "room_not_found" });
      if (room.hostId !== req.user!.sub) {
        return reply.code(403).send({ error: "host_only" });
      }
      const ok = await setChatBan(id, userId, false);
      if (!ok) return reply.code(404).send({ error: "participant_not_found" });
      await logModeration({
        roomId: id,
        actorId: req.user!.sub,
        targetId: userId,
        action: "chat_unban",
      });
      return { userId, chatBanned: false };
    },
  );

  // ── 시청자 수 (배지용, 경량) ──────────────────────────────
  app.get(
    "/rooms/:id/viewer-count",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const room = await getRoom(id);
      if (!room) return reply.code(404).send({ error: "room_not_found" });
      const count =
        room.viewerMode === "hls"
          ? await countHlsViewers(id, Date.now())
          : await countWebrtcViewers(id).catch(() => 0);
      const body: ViewerCountDto = { count, mode: room.viewerMode };
      return body;
    },
  );

  // ── HLS 재생 정보 (모드 B 시청자) ──────────────────────────
  app.get("/rooms/:id/hls", async (req, reply) => {
    const { id } = req.params as { id: string };
    const room = await getRoom(id);
    if (!room) return reply.code(404).send({ error: "room_not_found" });
    const body: HlsInfoDto = {
      mode: room.viewerMode,
      egressStatus: room.egressStatus,
      playlistUrl:
        room.viewerMode === "hls" && room.egressStatus === "active"
          ? hlsPlaylistUrl(id)
          : null,
    };
    return body;
  });

  // ── 방 종료 (host 전용) ────────────────────────────────────
  app.post("/rooms/:id/end", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const room = await getRoom(id);
    if (!room) return reply.code(404).send({ error: "room_not_found" });
    if (room.hostId !== req.user!.sub) {
      return reply.code(403).send({ error: "host_only" });
    }
    // 과금·리소스 누수 방지: 방 종료 시 egress 먼저 중지.
    await stopEgressForRoom(id);
    await endRoomRecord(id);
    // LiveKit room 삭제 → 전원 disconnect.
    await deleteLiveKitRoom(id);
    return { status: "ended", roomId: id };
  });
}

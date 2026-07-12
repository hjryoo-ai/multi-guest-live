import type { FastifyInstance } from "fastify";
import { EgressStatus as LkEgressStatus } from "livekit-server-sdk";
import { isAudioTrack, receiveWebhook } from "../services/livekit.js";
import {
  addPublishedAudioTrack,
  markParticipantJoined,
  markParticipantLeft,
  markRoomEnded,
  markRoomLive,
  removePublishedAudioTrack,
} from "../services/roomState.js";
import { getRoom, setEgressState } from "../services/rooms.js";
import {
  ensureEgressStarted,
  stopEgressForRoom,
  notifyFallback,
} from "../services/egress.js";
import { metrics } from "../services/metrics.js";
import { markHostGone, clearHostGone } from "../services/hostGrace.js";

// event.createdAt(초) 파싱 — bigint/number/string 모두 방어.
function eventTs(createdAt: unknown): number {
  const n = Number(createdAt);
  return Number.isFinite(n) && n > 0 ? n : Math.floor(Date.now() / 1000);
}

// uuid 형식 검사. load-test 등 우리 API 를 거치지 않은 참가자는 non-uuid identity/room 으로
// 오므로(users/rooms FK 없음), 이를 걸러 FK 위반 대신 관대하게 skip 한다.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s?: string): boolean => !!s && UUID_RE.test(s);

export async function webhookRoutes(app: FastifyInstance) {
  // LiveKit 은 application/webhook+json 으로 전송. 서명검증을 위해 raw body 를 보존.
  app.addContentTypeParser(
    "application/webhook+json",
    { parseAs: "string" },
    (_req, body, done) => done(null, body),
  );

  app.post("/webhooks/livekit", async (req, reply) => {
    let event;
    try {
      event = await receiveWebhook(
        req.body as string,
        req.headers.authorization,
      );
    } catch (err) {
      app.log.warn({ err }, "livekit webhook signature verification failed");
      return reply.code(401).send({ error: "invalid_signature" });
    }

    const roomId = event.room?.name;
    const ts = eventTs(event.createdAt);

    try {
      switch (event.event) {
        case "room_started":
          if (roomId) await markRoomLive(roomId);
          break;

        case "room_finished":
          // host 가 /end 없이 이탈해 empty timeout 으로 닫힌 경우도 여기서 ENDED 반영.
          if (roomId) {
            // 과금·리소스 누수 방지: 방이 끝나면 egress 반드시 중지.
            await stopEgressForRoom(roomId);
            await markRoomEnded(roomId, new Date(ts * 1000));
          }
          break;

        case "participant_joined": {
          const id = event.participant?.identity;
          if (roomId && id) {
            // 미등록(외부) 참가자는 FK 오염 방지를 위해 skip + 별도 카운터(에러 아님).
            if (!isUuid(id) || !isUuid(roomId)) {
              metrics.webhookUnknownIdentity();
              break;
            }
            await markParticipantJoined(roomId, id, ts);
            const room = await getRoom(roomId);
            if (room && room.hostId === id) {
              // host 복귀 → 이탈 유예 취소.
              await clearHostGone(roomId);
              // 모드 B(hls): host 실제 접속 시점에 egress 기동(빈 방 abort 방지).
              void ensureEgressStarted(room);
            }
          }
          break;
        }

        case "participant_left":
          if (roomId && event.participant?.identity) {
            const id = event.participant.identity;
            if (!isUuid(id) || !isUuid(roomId)) {
              metrics.webhookUnknownIdentity();
              break;
            }
            await markParticipantLeft(roomId, id, ts);
            // host 이탈 → 유예 시작(HOST_GRACE_SEC 내 미복귀 시 스위퍼가 방 종료).
            const room = await getRoom(roomId);
            if (room && room.hostId === id && room.status !== "ended") {
              await markHostGone(roomId, ts * 1000);
            }
          }
          break;

        case "track_published":
          if (
            roomId &&
            event.participant?.identity &&
            event.track?.sid &&
            isAudioTrack(event.track.type)
          ) {
            await addPublishedAudioTrack(
              roomId,
              event.participant.identity,
              event.track.sid,
            );
          }
          break;

        case "track_unpublished":
          if (roomId && event.track?.sid) {
            await removePublishedAudioTrack(roomId, event.track.sid);
          }
          break;

        // ── HLS egress(모드 B) 상태 반영 ─────────────────────
        //   egress 이벤트는 top-level room 대신 egressInfo.roomName 에 방을 담는다.
        case "egress_started":
        case "egress_updated": {
          const eg = event.egressInfo;
          const rid = eg?.roomName ?? roomId;
          if (rid && eg && eg.status === LkEgressStatus.EGRESS_ACTIVE) {
            await setEgressState(rid, "active", eg.egressId);
          }
          break;
        }

        case "egress_ended": {
          const eg = event.egressInfo;
          const rid = eg?.roomName ?? roomId;
          if (rid && eg) {
            const failed =
              eg.status === LkEgressStatus.EGRESS_FAILED ||
              eg.status === LkEgressStatus.EGRESS_ABORTED ||
              eg.status === LkEgressStatus.EGRESS_LIMIT_REACHED;
            if (failed) {
              // egress 비정상 종료 → 모드 A 폴백 + host 알림.
              const room = await getRoom(rid);
              if (room) await notifyFallback(rid, room.hostId, "egress_ended");
            } else {
              await setEgressState(rid, "none", null);
            }
          }
          break;
        }

        default:
          // 그 외 이벤트는 무시 (멱등/무해).
          break;
      }
    } catch (err) {
      app.log.error({ err, event: event.event }, "webhook handler failed");
      metrics.webhookError(event.event ?? "unknown");
      // 200 을 돌려주어 LiveKit 의 과도한 재시도를 피하되, 로깅으로 추적.
    }

    return { received: true };
  });
}

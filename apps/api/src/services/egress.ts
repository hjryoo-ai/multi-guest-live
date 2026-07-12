import {
  EgressClient,
  SegmentedFileOutput,
  SegmentedFileProtocol,
} from "livekit-server-sdk";
import { SIGNAL_EVENTS, type RoomDto } from "@multi-live/shared";
import { config } from "../config.js";
import { livekitRoomName, sendSignal } from "./livekit.js";
import { setEgressState, fallbackToWebrtc, getEgressId } from "./rooms.js";
import { metrics } from "./metrics.js";

/**
 * HLS egress(모드 B) — LiveKit Room Composite → HLS 세그먼트 직접 출력.
 *
 * 파이프라인(사용자 결정 ①): RTMP/mediamtx 경유 없이 segmented file output 으로
 * `.m3u8` + `.ts` 를 egress 컨테이너의 로컬 디스크(/out, 호스트 공유 볼륨)에 쓰고,
 * api 가 정적 서빙(/hls)한다. egress 컨테이너는 headless Chrome 이 방에 숨은 참가자로
 * 입장해 렌더링하는 구조라 Mac Docker 에서 무겁고 불안정할 수 있음(→ 실패 시 폴백).
 *
 * 컨테이너 내부 출력 경로 = /out/<roomId>/... ↔ 호스트 ./egress-out/<roomId>/...
 * 재생 URL = <API_URL>/hls/<roomId>/index.m3u8
 */
const egressClient = new EgressClient(
  config.livekit.url,
  config.livekit.apiKey,
  config.livekit.apiSecret,
);

// egress 컨테이너 기준 출력 루트(공유 볼륨). 정적 서빙 디렉터리와 대응.
const EGRESS_OUT_ROOT = "/out";

/** HLS 재생 매니페스트의 공개 URL(정적 서빙 경로). */
export function hlsPlaylistUrl(roomId: string): string {
  return `${config.publicApiUrl}/hls/${roomId}/index.m3u8`;
}

/**
 * 방의 Room Composite → HLS 세그먼트 egress 시작. egressId 반환.
 * 실패는 throw — 호출측(라우트)이 모드 A 폴백 + host 알림을 수행.
 */
export async function startHlsEgress(roomId: string): Promise<string> {
  const output = new SegmentedFileOutput({
    filenamePrefix: `${EGRESS_OUT_ROOT}/${roomId}/seg`,
    playlistName: `${EGRESS_OUT_ROOT}/${roomId}/index.m3u8`,
    livePlaylistName: `${EGRESS_OUT_ROOT}/${roomId}/live.m3u8`,
    segmentDuration: 2,
    protocol: SegmentedFileProtocol.HLS_PROTOCOL,
  });

  const info = await egressClient.startRoomCompositeEgress(
    livekitRoomName(roomId),
    { segments: output },
    { layout: "grid" },
  );
  return info.egressId;
}

/** egress 중지(멱등). 이미 종료됐거나 없는 egress 는 무시. */
export async function stopHlsEgress(egressId: string): Promise<void> {
  try {
    await egressClient.stopEgress(egressId);
  } catch (err) {
    console.warn(`[egress] stop(${egressId}) ignored:`, (err as Error).message);
  }
}

// ── 오케스트레이션(상태머신 + 폴백) ──────────────────────────
/**
 * 방이 모드 B(hls)이고 아직 egress 가 없으면 시작.
 * 실패 시(사용자 결정 ①): viewer_mode 를 A(webrtc)로 자동 폴백하고 host 에게 알림.
 * 상태 전이는 여기서 starting 까지, active/failed 는 webhook 이 확정.
 */
export async function ensureEgressStarted(room: RoomDto): Promise<void> {
  if (room.viewerMode !== "hls") return;
  if (room.egressStatus !== "none") return; // 이미 시작/활성/실패
  await setEgressState(room.id, "starting");
  try {
    const egressId = await startHlsEgress(room.id);
    await setEgressState(room.id, "starting", egressId);
  } catch (err) {
    console.error(
      `[egress] start 실패 room=${room.id}:`,
      (err as Error).message,
    );
    await notifyFallback(room.id, room.hostId, (err as Error).message);
  }
}

/** egress 실패 → 모드 A 폴백 + host 알림(공통). */
export async function notifyFallback(
  roomId: string,
  hostId: string,
  reason: string,
): Promise<void> {
  metrics.egressFailure();
  metrics.egressFallback();
  await fallbackToWebrtc(roomId);
  try {
    await sendSignal(roomId, [hostId], {
      event: SIGNAL_EVENTS.EGRESS_FALLBACK,
      payload: { reason },
    });
  } catch {
    /* host 미접속 — 무시 */
  }
}

/** 방 종료/room_finished 시 egress 반드시 중지(과금·리소스 누수 방지). */
export async function stopEgressForRoom(roomId: string): Promise<void> {
  const egressId = await getEgressId(roomId);
  if (egressId) await stopHlsEgress(egressId);
  await setEgressState(roomId, "ending", null);
}

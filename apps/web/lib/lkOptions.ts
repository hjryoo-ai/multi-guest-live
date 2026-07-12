import { VideoPresets, type RoomOptions } from "livekit-client";

/**
 * 공유 LiveKit Room 옵션(Phase 5 성능):
 *   - adaptiveStream: 화면에 보이는 타일만 고해상도 구독(대역폭 절감)
 *   - dynacast: 구독자 없는 레이어 발행 중단
 *   - simulcast 3레이어(h180/h360 + 원본) + 캡처 상한 720p → 게스트 N명에서 대역폭 안정
 */
export const roomOptions: RoomOptions = {
  adaptiveStream: true,
  dynacast: true,
  videoCaptureDefaults: {
    resolution: VideoPresets.h720.resolution,
  },
  publishDefaults: {
    simulcast: true,
    videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
  },
};

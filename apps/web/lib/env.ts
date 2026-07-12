export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
export const LIVEKIT_URL =
  process.env.NEXT_PUBLIC_LIVEKIT_URL ?? "ws://localhost:7880";

/**
 * 데모 표시 플래그(§7-lite 1-5) — **표시 전용**. 서버 가드(방 상한·수명·정리)와 무관하며
 * 신뢰 경계가 아니다. 랜딩 배너·"데모 시작" 노출만 제어한다(빌드타임 인라인).
 */
export const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === "1";
/**
 * 랜딩 고지에 표시할 방 수명(분). 서버 MAX_ROOM_LIFETIME_MIN 과 **같은 값**으로 함께 설정해
 * 고지 문구가 실제 서버 정책과 어긋나지 않게 한다(하드코딩 금지). 미설정 시 60.
 */
export const DEMO_LIFETIME_MIN = Number(
  process.env.NEXT_PUBLIC_DEMO_LIFETIME_MIN ?? 60,
);

import { ERROR_CODES } from "@multi-live/shared";
import { config } from "../config.js";

/**
 * LiveKit 업스트림 네트워크 호출 상한(§7-lite, chore/livekit-timeouts).
 *
 * RoomServiceClient/EgressClient 의 REST 호출은 LiveKit 서버(자체호스트·Cloud)가 느리거나
 * 무응답이면 무한정 매달릴 수 있다 — 그러면 데모 UX(방 만들기·QR 화면)가 버튼이 멈춘 채로 굳는다.
 * 이 헬퍼로 모든 네트워크 호출에 시간 상한을 두고, 초과 시 504(gateway timeout) 로 수렴시킨다.
 *
 * 범위(사용자 결정): 네트워크 호출 "전부"를 감싼다. 단 로컬 서명(AccessToken.toJwt)·
 * webhook 서명검증(WebhookReceiver.receive)은 네트워크가 아니므로 감싸지 않는다.
 * 기본 상한 10s — CI 로컬 LiveKit 은 빠르므로 verify spawn 인스턴스의 정상 경로에서 오탐 없음.
 */
export class LivekitTimeoutError extends Error {
  /** 중앙 에러 핸들러가 504 로 매핑하도록 statusCode/code 를 실어 보낸다. */
  readonly statusCode = 504;
  readonly code: string = ERROR_CODES.livekitTimeout;
  constructor(label: string, ms: number) {
    super(`LiveKit 호출 시간 초과: ${label} (${ms}ms)`);
    this.name = "LivekitTimeoutError";
  }
}

/**
 * LiveKit 네트워크 호출 프라미스를 시간 상한으로 감싼다.
 * 초과하면 LivekitTimeoutError(statusCode 504) 로 reject → 라우트로 전파되면 504 livekit_timeout.
 * (deleteRoom·stopEgress 처럼 호출측이 try/catch 로 삼키는 멱등 경로에서는 "무한 대기"만 끊는다.)
 */
export function withLivekitTimeout<T>(
  op: Promise<T>,
  label: string,
  ms: number = config.livekit.timeoutMs,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new LivekitTimeoutError(label, ms)),
      ms,
    );
    timer.unref?.();
    op.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

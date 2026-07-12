import { test, expect } from "@playwright/test";
import {
  bringUpGuests,
  createHost,
  joinViewer,
  openHostChat,
  sendChat,
  expectChat,
  subscribedRemoteAudioCount,
} from "./helpers";

/**
 * Phase 4 E2E — 모드 A(webrtc) 시청자 대규모 + 채팅.
 *   - subscribe-only 시청자가 host+guest 오디오를 전수 수신(구독 == publisher 수)
 *   - 서버 경유 채팅이 참가자 전원에 실시간 도달(양방향)
 *   - 시청자 수 배지 = 참가자 − publisher
 *
 * 기본값은 webrtc 모드이므로 host 는 별도 설정 없이 생성.
 * 모드 B(HLS)는 egress 컨테이너 의존(베스트 에포트) — 게이트에서 제외, README 에 재현 절차.
 */

test("[모드 A] 시청자 subscribe-only 오디오 전수 수신 + 양방향 채팅", async ({
  browser,
}) => {
  const host = await createHost(browser, "호스트");
  const [g1] = await bringUpGuests(browser, host, ["게스트1"]);

  // webrtc 시청자 입장(publish 없음).
  const viewer = await joinViewer(browser, host.roomId, "관객");

  // publishers = host + guest = 2 → 시청자는 둘 다 구독해야 함.
  await expect
    .poll(() => subscribedRemoteAudioCount(viewer.page), { timeout: 30_000 })
    .toBe(2);

  // 시청자 수 배지 = 참가자(3) − publisher(2) = 1.
  await expect
    .poll(
      () =>
        host.page
          .getByTestId("viewer-count")
          .textContent()
          .then((t) => (t ?? "").replace(/\D/g, "")),
      { timeout: 15_000 },
    )
    .toBe("1");

  // host 우측 패널 채팅 탭 활성화(기본 탭은 요청).
  await openHostChat(host.page);

  // 채팅 양방향: 시청자 → 전원(host) 도달.
  await sendChat(viewer.page, "관객질문입니다");
  await expectChat(host.page, "관객질문입니다");
  await expectChat(g1!.page, "관객질문입니다");

  // host → 전원(시청자) 도달.
  await sendChat(host.page, "호스트답변입니다");
  await expectChat(viewer.page, "호스트답변입니다");

  await host.ctx.close();
  await g1!.ctx.close();
  await viewer.ctx.close();
});

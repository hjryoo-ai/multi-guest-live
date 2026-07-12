import { test, expect } from "@playwright/test";
import {
  createHost,
  joinGuest,
  approve,
  waitUpgraded,
  openHostChat,
  sendChat,
  expectChat,
} from "./helpers";

/**
 * Phase 6.5 A-1 — 신호 스푸핑 차단.
 * 참가자가 data channel 로 서버 신호(topic=chat CHAT / topic=signal CHAT_MODERATED)를
 * 위조해도 다른 클라이언트가 무시하는지 검증. 대조군으로 '진짜 서버 경로'는 동작함을 확인.
 */
test("A-1 참가자 위조 신호는 무시되고, 진짜 서버 경로만 반영된다", async ({
  browser,
}) => {
  const host = await createHost(browser, "보안호스트");
  const attacker = await joinGuest(browser, host.roomId, host.code, "공격자");
  await approve(host.page, "공격자");
  await waitUpgraded(attacker.page);

  // host 채팅 탭 활성화(승인은 기본 요청 탭에서 끝났으므로 이제 채팅 탭으로).
  await openHostChat(host.page);

  // (대조군) 진짜 채팅 — host 가 서버 경유로 전송 → host 화면에 노출.
  await sendChat(host.page, "진짜메시지");
  await expectChat(host.page, "진짜메시지");
  const realId = await host.page
    .getByTestId("chat-msg")
    .filter({ hasText: "진짜메시지" })
    .first()
    .getAttribute("data-msg-id");
  expect(realId).toBeTruthy();

  // (공격 1) 참가자가 topic=chat 으로 CHAT 위조 브로드캐스트.
  //   sendData 브로드캐스트는 발신자를 제외하므로 host 가 수신 대상 → 가드 없으면 노출됨.
  await attacker.page.evaluate(() => {
    const room = (window as any).__lkRoom;
    const data = new TextEncoder().encode(
      JSON.stringify({
        type: "CHAT",
        message: {
          id: 999999,
          roomId: "x",
          userId: "x",
          nickname: "해커",
          text: "위조메시지",
          createdAt: new Date().toISOString(),
        },
      }),
    );
    return room.localParticipant.publishData(data, {
      reliable: true,
      topic: "chat",
    });
  });

  // (공격 2) 참가자가 topic=signal 로 CHAT_MODERATED 위조 → 진짜메시지를 숨기려 시도.
  await attacker.page.evaluate((id) => {
    const room = (window as any).__lkRoom;
    const data = new TextEncoder().encode(
      JSON.stringify({
        event: "CHAT_MODERATED",
        payload: { hiddenIds: [Number(id)] },
      }),
    );
    return room.localParticipant.publishData(data, {
      reliable: true,
      topic: "signal",
    });
  }, realId);

  // 위조가 반영됐다면 나타났을 시간(2s) 동안 host 화면을 관찰.
  await host.page.waitForTimeout(2000);

  // 위조 CHAT 은 노출되지 않는다.
  await expect(
    host.page.getByTestId("chat-msg").filter({ hasText: "위조메시지" }),
  ).toHaveCount(0);
  // 위조 CHAT_MODERATED 로 진짜메시지가 숨겨지지 않는다(data-hidden 유지).
  const realMsg = host.page
    .getByTestId("chat-msg")
    .filter({ hasText: "진짜메시지" })
    .first();
  await expect(realMsg).toHaveAttribute("data-hidden", "0");

  // (대조군) 진짜 서버 모더레이션은 동작 — host 가 '숨기기' 클릭 → 숨김 반영.
  await realMsg.getByRole("button", { name: "숨기기" }).click();
  await expect(realMsg).toHaveAttribute("data-hidden", "1", { timeout: 8000 });
});

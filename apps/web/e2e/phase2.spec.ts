import { test, expect, type Page, type Browser } from "@playwright/test";

/**
 * Phase 2 E2E — host + guest 1명 양방향 오디오 도달.
 * 설계 불변식 검증: 각 참가자의 subscribedAudioTracks 수 == (상대가 publish 중인 오디오 수).
 * 여기선 2인이므로 양쪽 모두 1 이어야 함.
 */

// 방의 '구독 중인 원격 오디오 트랙' 수를 페이지에서 직접 읽는다.
async function subscribedRemoteAudioCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const room = (window as any).__lkRoom;
    if (!room) return -1;
    let n = 0;
    room.remoteParticipants.forEach((p: any) => {
      p.audioTrackPublications.forEach((pub: any) => {
        if (pub.isSubscribed) n++;
      });
    });
    return n;
  });
}

async function newSessionPage(browser: Browser) {
  const context = await browser.newContext({
    permissions: ["microphone", "camera"],
  });
  const page = await context.newPage();
  return { context, page };
}

test("host ↔ guest 상호 오디오 도달 (subscribedAudioTracks == 1)", async ({
  browser,
}) => {
  // ── host: 방 생성 → PreJoin → LIVE ──────────────────────────
  const { context: hostCtx, page: host } = await newSessionPage(browser);
  await host.goto("/broadcast");
  await host.getByPlaceholder("호스트").fill("호스트E2E");
  await host.getByRole("button", { name: "방 만들기" }).click();

  // PreJoin 화면 → 입장
  await host.getByRole("button", { name: "입장" }).click();

  // LIVE 화면의 초대 배지에서 roomId/code 추출
  const invite = host.getByTestId("invite");
  await expect(invite).toBeVisible();
  const roomId = await invite.getAttribute("data-room-id");
  const code = await invite.getAttribute("data-code");
  expect(roomId).toBeTruthy();
  expect(code).toBeTruthy();

  // ── guest: 초대코드로 대기실 입장 ───────────────────────────
  const { context: guestCtx, page: guest } = await newSessionPage(browser);
  await guest.goto(`/join/${roomId}?code=${code}`);
  await guest.getByPlaceholder("게스트").fill("게스트E2E");
  await guest.getByRole("button", { name: "대기실 입장" }).click();

  // 대기실 연결 완료(room 노출) 대기
  await expect
    .poll(async () => guest.evaluate(() => !!(window as any).__lkRoom), {
      timeout: 20_000,
    })
    .toBe(true);

  // ── host: 승인 큐에서 게스트 승인 ───────────────────────────
  // 요청 큐 행으로 스코프 — 참가자 탭 상시 마운트라 닉네임/버튼 셀렉터는 컨테이너 스코프 필수.
  const queueRow = host.locator(
    '[data-testid="join-request-row"][data-nick="게스트E2E"]',
  );
  await expect(queueRow).toBeVisible({ timeout: 20_000 });
  await queueRow.getByRole("button", { name: "게스트로 승인" }).click();

  // guest 승격 → 출연 중
  await expect(guest.getByText("🎙️ 출연 중")).toBeVisible({ timeout: 20_000 });

  // ── 검증: 양쪽 모두 상대 오디오 1개 구독 ───────────────────
  await expect
    .poll(() => subscribedRemoteAudioCount(host), { timeout: 25_000 })
    .toBe(1);
  await expect
    .poll(() => subscribedRemoteAudioCount(guest), { timeout: 25_000 })
    .toBe(1);

  await hostCtx.close();
  await guestCtx.close();
});

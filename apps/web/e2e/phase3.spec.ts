import { test, expect } from "@playwright/test";
import {
  assertAudioReach,
  bringUpGuests,
  createHost,
  kick,
  waitUpgraded,
  subscribedRemoteAudioCount,
  subscribedRemoteAudioSids,
} from "./helpers";

/**
 * Phase 3 E2E 매트릭스 — 오디오 전수 도달 불변식의 회귀 게이트.
 *   불변식: 모든 참가자의 subscribedAudioTracks == (전체 publish 오디오 − 자기 것)
 *
 * PR 게이트 = 아래 핵심 시나리오(H + 게스트 2~3명).
 * 8명 전수(@heavy)는 CI flaky·비용 문제로 nightly/릴리스 전 수동 실행으로 분리.
 */

test("입장순서 [H→G1→G2] — 전원 상호 오디오 도달", async ({ browser }) => {
  const host = await createHost(browser, "호스트");
  const [g1, g2] = await bringUpGuests(browser, host, ["게스트1", "게스트2"]);

  // publishers = H + G1 + G2 = 3 → 각자 2개 구독.
  await assertAudioReach(host.page, 3, "host");
  await assertAudioReach(g1!.page, 3, "G1");
  await assertAudioReach(g2!.page, 3, "G2");

  // ★ 원래 위버스 버그의 직접 회귀 테스트:
  //   "2번째로 들어온 게스트(G2)의 음성이 host 에게 도달하는가" —
  //   host 가 2개(G1,G2)를 구독 중이면 G2 오디오가 host 에 반드시 도달한 것.
  expect(await subscribedRemoteAudioCount(host.page)).toBe(2);

  await host.ctx.close();
  await g1!.ctx.close();
  await g2!.ctx.close();
});

test("입장순서 [H→G2→G1] — 순서 무관 전수 도달", async ({ browser }) => {
  const host = await createHost(browser, "호스트");
  const [g2, g1] = await bringUpGuests(browser, host, ["게스트2", "게스트1"]);

  await assertAudioReach(host.page, 3, "host");
  await assertAudioReach(g1!.page, 3, "G1");
  await assertAudioReach(g2!.page, 3, "G2");

  await host.ctx.close();
  await g1!.ctx.close();
  await g2!.ctx.close();
});

test("[게스트 중도 퇴장 후 재입장] — 도달 복구 (새 trackSid 검증)", async ({
  browser,
}) => {
  const host = await createHost(browser, "호스트");
  const [g1] = await bringUpGuests(browser, host, ["게스트1"]);

  // H + G1 = 2 → 각자 1개. host 가 구독 중인 G1 의 (기존) 오디오 sid 기록.
  await assertAudioReach(host.page, 2, "host");
  await assertAudioReach(g1!.page, 2, "G1");
  const oldSids = await subscribedRemoteAudioSids(host.page);
  expect(oldSids.length).toBe(1);

  // G1 퇴장(우아한 disconnect → 즉시 ParticipantDisconnected) → host 구독 0.
  await g1!.page.evaluate(() => (window as any).__lkRoom?.disconnect());
  await g1!.page.close();
  await expect
    .poll(() => subscribedRemoteAudioCount(host.page), { timeout: 25_000 })
    .toBe(0);

  // G1 재입장 — 동일 컨텍스트(=동일 세션/userId). left 상태이므로 join-request 가
  // left→approved 자동 재승인(슬롯 있음) → 처음부터 guest 토큰으로 접속·자동 송출.
  const rejoin = await g1!.ctx.newPage();
  await rejoin.goto(`/join/${host.roomId}?code=${host.code}`);
  await rejoin.getByPlaceholder("게스트").fill("게스트1");
  await rejoin.getByRole("button", { name: "대기실 입장" }).click();
  await waitUpgraded(rejoin);

  await assertAudioReach(host.page, 2, "host(재입장 후)");
  await assertAudioReach(rejoin, 2, "G1(재입장)");

  // ★ 새 세션의 새 trackSid 를 구독해야 함(이전 세션 trackSid 가 기준선에 남지 않음).
  const newSids = await subscribedRemoteAudioSids(host.page);
  expect(newSids.length).toBe(1);
  expect(newSids[0]).not.toBe(oldSids[0]);

  await host.ctx.close();
  await g1!.ctx.close();
});

test("[G3 승인 → G1 강퇴] — 강퇴 후 잔여 전원 도달", async ({ browser }) => {
  const host = await createHost(browser, "호스트");
  const [g1, g2, g3] = await bringUpGuests(browser, host, [
    "게스트1",
    "게스트2",
    "게스트3",
  ]);

  // publishers = 4 → 각자 3개.
  await assertAudioReach(host.page, 4, "host");

  // G1 강퇴 → publishers = 3 (H,G2,G3), 각자 2개. G1 은 disconnect.
  await kick(host.page, "게스트1");
  await expect
    .poll(() => subscribedRemoteAudioCount(host.page), { timeout: 20_000 })
    .toBe(2);
  await assertAudioReach(g2!.page, 3, "G2(강퇴 후)");
  await assertAudioReach(g3!.page, 3, "G3(강퇴 후)");

  // 강퇴된 쪽: 공통 셸의 강퇴 안내 화면으로 전환(재요청 경로) — Phase 6.6.
  await expect(g1!.page.getByTestId("state-removed")).toBeVisible({
    timeout: 20_000,
  });

  await host.ctx.close();
  await g1!.ctx.close();
  await g2!.ctx.close();
  await g3!.ctx.close();
});

test("@heavy 8명 동시 접속 전수 오디오 도달", async ({ browser }) => {
  test.setTimeout(180_000);
  const host = await createHost(browser, "호스트");
  const nicks = Array.from({ length: 8 }, (_, i) => `게스트${i + 1}`);
  const guests = await bringUpGuests(browser, host, nicks);

  // publishers = 9 → 각자 8개.
  await assertAudioReach(host.page, 9, "host");
  for (let i = 0; i < guests.length; i++) {
    await assertAudioReach(guests[i]!.page, 9, `G${i + 1}`);
  }

  await host.ctx.close();
  for (const g of guests) await g.ctx.close();
});

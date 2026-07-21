import { test, expect } from "@playwright/test";
import {
  assertAudioReach,
  bringUpGuests,
  bringUpSpeaker,
  createHost,
  waitSpeaker,
  waitUpgraded,
  remoteVideoCount,
  subscribedRemoteAudioCount,
} from "./helpers";

/**
 * Phase 6A E2E — speaker(오디오 전용) 편입 + 역할 전환.
 *   - speaker 는 오디오 전수 도달 불변식에 guest 와 동일하게 편입(트랙 기준)
 *   - speaker 는 비디오를 publish 하지 않음
 *   - 역할 전환은 재연결 없이 동작, 강등 시 비디오가 서버 강제로 소멸(오디오 무중단)
 */

test("[H→G1→S1] 3자 오디오 전수 도달 + speaker 비디오 미publish", async ({
  browser,
}) => {
  const host = await createHost(browser, "호스트");
  const [g1] = await bringUpGuests(browser, host, ["게스트1"]);
  const s1 = await bringUpSpeaker(browser, host, "스피커1");

  // 오디오 publisher = H + G1 + S1 = 3 → 각자 2개 구독(트랙 기준, speaker 자연 편입).
  await assertAudioReach(host.page, 3, "host");
  await assertAudioReach(g1!.page, 3, "G1");
  await assertAudioReach(s1.page, 3, "S1");

  // host 는 speaker 스트립에서 S1 을 본다.
  await expect(
    host.page.locator('[data-testid="speaker-chip"][data-nick="스피커1"]'),
  ).toBeVisible({ timeout: 15_000 });

  // S1 은 비디오를 publish 하지 않는다(host 원격에서 S1 비디오 pub 0).
  await expect
    .poll(() => remoteVideoCount(host.page, "스피커1"), { timeout: 10_000 })
    .toBe(0);
  // G1(게스트)은 비디오 pub 1.
  await expect
    .poll(() => remoteVideoCount(host.page, "게스트1"), { timeout: 10_000 })
    .toBe(1);

  await host.ctx.close();
  await g1!.ctx.close();
  await s1.ctx.close();
});

test("[역할 전환] S1→guest 승격(비디오 publish) · G1→speaker 강등(비디오 소멸+오디오 지속)", async ({
  browser,
}) => {
  const host = await createHost(browser, "호스트");
  const [g1] = await bringUpGuests(browser, host, ["게스트1"]);
  const s1 = await bringUpSpeaker(browser, host, "스피커1");

  await assertAudioReach(host.page, 3, "host(초기)");

  // ── S1(speaker) → guest 승격: host 가 speaker-chip 의 [게스트로] 클릭 ──
  const chip = host.page.locator('[data-testid="speaker-chip"][data-nick="스피커1"]');
  await chip.getByRole("button", { name: "게스트로" }).click();
  // 승격 후 S1 은 카메라 publish → host 원격에 S1 비디오 pub 등장.
  await waitUpgraded(s1.page); // "🎙️ 출연 중"
  await expect
    .poll(() => remoteVideoCount(host.page, "스피커1"), { timeout: 20_000 })
    .toBe(1);

  // ── G1(guest) → speaker 강등: host 가 G1 타일의 [스피커로] 클릭 ──
  const tile = host.page.locator('[data-testid="tile"][data-nick="게스트1"]');
  await tile.getByRole("button", { name: "스피커로" }).click();
  // 강등 후 G1 비디오 pub 소멸(서버 자동 unpublish — A-4 실동작 확인됨).
  await expect
    .poll(() => remoteVideoCount(host.page, "게스트1"), { timeout: 20_000 })
    .toBe(0);
  // 오디오는 무중단: 여전히 3자 오디오 전수 도달.
  await assertAudioReach(host.page, 3, "host(전환 후)");
  await assertAudioReach(g1!.page, 3, "G1(강등 후)");
  // G1 클라이언트도 "음성 참여 중" 으로 전환.
  await waitSpeaker(g1!.page);

  await host.ctx.close();
  await g1!.ctx.close();
  await s1.ctx.close();
});

test("@heavy host + guest4 + speaker4 전수 오디오 도달", async ({ browser }) => {
  // 8회 순차 brings-up. 후반 speaker 큐행 대기가 부하로 폴 1주기 유실을 견디도록 넓어져
  // (QUEUE_ROW_WAIT_MS 2.5×=50s), 느린 대기 1~2회가 걸려도 테스트 레벨 타임아웃이 먼저
  // 자르지 않게 여유를 준다(@heavy 는 nightly — 느리지만-그린 > flaky).
  test.setTimeout(240_000);
  const host = await createHost(browser, "호스트");
  const guests = await bringUpGuests(browser, host, ["G1", "G2", "G3", "G4"]);
  const speakers = [];
  for (const n of ["S1", "S2", "S3", "S4"]) {
    speakers.push(await bringUpSpeaker(browser, host, n));
  }
  // 오디오 publisher = 1 + 4 + 4 = 9 → 각자 8개 구독.
  await assertAudioReach(host.page, 9, "host");
  for (let i = 0; i < guests.length; i++) {
    await assertAudioReach(guests[i]!.page, 9, `G${i + 1}`);
  }
  for (let i = 0; i < speakers.length; i++) {
    await assertAudioReach(speakers[i]!.page, 9, `S${i + 1}`);
  }
  expect(await subscribedRemoteAudioCount(host.page)).toBe(8);

  await host.ctx.close();
  for (const g of guests) await g.ctx.close();
  for (const s of speakers) await s.ctx.close();
});

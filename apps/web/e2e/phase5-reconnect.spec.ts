import { test, expect } from "@playwright/test";
import { createHost } from "./helpers";

/**
 * 재접속 통합 테스트(@heavy, 게이트 제외) — 짧은 TTL 토큰 + 강제 재접속.
 * 전제: API 를 TOKEN_TTL_SEC=6 로 기동(만료를 기다리지 않고 짧게).
 *   실행: TOKEN_TTL_SEC=6 로 api → HEAVY=1 playwright test phase5-reconnect
 *
 * 토큰 만료 후 signal-reconnect 를 강제하면 만료 토큰으로는 재접속이 실패하고,
 * ReconnectGuard 가 서버에서 새 토큰을 받아 재접속을 복구한다(원칙: 모든 재접속=새 토큰).
 * 판정: 수동/중복 배너 없이 최종 connected 로 복구.
 */
test("@heavy 토큰 만료 후 ReconnectGuard 가 새 토큰으로 재접속 복구", async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const host = await createHost(browser, "재접속호스트");
  const page = host.page;

  await expect
    .poll(() => page.evaluate(() => (window as any).__lkRoom?.state), {
      timeout: 20_000,
    })
    .toBe("connected");

  // 토큰(6초) 만료 대기.
  await page.waitForTimeout(7_000);

  // 만료 토큰으로 전체(시그널) 재접속 강제 → 실패 → 가드가 새 토큰으로 복구.
  await page.evaluate(() =>
    (window as any).__lkRoom?.simulateScenario("signal-reconnect"),
  );

  // 최종적으로 connected 로 복구(가드가 새 토큰 재발급).
  await expect
    .poll(() => page.evaluate(() => (window as any).__lkRoom?.state), {
      timeout: 30_000,
    })
    .toBe("connected");

  // 핑퐁/실패 배너가 뜨지 않아야 함.
  await expect(page.getByTestId("reconnect-manual")).toHaveCount(0);
  await expect(page.getByTestId("duplicate-banner")).toHaveCount(0);

  await host.ctx.close();
});

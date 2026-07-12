import { test, expect } from "@playwright/test";
import { createHost, approveAs } from "./helpers";

/**
 * Phase 6.6 모바일 스모크 — 게스트 여정(390×844).
 *   장치 프리뷰 → 대기실 → (호스트 승인) 승인 모먼트 토스트 + 출연 상태.
 * 호스트는 데스크톱 컨텍스트(createHost), 게스트만 모바일 뷰포트로 별도 컨텍스트 생성.
 */

test("[모바일 게스트] 장치 프리뷰 → 대기실 → 승인 모먼트", async ({ browser }) => {
  const host = await createHost(browser, "모바일호스트");

  const guestCtx = await browser.newContext({
    permissions: ["microphone", "camera"],
    viewport: { width: 390, height: 844 },
  });
  const g = await guestCtx.newPage();

  await g.goto(`/join/${host.roomId}?code=${host.code}`);

  // 입장 전: 장치 프리뷰 노출.
  await expect(g.getByTestId("device-preview")).toBeVisible({ timeout: 15_000 });

  // 대기실 입장.
  await g.getByPlaceholder("게스트").fill("모바일게스트");
  await g.getByRole("button", { name: "대기실 입장" }).click();
  await expect(g.getByTestId("waiting-room")).toBeVisible({ timeout: 20_000 });

  // 호스트 승인 → 승인 모먼트 토스트 + 출연 상태.
  await approveAs(host.page, "모바일게스트", "guest");
  await expect(g.getByTestId("toast")).toBeVisible({ timeout: 25_000 });
  await expect(g.getByText("🎙️ 출연 중")).toBeVisible({ timeout: 25_000 });

  await host.ctx.close();
  await guestCtx.close();
});

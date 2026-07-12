import { test, expect } from "@playwright/test";

/**
 * Phase 6.6 모바일 스모크 — 호스트 대시보드(390×844).
 *   좁은 화면에선 우측 패널이 '관리' 버튼 → 바텀시트로 제공된다.
 *   시트 안에서 참가자/요청/채팅 탭 전환(모든 패널 상시 마운트, display 토글).
 */

test.use({ viewport: { width: 390, height: 844 } });

test("[모바일 호스트] 관리 바텀시트 · 탭 전환", async ({ page }) => {
  await page.goto("/broadcast");
  await page.getByPlaceholder("호스트").fill("모바일호스트");
  await page.getByRole("button", { name: "방 만들기" }).click();
  await page.getByRole("button", { name: "입장" }).click();
  await expect(page.getByTestId("invite")).toBeVisible({ timeout: 20_000 });

  // 좁은 화면: 관리 버튼 → 바텀시트.
  await page.getByRole("button", { name: "관리" }).click();
  const sheet = page.getByTestId("host-panel-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId("host-panel")).toBeVisible();

  // 채팅 탭 → 입력창 노출.
  await sheet.getByRole("tab", { name: "채팅" }).click();
  await expect(sheet.getByTestId("chat-input")).toBeVisible();

  // 참가자 탭 → 호스트 본인이 목록에.
  await sheet.getByRole("tab", { name: /참가자/ }).click();
  await expect(sheet.getByText("모바일호스트 (나)")).toBeVisible({
    timeout: 15_000,
  });
});

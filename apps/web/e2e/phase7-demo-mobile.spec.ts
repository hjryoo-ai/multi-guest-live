import { test, expect } from "@playwright/test";

/**
 * §7-lite 모바일 스모크 — 데모 UX(390×844). 방문자 첫 접점이라 게이트 가치가 가장 높다.
 *   랜딩 배너 대신 데모 플로우 URL(?demo=1)로 직접 진입해 **서버 표시 플래그와 무관하게**
 *   플로우 자체를 검증한다(NEXT_PUBLIC_DEMO_MODE 빌드 플래그에 게이트를 묶지 않기 위함).
 *
 * 커버:
 *   - 데모 시작 → 장치 선택(prejoin) 없이 자동 라이브
 *   - 게스트·시청자 QR 2종 노출
 *   - 1회성 가이드 오버레이 표시 → 닫기
 *   - 이중 생성 방어: ?demo=1 URL 제거 + 새로고침 시 방이 또 생기지 않음
 */

test.use({ viewport: { width: 390, height: 844 } });

test("[모바일 데모] 자동 라이브 · QR · 1회 가이드 · 새로고침 중복생성 없음", async ({
  page,
}) => {
  await page.goto("/broadcast?demo=1");

  // 자동 방 생성 → 바로 라이브(invite 노출 = 라이브 진입).
  const invite = page.getByTestId("invite");
  await expect(invite).toBeVisible({ timeout: 20_000 });
  expect(await invite.getAttribute("data-room-id")).toBeTruthy();

  // 1회성 가이드 오버레이 → 닫기.
  const guide = page.getByTestId("guide-overlay");
  await expect(guide).toBeVisible();
  await page.getByTestId("guide-dismiss").click();
  await expect(guide).toHaveCount(0);

  // 게스트·시청자 QR 2종 노출.
  await expect(page.getByTestId("qr-guest")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("qr-viewer")).toBeVisible();

  // 이중 생성 방어: ?demo=1 이 URL 에서 제거됐고, 새로고침해도 방이 또 생기지 않는다.
  await expect(page).toHaveURL(/\/broadcast$/);
  await page.reload();
  await expect(page.getByRole("button", { name: "방 만들기" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("invite")).toHaveCount(0);
});

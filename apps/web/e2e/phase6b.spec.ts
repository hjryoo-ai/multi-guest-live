import { test, expect } from "@playwright/test";
import { createHost, joinViewer, openHostChat, sendChat } from "./helpers";

/**
 * Phase 6B E2E — 채팅 운영(모드 A 실시간).
 *   viewer 메시지 → host 숨김(viewer 실시간 제거 + host 스타일 전환) → 해제(복원)
 *   → host 가 viewer 차단 → viewer 입력창 비활성.
 */
test("[채팅 운영] 숨김/해제 실시간 수렴 + 유저 차단", async ({ browser }) => {
  const host = await createHost(browser, "호스트");
  await openHostChat(host.page); // host 채팅 탭 활성화(기본 탭은 요청)
  const viewer = await joinViewer(browser, host.roomId, "관객");

  const MSG = "관객메시지1";
  await sendChat(viewer.page, MSG);

  const hostMsg = host.page.locator('[data-testid="chat-msg"]', { hasText: MSG });
  const viewerMsg = viewer.page.locator('[data-testid="chat-msg"]', { hasText: MSG });
  await expect(hostMsg).toBeVisible({ timeout: 15_000 });
  await expect(viewerMsg).toBeVisible({ timeout: 15_000 });

  // ── host 숨김 ──
  await hostMsg.getByRole("button", { name: "숨기기" }).click();
  // viewer 화면에서 흔적 없이 제거.
  await expect(viewerMsg).toHaveCount(0, { timeout: 15_000 });
  // host 화면에는 남되 hidden 스타일(플래그).
  await expect(hostMsg).toHaveAttribute("data-hidden", "1", { timeout: 15_000 });

  // ── host 해제 → viewer 복원 ──
  await hostMsg.getByRole("button", { name: "해제" }).click();
  await expect(viewerMsg).toHaveCount(1, { timeout: 15_000 });
  await expect(hostMsg).toHaveAttribute("data-hidden", "0", { timeout: 15_000 });

  // ── host 가 viewer 차단 → viewer 입력 비활성 ──
  await hostMsg.getByRole("button", { name: "차단" }).click();
  // Phase 6.6: 파괴적 액션 컨펌 다이얼로그 → "차단하기" 확정.
  await host.page
    .getByTestId("confirm-dialog")
    .getByRole("button", { name: "차단하기" })
    .click();
  // 차단된 viewer 가 전송 시도 → 403 → 입력창이 안내로 전환.
  await sendChat(viewer.page, "차단후시도");
  await expect(viewer.page.getByTestId("chat-banned")).toBeVisible({
    timeout: 15_000,
  });

  await host.ctx.close();
  await viewer.ctx.close();
});

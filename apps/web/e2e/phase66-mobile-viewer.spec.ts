import { test, expect, request as pwRequest } from "@playwright/test";
import { createHash, createHmac } from "node:crypto";
import { cpSync, mkdirSync } from "node:fs";
import path from "node:path";

/**
 * Phase 6.6 모바일 스모크 — 시청자 세로 레이아웃(390×844).
 *   · 영상 위 LIVE·시청자 수 오버레이
 *   · 채팅 입력 포커스 상태에서도 전송 버튼이 뷰포트 안(키보드/safe-area 회귀 가드)
 *   · 채팅 전송 → 메시지 표시
 * HLS 정적 픽스처 재사용(egress 무관, phase4-hls-player 와 동일 주입 경로).
 */

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const API_KEY = process.env.LIVEKIT_API_KEY ?? "devkey";
const API_SECRET =
  process.env.LIVEKIT_API_SECRET ?? "devsecret_change_me_0123456789abcdef";

const EGRESS_OUT = path.resolve(process.cwd(), "../../egress-out");
const FIXTURE = path.resolve(process.cwd(), "e2e/fixtures/hls");

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");
function signWebhook(body: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const sha256 = createHash("sha256").update(body).digest("base64");
  const payload = b64url(
    JSON.stringify({ iss: API_KEY, iat: now, exp: now + 60, sha256 }),
  );
  const sig = b64url(
    createHmac("sha256", API_SECRET).update(`${header}.${payload}`).digest(),
  );
  return `${header}.${payload}.${sig}`;
}

test.use({ viewport: { width: 390, height: 844 } });

test("[모바일 시청자] 세로 레이아웃 · 오버레이 · 키보드 포커스 전송 가시", async ({
  page,
}) => {
  const ctx = await pwRequest.newContext();

  const s = await (
    await ctx.post(`${API}/auth/session`, { data: { nickname: "모바일호스트" } })
  ).json();
  const room = await (
    await ctx.post(`${API}/rooms`, {
      headers: { authorization: `Bearer ${s.token}` },
      data: { title: "모바일-HLS", maxGuests: 8, viewerMode: "hls" },
    })
  ).json();
  const roomId = room.id as string;

  mkdirSync(path.join(EGRESS_OUT, roomId), { recursive: true });
  cpSync(FIXTURE, path.join(EGRESS_OUT, roomId), { recursive: true });

  const evBody = JSON.stringify({
    event: "egress_started",
    egressInfo: { egressId: "EG_mobile", roomName: roomId, status: "EGRESS_ACTIVE" },
    createdAt: Math.floor(Date.now() / 1000),
    id: "wh_mobile",
  });
  const wh = await ctx.post(`${API}/webhooks/livekit`, {
    headers: {
      "content-type": "application/webhook+json",
      authorization: signWebhook(evBody),
    },
    data: evBody,
  });
  expect(wh.status()).toBe(200);

  // 입장(세로 뷰포트).
  await page.goto(`/watch/${roomId}`);
  await page.getByPlaceholder("시청자").fill("모바일시청자");
  await page.getByRole("button", { name: "시청 입장" }).click();

  const video = page.getByTestId("hls-video");
  await expect(video).toBeVisible({ timeout: 15_000 });

  // 영상 위 오버레이(LIVE · 시청자 수) — 진입 직후 노출.
  await expect(page.getByText("LIVE")).toBeVisible();
  await expect(page.getByTestId("viewer-count")).toBeVisible();

  // 채팅 입력 포커스 → 전송 버튼이 뷰포트 안(키보드/safe-area 로 잘리지 않음).
  const input = page.getByTestId("chat-input");
  await expect(input).toBeVisible();
  await input.focus();
  const send = page.getByRole("button", { name: "전송" });
  await expect(send).toBeInViewport();

  // 전송 → 메시지 표시(낙관적 반영).
  const MSG = "모바일에서 보냅니다";
  await input.fill(MSG);
  await send.click();
  await expect(
    page.locator('[data-testid="chat-msg"]', { hasText: MSG }),
  ).toBeVisible({ timeout: 15_000 });

  await ctx.dispose();
});

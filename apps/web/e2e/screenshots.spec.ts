import { test, request as pwRequest } from "@playwright/test";
import {
  createHost,
  joinGuest,
  approveAs,
  bringUpGuests,
  joinViewer,
  sendChat,
  openHostChat,
  kick,
} from "./helpers";
import { createHash, createHmac } from "node:crypto";
import { cpSync, mkdirSync } from "node:fs";
import path from "node:path";

/**
 * Phase 6.6 스크린샷 산출(after). 기본 게이트에서는 testIgnore 로 제외되며,
 * 재생성 시 config 의 testIgnore 를 잠시 풀고 이 파일만 실행한다.
 * 저장 위치: docs/screenshots/*.png
 */

const SHOT_DIR = path.resolve(process.cwd(), "../../docs/screenshots");
mkdirSync(SHOT_DIR, { recursive: true });
const shot = (name: string) => path.join(SHOT_DIR, `${name}.png`);

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

test("host 데스크톱 대시보드", async ({ browser }) => {
  const host = await createHost(browser, "호스트진행");
  await host.page.setViewportSize({ width: 1280, height: 800 });
  await host.page.getByRole("tab", { name: "채팅" }).click();
  await host.page.waitForTimeout(500);
  await host.page.screenshot({ path: shot("host-desktop") });
  await host.ctx.close();
});

test("guest 모바일 프리뷰·대기실", async ({ browser }) => {
  const host = await createHost(browser, "호스트");
  const gctx = await browser.newContext({
    permissions: ["microphone", "camera"],
    viewport: { width: 390, height: 844 },
  });
  const g = await gctx.newPage();
  await g.goto(`/join/${host.roomId}?code=${host.code}`);
  await g.getByTestId("device-preview").waitFor({ timeout: 15_000 });
  await g.waitForTimeout(600);
  await g.screenshot({ path: shot("guest-preview-mobile") });

  await g.getByPlaceholder("게스트").fill("게스트지원");
  await g.getByRole("button", { name: "대기실 입장" }).click();
  await g.getByTestId("waiting-room").waitFor({ timeout: 20_000 });
  await g.waitForTimeout(600);
  await g.screenshot({ path: shot("guest-waiting-mobile") });
  await host.ctx.close();
  await gctx.close();
});

test("viewer 모바일 시청", async ({ browser }) => {
  const ctx = await pwRequest.newContext();
  const s = await (
    await ctx.post(`${API}/auth/session`, { data: { nickname: "샷호스트" } })
  ).json();
  const room = await (
    await ctx.post(`${API}/rooms`, {
      headers: { authorization: `Bearer ${s.token}` },
      data: { title: "샷-HLS", maxGuests: 8, viewerMode: "hls" },
    })
  ).json();
  const roomId = room.id as string;
  mkdirSync(path.join(EGRESS_OUT, roomId), { recursive: true });
  cpSync(FIXTURE, path.join(EGRESS_OUT, roomId), { recursive: true });
  const evBody = JSON.stringify({
    event: "egress_started",
    egressInfo: { egressId: "EG_shot", roomName: roomId, status: "EGRESS_ACTIVE" },
    createdAt: Math.floor(Date.now() / 1000),
    id: "wh_shot",
  });
  await ctx.post(`${API}/webhooks/livekit`, {
    headers: {
      "content-type": "application/webhook+json",
      authorization: signWebhook(evBody),
    },
    data: evBody,
  });

  const gctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await gctx.newPage();
  await page.goto(`/watch/${roomId}`);
  await page.getByPlaceholder("시청자").fill("샷시청자");
  await page.getByRole("button", { name: "시청 입장" }).click();
  await page.getByTestId("hls-video").waitFor({ timeout: 15_000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: shot("viewer-watch-mobile") });
  await gctx.close();
  await ctx.dispose();
});

// ── 엔트리·정적 화면 ─────────────────────────────────────────
test("엔트리: 방송 시작(setup)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/broadcast");
  await page.getByPlaceholder("호스트").waitFor();
  await page.screenshot({ path: shot("entry-broadcast-setup") });
});

test("엔트리: 시청 입장(모바일)", async ({ browser }) => {
  const host = await createHost(browser, "호스트");
  const gctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const g = await gctx.newPage();
  await g.goto(`/watch/${host.roomId}`);
  await g.getByPlaceholder("시청자").waitFor({ timeout: 15_000 });
  await g.screenshot({ path: shot("entry-viewer-mobile") });
  await host.ctx.close();
  await gctx.close();
});

test("게스트 장치 프리뷰(데스크톱 2단)", async ({ browser }) => {
  const host = await createHost(browser, "호스트");
  const gctx = await browser.newContext({
    permissions: ["microphone", "camera"],
    viewport: { width: 1100, height: 820 },
  });
  const g = await gctx.newPage();
  await g.goto(`/join/${host.roomId}?code=${host.code}`);
  await g.getByTestId("device-preview").waitFor({ timeout: 15_000 });
  await g.waitForTimeout(600);
  await g.screenshot({ path: shot("guest-preview-desktop") });
  await host.ctx.close();
  await gctx.close();
});

// ── 호스트 상태 ─────────────────────────────────────────────
test("host 요청 큐(승인 대기)", async ({ browser }) => {
  const host = await createHost(browser, "호스트진행");
  await host.page.setViewportSize({ width: 1280, height: 800 });
  // 게스트가 대기실 입장 → 요청 큐에 노출(기본 탭이 요청).
  const guest = await joinGuest(browser, host.roomId, host.code, "지원게스트");
  await host.page
    .getByRole("button", { name: "게스트로 승인" })
    .waitFor({ timeout: 20_000 });
  await host.page.screenshot({ path: shot("host-queue-desktop") });
  await host.ctx.close();
  await guest.ctx.close();
});

test("host 채팅 탭(메시지)", async ({ browser }) => {
  const host = await createHost(browser, "호스트진행");
  await host.page.setViewportSize({ width: 1280, height: 800 });
  const viewer = await joinViewer(browser, host.roomId, "관객");
  await openHostChat(host.page);
  await sendChat(viewer.page, "안녕하세요 반가워요!");
  await sendChat(host.page, "와 주셔서 고마워요 :)");
  await host.page
    .locator('[data-testid="chat-msg"]', { hasText: "반가워요" })
    .first()
    .waitFor({ timeout: 15_000 });
  await host.page.waitForTimeout(400);
  await host.page.screenshot({ path: shot("host-chat-desktop") });
  await host.ctx.close();
  await viewer.ctx.close();
});

test("host 방송 종료 컨펌", async ({ browser }) => {
  const host = await createHost(browser, "호스트진행");
  await host.page.setViewportSize({ width: 1280, height: 800 });
  await host.page.getByRole("button", { name: "방송 종료" }).click();
  const dialog = host.page.getByTestId("confirm-dialog");
  await dialog.waitFor({ timeout: 10_000 });
  await host.page.waitForTimeout(400); // 오픈 애니메이션(160ms) 정착 대기
  await host.page.screenshot({ path: shot("host-confirm-end") });
  await host.ctx.close();
});

test("host 관리 바텀시트(모바일)", async ({ browser }) => {
  const ctx = await browser.newContext({
    permissions: ["microphone", "camera"],
    viewport: { width: 390, height: 844 },
  });
  const page = await ctx.newPage();
  await page.goto("/broadcast");
  await page.getByPlaceholder("호스트").fill("모바일호스트");
  await page.getByRole("button", { name: "방 만들기" }).click();
  await page.getByRole("button", { name: "입장" }).click();
  await page.getByTestId("invite").waitFor({ timeout: 20_000 });
  await page.getByRole("button", { name: "관리" }).click();
  await page.getByTestId("host-panel-sheet").waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: shot("host-sheet-mobile") });
  await ctx.close();
});

// ── 게스트/시청자 라이브 ─────────────────────────────────────
test("게스트 승인 모먼트(모바일)", async ({ browser }) => {
  const host = await createHost(browser, "호스트");
  const gctx = await browser.newContext({
    permissions: ["microphone", "camera"],
    viewport: { width: 390, height: 844 },
  });
  const g = await gctx.newPage();
  await g.goto(`/join/${host.roomId}?code=${host.code}`);
  await g.getByPlaceholder("게스트").fill("초대게스트");
  await g.getByRole("button", { name: "대기실 입장" }).click();
  await g.getByTestId("waiting-room").waitFor({ timeout: 20_000 });
  await approveAs(host.page, "초대게스트", "guest");
  // 토스트가 떠 있는 순간(4초 TTL) 캡처.
  await g.getByTestId("toast").waitFor({ timeout: 25_000 });
  await g.screenshot({ path: shot("guest-onstage-mobile") });
  await host.ctx.close();
  await gctx.close();
});

test("시청자 데스크톱 2단(webrtc)", async ({ browser }) => {
  const host = await createHost(browser, "호스트");
  const [g1] = await bringUpGuests(browser, host, ["게스트1"]);
  const vctx = await browser.newContext({ viewport: { width: 1200, height: 820 } });
  const page = await vctx.newPage();
  await page.goto(`/watch/${host.roomId}`);
  await page.getByPlaceholder("시청자").fill("관객");
  await page.getByRole("button", { name: "시청 입장" }).click();
  await page.evaluate(() => (window as any).__lkRoom);
  await page.waitForTimeout(2500); // 트랙 구독·타일 렌더 안정화
  await page.screenshot({ path: shot("viewer-watch-desktop") });
  await host.ctx.close();
  await g1!.ctx.close();
  await vctx.close();
});

test("강퇴 안내 화면(모바일)", async ({ browser }) => {
  const host = await createHost(browser, "호스트");
  const gctx = await browser.newContext({
    permissions: ["microphone", "camera"],
    viewport: { width: 390, height: 844 },
  });
  const g = await gctx.newPage();
  await g.goto(`/join/${host.roomId}?code=${host.code}`);
  await g.getByPlaceholder("게스트").fill("강퇴게스트");
  await g.getByRole("button", { name: "대기실 입장" }).click();
  await approveAs(host.page, "강퇴게스트", "guest");
  await g.getByText("🎙️ 출연 중").waitFor({ timeout: 25_000 });
  await kick(host.page, "강퇴게스트");
  await g.getByTestId("state-removed").waitFor({ timeout: 20_000 });
  await g.screenshot({ path: shot("guest-removed-mobile") });
  await host.ctx.close();
  await gctx.close();
});

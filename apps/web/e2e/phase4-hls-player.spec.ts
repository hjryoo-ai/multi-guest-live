import { test, expect, request as pwRequest } from "@playwright/test";
import { createHash, createHmac } from "node:crypto";
import { cpSync, mkdirSync } from "node:fs";
import path from "node:path";

/**
 * 모드 B 플레이어·서빙 커버리지 (egress 무관).
 *   커버리지 분리: egress=실서버 검증(로컬은 폴백), 서빙+hls.js 재생=CI 검증.
 *
 * 사전 생성 정적 HLS 픽스처를 egress-out/<roomId>/ 에 놓고 egress_started(active) 를
 * 서명 webhook 으로 주입 → /watch(모드 B) → hls.js 가 매니페스트 파싱(재생 경로 정상).
 * host 를 접속시키지 않으므로 실제 egress 기동/폴백은 발생하지 않는다.
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

test("[모드 B] 정적 HLS 픽스처가 서빙·재생된다 (hls.js MANIFEST_PARSED)", async ({
  page,
}) => {
  const ctx = await pwRequest.newContext();

  // 1) host 세션 + HLS 방 생성(브라우저 host 는 접속하지 않음 → egress/폴백 없음).
  const s = await (
    await ctx.post(`${API}/auth/session`, { data: { nickname: "픽스처호스트" } })
  ).json();
  const room = await (
    await ctx.post(`${API}/rooms`, {
      headers: { authorization: `Bearer ${s.token}` },
      data: { title: "HLS-fixture", maxGuests: 8, viewerMode: "hls" },
    })
  ).json();
  const roomId = room.id as string;

  // 2) 픽스처를 서빙 디렉터리로 복사.
  mkdirSync(path.join(EGRESS_OUT, roomId), { recursive: true });
  cpSync(FIXTURE, path.join(EGRESS_OUT, roomId), { recursive: true });

  // 3) egress_started(active) 주입 → egressStatus=active + playlistUrl 노출.
  const evBody = JSON.stringify({
    event: "egress_started",
    egressInfo: { egressId: "EG_fixture", roomName: roomId, status: "EGRESS_ACTIVE" },
    createdAt: Math.floor(Date.now() / 1000),
    id: "wh_fixture",
  });
  const wh = await ctx.post(`${API}/webhooks/livekit`, {
    headers: {
      "content-type": "application/webhook+json",
      authorization: signWebhook(evBody),
    },
    data: evBody,
  });
  expect(wh.status()).toBe(200);

  // 매니페스트가 정적 서빙되는지(200 + #EXTM3U).
  const info = await (await ctx.get(`${API}/rooms/${roomId}/hls`)).json();
  expect(info.playlistUrl).toBeTruthy();
  const manifest = await ctx.get(info.playlistUrl);
  expect(manifest.status()).toBe(200);
  expect(await manifest.text()).toContain("#EXTM3U");

  // 4) 시청자 입장(모드 B) → hls.js 매니페스트 파싱.
  await page.goto(`/watch/${roomId}`);
  await page.getByPlaceholder("시청자").fill("픽스처시청자");
  await page.getByRole("button", { name: "시청 입장" }).click();

  const video = page.getByTestId("hls-video");
  await expect(video).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(() => video.getAttribute("data-hls-state"), { timeout: 20_000 })
    .toBe("parsed");

  await ctx.dispose();
});

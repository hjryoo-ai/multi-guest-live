import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { QUEUE_POLL_MS } from "../lib/timings";

/**
 * 승인 큐행 가시성 대기 상한(ms). 제품 폴백 폴링 주기(QUEUE_POLL_MS)에서 파생한다.
 *
 * 불변식: 대기는 폴백 주기의 **2배를 초과**해야 한다 — "1주기 초과"가 아니라 "1주기 유실을
 * 견딤"이 옳은 하한이다. 최악은 요청이 폴 N 직후 들어오고(≈+1주기), 부하로 폴 N+1 의 refresh
 * 가 유실/지연되는 것(≈+1주기)이라, 보증까지 최대 2주기가 걸릴 수 있다(@heavy 9-컨텍스트 부하에서
 * 후반 speaker 큐행 지연 — phase6a S4/S3 연속 실패로 확인). 따라서 대기는 2주기를 초과해야 한다.
 *   → 2.5× = 2주기(40s) + refresh 지연 여유 10s. 폴링 주기를 바꾸면 이 값은 자동으로 함께 움직인다.
 *
 * PR#12 는 이 관계를 1.5× 로 잘못 못박았고(프로즈 주석 두 곳이 막지 못함), phase6a 후반부에서
 * 재발했다 → 아래에서 하한(2×)을 코드로 강제한다.
 */
export const QUEUE_ROW_WAIT_MS = Math.round(QUEUE_POLL_MS * 2.5);

// 불변식 하한(머신 체크): 대기가 2×폴백주기 미만이면 로드 시점에 즉시 실패시킨다.
// 프로즈 주석은 PR#12 에서 잘못된 배수를 막지 못했으므로, 관계를 코드로 못박는다.
if (QUEUE_ROW_WAIT_MS < QUEUE_POLL_MS * 2) {
  throw new Error(
    `QUEUE_ROW_WAIT_MS(${QUEUE_ROW_WAIT_MS}ms) < 2×QUEUE_POLL_MS(${QUEUE_POLL_MS * 2}ms): ` +
      `승인 큐행 대기는 폴백 폴링 1주기 유실을 견디도록 폴백 주기의 2배를 초과해야 한다.`,
  );
}

export interface Peer {
  ctx: BrowserContext;
  page: Page;
}

export async function newSessionPage(browser: Browser): Promise<Peer> {
  const ctx = await browser.newContext({
    permissions: ["microphone", "camera"],
  });
  const page = await ctx.newPage();
  return { ctx, page };
}

/** 방의 '구독 중인 원격 오디오 트랙' 수. */
export async function subscribedRemoteAudioCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const room = (window as any).__lkRoom;
    if (!room) return -1;
    let n = 0;
    room.remoteParticipants.forEach((p: any) => {
      p.audioTrackPublications.forEach((pub: any) => {
        if (pub.isSubscribed) n++;
      });
    });
    return n;
  });
}

/** 구독 중인 원격 오디오 트랙 sid 집합. */
export async function subscribedRemoteAudioSids(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const room = (window as any).__lkRoom;
    const out: string[] = [];
    room?.remoteParticipants.forEach((p: any) => {
      p.audioTrackPublications.forEach((pub: any) => {
        if (pub.isSubscribed && pub.trackSid) out.push(pub.trackSid);
      });
    });
    return out;
  });
}

/** 설계 불변식: 참가자의 구독 오디오 수 == (전체 publish 오디오 − 자기 것). */
export async function assertAudioReach(
  page: Page,
  totalPublishers: number,
  who: string,
) {
  await expect
    .poll(() => subscribedRemoteAudioCount(page), {
      timeout: 30_000,
      message: `${who}: subscribedAudioTracks == ${totalPublishers - 1} 기대`,
    })
    .toBe(totalPublishers - 1);
}

/** host 방송 시작 → roomId/code 반환. mode 로 시청자 모드(webrtc/hls) 선택. */
export async function createHost(
  browser: Browser,
  nickname = "호스트",
  mode: "webrtc" | "hls" = "webrtc",
): Promise<Peer & { roomId: string; code: string }> {
  const peer = await newSessionPage(browser);
  const { page } = peer;
  await page.goto("/broadcast");
  await page.getByPlaceholder("호스트").fill(nickname);
  if (mode === "hls") {
    await page.getByRole("combobox").selectOption("hls");
  }
  await page.getByRole("button", { name: "방 만들기" }).click();
  await page.getByRole("button", { name: "입장" }).click();
  const invite = page.getByTestId("invite");
  await expect(invite).toBeVisible({ timeout: 20_000 });
  const roomId = (await invite.getAttribute("data-room-id"))!;
  const code = (await invite.getAttribute("data-code"))!;
  return { ...peer, roomId, code };
}

/** guest 대기실 입장(아직 승인 전). */
export async function joinGuest(
  browser: Browser,
  roomId: string,
  code: string,
  nickname: string,
): Promise<Peer> {
  const peer = await newSessionPage(browser);
  await peer.page.goto(`/join/${roomId}?code=${code}`);
  await peer.page.getByPlaceholder("게스트").fill(nickname);
  await peer.page.getByRole("button", { name: "대기실 입장" }).click();
  await expect
    .poll(() => peer.page.evaluate(() => !!(window as any).__lkRoom), {
      timeout: 20_000,
    })
    .toBe(true);
  return peer;
}

/** host 큐에서 특정 닉네임을 role 로 승인. */
export async function approveAs(
  hostPage: Page,
  nickname: string,
  role: "guest" | "speaker" = "guest",
) {
  // 요청 큐 행으로 스코프(정확 일치). host 패널은 참가자/요청 탭이 상시 마운트라
  // 스코프 없는 li·닉네임 셀렉터는 참가자 탭의 'viewer 행'과 이중 매치된다(strict violation).
  const row = hostPage.locator(
    `[data-testid="join-request-row"][data-nick="${nickname}"]`,
  );
  await expect(row).toBeVisible({ timeout: QUEUE_ROW_WAIT_MS });
  const label = role === "speaker" ? "스피커로 승인" : "게스트로 승인";
  await row.getByRole("button", { name: label }).click();
}

/** host 큐에서 특정 닉네임 게스트 승인(하위호환). */
export async function approve(hostPage: Page, nickname: string) {
  await approveAs(hostPage, nickname, "guest");
}

/** guest 가 출연(마이크 송출)으로 승격될 때까지 대기. */
export async function waitUpgraded(guestPage: Page) {
  await expect(guestPage.getByText("🎙️ 출연 중")).toBeVisible({
    timeout: 25_000,
  });
}

/** speaker 로 승격(음성 참여)될 때까지 대기. */
export async function waitSpeaker(page: Page) {
  await expect(page.getByText("🎙 음성 참여 중")).toBeVisible({
    timeout: 25_000,
  });
}

/** 원격 비디오 publication 수(옵션: 특정 닉네임만). */
export async function remoteVideoCount(
  page: Page,
  nick?: string,
): Promise<number> {
  return page.evaluate((n) => {
    const room = (window as any).__lkRoom;
    let count = 0;
    room?.remoteParticipants.forEach((p: any) => {
      if (n && p.name !== n) return;
      count += p.videoTrackPublications.size;
    });
    return count;
  }, nick);
}

/** host 스테이지에서 특정 닉네임 타일의 강퇴 버튼 클릭. */
export async function kick(hostPage: Page, nickname: string) {
  // 스테이지 타일로 스코프. data-nick 은 tile·speaker-chip·요청 큐 행이 공유하므로
  // testid 로 좁히지 않으면 이중/삼중 매치된다(참가자/요청 탭 상시 마운트).
  const tile = hostPage.locator(`[data-testid="tile"][data-nick="${nickname}"]`);
  await expect(tile).toBeVisible({ timeout: 20_000 });
  await tile.getByRole("button", { name: "강퇴" }).click();
  // Phase 6.6: 파괴적 액션은 컨펌 다이얼로그 → "강퇴하기" 확정.
  await hostPage
    .getByTestId("confirm-dialog")
    .getByRole("button", { name: "강퇴하기" })
    .click();
}

/** 모드 A(webrtc) 시청자로 입장(subscribe-only). __lkRoom 준비까지 대기. */
export async function joinViewer(
  browser: Browser,
  roomId: string,
  nickname: string,
): Promise<Peer> {
  const peer = await newSessionPage(browser);
  await peer.page.goto(`/watch/${roomId}`);
  await peer.page.getByPlaceholder("시청자").fill(nickname);
  await peer.page.getByRole("button", { name: "시청 입장" }).click();
  await expect
    .poll(() => peer.page.evaluate(() => !!(window as any).__lkRoom), {
      timeout: 20_000,
    })
    .toBe(true);
  return peer;
}

/**
 * host 우측 패널의 '채팅' 탭 활성화(Phase 6.6).
 *   패널은 참가자/요청/채팅 3탭이고 기본 탭은 '요청'(승인 동선 우선) →
 *   host 채팅을 조작하려면 채팅 탭을 먼저 연다. 탭은 display 토글이라 상태는 보존된다.
 */
export async function openHostChat(page: Page) {
  await page.getByRole("tab", { name: "채팅" }).click();
}

/** 채팅 입력창에 텍스트를 넣고 전송. */
export async function sendChat(page: Page, text: string) {
  const input = page.getByPlaceholder("메시지 입력").first();
  await input.fill(text);
  await input.press("Enter");
}

/** 특정 채팅 텍스트가 페이지에 나타날 때까지 대기. */
export async function expectChat(page: Page, text: string) {
  await expect(page.getByText(text, { exact: false }).first()).toBeVisible({
    timeout: 15_000,
  });
}

/** guest 를 대기실 입장 → 스피커 승인 → 음성 참여까지. */
export async function bringUpSpeaker(
  browser: Browser,
  host: Peer & { roomId: string; code: string },
  nickname: string,
): Promise<Peer> {
  const s = await joinGuest(browser, host.roomId, host.code, nickname);
  await approveAs(host.page, nickname, "speaker");
  await waitSpeaker(s.page);
  return s;
}

/** host + N 게스트를 모두 출연시키고 각자 컨텍스트를 반환. */
export async function bringUpGuests(
  browser: Browser,
  host: Peer & { roomId: string; code: string },
  nicknames: string[],
): Promise<Peer[]> {
  const guests: Peer[] = [];
  for (const nick of nicknames) {
    const g = await joinGuest(browser, host.roomId, host.code, nick);
    await approve(host.page, nick);
    await waitUpgraded(g.page);
    guests.push(g);
  }
  return guests;
}

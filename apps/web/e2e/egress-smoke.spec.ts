import { test, expect, request as pwRequest } from "@playwright/test";
import { createHost } from "./helpers";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/**
 * 모드 B(HLS) egress 스모크 — 베스트 에포트(@heavy 로 기본 게이트 제외).
 * 전제: docker egress 컨테이너 기동 필요(`docker compose up -d egress`).
 *
 * host 가 실제 송출 중인 HLS 방에서 egress 제어 루프가 "정상 종단 상태"에 도달하는지 검증:
 *   - 성공: egressStatus=active + playlistUrl 재생 가능(실제 HLS 세그먼트 생성)
 *   - 폴백: egress 실패 시 viewer_mode=webrtc + egressStatus=failed (자동 폴백)
 * 둘 중 하나면 제어 루프가 올바른 것 — Mac Docker 의 egress(headless Chrome) 불안정성에
 * 강건하도록 종단 상태만 단언한다.
 */
test("@heavy [모드 B] egress 제어 루프가 정상 종단 상태에 도달", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const host = await createHost(browser, "HLS호스트", "hls");

  const ctx = await pwRequest.newContext();
  const deadline = Date.now() + 90_000;
  let terminal: any = null;
  while (Date.now() < deadline) {
    const res = await ctx.get(`${API}/rooms/${host.roomId}/hls`);
    const info = await res.json();
    if (info.egressStatus === "active" && info.playlistUrl) {
      terminal = { kind: "active", info };
      break;
    }
    if (info.egressStatus === "failed") {
      terminal = { kind: "failed", info };
      break;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  expect(terminal, "egress 제어 루프가 종단 상태(active|failed)에 도달").toBeTruthy();
  console.log("[egress-smoke] terminal =", JSON.stringify(terminal));

  if (terminal.kind === "active") {
    // 실제 HLS 매니페스트가 재생 가능해야 함.
    const m = await ctx.get(terminal.info.playlistUrl);
    expect(m.status()).toBe(200);
    const body = await m.text();
    expect(body).toContain("#EXTM3U");
  } else {
    // 폴백 검증: 방이 webrtc 로 전환됐는지.
    const room = await (await ctx.get(`${API}/rooms/${host.roomId}`)).json();
    expect(room.viewerMode).toBe("webrtc");
  }

  await ctx.dispose();
  await host.ctx.close();
});

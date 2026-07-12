import { defineConfig } from "@playwright/test";

/**
 * Phase 2/3 E2E — 가짜 미디어로 실제 LiveKit A/V 를 구동해 오디오 전수 도달을 검증.
 * 전제: docker infra(livekit/redis/postgres) + api(:4000) 가 이미 실행 중이어야 함.
 *       web(:3000) 은 아래 webServer 가 자동 기동.
 */
export default defineConfig({
  testDir: "./e2e",
  // 스크린샷 산출 스펙은 게이트에서 제외(문서용). 재생성 시 이 줄을 잠시 주석 처리.
  testIgnore: "**/screenshots.spec.ts",
  timeout: 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // PR 게이트는 핵심 시나리오만. 8명 전수(@heavy)는 HEAVY=1 로 nightly 실행.
  grep: process.env.HEAVY ? /@heavy/ : undefined,
  grepInvert: process.env.HEAVY ? undefined : /@heavy/,
  use: {
    baseURL: "http://localhost:3000",
    launchOptions: {
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
    permissions: ["microphone", "camera"],
  },
  webServer: {
    command: "pnpm exec next start -p 3000",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});

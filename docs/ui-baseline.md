# Phase 6.6 — UI 기준선 (ui-baseline)

> UI 다듬기 패스의 성능·품질 기준선. 번들 수치는 `pnpm --filter web build` 실측,
> 스크린샷은 `docs/screenshots/*.png`(after). Lighthouse 는 아래 절차로 재현.

## 1. 번들 (First Load JS) — 실측

| 라우트 | Phase 6.5 종료 | Phase 6.6 종료 | 비고 |
|---|---|---|---|
| `/watch/[roomId]` | 264 kB | 266 kB | hls.js 는 여전히 lazy 청크(모드 A/게스트 미로드) |
| `/join/[roomId]` | 268 kB | 270 kB | DevicePreview(+2 kB) |
| `/broadcast` | 270 kB | 270 kB | HostPanel 로 재구성(순증 ~0) |
| shared | 87.3 kB | 87.3 kB | — |

증가분(≤2 kB/route)은 신규 컴포넌트(DevicePreview·MediaFrame·HostPanel·상태 셸) 대비 미미.
hls.js(약 −155 kB)의 lazy 분리(6.5 B-4 이관분)는 유지된다.

> **기준선 이동 — Next 15 업그레이드(#2) 이후**: `/watch` **280 kB** · `/join`·`/broadcast` 284 kB · shared **102 kB**(87.3→102). 증가분(~+15 kB)은 라우트 코드가 아니라 **Next 15 shared 런타임**에서 발생(route별 코드는 3.3~4.6 kB로 유지) — 코드 리그레션이 아닌 프레임워크 고정비용. **이후 PR의 번들 비교 기준선은 이 수치(watch 280 kB)를 쓴다.**
>
> **§7-lite 데모 UX(#6) 이후**: `/broadcast` 284→**286 kB**(+2 kB, RoomShare·DemoGuide·데모 진입 로직). **shared 102 kB·`/watch` 280·`/join` 284 는 불변** — QR 라이브러리(`qrcode.react`)를 `next/dynamic(ssr:false)`로 **동적 청크** 분리해 공유 런타임·타 라우트에 싣지 않았다(설계 의도 실측 확인). /broadcast 순증(+2 kB)은 신규 UI 컴포넌트 대비 미미(≤2 kB/route 관례 내).

## 2. 레벨미터/글로우 링 리렌더 = 0 (설계 성질)

스펙 §6 "볼륨 틱당 React commit 0" 은 **측정이 아니라 구조로 보장**한다:

- `useTrackVolume`·`useIsSpeaking`(state 훅) **제거**. 볼륨→`setState` 경로가 코드에 존재하지 않는다.
- `Stage.useAudioGlow`(components/Stage.tsx): rAF 로 `participant.audioLevel` 을 읽어
  `el.style.setProperty("--glow"/"--meter", …)` 로 **DOM 에 직접 기록** — 리액트 트리 갱신 없음.
- 레벨미터 폭은 CSS `calc(var(--meter) * 100%)`, 글로우는 `box-shadow/outline` + `color-mix(var(--glow))`.
- `DevicePreview` 마이크 미터도 동일 철학(analyser → CSS 변수).
- 검증: 볼륨 변화로 리렌더를 유발하는 유일한 경로였던 두 훅이 없으므로, 프로파일러상 볼륨 틱 commit 은
  구조적으로 0. 마이크 구독/음소거 같은 **저빈도 상태**만 이벤트로 갱신(`useMicSubscribed`).

## 3. 접근성 바닥값

- 전 인터랙션 `:focus-visible` 브랜드 링(globals.css).
- ConfirmDialog·BottomSheet: `role="dialog"` + `aria-modal` + 포커스 트랩 + Esc.
- HostPanel 탭: `role="tab"` + `aria-selected`.
- Toast: `aria-live="polite"` + `role="status"`.
- `prefers-reduced-motion`: 애니메이션 시간 최소화 + 글로우 정적 테두리 대체.
- 숫자(시청자 수 등) `tabular-nums`.

## 4. Lighthouse — 재현 절차(수동)

헤드리스 Lighthouse 는 실미디어/LiveKit 접속 없이 **입장 전 화면** 기준으로 잡는다(대표 표면):

```bash
pnpm --filter web build && pnpm --filter web exec next start -p 3000 &
npx lighthouse http://localhost:3000/broadcast \
  --preset=desktop --only-categories=performance,accessibility,best-practices \
  --output=json --output-path=docs/lighthouse-broadcast.json --chrome-flags="--headless"
```

라이브 화면(스테이지·채팅)은 미디어 스트림 의존이라 Lighthouse 자동화 대신 스크린샷·E2E 로 커버.
현 단계 기준선은 §1 번들 + §2 리렌더 성질 + §5 스크린샷으로 갈음(정식 Lighthouse 수치는 배포 파이프라인에서 수집 권장).

## 5. 스크린샷 (after)

`docs/screenshots/`(14장) — `pnpm --filter web exec playwright test screenshots` 로 재생성
(playwright.config 의 `testIgnore` 를 잠시 주석 처리). 컨펌/시트 등 오버레이 캡처는 오픈
애니메이션(160~200ms) 정착을 위해 `waitForTimeout` 후 촬영한다.

**엔트리·정적**: `entry-broadcast-setup` · `entry-viewer-mobile` · `guest-preview-desktop` · `guest-preview-mobile`
**호스트**: `host-desktop`(2단+글로우 링) · `host-queue-desktop`(요청 큐·승인 버튼) · `host-chat-desktop`(채팅 탭) · `host-confirm-end`(방송 종료 컨펌) · `host-sheet-mobile`(관리 바텀시트)
**게스트**: `guest-waiting-mobile`(대기실) · `guest-onstage-mobile`(승인 모먼트 토스트+출연) · `guest-removed-mobile`(강퇴 안내)
**시청자**: `viewer-watch-mobile`(세로·오버레이·safe-area) · `viewer-watch-desktop`(2단)

> 스크린샷 산출 중 2건 실수정: ①ConfirmDialog/BottomSheet 표면을 `--surface-2`+짙은 백드롭(0.72)+강한 그림자로 **엘리베이션 강화**(다크 배경 대비 부족 해소). ②호스트 요청 큐 행을 360px 패널에서 닉네임/버튼 2줄로 재배치(버튼 세로 줄바꿈 깨짐 해소).
> before 스냅샷은 VCS 미사용(비-git 저장소)으로 별도 보존본이 없다. 구조 변경 요약은 커밋 노트/리포트로 대체.

## 6. E2E 게이트

기존 11 게이트 + 모바일 스모크 4종(390×844) = **15 통과**. 스크린샷 스펙(3)은 게이트 제외.
- 모바일 시청: 오버레이 가시 + **입력 포커스 상태에서 전송 버튼 뷰포트 내**(키보드/ safe-area 회귀 가드) + 전송.
- 모바일 게스트: 프리뷰 → 대기실 → 승인 모먼트 토스트 + 출연 상태.
- 모바일 호스트: 관리 바텀시트 → 탭 전환(참가자/채팅).
- **모바일 데모(§7-lite #6 신규)**: `/broadcast?demo=1` → 자동 라이브 → QR 2종 + 1회 가이드 → **새로고침 시 방 중복생성 없음**(이중생성 벡터 회귀 가드).

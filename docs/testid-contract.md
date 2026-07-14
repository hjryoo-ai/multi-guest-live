# E2E 테스트 계약 (testid / 셀렉터) — Phase 6.6 이전 고정본

> **이 패스의 최우선 규칙(6.6 §5).** UI 개편이 아래 계약을 조용히 깨는 것이 최대 리스크다.
> 마크업을 바꿔도 아래 앵커는 **반드시 보존·이동**한다. 불가피하게 텍스트/역할 라벨을 바꾸면
> `e2e/helpers.ts` + 해당 spec 을 **동일 커밋**에서 고쳐야 하며 완료 보고에 명시한다.
> 추출 시점: Phase 6.6 시작 전(Phase 6.5 완료 상태). E2E 게이트 = 11개 스펙(회귀 기준).

## 1. `data-testid` (보존 필수)

| testid | 위치(컴포넌트) | 동반 속성 | 사용처(spec/helper) |
|---|---|---|---|
| `invite` | 방 생성 후 초대 카드 (broadcast) | `data-room-id`, `data-code` | createHost — roomId·code 추출 |
| `tile` | Stage 참가자 타일 | `data-nick` | phase3/6a, remoteVideoCount, kick |
| `speaker-chip` | speaker 스트립 아바타 | `data-nick`(권장) | phase6a |
| `viewer-count` | 시청자 수 배지 | — | phase4 |
| `hls-video` | HlsPlayer `<video>` | `data-hls-state`=`idle\|parsed\|error` | phase4-hls-player |
| `chat-msg` | 채팅 메시지 행 | `data-msg-id`, `data-hidden`=`0\|1` | phase4/6b/65a |
| `chat-banned` | 채팅 차단 안내 | — | phase6b |
| `duplicate-banner` | ReconnectGuard 중복 접속 | — | phase5-reconnect(있으면) |
| `reconnect-manual` | ReconnectGuard 수동 재접속 | — | phase5-reconnect |

## 2. 텍스트/역할/placeholder 셀렉터 (보존 또는 동일 커밋 수정)

**Placeholder** (`getByPlaceholder`): `호스트` · `게스트` · `시청자` · `메시지 입력`

**버튼** (`getByRole("button", { name })`):
`방 만들기` · `입장` · `대기실 입장` · `시청 입장` · `게스트로 승인` · `스피커로 승인` · `거절` ·
`강퇴`(타일 내) · `숨기기`(채팅) · `게스트로`(speaker chip→guest) · `스피커로`(tile→speaker) · `다시 접속`(reconnect-manual)

**콤보박스**: `getByRole("combobox").selectOption("hls")` — broadcast 모드 선택(value=`hls`/`webrtc`)

**텍스트** (`getByText`): `🎙️ 출연 중`(guest 승격) · `🎙 음성 참여 중`(speaker 승격)

## 3. 런타임 훅

- `window.__lkRoom` — `AudioReach` 가 `useRoomContext()` room 을 노출(E2E 구독상태 introspection). **보존 필수.**

## 4. Phase 6.6 신규 상태 화면 testid (후속 E2E·모바일 스모크용 신규 부여)

| testid | 화면/상태 |
|---|---|
| `state-loading` | 공통 셸 로딩(스켈레톤 컨테이너) |
| `state-error` | 공통 셸 에러(원인+재시도) |
| `state-ended` | 방송 종료 화면 |
| `state-removed` | 강퇴 안내(재요청 경로) — **구현됨(6.6 Guest)**. `phase3` 강퇴 시나리오가 강퇴된 쪽 가시성 검증 |
| `device-preview` | guest 장치 프리뷰 — **구현됨(6.6 Guest)** |
| `waiting-room` | guest 대기실 — **구현됨(6.6 Guest)**. 승격되면 이 testid 는 사라지고 상태 pill 이 `🎙️ 출연 중`/`🎙 음성 참여 중` 노출(기존 승격 신호 보존) |
| ~~`approval-toast`~~ | 승인 모먼트는 **공용 `toast` testid** 로 통일(별도 testid 미부여). guest 모바일 스모크가 `toast` 가시성으로 검증 |
| `chat-input` | 채팅 입력창(비활성 상태 판별) — **구현됨(6.6 Viewer)**. placeholder `메시지 입력` 병존 유지 |
| `chat-jump` | "새 메시지 ↓" 점프 배지 — **구현됨(6.6 Viewer)** |
| `chat-retry` | 전송 실패 재시도 버튼(`↻ 다시 보내기`) — **구현됨(6.6 Viewer)** |
| `host-panel` | host 우측 패널(참가자/요청/채팅 탭) — **구현됨(6.6 Host)**. 탭은 `role="tab"` (`참가자 N` / `요청` / `채팅`), 기본 활성 = `요청` |
| `participant-row` | 참가자 탭의 행(HostPanel) — `data-nick`. **컨테이너 스코프 앵커**(승인 전 게스트는 여기 `…시청` 행으로도 존재) |
| `join-request-row` | 요청 탭 승인 큐 행(HostQueue) — `data-nick`. `approveAs` 가 `[data-testid="join-request-row"][data-nick=…]` 로 정확·스코프 선택 |
| `host-panel-sheet` | 모바일 host 하단 시트 — **구현됨(6.6 Host)**. 좁은 화면(<900px)에서 `관리` 버튼으로 오픈 |
| `confirm-dialog` | 파괴적 액션 컨펌 — 구현됨 |
| `toast` | 토스트(성공/실패/정보) — 구현됨 |

> 신규 testid 는 기존 계약을 침범하지 않으며, 모바일 스모크(390×844) 3종이 이를 사용한다.

## 6. §7-lite 데모 UX testid (신규 · 동일 커밋 반영)

| testid | 위치(컴포넌트) | 동반 속성 | 사용처(spec/helper) |
|---|---|---|---|
| `demo-start` | 랜딩 데모 배너의 "데모 시작"(app/page.tsx, `NEXT_PUBLIC_DEMO_MODE` 시에만 렌더) | — (링크 `/broadcast?demo=1`) | 수동/스크린샷 (모바일 스모크는 URL 직행이라 미의존) |
| `qr-guest` | 호스트 라이브 QR 공유 — 게스트 진입(RoomShare) | `data-url` | phase7-demo-mobile |
| `qr-viewer` | 호스트 라이브 QR 공유 — 시청자 진입(RoomShare) | `data-url` | phase7-demo-mobile |
| `guide-overlay` | 데모 1회성 가이드 오버레이(DemoGuide, 세션당 1회) | `role="dialog"` | phase7-demo-mobile |
| `guide-dismiss` | 가이드 "시작하기"(닫기) | — | phase7-demo-mobile |

> `demo-start` 노출은 **표시 플래그**(`NEXT_PUBLIC_DEMO_MODE`) 종속이지만, 데모 **플로우**는 `?demo=1`
> URL 로 구동되어 표시 플래그와 무관하다 — 그래서 모바일 스모크는 배너를 거치지 않고 `/broadcast?demo=1`
> 로 직행해 게이트를 빌드 플래그에 묶지 않는다. QR 컨테이너 div 는 동기 렌더(내부 SVG 만 동적 로드)라
> `toBeVisible` 이 즉시 성립한다.

## 5. Phase 6.6 에서 변경된 계약(동일 커밋 반영 완료)

호스트 채팅이 우측 패널의 **채팅 탭**(기본 비활성, `요청` 탭이 기본)으로 이동했다. host 채팅을
조작하는 스펙은 먼저 채팅 탭을 열어야 한다 → `helpers.openHostChat(page)` = `getByRole("tab",{name:"채팅"}).click()`.
반영된 스펙: `phase4`(승인 후), `phase65a`(승인 후), `phase6b`(생성 직후). kick 은 타일 버튼이라 무관.
탭은 display 토글(상시 마운트)이라 전환·폴링에도 채팅/큐 상태가 보존된다.

### 셀렉터 스코프 규칙 (상시 마운트 탭 — 필수)

host 패널 탭이 **display 토글 상시 마운트**라는 사실은 셀렉터에 직접적 제약을 만든다:
**참가자 / 요청 두 리스트의 `<li>` 가 (숨은 탭 포함) DOM 에 항상 공존**한다. 따라서 —

- **모든 행 셀렉터는 컨테이너 스코프 필수**다. `locator("li",{hasText:닉})` 처럼 스코프 없는
  선택은 승인 전 게스트에서 참가자 탭 `…시청` 행과 요청 탭 `…게스트로 승인` 행에 **이중 매치**
  (Playwright strict violation)된다. 반드시 `participant-row` / `join-request-row` 로 좁힌다.
- **닉네임은 정확 일치**로: `data-nick="게스트1"` 은 `게스트10` 에 부분매치되지 않는다.
- **`data-nick` 는 tile·speaker-chip·join-request-row·participant-row 가 공유**한다. 이 속성만으로
  선택하면 다중 매치되므로 **반드시 `[data-testid=…]` 와 결합**한다(예: `kick` = `[data-testid="tile"][data-nick=…]`).
- 이 규칙의 게이트 회귀 방지 테스트: `phase3` "[승인 큐 스코프] … 마스킹 회귀 방지" —
  참가자·요청 행 공존을 결정적으로 만들어 스코프 회귀 시 게이트에서 즉시 실패한다.
  (원래 이 버그는 `@heavy`(nightly)에서만 드러났다 → 게이트로 승격.)

### 대기 시간 규칙 (테스트 vs 제품 폴백 주기)

- **E2E 대기 시간은 대응하는 제품 폴백 주기를 초과해야 한다.** 신호(push) 유실 시 폴백 폴링이
  "이 주기 안에는 반드시 뜬다"를 보증하므로, 대기가 그 주기와 같거나 짧으면 보증 경계와 레이스가
  난다(@heavy 8명 부하에서 마지막 게스트 큐행이 폴링 직전에야 떠 1차 시도 실패 → retry 의존).
- **파생으로 강제**한다(매직넘버 금지): 큐행 대기 = `QUEUE_POLL_MS × 1.5`(`lib/timings.ts` 단일 출처,
  `helpers.QUEUE_ROW_WAIT_MS`). 폴링 주기를 바꾸면 대기도 자동으로 함께 움직여 레이스가 조용히 부활하지 않는다.

# Phase 6.5 — 배포 전 하드닝 리포트

> 범위: 인프라 없이 **코드 레벨**에서 다듬을 수 있는 보안·성능·안정성. TURN/HTTPS/실시크릿/실인증은 Phase 7.
> 검증: 신규 `verify:phase65a/b/c`(총 31 assertion) + 기존 `verify:phase1~6b` 회귀(124) + E2E 11게이트.
> 결과: **전 verify 155 assertion 통과, E2E 11/11 통과, 회귀 0.**

구현 순서는 A→B→C 지만, 부트스트랩 성격 항목(CORS·helmet·rate-limit·HLS 헤더·에러 핸들러·graceful shutdown·health)은
`index.ts` 한 곳이라 **한 번에** 반영하고 각 트랙 종료 시 verify+E2E 로 회귀를 확인했다(회귀 무결).

---

## Track A — 보안

| 항목 | 조치 | 검증 |
|---|---|---|
| **A-1 신호 스푸핑 차단** (P0) | 실측(probe) 후 `isServerSignal(participant)=participant==null` 유틸(`web/lib/signal.ts`)로 전 `DataReceived` 핸들러(AudioReach·EgressFallbackBanner·HostQueue·ReconnectGuard·Chat) 가드. chat 토픽(CHAT)·signal 토픽(CHAT_MODERATED 등) 모두 서버 발신이라 함께 차단. | e2e `phase65a`: 참가자가 위조 CHAT·CHAT_MODERATED 발송 → 무시, 진짜 서버 경로만 반영(+대조군) |
| **A-2 입력·인증 검증** (P0) | ① `:id`/`:userId` UUID preValidation 훅(→400 `invalid_id`) ② nickname·title 제어문자 거부(shared) ③ audio-report 는 body identity 무시하고 `req.user.sub` 권위(스키마에 identity 필드 없음) ④ 시크릿 부트 검증(→C-3) | `verify:phase65a` |
| **A-3 엔드포인트 rate limit** (P0) | `@fastify/rate-limit`(Redis 스토어). **user 키** 기준: token 30/분, join-requests 10/분, invite 20/분. `/auth/session`만 IP 10/분(비프로덕션 loopback 예외 → 로컬 E2E·verify 무간섭). 채팅 1/s 는 기존 유지. | `verify:phase65a`(429 + **per-user 비합산** 확인) |
| **A-4 웹 계층** (P0~P1) | ① CORS 화이트리스트(`CORS_ORIGINS`, 프로덕션 `*` 부트 거부) ② `/hls/:roomId` 첫 세그먼트 UUID 격리(traversal→400) ③ `@fastify/helmet`(CSP·CORP 는 HLS/CORS 위해 비활성) ④ body 상한 1MB(webhook 포함, →413) ⑤ XSS: `dangerouslySetInnerHTML`·자동 링크화 부재 확인(React 기본 이스케이프) | `verify:phase65a` + grep 감사 |
| **A-5 로그·응답 위생** (P1) | ① pino `redact` 로 Authorization·cookie 마스킹 ② 중앙 에러 핸들러: 프로덕션 5xx 는 내부 메시지 미노출(서버 로그만) ③ 토큰·시크릿 직접 로깅 경로 부재 확인 | grep 감사 + `verify:phase65c`(flat 에러 스키마) |

**A-1 실측(probe) 결과**: 서버(`RoomServiceClient.sendData`) 발신 시 클라이언트 `DataReceived` 의 `participant=undefined`,
참가자(`localParticipant.publishData`) 발신 시 발신 참가자로 채워짐(identity·kind). → `participant==null` 로 100% 구분. probe 파일은 삭제.

---

## Track B — 성능

| 항목 | 조치 | 측정/검증 |
|---|---|---|
| **B-1 채팅 폴링 캐시** (P0) | `getChatSnapshot`: messages+hiddenIds+cursor 를 Redis **1초 TTL** 캐시. 방별 **버전 키(write 시 INCR)** 로 즉시 무효화(신규 메시지·숨김/해제) — 스캔 불필요. viewerCount 는 폴러별 heartbeat 라 라이브 계산. | `verify:phase65b`: 연속 6 GET → hit+5/miss+1(DB 조회 ≤1/초/방), TTL 만료·write 후 정합성 |
| **B-2 DB·Redis 접근** (P1) | ① 인덱스 이미 충분: `chat_messages_room_id_idx(roomId,id)`·`_room_hidden_idx(roomId,hidden)`·`room_participants_room_idx` — 마이그레이션 불필요 ② `KEYS`→`SCAN`(hostGrace 스위퍼·metrics 게이지) + 다건 `scard` 파이프라인화 | 코드 리뷰 |
| **B-3 HLS 캐싱 헤더** (P0) | 세그먼트(.ts/.m4s/.mp4) `public, max-age=86400, immutable` / 매니페스트(.m3u8) `no-cache`. `@fastify/static` 기본 cacheControl 비활성해 setHeaders 우선. CDN 정책과 동일해짐. | `verify:phase65b` |
| ~~**B-4 웹 클라이언트**~~ | **→ Phase 6.6 Track D 에서 완료.** 레벨미터/글로우: `useTrackVolume`·`useIsSpeaking` 제거 후 rAF→CSS 변수(볼륨 틱 리렌더 **구조적 0**). hls.js 동적 import 유지(모드 A/게스트 미로드). 상세 `docs/ui-baseline.md`. | 6.6 E2E 14 |
| **B-5 서버 응답성** (P1) | LiveKit 도달성 체크에 5초 타임아웃(`checkLiveKitReachable`). webhook 핸들러는 DB(인덱스) + 간헐 LiveKit 호출로 경량, egress 기동은 이미 `void`(비동기). | — |

---

## Track C — 안정성·운영

| 항목 | 조치 | 검증 |
|---|---|---|
| **C-1 graceful shutdown** (P0) | SIGTERM/SIGINT → 스위퍼 정지 → `app.close()`(신규 거부+진행 drain) → redis/db 종료 → exit 0. 10초 하드 상한. | `verify:phase65c`: exit 0 + drain 5xx 없음 + 종료 후 접속 거부 |
| **C-2 에러 응답 표준화** (P1) | 전 엔드포인트가 이미 `{ error: <code> }` **단일 flat 스키마**로 일관 → 코드 카탈로그 `ERROR_CODES`(shared)로 집약+문서화. 중첩 `{error:{code,message}}` 는 **미채택**(일관된 계약·124 assertion 을 깨고 이득 미미). | `verify:phase65c`(flat 확인) |
| **C-3 부트 fail-fast** (P0) | 전 env zod 검증. 프로덕션에서 약한 시크릿(devkey/<32자)·CORS `*`·형식오류면 **어떤 키가 왜** 인지 출력 후 즉시 종료. | `verify:phase65a` |
| **C-4 운영 편의** | (P1) 요청 로그 reqId = Fastify 기본 · 도메인 로그 roomId 포함 / (P1) `/health/ready` 에 LiveKit 도달성 추가(다운 시 503) / (P2) pnpm audit 보고 ↓ / (P2) 백업 방침 ↓ | `verify:phase65c` |

---

## 측정치·관측

- **watch 페이지 번들**: First Load JS **419kB → 264kB** (−155kB, hls.js lazy 분리).
- **채팅 DB 조회**: 시청자 N·폴링 3초여도 방당 **≤1 DB 조회/초**(1초 캐시 + 버전 무효화). 캐시 메트릭 `ml_chat_cache_total{result}`.
- **신규 메트릭**: `ml_http_rate_limited_total{route}`, `ml_chat_cache_total{result}`.

## P2 스킵/백로그

- **pnpm audit**: 18건(2 low·10 moderate·6 high) — 대부분 **Next.js** 권고(≥15.5.16 패치). 현재 Next 14 → **Next 15 메이저 업그레이드는 배포 직전 리스크**라 백로그. API(fastify/zod/drizzle) 측 고위험 없음.
- **미사용 의존성·TS strict `any/!` 정리**(C-4-3): 시간 판단으로 스킵(백로그).
- **B-2 참가자 인덱스 (room_id,state)**: 현재 (room_id) 인덱스로 충분(방당 참가자 ≤~230), 필요 시 0003 마이그레이션.
- **B-5-2 전 LiveKit 호출 타임아웃 래핑**: health 체크에만 적용. 전면 래핑은 후속.
- **A-3 세션 IP 상한 로컬 검증**: loopback 예외라 로컬에서 429 미검(프로덕션 활성). per-user 경로로 rate limit 동작을 대표 검증.

## 백업 방침(C-4-4, 문서화만)

- **Postgres**: 유일한 영속 상태(방·참가자·채팅·모더레이션 로그). 정기 `pg_dump`(예: 시간별, 보존 7~30일) 권장.
- **Redis**: **전부 재구축 가능**(presence·채팅 캐시·초대코드·host 유예·rate limit 카운터). 소멸 시 — presence 는 webhook 재수신으로 복원, 캐시는 재계산, 유예키 소멸은 안전측(스위퍼가 재평가), rate limit 리셋은 무해. → **휘발 허용**, 백업 불필요.

## Phase 7-lite §1-1 — 리버스 프록시 신뢰 (보안 수정 · 후속)

**발견(취약)**: `index.ts` 의 `trustProxy: true` 하드코딩이 `X-Forwarded-For` 의 **leftmost** 값을
`req.ip` 로 채택 → 직결 클라이언트가 `X-Forwarded-For: <임의 IP>` 한 줄로 IP 정체성을 위조 가능.
결과로 6.5 A-3 의 **IP 키 rate limit**(`/auth/session` 익명 세션 폭증 차단·초대코드 무차별 대입 방어)이
매 요청 위조 IP 를 바꾸면 버킷을 회피, **헤더 조작만으로 우회 가능**한 상태였다.

**수정**:
- `trustProxy` 를 `TRUST_PROXY` env 로 구동. 기본 **false(직결·XFF 불신)**, 프로덕션은 **`1`(Caddy 1홉)**
  → 오른쪽 1홉만 신뢰하므로 leftmost 위조값 무시. 잘못된 IP/CIDR 형식은 부트에서 fail-fast(C-3).
- rate limit 코드는 **무변경**(키 전략·loopback 예외 정책 그대로) — 결함은 `req.ip` 산출 신뢰에 있었음.
- 프록시 배선 가이드: `docs/deploy/reverse-proxy.md`(Caddy 가 XFF 를 실제 IP 로 덮어씀 → 클라 위조 무시).

**검증**(`verify:phase7`, 게이트 편입): 격리 서버 2개로 매트릭스 양쪽 —
- A) `TRUST_PROXY=1`: leftmost 주입 무력화 + 서로 다른 IP 버킷 분리.
- B) `TRUST_PROXY` 미설정·production: XFF 완전 무시(소켓 IP 합산) + **프로덕션 loopback 비예외 직접 관측**
  (6.5 때 "로컬 429 미검(loopback 예외)"으로 남겼던 A-3 IP 상한을 이제 관측으로 고정).

## AC 충족

- ✅ 참가자 발신으로 서버 신호 위조 불가(e2e)
- ✅ 프로덕션 약한 시크릿·CORS `*`·env 오류 → 부트 실패
- ✅ 모드 B 채팅 폴링 DB 조회가 시청자 수 무관 방당 상한(≤1/초)
- ✅ SIGTERM 무중단 종료 · 전 에러 응답 단일 스키마
- ✅ 전 verify(155) + E2E 11게이트 회귀 무결

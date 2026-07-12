# Multi-Live — 멀티 게스트 라이브 스트리밍

호스트 1명 + 게스트 최대 N명(기본 8) + 다수 시청자를 위한 라이브 방송 시스템.
**모든 참가자의 오디오가 모든 참가자에게 도달함을 구조적으로 보장**하는 것이 핵심 목표이며,
라우팅은 전적으로 LiveKit(SFU)에 위임한다.

> 🚧 **개인 포트폴리오 프로젝트 · 진행 중 (Phase 7-lite).** 모든 변경은 CI 게이트(verify + Playwright E2E)를 통과한 PR로만 main에 진입한다.

## 스택

| 영역 | 선택 |
|---|---|
| SFU | LiveKit (self-hosted) |
| 백엔드 | Node.js + TypeScript + Fastify |
| DB | PostgreSQL(drizzle) + Redis |
| 프론트 | Next.js 14 (App Router) + `@livekit/components-react` |

## 디렉터리

```
.
├─ docker-compose.yml       # livekit + redis + postgres
├─ livekit.yaml             # SFU 설정 (dev)
├─ apps/
│  ├─ api/                  # Fastify 백엔드 (rooms/tokens/webhooks)
│  └─ web/                  # Next.js 클라이언트
└─ packages/shared/         # 타입 · 이벤트 상수 · zod 스키마
```

## 로컬 기동

전제: Node ≥ 20, pnpm ≥ 9, Docker.

```bash
# 1) 환경 변수
cp .env.example .env
cp .env.example apps/api/.env       # api 전용 로드
# NEXT_PUBLIC_* 는 web 에서도 읽히므로 루트 .env 로 충분

# 2) 의존성
pnpm install

# 3) 인프라 (livekit / redis / postgres)
pnpm infra:up          # = docker compose up -d

# 4) DB 마이그레이션 생성 + 적용
pnpm db:generate       # drizzle 스키마 → SQL 마이그레이션
pnpm db:migrate        # 적용

# 5) 개발 서버 (api :4000, web :3000 동시 기동)
pnpm dev
```

확인:

```bash
curl http://localhost:4000/health           # {"status":"ok"}
curl http://localhost:4000/health/ready      # db/redis 연결 상태
open http://localhost:3000                    # 랜딩 페이지
```

인프라 종료: `pnpm infra:down`

## API (Phase 1)

| 메서드 | 경로 | 인증 | 설명 |
|---|---|---|---|
| POST | `/auth/session` | — | `{nickname}` → user 생성 + 세션 JWT |
| POST | `/rooms` | Bearer | host가 방 생성 (DB + LiveKit room) |
| GET | `/rooms/:id` | — | 방 메타 + 참가자 목록 |
| POST | `/rooms/:id/token` | Bearer | **role은 서버가 결정** (host 본인=host, 그 외=viewer). `guest`/`speaker` 자기선언 요청은 403 |
| POST | `/rooms/:id/end` | Bearer(host) | 방 종료 + LiveKit deleteRoom |
| POST | `/webhooks/livekit` | 서명검증 | participant/track/room 이벤트 → DB·Redis 멱등 동기화 |

### API (Phase 2 추가)

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/rooms/:id/invite` | host 초대코드 발급 (Redis, multi-use, TTL 1h) |
| POST | `/rooms/:id/join-requests` | guest가 코드로 승인 요청 → state=requested |
| GET | `/rooms/:id/join-requests` | host 대기 큐 (3초 폴링) |
| POST | `/rooms/:id/guests/:userId/approve` | host 승인 (멱등, DB→LiveKit 순, max_guests 검증, 감사로그) |
| POST | `/rooms/:id/guests/:userId/reject` | host 거절 → 큐에서 제거, 토큰 403 유지 |
| POST | `/rooms/:id/audio-report` | 클라이언트 오디오 수신 리포트 → 누락 시 RESUBSCRIBE_AUDIO 신호 |

`/rooms/:id/token`은 승인 게이트 확장: `guest` 요청은 DB `state=approved` 일 때만 발급.

### API (Phase 4 추가)

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/rooms/:id/chat` | 채팅 전송(서버 경유 저장→전파). rate limit 1/s(429)·길이 500자(400)·금칙어 마스킹 |
| GET | `/rooms/:id/chat?after=<id>` | 채팅 조회(히스토리 50 / 커서 델타) + `viewerCount`. 모드 B heartbeat 겸용 |
| GET | `/rooms/:id/viewer-count` | 시청자 수 배지. 모드 A=참가자−publisher, 모드 B=HLS heartbeat 집계 |
| GET | `/rooms/:id/hls` | HLS 재생 정보(`mode`·`egressStatus`·`playlistUrl`) |
| GET | `/hls/<roomId>/index.m3u8` | egress 산출 HLS 매니페스트/세그먼트 정적 서빙 |

`viewer_mode`(webrtc\|hls)는 **방 생성 시 고정, LIVE 중 변경 불가**. `POST /webhooks/livekit`
는 `egress_started/updated/ended` 를 처리하고, egress 실패 시 자동으로 모드 A 폴백 + host 알림.

검증:
- 서버: `pnpm --filter @multi-live/api verify:phase1` (19) · `verify:phase2` (13)
- E2E: `pnpm --filter @multi-live/web e2e` — 가짜 미디어로 host↔guest 실제 A/V,
  **양쪽 subscribedAudioTracks == 1** 검증 (docker infra + api 기동 필요).

> ⚠️ LiveKit 서버는 **v1.9+** 필요(신형 client SDK와 프로토콜 호환). Mac Docker 로컬
> 개발은 `livekit.yaml`의 `rtc.node_ip: 127.0.0.1`로 ICE 후보를 호스트 도달 가능하게 광고.

## Phase 진행

- **Phase 0** ✅ 골격 + docker-compose + DB 스키마
- **Phase 1** ✅ 인증 · 방 생성 · 토큰 발급 · webhook 동기화
- **Phase 2** ✅ host + guest 1명 양방향 A/V · 초대/승인/거절 · 오디오 도달 검증(최소) · E2E
- **Phase 3** ✅ 게스트 N명 · 운영도구(음소거/강퇴) · 오디오 전수검증 강화 · E2E 매트릭스
- **Phase 4** ✅ 시청자 대규모(모드 A WebRTC / 모드 B HLS egress) · 채팅 · 시청자 수
- **Phase 5** ✅ 관측(/metrics) · 성능(simulcast/adaptive) · 경계(재접속·host유예·중복) · CI
- **Phase 6** ✅ speaker(오디오 전용) 역할 + 역할 전환 · 채팅 운영(숨김/차단)
- **Phase 6.5** ✅ 배포 전 하드닝(신호 스푸핑 차단 · rate limit · 채팅 캐시 · graceful shutdown · 부트 fail-fast)

### Phase 3 핵심

- **승격 단일 경로**: 모든 (재)접속은 서버가 DB 상태로 role 결정한 새 토큰으로 시작.
  승인된 사용자는 처음부터 guest 토큰, 그 외 viewer→`updateParticipant` fast-path(서버
  백그라운드 재시도로 신뢰화). token-swap 재연결 경로는 제거.
- **상태 전이 명시**: 퇴장 시 `state=left`(kicked 보존). join-request 가 `left→approved`
  자동 재승인(max_guests 검증, 자리 없으면 큐잉) · `kicked`는 재승인 필수.
- **운영**: 음소거(`mutePublishedTrack`, 비대칭 — 재개는 guest 본인만) · 강퇴
  (`removeParticipant`+`state=kicked`, 이후 `/token` 403). speaker 전환은 범위 외(후속).
- **오디오 경고**: 리포트 수신 시점 lazy 평가. `missing_subscription`(30s+ 미구독) +
  `stale_report`(30s+ 무보고). 퇴장/track_unpublished 시 경고·기준선 정리.
- **큐 실시간화**: `QUEUE_UPDATED` 신호(트리거) + GET(진실) + 20초 폴링 fallback.

검증: `verify:phase3`(18) · E2E `pnpm --filter @multi-live/web e2e`(게이트 5) ·
`HEAVY=1 ... e2e`(8명 전수, nightly). 게이트 `[H→G1→G2]`는 위버스 "2번째 게스트 음성
미도달" 버그의 직접 회귀 테스트.

### Phase 4 핵심

- **모드 A(WebRTC, 기본)**: 시청자는 subscribe-only 토큰으로 같은 LiveKit room 입장 →
  host/guest 오디오를 전수 수신(저지연, ~수천). `/watch/[roomId]`.
- **모드 B(HLS, 대규모)**: LiveKit **Room Composite → HLS 세그먼트 직접 출력**(RTMP/mediamtx
  경유 없음) → api 정적 서빙(`/hls`) → hls.js 재생. `viewer_mode` 는 생성 시 고정.
  - **상태머신**: `none→starting→active→ending`/`failed`. host 실제 접속(participant_joined)
    시 egress 기동 → `egress_*` webhook 으로 active 확정.
  - **수명 관리**: `room_finished`/`/end` 시 egress **반드시 중지**(과금·리소스 누수 방지).
  - **폴백**: egress 실패 시 `viewer_mode` 를 자동으로 A 로 되돌리고 host 에게
    `EGRESS_FALLBACK` 알림 → 신규 시청자는 WebRTC 로 계속 시청.
- **채팅(서버 경유 단일화)**: 저장(Postgres, 서버가 id·ts 부여 = 순서의 단일 진실) →
  전파 이원화(모드 A `sendData` push / 모드 B `GET ?after=` 3초 폴링·히스토리 50 겸용).
  rate limit 1/s·길이 500자·금칙어 마스킹·`hidden` soft delete.
- **시청자 수**: 모드 A=`numParticipants − publisher`, 모드 B=heartbeat(채팅 폴링 겸용)
  Redis TTL ZSET 근사 집계.

검증: `verify:phase4`(19: 채팅·rate·길이·금칙어·hidden·커서 + viewer-count·HLS·egress
상태머신·폴백) · E2E 게이트 `[모드 A]`(시청자 오디오 전수 수신 + 양방향 채팅 + 배지).

#### 모드 B(HLS) egress 로컬 재현

```bash
docker compose up -d egress          # livekit/egress (headless Chrome, ~1GB)
HEAVY=1 pnpm --filter @multi-live/web exec playwright test egress-smoke
```

> ⚠️ **Mac Docker 로컬 한계**: `livekit.yaml` 의 `rtc.node_ip: 127.0.0.1` 은 **호스트
> 브라우저**용 ICE 후보다. egress 컨테이너 **내부**의 Chrome 에는 127.0.0.1 이 자기 자신을
> 가리켜 미디어 연결이 실패(`egress_aborted: "Start signal not received"`, 412) → 서버가
> 모드 A 로 자동 폴백한다. 단일 node_ip 로는 호스트 브라우저와 in-docker egress 를 동시에
> 만족시킬 수 없다(WebRTC 후보 광고 충돌). egress-smoke 테스트는 이 제약에 강건하도록
> **종단 상태(active|failed)** 만 단언한다. 실 서버(공인 IP/TURN)에서는 active 로 세그먼트가
> 생성된다.

### Phase 5 핵심 (안정화 · 관측 · 성능)

- **관측**: `GET /metrics`(prom-client) — 오디오 도달(누락/재구독/해소/stale), egress
  전이·실패·폴백, 채팅 429, webhook 오류·미등록 identity, 활성 방/참가자 게이지.
  게이지 `collect()` 는 try-catch(조회 실패가 /metrics 전체 500 으로 번지지 않게).
  선택적 `METRICS_TOKEN`(Bearer). LiveKit 자체 메트릭은 `prometheus_port: 6789` 노출
  → `curl localhost:6789/metrics`.
- **성능**: `lib/lkOptions.ts` — simulcast 3레이어 + adaptiveStream + dynacast + 캡처 720p.
  부하테스트는 로컬(`scripts/loadtest.sh`, 게스트8+시청자100) → [`docs/phase5-loadtest.md`].
  AC(오디오 도달 실패율 0%) = 앱 클라이언트 missing_subscription 0(+`ml_audio_missing_detected_total` Δ0)
  ∧ livekit-cli 구독 통계 일치.
- **경계 케이스**:
  - **토큰 만료·재접속**: `ReconnectGuard` — Disconnected(일시 단절)에서 서버 새 토큰으로
    재접속(원칙: 모든 재접속=새 토큰). 제외: 의도적/강퇴/방종료/**DUPLICATE_IDENTITY(핑퐁 방지)**/
    ROOM_ENDING. 백오프 + 상한 3 + 수동 버튼. 판정은 `shouldReconnectOnDisconnect`(shared).
  - **host 이탈**: `participant_left(host)` → 유예(`HOST_GRACE_SEC` 기본 60) → 미복귀 시
    스위퍼가 `ROOM_ENDING` 브로드캐스트 후 방 종료(egress stop 포함). 종료 직전 Redis
    presence 재확인(레이스 방어) + SETNX 락. **host 승계는 향후 과제**.
  - **중복 로그인**: "새 접속이 이김" 유지, 끊긴 쪽에 `DUPLICATE_IDENTITY` 안내(서버 작업 없음).
- **CI**: `.github/workflows/ci.yml`(PR 게이트: typecheck→인프라→verify 5종→E2E 7게이트,
  실패 시 trace 업로드, concurrency 취소, pnpm/PW 캐시, 신선 DB) ·
  `nightly.yml`(@heavy 8명 + egress 스모크 + 축소 부하, 보고용). 러너 환경은
  `livekit.ci.yaml`+`docker-compose.ci.yml` 로 분리.

검증: `verify:phase5`(19: /metrics 증분·host 유예 스위퍼·재접속 판정) ·
E2E 게이트 7 · `HEAVY=1 ... phase5-reconnect`(TTL 6초로 api 기동, 재접속 복구 통합).

### API (Phase 6 추가)

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/rooms/:id/guests/:userId/approve` | body `{role?: 'guest'\|'speaker'}`(기본 guest). role별 슬롯 검증. 이미 승인된 다른 role 은 409 |
| POST | `/rooms/:id/participants/:userId/role` | host 역할 전환 guest↔speaker. approved 대상만, 슬롯 검증, 멱등, `role_change` 로그 |
| POST | `/rooms/:id/chat/:messageId/hide` · `/unhide` | host 채팅 숨김/해제(tombstone). CHAT_MODERATED 브로드캐스트 |
| POST · DELETE | `/rooms/:id/chat-bans/:userId` | host 채팅 차단/해제. 차단 유저 전송은 403 `chat_banned`(rate limit 이전) |

`rooms.max_speakers`(기본 20)는 guest 슬롯과 분리. 토큰은 승인 시 **DB role 대로** 발급.

### Phase 6 핵심

- **speaker(오디오 전용)**: `canPublishSources:[microphone]`. 오디오 전수 도달 불변식에 트랙
  기준으로 자연 편입(구조 변경 없음). 비디오 그리드와 분리된 "음성 참여" 스트립으로 렌더.
- **역할 전환**: 재연결 없이 `updateParticipant`(grant+metadata) 단일 경로. **강등(guest→speaker)
  시 LiveKit v1.9 가 `canPublishSources` 축소로 카메라 트랙을 자동 unpublish**(실측 확인) —
  서버는 방어적으로 잔여 비디오를 강제 mute(버전차 대비, 현재 no-op). 오디오 무중단.
- **채팅 운영**: 숨김은 tombstone(레코드 보존) — 비-host 에겐 흔적 없이 제거, host 에겐 플래그로
  표시+해제. 전파는 모드 A `sendData`(즉시) + 저빈도 GET 재조정(4초, hiddenIds 스냅샷)으로
  유실(subscribe-only viewer 데이터채널 지연 등) 대비 수렴. 모드 B 는 폴링 스냅샷.
  차단은 `room_participants.chat_banned_at`(세션 스코프, 방 종료로 소멸).

검증: `verify:phase6a`(17) · `verify:phase6b`(19) · E2E 게이트 10(speaker 편입·역할전환·
채팅 운영) · @heavy(8명 + speaker 혼합, nightly).

> 백로그: ①join-request 에 요청자 role hint(비구속) ②모드 B 실시간 unhide(현재 히스토리
> 재로드 수준) ③speaker 승계/host 승계.

### Phase 6.5 핵심 (배포 전 하드닝)

> 상세: [`docs/hardening-report.md`](./docs/hardening-report.md). 인프라 없이 코드 레벨 보안·성능·안정성.

- **보안**: ① 신호 스푸핑 차단 — data channel 로 온 서버 신호는 `participant==null`(서버 발신)일
  때만 신뢰(참가자 위조 무시) ② `:id`/`:userId` UUID 검증·제어문자 거부·리포트 신원은 토큰 권위
  ③ 엔드포인트 rate limit(user 키 위주, `/auth/session` 만 IP·비프로덕션 loopback 예외)
  ④ CORS 화이트리스트·HLS traversal 격리·helmet·body 1MB ⑤ 로그 시크릿 마스킹·프로덕션 5xx 미노출.
- **성능**: ① 채팅 조회 1초 마이크로 캐시(방별 버전 무효화) → 시청자 수 무관 DB 조회 ≤1/초/방
  ② `KEYS`→`SCAN` ③ HLS 캐싱 헤더(세그먼트 immutable/매니페스트 no-cache) ④ hls.js 동적 import
  (watch First Load 419→264kB).
- **안정성**: ① SIGTERM graceful shutdown(drain+exit 0) ② 부트 fail-fast(프로덕션 약한 시크릿·
  CORS `*` 거부) ③ `/health/ready` 에 LiveKit 도달성 ④ 에러 응답 단일 flat 스키마(`ERROR_CODES`).

검증: `verify:phase65a`(16, 보안) · `verify:phase65b`(6, 성능) · `verify:phase65c`(9, 안정성) ·
E2E 게이트 11(신호 스푸핑 추가). 전 verify 155 + E2E 11 회귀 무결.

> 프로덕션 부트 요건은 [`.env.example`](./.env.example) 하단 참조(약한 시크릿·CORS `*` → 부트 실패).

- Phase 2 — host + guest 1명 A/V + 승인 플로우
- Phase 3 — 게스트 N명 + 운영도구 + 오디오 전수검증 + E2E
- Phase 4 — 시청자 대규모(webrtc/HLS) + 채팅
- Phase 5 — simulcast · 모니터링 · 경계케이스 · 부하테스트
- Phase 6.5 — 배포 전 하드닝(보안·성능·안정성) → [`docs/hardening-report.md`](./docs/hardening-report.md)

상세 설계는 [`multi-guest-live-design.md`](./multi-guest-live-design.md) 참조.

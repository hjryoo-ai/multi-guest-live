# 멀티 게스트 라이브 스트리밍 시스템 — 순차 상세설계 (Claude Code 구현용)

> 목표: 호스트 1명 + 게스트 최대 N명(기본 8명)이 각자 디바이스에서 참여하고,
> 다수 시청자가 관전하는 라이브 방송 시스템.
> 핵심 요구사항: **모든 참가자의 오디오가 모든 참가자에게 도달함을 구조적으로 보장**
> (위버스에서 관찰된 "2번째 게스트 음성이 호스트에게 안 들리는" 유형의 결함 원천 차단)

---

## 0. 기술 스택 결정 (가정 — 변경 시 이 섹션만 수정)

| 영역 | 선택 | 근거 |
|---|---|---|
| SFU | **LiveKit (OSS, self-hosted)** | 오픈소스, 서버/클라이언트 SDK 완비, full-mesh 구독이 기본 동작이라 오디오 라우팅 버그가 구조적으로 없음. Egress로 HLS 송출 가능 |
| 백엔드 | **Node.js + TypeScript (Fastify)** | LiveKit server-sdk-js 공식 지원 |
| DB | **PostgreSQL** (영속) + **Redis** (실시간 방 상태, presence) | |
| 프론트 | **Next.js 14+ + @livekit/components-react** | 웹 우선. 모바일 앱은 후속 단계에서 React Native로 확장 |
| 시청자 배포 | Phase 4에서 두 모드: (a) LiveKit subscribe-only 참가자 (수천 명급) (b) Egress → RTMP → LL-HLS/CDN (수십만 명급) | |
| 개발 환경 | docker-compose (livekit-server, redis, postgres) | 로컬에서 전체 스택 기동 |

> ⚠️ 관리형(LiveKit Cloud / Agora / Amazon IVS)으로 바꾸려면 SFU 배포 부분만 교체. API 계약은 동일하게 유지.

---

## 1. 핵심 개념 및 역할 모델

### 역할 (role)
- `host`: 방 생성자. 게스트 승인/강퇴/음소거, 방송 종료 권한
- `guest`: 승인된 출연자. 오디오/비디오 publish 가능. 화면 슬롯 점유
- `speaker`: (확장) 음성만 publish 가능한 참여자 — 화면 슬롯 초과 시 사용
- `viewer`: subscribe-only. publish 권한 없음. 채팅 가능

### 방 상태 머신
```
CREATED → LIVE → ENDED
guest 슬롯: EMPTY → REQUESTED → APPROVED(publish 중) → LEFT/KICKED
```

### 오디오 도달 보장 원칙 (설계 불변식)
1. publish/subscribe 라우팅은 전적으로 SFU(LiveKit)에 위임 — 앱 코드에서 피어 간 연결을 직접 관리하지 않는다
2. 클라이언트는 `autoSubscribe: true` 고정. 선택적 구독 최적화는 **비디오 트랙에만** 적용, 오디오 트랙은 항상 전원 구독
3. 서버는 참가자별 "수신 중인 오디오 트랙 목록"을 주기 보고받아 (N-1)개 미만이면 경보 + 자동 재구독 트리거

---

## 2. Phase 0 — 프로젝트 골격 & 개발환경

**산출물**
```
repo/
├─ docker-compose.yml          # livekit, redis, postgres
├─ livekit.yaml                # SFU 설정 (포트, 키)
├─ apps/
│  ├─ api/                     # Fastify 백엔드
│  │  ├─ src/routes/           # rooms, tokens, moderation, webhooks
│  │  ├─ src/services/         # livekit.ts, roomState.ts
│  │  └─ src/db/               # schema, migrations (drizzle 또는 prisma)
│  └─ web/                     # Next.js 클라이언트
│     ├─ app/(host)/broadcast/
│     ├─ app/(guest)/join/[roomId]/
│     └─ app/(viewer)/watch/[roomId]/
└─ packages/shared/            # 타입, 이벤트 상수, zod 스키마
```

**작업 목록**
1. pnpm monorepo 초기화, TypeScript strict 모드
2. docker-compose 작성: `livekit/livekit-server`(dev 모드, API key/secret 고정), redis:7, postgres:16
3. DB 스키마 마이그레이션:
   - `users(id, nickname, created_at)`
   - `rooms(id, host_id, title, status, max_guests, created_at, ended_at)`
   - `room_participants(room_id, user_id, role, state, joined_at, left_at)`
   - `moderation_logs(room_id, actor_id, target_id, action, at)`
4. `.env.example`, README(로컬 기동 방법)

**완료 기준(AC)**: `docker compose up` + `pnpm dev`로 API 헬스체크와 Next.js 페이지가 뜬다.

---

## 3. Phase 1 — 인증 · 방 생성 · 토큰 발급

**API 계약**
```
POST /rooms                    # host가 방 생성 → LiveKit room 생성
POST /rooms/:id/token          # role별 LiveKit AccessToken 발급
POST /rooms/:id/end            # host만. 방 종료 + 전원 disconnect
GET  /rooms/:id                # 방 메타 + 현재 참가자 목록
POST /webhooks/livekit         # participant_joined/left, track_published 수신
```

**토큰 grant 매핑 (핵심)**
| role | canPublish | canSubscribe | canPublishData |
|---|---|---|---|
| host | ✅ | ✅ | ✅ |
| guest | ✅ | ✅ | ✅ |
| speaker | ✅ (audio만: `canPublishSources: [MICROPHONE]`) | ✅ | ✅ |
| viewer | ❌ | ✅ | ✅ (채팅용) |

**작업 목록**
1. 간이 인증(닉네임 기반 세션 or JWT) — 실서비스 인증은 범위 외, 인터페이스만 분리
2. LiveKit server-sdk로 room 생성/삭제, AccessToken 발급 (TTL 10분, 재발급 엔드포인트)
3. LiveKit webhook 서명 검증 → `room_participants` 상태 동기화 (Redis + Postgres)
4. 권한 미들웨어: host 전용 액션 검증

**AC**: 두 브라우저에서 각각 host/viewer 토큰으로 같은 room에 접속되고, webhook으로 참가자 목록이 DB에 반영된다.

---

## 4. Phase 2 — 호스트 + 게스트 1명 (양방향 A/V)

**클라이언트 작업**
1. `@livekit/components-react`의 `LiveKitRoom` + `GridLayout`으로 방송 화면 구성
2. 장치 선택(마이크/카메라), 입장 전 프리뷰(로컬 트랙 미리보기)
3. 초대 플로우: host가 초대 링크 생성 → guest가 링크로 입장 → **host 승인 후** guest 토큰 발급
   - 승인 전 guest는 `viewer` 토큰으로 대기실 입장 → 승인 시 서버가 `guest` 토큰 재발급, 클라이언트는 재연결 없이 `room.localParticipant.setPermissions` 반영(LiveKit updateParticipant 사용)
4. 연결 상태 UI: 각 타일에 오디오 수신 인디케이터(원격 오디오 트랙 subscribed 여부 + 레벨 미터)

**서버 작업**
1. `POST /rooms/:id/invite` → 초대 코드 발급 (Redis, TTL 1시간)
2. `POST /rooms/:id/guests/:userId/approve` → LiveKit `updateParticipant`로 publish 권한 부여
3. 오디오 도달 검증 잡(1차): webhook의 `track_published`(audio) 발생 시, 5초 후 각 참가자의 구독 상태를 `listParticipants`로 점검 → 미구독 발견 시 data channel로 해당 클라이언트에 `RESUBSCRIBE_AUDIO` 이벤트 발송

**AC**: host↔guest 상호 A/V 송수신. 어느 쪽이든 마이크를 켜면 상대 타일에 레벨 미터가 움직인다.

---

## 5. Phase 3 — 게스트 N명 (기본 8) + 운영 도구 ★핵심 단계

**기능**
1. **승인 대기열**: 다수 guest 요청 → host 화면에 큐 표시, 개별 승인/거절. `max_guests` 초과 시 승인 버튼 비활성
2. **그리드/스포트라이트 레이아웃**: 1~4명 그리드, 5명+ 페이지네이션 그리드, 액티브 스피커 스포트라이트 토글 (`useSpeakingParticipants`)
3. **운영(moderation)**: host가 개별 guest 음소거(`mutePublishedTrack`), 강퇴(`removeParticipant`), speaker↔guest 전환. 모든 액션 `moderation_logs` 기록
4. **오디오 전수 도달 검증(강화)** — 원래 버그의 회귀 방지 장치:
   - 각 클라이언트가 10초마다 data channel로 `AUDIO_RX_REPORT { subscribedAudioTrackSids: [...] }` 발송
   - 서버가 "publish 중인 오디오 트랙 집합"과 대조 → 누락 시 ①해당 클라이언트에 재구독 지시 ②30초 내 미해결 시 host에게 경고 배지 표시
5. **재연결 처리**: LiveKit 자동 reconnect 사용 + `Disconnected` 상태 UI, 토큰 만료 시 재발급 후 재입장

**E2E 테스트 (Playwright, 필수)**
- 시나리오 매트릭스: 입장 순서 조합 [H→G1→G2], [H→G2→G1], [G 중도 퇴장 후 재입장], [G3 승인 → G1 강퇴]
- 각 시나리오에서 assert: **모든 참가자의 subscribedAudioTracks 수 == (publish 중 오디오 수 − 자기 것)**
- 가짜 미디어: Chromium `--use-fake-device-for-media-stream`

**AC**: 8명 동시 접속 시 전원 상호 오디오 도달이 E2E로 검증된다. host 운영 액션이 1초 내 반영된다.

---

## 6. Phase 4 — 시청자 대규모 + 채팅

**모드 A (기본, ~수천 명)**: viewer는 subscribe-only 토큰으로 같은 LiveKit room에 입장. 저지연(<1s), 구현 단순.

**모드 B (대규모, 옵션 플래그)**: LiveKit **Egress**(room composite)로 그리드 합성 → RTMP → 미디어 서버/CDN → LL-HLS 재생(hls.js). 지연 3~8s, 비용·확장성 우수.
- `rooms.viewer_mode: 'webrtc' | 'hls'` 컬럼으로 전환
- Egress 시작/종료는 방 LIVE/ENDED에 연동

**채팅**: LiveKit data channel(topic: `chat`) + 서버 릴레이 저장. 금칙어 필터 훅 자리만 마련. 시청자 수 배지(`numParticipants` 또는 Redis presence).

**AC**: 모드 A에서 viewer 50명 부하 스크립트(livekit-cli load test)로 A/V 수신 확인. 모드 B에서 HLS 플레이어 재생 확인.

---

## 7. Phase 5 — 안정화 · 관측 · 성능

1. **네트워크 적응**: 비디오 simulcast 활성(3 레이어), `adaptiveStream: true`. 대역폭 저하 시 오디오 우선 보호(LiveKit 기본 + 비디오 해상도 상한 동적 조정)
2. **모니터링**: LiveKit Prometheus 메트릭 + API 구조화 로그. 대시보드 항목 — 방별 참가자 수, 오디오 도달 검증 실패율, 재연결 횟수, egress 상태
3. **경계 케이스**: 토큰 만료 중 방송, host 이탈(1분 유예 후 자동 종료 or 게스트 중 승계 정책 — `rooms.host_succession` 플래그), 중복 로그인(동일 user 2디바이스 → 기존 세션 kick)
4. **부하 테스트**: guest 8 + viewer 500 기준 CPU/대역폭 리포트 작성

**AC**: 오디오 도달 검증 실패율 0%(E2E 기준), 재연결 시 5초 내 A/V 복구.

---

## 8. Claude Code 실행 순서 요약

```
1. Phase 0: 골격 + docker-compose + DB 스키마        (커밋 단위 1)
2. Phase 1: rooms/token API + webhook 동기화          (커밋 단위 2)
3. Phase 2: host+guest 1명 A/V + 승인 플로우          (커밋 단위 3)
4. Phase 3: N명 + 운영도구 + 오디오 전수검증 + E2E    (커밋 단위 4~5)
5. Phase 4: viewer 모드 A → 모드 B(egress/HLS) → 채팅 (커밋 단위 6~7)
6. Phase 5: simulcast/모니터링/경계케이스/부하테스트   (커밋 단위 8)
```

각 Phase는 AC 충족 + 테스트 통과 후 다음으로 진행. Phase 3의 E2E 오디오 매트릭스는 이후 모든 Phase에서 CI 필수 게이트로 유지한다.

---

## Phase 6 — Speaker 역할 + 채팅 운영 (구현 완료)

### 6A. Speaker(오디오 전용)
- `speaker` role: `canPublishSources:[microphone]`. guest 슬롯(`max_guests`)과 분리된
  `max_speakers`(기본 20) 슬롯. 오디오 전수 도달 불변식에 **트랙 기준으로 자연 편입**(코드 변경 없음).
- 역할 결정은 host 만. `approve {role}` + `POST /participants/:userId/role`(전환) 단일 경로.
  토큰은 승인 시 **DB role 대로** 발급(서버 권위). 재입장은 이전 role 유지.
- **A-4 실측 결과**: LiveKit v1.9 는 `updateParticipant` 로 `canPublishSources` 축소 시
  허용 외(카메라) 트랙을 **자동 unpublish**. 서버 강제 mute 는 버전차 대비 방어(현재 no-op).
  강등 시 오디오 무중단.

### 6B. 채팅 운영
- **숨김(tombstone)**: `hidden`+`moderated_at`. 비-host 제거 / host 플래그 표시+해제.
  전파 = 모드 A `sendData`(즉시) + 저빈도 GET 재조정(hiddenIds 스냅샷)으로 유실 대비 수렴.
- **차단**: `room_participants.chat_banned_at`(세션 스코프). 전송 시 rate limit **이전** 평가 → 403.
- 운영 액션 전부 `moderation_logs`(+detail) 기록. 메트릭 4종 추가.

### 백로그 (Phase 6 범위 외, 명시적 유보)
- join-request 에 요청자 role **hint**(비구속) — 현재 role 결정은 host 전용.
- 모드 B **실시간 unhide** — 현재는 히스토리 재로드/스냅샷 수렴 수준.
- **host/speaker 승계** — 권한 이전 파급이 커 별도 단계.

### 구현 노트 (비자명)
- LiveKit `sendData` 브로드캐스트(destinationIdentities 생략)는 **발신자를 제외**한다 →
  발신자는 자기 메시지를 응답 DTO 로 낙관적 반영해야 UI 에 보인다.

---

## Phase 6.5 — 배포 전 하드닝 (보안 · 성능 · 안정성)

> 상세·측정치: [`docs/hardening-report.md`](./docs/hardening-report.md). 인프라 없이 코드 레벨만.

### 보안 (Track A)
- **신호 스푸핑 차단**: LiveKit data channel 은 참가자도 발신 가능 → 서버 신호(topic=signal/chat)는
  `DataReceived` 의 `participant==null`(= `RoomServiceClient` 서버 발신)일 때만 신뢰. 실측 확인 후
  전 핸들러 일괄 가드(`web/lib/signal.ts`).
- **입력·인증**: `:id`/`:userId` UUID 강제·제어문자 거부·리포트 신원은 `req.user` 권위.
- **rate limit**: `@fastify/rate-limit`(Redis) — user 키(token 30·join 10·invite 20 /분),
  `/auth/session` 만 IP 10/분(비프로덕션 loopback 예외로 로컬 무간섭).
- **웹 계층**: CORS 화이트리스트(프로덕션 `*` 부트 거부) · HLS roomId UUID 격리 · helmet · body 1MB.
- **위생**: 로그 시크릿 마스킹 · 프로덕션 5xx 내부정보 미노출(중앙 에러 핸들러).

### 성능 (Track B)
- **채팅 캐시**: 조회 스냅샷 Redis 1초 TTL + 방별 버전 키(write 시 INCR 무효화) →
  시청자 수 무관 DB 조회 ≤1/초/방. (인덱스는 기존 `(room_id,id)`·`(room_id,hidden)` 로 충분.)
- `KEYS`→`SCAN`(스위퍼·게이지) + scard 파이프라인.
- HLS 캐싱 헤더(세그먼트 `immutable` / 매니페스트 `no-cache`) — CDN 정책과 동일.
- hls.js **동적 import** → 모드 A watch First Load 419→264kB.

### 안정성 (Track C)
- **graceful shutdown**: SIGTERM → 스위퍼 정지 → drain → redis/db 종료 → exit 0(10s 상한).
- **부트 fail-fast**: 전 env zod 검증. 프로덕션 약한 시크릿·CORS `*` → 원인 출력 후 부트 실패.
- `/health/ready` 에 LiveKit 도달성 추가. 에러 응답은 단일 flat `{error:<code>}`(`ERROR_CODES` 집약).

### 구현 노트 (비자명)
- **`@fastify/rate-limit` 은 한계 초과를 throw** 한다 → 중앙 에러 핸들러가 받으므로
  `errorResponseBuilder` 반환에 `statusCode:429` 를 포함하고 핸들러에서 429 를 표준화해야 한다.
- rate-limit 의 `keyGenerator(userKey)` 가 `req.user` 를 보려면 **authGuard 를 rate-limit 보다 먼저**
  등록해야 한다(안 그러면 IP 폴백 → 로컬 E2E 의 여러 참가자가 한 IP 로 합산).
- `@fastify/static` 기본 `cacheControl(public,max-age=0)` 이 `setHeaders` 를 덮으므로 `cacheControl:false` 필요.

### 백로그 (P2 유보)
- Next.js 보안 권고 대응(≥15.5.16) — 메이저 업그레이드라 배포 직전 리스크로 분리.
- 미사용 의존성·TS strict 잔여 예외 정리 · 전 LiveKit 호출 타임아웃 래핑 · 참가자 (room_id,state) 인덱스.

# 데모 가드 (§7-lite 1-4)

공개 데모 배포에서 익명 트래픽으로부터 리소스·프라이버시를 지키는 서버측 가드. **전부 env 플래그이며
기본값은 "비활성"** — dev·CI·E2E 는 값을 주지 않으므로 완전 무동작(방을 다수 만드는 게이트에 영향 0).
데모 특성은 브랜치가 아니라 env 로 표현한다(브랜치 전략 원칙).

## env 플래그 (전부 기본 0 = off)

| env | 의미 | 초과 시 |
|---|---|---|
| `MAX_CONCURRENT_ROOMS` | 동시 활성 방(created\|live) 상한 | 방 생성 **503 `demo_room_cap`** + `Retry-After` |
| `MAX_ROOM_LIFETIME_MIN` | 방 최대 수명(분) | 생성 후 초과 시 자동 종료 |
| `DATA_RETENTION_HOURS` | 종료 후 데이터 보존(시간) | 초과 방·연관·고아 user 삭제 |

예시(데모 배포 env): `MAX_CONCURRENT_ROOMS=20`, `MAX_ROOM_LIFETIME_MIN=60`, `DATA_RETENTION_HOURS=24`.

## 동작

- **상한**: `POST /rooms` 에서 활성 방 수 ≥ cap 이면 생성 거부. 용량 소진이므로 409 가 아니라 **503 + `Retry-After`** (일시적·재시도 가능 의미). `demo_room_cap` 은 `ERROR_CODES` 레지스트리 등록.
- **수명 만료**: `demoSweeper` 가 생성 후 수명 초과 활성 방을 종료. 종료는 host 이탈 유예 스위퍼와 **동일한 공유 경로**(`endRoomGracefully`: ROOM_ENDING → 유예 → deleteRoom→room_finished, **egress stop 포함**)를 쓴다. 프리미티브를 따로 조합해 두 번째 종료 경로를 만들지 않는다(Phase 3 원칙). demoSweeper 도 hostGrace 와 동일한 SETNX 락.
- **데이터 보존**: 종료 후 보존기간 초과 방의 `chat_messages`·`moderation_logs`·`room_participants`·`rooms` 를 FK 순서로 삭제(트랜잭션), + 어느 방에도 안 남고 생성도 보존기간 지난 **익명 user** 삭제. 별도 cron 이 아니라 스위퍼 내장 → 시간 주입 검증 가능·compose 단순.

두 스위핑 값(`MAX_ROOM_LIFETIME_MIN`·`DATA_RETENTION_HOURS`)이 **모두 0이면 스위퍼 인터벌 자체를 걸지 않는다.**

## 검증

`verify:phase7demo`(게이트 편입) — 혼합:
- **상한**: `MAX_CONCURRENT_ROOMS`=(현재 활성+2) 격리 인스턴스에 방 3개 → 3번째 503+Retry-After(공유 DB 라 현재 수 기준으로 결정적).
- **수명/보존**: in-process `sweepDemoOnce(nowMs, opts)` — 픽스처를 far-past 로 aging + 1h 윈도우로 다른 CI 레코드와 격리. 수명=만료 대상 선별(최근 방 제외), 보존=방·채팅·고아 user 삭제 확인.

## 랜딩 고지 정합(#6 데모 UX 에서)

랜딩 고지 문구("최대 60분 · 매일 정리" 등)는 위 env 실값과 **어긋나면 안 된다**. #6 에서 문구를 하드코딩하지 말고 서버 설정을 반영하거나 최소한 배포 env 와 함께 관리한다. 배너·데모 시작 버튼용 **클라이언트 표시 플래그**(`NEXT_PUBLIC_DEMO_MODE` 류)는 서버 가드와 무관한 표시 전용으로 #6 에서 별도 도입.

**#6 구현(feat/7lite-demo-ux)**:
- `NEXT_PUBLIC_DEMO_MODE=1` → 랜딩 배너 + "데모 시작"(`/broadcast?demo=1`) 노출. **표시 전용**(신뢰 경계 아님). 미설정이면 배너 없음.
- 고지 수명 수치는 하드코딩하지 않고 `NEXT_PUBLIC_DEMO_LIFETIME_MIN`(서버 `MAX_ROOM_LIFETIME_MIN` 과 **같은 값**을 함께 설정) 을 참조 → 문구가 서버 정책과 정합.
- **데모 플로우**(`?demo=1` 자동 방 생성 → 장치선택 생략 → 라이브 → QR·가이드)는 표시 플래그와 **무관**(URL 구동)하고 서버 가드(cap·rate limit) 하에서 동작 → E2E 가 빌드 플래그에 묶이지 않는다.
- **이중 생성 방어**: 자동 진입은 mount-once ref(StrictMode/재렌더 중복 차단) + 생성 성공 직후 `history.replaceState` 로 `?demo=1` 제거(새로고침 시 방 재생성·cap/rate 소진 차단). 모바일 스모크가 "새로고침 후 방 미생성"을 회귀 가드로 고정.

## 설계 갱신 이력

원설계 §1-4-3 은 "cron 1줄 + 종료 후 24h 삭제" + 상한 409 였으나, 구현에서 다음으로 정제:
- **야간 창(quiet hours) 폐기** — "야간에 잔존 활성 방 종료"는 이미 수명 만료 + host 유예 + emptyTimeout 으로 3중 커버되어 불필요. 원설계의 실제 의도(데이터 삭제)를 `DATA_RETENTION_HOURS` 로 구현.
- **cron → 스위퍼 내장**: 시간 주입 테스트 가능 + compose 단순.
- **상한 409 → 503 + Retry-After**: 용량 소진의 의미상 정확.

# 브랜치 전략

> 1. **main = 배포되는 유일한 진실.** 장기 분기 금지 — 데모 특성은 브랜치가 아니라 env 플래그(`DEMO_MODE`, `MAX_CONCURRENT_ROOMS` 등)로 표현한다.
> 2. **모든 변경은 단기 브랜치 → PR → CI 게이트 → squash merge.** 브랜치 수명 목표 ≤ 3일.
> 3. **롤백은 브랜치가 아니라 태그로.** 배포 단위마다 태그를 남기고, 문제 시 이전 태그로 되돌린다.

## 1. 브랜치 모델

```
main ──────●───────●───────●──── (protected, 항상 배포 가능 상태)
            \feat/7lite-... → PR → squash
```

- 종류: `feat/*` `fix/*` `chore/*` `docs/*` (+ 긴급 `hotfix/*`)
- 네이밍: `<종류>/<phase약칭>-<슬라이스>` — 예: `feat/7lite-demo-guards`
- 항상 최신 main에서 분기. 최신화는 **rebase**(merge commit 금지), 머지는 **squash** — main 히스토리 = "검증 통과한 슬라이스" 목록.
- 브랜치 1개 = 설계문서 슬라이스 1개 = PR 1개. 슬라이스가 커지면(= CI 게이트 30분 내 통과 못 할 크기면) 브랜치를 쪼갠다.

## 2. main 보호 규칙

- PR 없이 직접 push 금지, force-push 금지
- **Required status check: `gate`** — CI 워크플로(`.github/workflows/ci.yml`)의 job id 가 `gate` 다. (워크플로 name 은 `CI`, 체크 표시명은 `CI / gate`.) required 로 거는 대상은 워크플로 이름이 아니라 **job 이름 `gate`**.
- `enforce_admins: true` — 1인 프로젝트라도 관리자 본인도 게이트를 우회하지 않는다(§7 서사와 일관, hotfix 예외 없음 원칙과도 일관).
- 리뷰어 요구는 걸지 않음(1인) — 대신 **CI 그린 = 머지 조건**을 기계로 강제.
- **게이트 정의(수치 정본)**: `gate` = typecheck(전체) + verify(1~6.5 + §7-lite 프록시신뢰·데모가드·LiveKit타임아웃) + **Playwright E2E 16개** = 핵심 12 + 모바일 스모크 4종(390×844: 시청·게스트·호스트 + **데모**). `@heavy`(8명 전수·egress·reconnect)와 `screenshots.spec`은 게이트 제외(→ `nightly.yml`). **이 16이 수치 정본**이며 ci.yml 스텝 라벨·PR 본문 수치는 여기에 맞춘다(라벨 드리프트 방지). 핵심 11→12: `fix/e2e-queue-scope` 가 승인-큐 스코프 회귀 방지 테스트(`phase3`)를 게이트로 승격.
- **보고 수치의 출처 = 실행 로그**: "N/N 통과" 보고는 반드시 **CI 실행 로그의 passed 카운트**에서 읽는다 — 스텝 *이름*·주석·문서 라벨이 아니라. 라벨·문서·보고가 서로 어긋나면 **CI 로그가 정본**이고, 어긋난 라벨은 즉시 정정한다.

설정 명령(레포 push 후 1회, PR #1 머지 직후 활성화):

```bash
gh api -X PUT repos/hjryoo-ai/multi-guest-live/branches/main/protection \
  -H "Accept: application/vnd.github+json" \
  --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "checks": [ { "context": "gate" } ] },
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

> 순서 주의: 보호 규칙은 **PR #1 머지 직후** 활성화한다. PR #1 자체는 보호 규칙이 걸리기 전에 정상 PR로 머지하고, 그 직후 위 명령을 실행한다.

## 3. PR 규칙

`.github/PULL_REQUEST_TEMPLATE.md` 의 3개 항목 필수:

1. **변경**: 무엇을 왜 (설계문서 § 참조)
2. **검증**: 통과한 verify/E2E 스코프 (예: "E2E 16/16, verify 1~6.5 + §7-lite 그린")
3. **계약 영향**: testid·에러코드·API 계약·env 변경 여부 — 있으면 계약 문서(`docs/testid-contract.md` 등) 갱신을 **같은 PR**에 포함

DB 마이그레이션 포함 PR은 제목에 `[migration]` 표기. 마이그레이션은 **expand-only(backward-compatible)** 만 — 컬럼 drop/rename 을 배포와 같은 PR에 넣지 않는다(배포 중 구버전 코드가 잠깐 공존).

## 4. CI/CD 배선

- **`ci.yml`** (기존): 트리거 = `pull_request` + `push: main`. job `gate` = typecheck → 인프라 기동 → verify(1~6.5) → Playwright E2E. PR에서 게이트, main에서 재확인.
- **`nightly.yml`** (기존): main 대상 cron(@heavy) — 부하테스트/8명 전수/egress 스모크.
- **`deploy.yml`** (신규, 현재 **골격/휴면**): `workflow_dispatch` 전용. 파이프라인 형태(빌드 → GHCR push `:sha-xxxxxxx` + `:latest` → git 태그 `deploy-*`)와 권한만 확정. **#7 chore/cd-wire** 에서 완성:
  1. `apps/api/Dockerfile` 추가(빌드 대상)
  2. 트리거를 CI 성공 후 자동 배포로 전환
  3. VPS SSH → `docker compose pull && up -d` (compose 는 `:latest` 추적) + 시크릿 `VPS_HOST`·`VPS_SSH_KEY`
  - web 은 Vercel 이 main 자동 추적(별도 잡 불요).

## 5. 롤백 절차

배포 장애 시:

1. 직전 정상 `deploy-*` 태그의 sha 확인: `git tag -l 'deploy-*' --sort=-creatordate | head`
2. VPS 에서 이전 이미지로 되돌리기: `API_IMAGE=ghcr.io/hjryoo-ai/multi-guest-live/api:sha-xxxxxxx docker compose up -d`
3. **드리프트 주의**: 수동 롤백 후에도 `:latest` 는 여전히 깨진 이미지를 가리킨다. **다음 main push 가 나면 deploy 가 깨진 `:latest` 를 재배포**한다. 따라서 롤백은 임시 조치이며, **`git revert` PR 을 머지해 `:latest` 를 정상화하기 전까지 main 에 다른 것을 머지하지 않는다.**

## 6. hotfix 예외 (우회 아님)

배포 장애 시: `hotfix/*` 를 main 에서 분기 → 최소 수정 → PR → CI 게이트 **동일하게 통과**(우회 없음) → squash → 배포. "CI 를 건너뛰는 긴급 경로"는 만들지 않는다 — 게이트 20~30분이면 우회로 얻는 시간보다 리스크가 크다.

## 7. 시크릿 위생

- 실 시크릿(LiveKit Cloud 키, VPS 키 등)은 **repo 밖**에만: GitHub Secrets / VPS env. `.env.example`·`livekit.yaml` 은 dev 플레이스홀더(`devkey`)만.
- public 전환/최초 push 전 **전체 히스토리** 시크릿 스캔(gitleaks) 통과 확인. (초기 커밋 스캔: `no leaks found` ✅)
- 향후 `ci.yml` 에 gitleaks 스텝 추가 검토(#4 env화와 함께) → 키 커밋을 게이트에서 차단.

## 8. Phase 7-lite 슬라이스 → PR 매핑

> 상태 = 검증 통과한 슬라이스 목록(main 히스토리). 원설계 8-슬라이스에 진행 중 삽입된
> 슬라이스(gate-count·owner-rename·livekit-timeouts·ci-actions-bump)는 PR# 로 함께 기록한다.

| # | 브랜치 | 내용 (7-lite 문서 §) | 상태 |
|---|---|---|---|
| 0 | (bootstrap) | git init · LICENSE · noreply author · public repo · main push | ✅ 완료 |
| 1 | `chore/branching-infra` | PR 템플릿 · main 보호 · deploy.yml 골격 · 이 문서 | ✅ PR#1 |
| 2 | `chore/next-15-upgrade` | §1-3-1 Next.js ≥15.5.16 | ✅ PR#2 |
| ↳ | `chore/gate-count-baseline` | E2E 수치 14 정정 + 번들 기준선 갱신 | ✅ PR#3 |
| 3 | `feat/7lite-proxy-trust` | §1-1 trustProxy·rate limit 키 (보안 수정) | ✅ PR#4 |
| 4 | `feat/7lite-cloud-env` | §1-2 Cloud 전환 준비(하드코딩 grep·env화·웹훅 경로) | ✅ PR#5 |
| ↳ | `chore/owner-rename-refs` | 저장소 owner 참조 정리(repojacking 위생) | ✅ PR#6 |
| 5 | `feat/7lite-demo-guards` | §1-4 방 상한·최대 수명·데이터 보존 | ✅ PR#7 |
| 5b | `chore/livekit-timeouts` | §1-5 에서 분리 — LiveKit 호출 전면 타임아웃(504 livekit_timeout) | ✅ PR#8 |
| 6 | `feat/7lite-demo-ux` | §1-5 데모 시작·QR·가이드 (타임아웃은 5b 로 분리) | ✅ PR#9 · testid 신규·게이트 14→15 |
| 6b | `chore/ci-actions-bump` | `actions/*@v4` Node20 deprecation 경고 해소(동작 변경 0) | ✅ PR#10 |
| ↳ | `fix/e2e-queue-scope` | @heavy `approveAs` 이중매치 잠복 회귀 수정 + 게이트 승격(상시 마운트 탭 스코프) | ✅ PR#11 · 게이트 15→16 |
| ↳ | `fix/heavy-queue-wait` | @heavy 마지막 게스트 큐행 레이스 디-플레이크(테스트 대기를 폴백 주기 `QUEUE_POLL_MS`서 파생) | ✅ PR#12 |
| ↳ | `fix/heavy-speaker-queue-wait` | @heavy `phase6a` 후반 speaker 큐행 대기 하한 재도출(1.5×→2.5×, "1주기 유실 견딤" 불변식 + 로드시점 머신체크) | ← **현재 PR** |
| 7 | `chore/cd-wire` | §1-6 Dockerfile 추가 + deploy.yml 실제 VPS 연결 | 다음 슬라이스 |
| 8 | `docs/readme-portfolio` | §5 README·production-notes (GIF·데모링크는 7b 후) | ✅ PR#13 (7 보다 먼저 머지) |

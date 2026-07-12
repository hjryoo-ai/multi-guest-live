# Phase 5 부하테스트 리포트 (템플릿)

정식 부하테스트는 **로컬 실행**으로 리포트를 산출한다(PR 게이트에는 넣지 않음 — 러너 자원·flaky
리스크 대비 게이트 가치가 낮음). nightly 는 축소판(시청자 30, `continue-on-error`, 보고용).

## 실행

```bash
# 전제: docker infra + api(:4000) 기동, livekit-cli(lk) 설치(brew install livekit-cli)
bash scripts/loadtest.sh --subscribers 100 --duration 60s --report docs/phase5-loadtest.result.md
```

## 구성

- 게스트(video publish) 8 + 시청자(subscribe) 100
- LiveKit self-hosted SFU (docker), simulcast 3레이어 + adaptiveStream + dynacast, 캡처 720p

## AC: 오디오 도달 실패율 0% (측정 정의)

load-test 클라이언트는 우리 앱 클라이언트가 아니라 `AUDIO_RX_REPORT` 를 보내지 않는다. 따라서
다음 **두 지표를 합쳐** 판정한다:

1. **실제 앱 클라이언트(host + guest 8)의 `missing_subscription` alert = 0**
   - 병행으로 `HEAVY=1 playwright test phase3`(8명 전수)을 함께 띄우고,
     테스트 구간 동안 `/metrics` 의 `ml_audio_missing_detected_total` 증분(Δ)이 0 인지 확인.
   - host `/rooms/:id/alerts` 에 `missing_subscription` 이 없어야 함.
2. **livekit-cli 구독 통계에서 기대 트랙 수 수신**
   - load-test 요약의 구독 성공/기대 트랙 수 일치.

## 결과 (수동 기입)

| 항목 | 값 |
|---|---|
| 시청자 수 | 100 |
| duration | 60s |
| LiveKit CPU peak | (docker stats) |
| LiveKit 대역폭 | (livekit :6789 /metrics) |
| ml_audio_missing_detected_total Δ | (기대 0) |
| app client missing_subscription | (기대 0) |
| livekit-cli 구독 성공률 | (기대 100%) |

> LiveKit 자체 메트릭 스크레이프: `livekit.yaml` 의 `prometheus_port: 6789` → `curl localhost:6789/metrics`.

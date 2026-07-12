#!/usr/bin/env bash
# Phase 5 부하테스트 — livekit-cli(lk) load-test.
#   기본: 게스트(비디오 publish) 8 + 시청자 N(subscribe). 정식 AC 는 시청자 100(로컬).
#   측정 정의(오디오 도달 실패율 0%):
#     ① 실제 앱 클라이언트(host+guest 8)의 missing_subscription alert = 0
#        → /metrics 의 ml_audio_missing_detected_total 증분으로 확인(테스트 구간).
#     ② livekit-cli 구독 통계에서 기대 트랙 수 수신.
#   ①은 별도로 @heavy 8명 E2E 를 함께 띄워 측정한다(이 스크립트는 ② + 서버 지표 스냅샷).
#
# 사용: bash scripts/loadtest.sh [--subscribers N] [--duration 60s] [--report FILE]
set -euo pipefail

SUBSCRIBERS=100
DURATION=60s
REPORT=/tmp/phase5-loadtest.md
URL=${NEXT_PUBLIC_LIVEKIT_URL:-ws://localhost:7880}
API_KEY=${LIVEKIT_API_KEY:-devkey}
API_SECRET=${LIVEKIT_API_SECRET:-devsecret_change_me_0123456789abcdef}
API=${NEXT_PUBLIC_API_URL:-http://localhost:4000}
ROOM=loadtest-$RANDOM

while [ $# -gt 0 ]; do
  case "$1" in
    --subscribers) SUBSCRIBERS="$2"; shift 2;;
    --duration) DURATION="$2"; shift 2;;
    --report) REPORT="$2"; shift 2;;
    *) echo "unknown arg: $1"; exit 2;;
  esac
done

CLI=""
command -v lk >/dev/null 2>&1 && CLI=lk
[ -z "$CLI" ] && command -v livekit-cli >/dev/null 2>&1 && CLI=livekit-cli
if [ -z "$CLI" ]; then
  echo "livekit-cli(lk) 미설치. 설치: brew install livekit-cli  (또는 https://github.com/livekit/livekit-cli)"
  exit 1
fi

metric() { curl -s "$API/metrics" | sed -n "s/^$1 \([0-9.e+-]*\)$/\1/p"; }

MISSING_BEFORE=$(metric ml_audio_missing_detected_total); MISSING_BEFORE=${MISSING_BEFORE:-0}
echo "[loadtest] room=$ROOM subscribers=$SUBSCRIBERS duration=$DURATION"

# 게스트 8(비디오) + 시청자 N. (플래그는 CLI 버전에 따라 다를 수 있어 필요 시 조정)
"$CLI" load-test \
  --url "$URL" --api-key "$API_KEY" --api-secret "$API_SECRET" \
  --room "$ROOM" \
  --video-publishers 8 --subscribers "$SUBSCRIBERS" \
  --duration "$DURATION" | tee /tmp/loadtest-raw.txt

MISSING_AFTER=$(metric ml_audio_missing_detected_total); MISSING_AFTER=${MISSING_AFTER:-0}

{
  echo "# Phase 5 부하테스트 리포트"
  echo
  echo "- 일시: (수동 기입)"
  echo "- 구성: 게스트(video) 8 + 시청자 $SUBSCRIBERS, duration=$DURATION, room=$ROOM"
  echo "- LiveKit CPU/대역폭: (docker stats / livekit :6789 /metrics 에서 기입)"
  echo
  echo "## 오디오 도달 실패율 (AC: 0%)"
  echo "- ml_audio_missing_detected_total: before=$MISSING_BEFORE after=$MISSING_AFTER (Δ=$((MISSING_AFTER - MISSING_BEFORE)))"
  echo "- 병행 @heavy 8명 E2E 의 host/guest missing_subscription alert: (기입, 기대 0)"
  echo
  echo "## livekit-cli 구독 통계"
  echo '```'
  tail -n 40 /tmp/loadtest-raw.txt
  echo '```'
} > "$REPORT"

echo "[loadtest] 리포트: $REPORT (missing Δ=$((MISSING_AFTER - MISSING_BEFORE)))"

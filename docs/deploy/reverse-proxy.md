# 리버스 프록시 (Caddy) — 준비물

> Phase 7-lite §1-1. **실제 VPS 배선은 #7 `chore/cd-wire`** 에서. 이 문서는 그때 붙일 설정과
> 앱측 `TRUST_PROXY` 의 관계를 고정해 둔다. web 은 Vercel 이 별도 호스팅하므로 대상 아님.

## 왜 필요한가

API 는 `req.ip` 로 rate limit 버킷을 나눈다(`/auth/session` 익명 세션 폭증 차단, 초대코드 무차별
대입 방어). 프록시 뒤에서 소켓 IP 는 항상 프록시가 되므로, 실제 클라이언트 IP 는 `X-Forwarded-For`(XFF)
에서 읽어야 한다. 그런데 XFF 는 **클라이언트가 위조**할 수 있으므로, "어디까지 믿을지"를 정확히 정해야 한다.

- 앱: `TRUST_PROXY=1` → **오른쪽 1홉(Caddy)만 신뢰**. 클라이언트가 넣은 leftmost XFF 는 무시된다.
- Caddy: XFF 를 **실제 원격 IP 로 설정**(클라이언트가 보낸 XFF 를 덮어씀) → 이중 방어.

두 개가 함께여야 위조가 원천 차단된다. (앱만으로도 홉 수 신뢰로 방어되지만, Caddy 에서 덮으면 확실.)

## Caddyfile 스니펫

```caddy
api.example.com {
	# 클라이언트가 보낸 X-Forwarded-For 를 실제 원격 IP 로 덮어씀(위조 무시).
	# {remote_host} = Caddy 가 관측한 실제 TCP 피어(진짜 클라이언트).
	reverse_proxy 127.0.0.1:4000 {
		header_up X-Forwarded-For {remote_host}
	}

	encode zstd gzip
}
```

## 웹훅 (LiveKit Cloud 대시보드 등록)

Cloud 대시보드의 webhook URL 은 `https://api.<도메인>/webhooks/livekit` 로 등록한다.
서명 검증이 **raw body 바이트**에 의존하므로(`addContentTypeParser` 로 원문 보존), **프록시가 요청
body 를 변형하면 안 된다**. Caddy `reverse_proxy` 는 기본적으로 body 를 무변형 전달하므로 별도 설정
불필요 — 단, body 를 건드리는 미들웨어(재작성·버퍼링 변환 등)를 이 경로에 추가하지 말 것.
`encode`(응답 압축)는 요청 body 와 무관하므로 서명 검증에 영향 없다.

## 앱측 설정 (VPS env)

```bash
# Caddy 1대 뒤 — 오른쪽 1홉만 신뢰(leftmost 위조 XFF 무력화)
TRUST_PROXY=1
# (특정 프록시 IP/서브넷만 신뢰하려면: TRUST_PROXY=10.0.0.0/8,127.0.0.1)
```

`TRUST_PROXY` 미설정/`false` 는 **직결(프록시 없음)** 을 의미 — 이때 XFF 는 완전히 무시되고 `req.ip`
는 소켓 IP 다. 프록시 뒤인데 이 값을 비워두면 모든 클라이언트가 Caddy IP 하나로 합산되어 rate limit
이 무력해지므로, **배선 시 반드시 `TRUST_PROXY=1` 을 함께 설정**한다.

## 검증

`pnpm --filter @multi-live/api verify:phase7` (게이트 편입) 이 격리 서버 2개로 양쪽을 확인한다:
`TRUST_PROXY=1` 의 위조 무력화·버킷 분리, 그리고 미설정 시 XFF 완전 무시. 상세는 스크립트 주석 참조.

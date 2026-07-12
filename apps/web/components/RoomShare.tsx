"use client";

import dynamic from "next/dynamic";

/**
 * QR 공유(호스트 라이브 화면). 게스트/시청자 각각의 진입 URL 을 QR 로 노출해
 * 데모 방문자가 링크 복붙 없이 폰으로 바로 붙게 한다.
 *
 * 번들: qrcode.react 는 next/dynamic(ssr:false)로 **동적 청크**로 분리 —
 * /broadcast First Load JS(공유 런타임)에 싣지 않는다. QR 은 브라우저에서만 생성(클라이언트 전용).
 */
const QRCode = dynamic(
  () => import("qrcode.react").then((m) => m.QRCodeSVG),
  {
    ssr: false,
    loading: () => <div style={{ width: 128, height: 128 }} aria-hidden />,
  },
);

function QrItem({
  testid,
  label,
  hint,
  url,
}: {
  testid: string;
  label: string;
  hint: string;
  url: string;
}) {
  return (
    <div className="qr-item" data-testid={testid} data-url={url}>
      <div className="qr-frame">
        {url ? (
          <QRCode value={url} size={128} level="M" marginSize={2} />
        ) : (
          <div style={{ width: 128, height: 128 }} aria-hidden />
        )}
      </div>
      <div className="qr-label">{label}</div>
      <div className="qr-hint muted">{hint}</div>
    </div>
  );
}

/** roomId/code 로 게스트·시청자 QR 2종을 렌더. code 없으면 게스트 QR 은 빈 프레임. */
export function RoomShare({ roomId, code }: { roomId: string; code: string }) {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const guestUrl = origin && code ? `${origin}/join/${roomId}?code=${code}` : "";
  const viewerUrl = origin ? `${origin}/watch/${roomId}` : "";
  return (
    <section className="card room-share" aria-label="QR 공유">
      <QrItem
        testid="qr-guest"
        label="게스트로 참여"
        hint="스캔하면 출연 요청"
        url={guestUrl}
      />
      <QrItem
        testid="qr-viewer"
        label="시청자로 보기"
        hint="스캔하면 바로 시청"
        url={viewerUrl}
      />
    </section>
  );
}

"use client";

import { useEffect, useRef } from "react";

/**
 * 데모 1회성 가이드 오버레이(§7-lite 1-5). 데모로 라이브에 처음 진입할 때만 뜬다
 * (호출측이 sessionStorage `ml-demo-guide-seen` 로 세션당 1회 보장). 방문자 첫 접점 코칭.
 * 애니메이션은 globals.css 에서 prefers-reduced-motion 을 존중.
 */
export function DemoGuide({ onClose }: { onClose: () => void }) {
  const btnRef = useRef<HTMLButtonElement>(null);

  // 진입 시 CTA 로 포커스 이동 + Esc 로 닫기(모달 접근성).
  useEffect(() => {
    btnRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="demo-guide-overlay"
      data-testid="guide-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="demo-guide-title"
      onClick={onClose}
    >
      <div className="demo-guide-card" onClick={(e) => e.stopPropagation()}>
        <h2 id="demo-guide-title" style={{ marginTop: 0 }}>
          데모 방송이 시작됐어요 🎬
        </h2>
        <ol className="demo-guide-steps">
          <li>
            <strong>게스트 QR</strong> 을 공유하면 상대가 폰으로 스캔해 바로 출연
            요청을 보낼 수 있어요.
          </li>
          <li>
            <strong>시청자 QR</strong> 로는 누구나 로그인 없이 시청만 할 수 있어요.
          </li>
          <li>이 데모 방은 일정 시간이 지나면 자동으로 정리돼요.</li>
        </ol>
        <button
          ref={btnRef}
          className="btn"
          data-testid="guide-dismiss"
          onClick={onClose}
        >
          시작하기
        </button>
      </div>
    </div>
  );
}

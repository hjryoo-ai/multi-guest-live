"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Badge } from "./ui";
import { ViewerCount } from "./ViewerCount";

/**
 * 영상 영역 프레임 — 미디어(children) 위에 LIVE·시청자 수 오버레이.
 * 영상 영역 탭 = 오버레이 토글(표시 시 3초 자동 숨김). 채팅 영역과 경계 분리(이 프레임만 토글).
 * 오버레이는 pointer-events 로 배지만 클릭 가능, 나머지 탭은 토글로 흐른다.
 */
export function MediaFrame({
  roomId,
  variant = "video",
  children,
}: {
  roomId: string;
  variant?: "video" | "stage";
  children: ReactNode;
}) {
  const [show, setShow] = useState(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleHide = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setShow(false), 3000);
  }, []);

  const toggle = useCallback(() => {
    setShow((s) => {
      const next = !s;
      if (next) scheduleHide();
      else if (timerRef.current) clearTimeout(timerRef.current);
      return next;
    });
  }, [scheduleHide]);

  // 진입 시 잠깐 노출 후 자동 숨김.
  useEffect(() => {
    scheduleHide();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [scheduleHide]);

  return (
    <div
      className={variant === "stage" ? "watch-media watch-stage" : "watch-media"}
      onClick={toggle}
    >
      {children}
      <div className="watch-overlay" data-show={show}>
        <Badge kind="live">LIVE</Badge>
        <ViewerCount roomId={roomId} />
      </div>
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { apiGetHls } from "../lib/api";
import type { EgressStatus } from "@multi-live/shared";

/**
 * 모드 B(HLS) 재생 — hls.js 로 egress 산출 매니페스트를 재생.
 * egress 가 active 가 될 때까지 /rooms/:id/hls 를 폴링해 playlistUrl 을 획득하고,
 * Safari 는 native HLS, 그 외는 hls.js 로 attach.
 */
export function HlsPlayer({ roomId }: { roomId: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<EgressStatus>("none");
  const [url, setUrl] = useState<string | null>(null);
  // 재생 파이프라인 상태(테스트 가능성): idle | parsed | error.
  const [hlsState, setHlsState] = useState<"idle" | "parsed" | "error">("idle");

  // egress active + playlistUrl 폴링.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const info = await apiGetHls(roomId);
        if (!alive) return;
        setStatus(info.egressStatus);
        if (info.playlistUrl) setUrl(info.playlistUrl);
      } catch {
        /* 무시 */
      }
    };
    void tick();
    const t = setInterval(tick, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [roomId]);

  // url 확정 시 attach.
  //   B-4-1: hls.js 는 여기서 동적 import — 모드 A(WebRTC) 시청자·게스트는 로드하지 않아
  //   초기 번들에서 분리된다(hls.js 는 별도 lazy 청크).
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !url) return;

    let hls: { destroy: () => void } | null = null;
    let canceled = false;
    const onMeta = () => setHlsState("parsed");
    const onErr = () => setHlsState("error");

    void (async () => {
      const { default: Hls } = await import("hls.js");
      if (canceled || !video) return;

      // hls.js(MSE) 우선. Safari native 는 hls.js 미지원일 때만 fallback.
      //   (일부 Chromium 은 mpegurl canPlayType 에 truthy 를 반환하지만 실제 재생은 못 함)
      if (Hls.isSupported()) {
        const instance = new Hls({ lowLatencyMode: true });
        hls = instance;
        // 매니페스트 파싱 성공 = 서빙+플레이어 경로 정상(세그먼트 디코드와 무관).
        // parsed 는 sticky: 파싱 후의 fatal(디코드/버퍼 stall 등)은 이 마일스톤을 덮지 않는다.
        instance.on(Hls.Events.MANIFEST_PARSED, () => setHlsState("parsed"));
        instance.on(Hls.Events.ERROR, (_e, data) => {
          if (data.fatal)
            setHlsState((prev) => (prev === "parsed" ? prev : "error"));
        });
        instance.loadSource(url);
        instance.attachMedia(video);
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = url; // Safari native.
        video.addEventListener("loadedmetadata", onMeta);
        video.addEventListener("error", onErr);
      }
    })();

    return () => {
      canceled = true;
      if (hls) hls.destroy();
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("error", onErr);
    };
  }, [url]);

  // MediaFrame 내부에서 사용 — <video> 는 .watch-media 의 직접 자식이어야 오버레이/비율 CSS 가 걸린다.
  return (
    <>
      <video
        ref={videoRef}
        data-testid="hls-video"
        data-hls-state={hlsState}
        controls
        autoPlay
        muted
        playsInline
      />
      {status !== "active" && (
        <div
          className="muted"
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            textAlign: "center",
            padding: "0 24px",
            fontSize: 13,
            pointerEvents: "none",
          }}
        >
          {status === "failed"
            ? "실시간(HLS) 송출이 잠시 멈췄어요. 곧 다시 이어져요."
            : "방송을 준비하고 있어요. 잠시만 기다려 주세요."}
        </div>
      )}
    </>
  );
}

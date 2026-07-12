"use client";

import { useEffect, useRef, useState } from "react";
import { PermissionDenied } from "./state";

/**
 * 입장 전 장치 프리뷰 — 셀프뷰 + 마이크 레벨 + 장치 선택 + 권한 거부 안내.
 * 생명주기(중요): getUserMedia 로컬 트랙은 언마운트(대기실 진입·페이지 이탈) 시 반드시 stop.
 *   안 그러면 카메라 표시등이 켜진 채 대기하거나, 본입장 때 장치 잠금 충돌이 난다.
 * 마이크 레벨은 rAF 로 CSS 변수(--meter)만 갱신 — 프레임당 리렌더 없음(글로우와 동일 철학).
 */
export function DevicePreview() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const meterRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [denied, setDenied] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [camId, setCamId] = useState<string | undefined>(undefined);
  const [micId, setMicId] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    let audioCtx: AudioContext | null = null;
    let raf = 0;

    async function start() {
      // 이전 스트림 정리(장치 전환 시 잠금 방지).
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: camId ? { deviceId: { exact: camId } } : true,
          audio: micId ? { deviceId: { exact: micId } } : true,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        setDenied(false);
        if (videoRef.current) videoRef.current.srcObject = stream;

        // 권한 허용 후에야 라벨이 채워진다.
        const devs = await navigator.mediaDevices.enumerateDevices();
        if (cancelled) return;
        setCams(devs.filter((d) => d.kind === "videoinput"));
        setMics(devs.filter((d) => d.kind === "audioinput"));

        // 마이크 레벨 미터(analyser → CSS 변수).
        try {
          audioCtx = new AudioContext();
          void audioCtx.resume();
          const srcNode = audioCtx.createMediaStreamSource(stream);
          const analyser = audioCtx.createAnalyser();
          analyser.fftSize = 256;
          srcNode.connect(analyser);
          const data = new Uint8Array(analyser.frequencyBinCount);
          const loop = () => {
            raf = requestAnimationFrame(loop);
            analyser.getByteTimeDomainData(data);
            let peak = 0;
            for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
            meterRef.current?.style.setProperty(
              "--meter",
              Math.min(1, peak / 64).toFixed(3),
            );
          };
          raf = requestAnimationFrame(loop);
        } catch {
          /* 레벨 미터 없이도 프리뷰는 동작 */
        }
      } catch {
        if (!cancelled) setDenied(true);
      }
    }
    void start();

    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      void audioCtx?.close();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [camId, micId, nonce]);

  if (denied) {
    return <PermissionDenied onRetry={() => setNonce((n) => n + 1)} />;
  }

  return (
    <div data-testid="device-preview" className="card" style={{ padding: 12 }}>
      <div
        style={{
          position: "relative",
          aspectRatio: "16 / 10",
          background: "#000",
          borderRadius: "var(--radius-sm)",
          overflow: "hidden",
        }}
      >
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            transform: "scaleX(-1)", // 셀프뷰 미러링
          }}
        />
      </div>

      {/* 마이크 레벨 미터 */}
      <div
        style={{ display: "flex", alignItems: "center", gap: 8, margin: "10px 0" }}
      >
        <span style={{ fontSize: 12 }}>🎤</span>
        <div
          ref={meterRef}
          style={{
            flex: 1,
            height: 6,
            borderRadius: 3,
            background: "var(--surface-2)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: "calc(var(--meter, 0) * 100%)",
              background: "var(--brand)",
              transition: "width 90ms linear",
            }}
          />
        </div>
      </div>

      {/* 장치 선택 */}
      <div style={{ display: "flex", gap: 8 }}>
        <select
          aria-label="카메라 선택"
          value={camId ?? ""}
          onChange={(e) => setCamId(e.target.value || undefined)}
          style={selectStyle}
        >
          {cams.length === 0 && <option value="">카메라</option>}
          {cams.map((d, i) => (
            <option key={d.deviceId || i} value={d.deviceId}>
              {d.label || `카메라 ${i + 1}`}
            </option>
          ))}
        </select>
        <select
          aria-label="마이크 선택"
          value={micId ?? ""}
          onChange={(e) => setMicId(e.target.value || undefined)}
          style={selectStyle}
        >
          {mics.length === 0 && <option value="">마이크</option>}
          {mics.map((d, i) => (
            <option key={d.deviceId || i} value={d.deviceId}>
              {d.label || `마이크 ${i + 1}`}
            </option>
          ))}
        </select>
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: 10, marginBottom: 0 }}>
        입장하면 미리보기는 꺼지고, 호스트가 승인하면 카메라·마이크가 켜져요.
      </p>
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: "8px 10px",
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  color: "var(--text)",
  fontSize: 13,
};

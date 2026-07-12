"use client";

import { useCallback, useEffect, useState } from "react";
import { LiveKitRoom, RoomAudioRenderer } from "@livekit/components-react";
import type { RoomDetailDto } from "@multi-live/shared";
import { LIVEKIT_URL } from "../../../../lib/env";
import { apiGetRoom, apiIssueToken, ensureSession } from "../../../../lib/api";
import { Stage } from "../../../../components/Stage";
import { RealtimeChat, PollChat } from "../../../../components/Chat";
import { HlsPlayer } from "../../../../components/HlsPlayer";
import { MediaFrame } from "../../../../components/MediaFrame";
import { ConnectionBanner } from "../../../../components/ConnectionBanner";
import { AudioReach } from "../../../../components/AudioReach";
import { ReconnectGuard } from "../../../../components/ReconnectGuard";
import { EndedState, ErrorState } from "../../../../components/state";
import { Button } from "../../../../components/ui";
import { roomOptions } from "../../../../lib/lkOptions";

export default function WatchPage({ params }: { params: { roomId: string } }) {
  const roomId = params.roomId;
  const [nickname, setNickname] = useState("");
  const [room, setRoom] = useState<RoomDetailDto | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);
  const [entered, setEntered] = useState(false);

  const loadRoom = useCallback(() => {
    setLoadFailed(false);
    apiGetRoom(roomId)
      .then(setRoom)
      .catch(() => setLoadFailed(true));
  }, [roomId]);

  useEffect(() => {
    loadRoom();
  }, [loadRoom]);

  const enter = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      await ensureSession(nickname.trim() || "시청자");
      const fresh = await apiGetRoom(roomId);
      setRoom(fresh);
      // 모드 A(webrtc): subscribe-only viewer 토큰으로 LiveKit 접속.
      // 모드 B(hls): LiveKit 미접속 — HLS 플레이어로 시청.
      if (fresh.viewerMode === "webrtc") {
        const tok = await apiIssueToken(roomId); // 서버가 viewer 로 결정.
        setToken(tok.token);
      }
      setEntered(true);
    } catch (e: any) {
      setError(e?.body?.error ?? e?.message ?? "입장하지 못했어요. 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  }, [nickname, roomId]);

  // ── 방송 종료 ──────────────────────────────────────────────
  if (room && room.status === "ended") {
    return <EndedState />;
  }

  // ── 방을 찾지 못함 ────────────────────────────────────────
  if (loadFailed && !entered) {
    return (
      <ErrorState
        message="이 방송을 찾을 수 없어요. 링크가 올바른지 확인해 주세요."
        onRetry={loadRoom}
      />
    );
  }

  // ── 입장 전 화면 ──────────────────────────────────────────
  if (!entered) {
    return (
      <main className="container">
        <h1 style={{ marginBottom: 4 }}>시청 입장</h1>
        <p className="muted" style={{ marginTop: 0, marginBottom: 20 }}>
          {room ? room.title : "방송 정보를 불러오는 중…"}
        </p>
        <div className="card" style={{ maxWidth: 460 }}>
          {room && (
            <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
              {room.viewerMode === "hls" ? "실시간 시청" : "실시간 참여형"} 방송이에요.
            </p>
          )}
          <label style={{ display: "block", margin: "8px 0 16px" }}>
            <div className="muted" style={{ fontSize: 13 }}>표시할 이름</div>
            <input
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="시청자"
              style={inputStyle}
            />
          </label>
          {error && (
            <p style={{ color: "var(--danger)", fontSize: 13 }}>{error}</p>
          )}
          <Button onClick={enter} disabled={busy}>
            {busy ? "입장하는 중…" : "시청 입장"}
          </Button>
        </div>
      </main>
    );
  }

  // ── 모드 B: HLS 재생 ────────────────────────────────────────
  if (room?.viewerMode === "hls") {
    return (
      <div className="watch-shell">
        <MediaFrame roomId={roomId} variant="video">
          <HlsPlayer roomId={roomId} />
        </MediaFrame>
        <div className="watch-chat">
          <PollChat roomId={roomId} fill />
        </div>
      </div>
    );
  }

  // ── 모드 A: WebRTC subscribe-only ───────────────────────────
  if (!token) return null;
  return (
    <LiveKitRoom
      serverUrl={LIVEKIT_URL}
      token={token}
      connect
      options={roomOptions}
      audio={false}
      video={false}
      data-lk-theme="default"
    >
      <div className="watch-shell">
        <MediaFrame roomId={roomId} variant="stage">
          <Stage roomId={roomId} />
        </MediaFrame>
        <div className="watch-chat">
          <RealtimeChat roomId={roomId} fill />
        </div>
      </div>
      <RoomAudioRenderer />
      <AudioReach roomId={roomId} />
      <ConnectionBanner />
      <ReconnectGuard
        issueToken={async () => (await apiIssueToken(roomId)).token}
        onToken={setToken}
      />
    </LiveKitRoom>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  marginTop: 4,
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  color: "var(--text)",
};

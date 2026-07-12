"use client";

import { useCallback, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  LiveKitRoom,
  RoomAudioRenderer,
  ControlBar,
} from "@livekit/components-react";
import { LIVEKIT_URL } from "../../../../lib/env";
import { apiIssueToken, apiRequestJoin, ensureSession } from "../../../../lib/api";
import { Stage } from "../../../../components/Stage";
import { AudioReach } from "../../../../components/AudioReach";
import { GuestUpgrade } from "../../../../components/GuestUpgrade";
import { MuteBanner } from "../../../../components/MuteBanner";
import { ConnectionBanner } from "../../../../components/ConnectionBanner";
import { RealtimeChat } from "../../../../components/Chat";
import { ReconnectGuard } from "../../../../components/ReconnectGuard";
import { DevicePreview } from "../../../../components/DevicePreview";
import { RemovedState, EndedState } from "../../../../components/state";
import { Button } from "../../../../components/ui";
import { useToast } from "../../../../components/ui";
import { roomOptions } from "../../../../lib/lkOptions";

export default function JoinPage({ params }: { params: { roomId: string } }) {
  const roomId = params.roomId;
  const search = useSearchParams();
  const toast = useToast();
  const [nickname, setNickname] = useState("");
  const [code, setCode] = useState(search.get("code") ?? "");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [role, setRole] = useState<"guest" | "speaker" | null>(null);
  const [terminated, setTerminated] = useState<"kicked" | "ended" | null>(null);
  const announcedRef = useRef(false);
  const upgraded = role !== null;

  // 강퇴/방 종료 → 재접속 불가 종료를 안내 화면으로 라우팅(ReconnectGuard 가 reason 판정).
  const onTerminated = useCallback((reason: "kicked" | "ended") => {
    setTerminated(reason);
  }, []);

  // '다시 참여 요청' — 재승인 필수 정책 그대로 입장 전(장치 프리뷰)으로 되돌린다.
  const rerequest = useCallback(() => {
    try {
      sessionStorage.removeItem(`ml-approved-${roomId}`);
    } catch {
      /* 무시 */
    }
    announcedRef.current = false;
    setTerminated(null);
    setRole(null);
    setToken("");
  }, [roomId]);

  const join = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      await ensureSession(nickname.trim() || "게스트");
      // 초대코드로 승인 요청(대기실 등록).
      const jr = await apiRequestJoin(roomId, code.trim());
      // 이미 승인된 사용자(재입장 등)는 처음부터 guest 토큰으로 접속 →
      //   불안정한 token-swap 재연결을 피하고 접속 즉시 canPublish 확보.
      // 아직 미승인이면 viewer 로 대기실 입장 → GuestUpgrade 가 승인 시 송출로 전환.
      const tok =
        jr.state === "approved"
          ? await apiIssueToken(roomId, "guest")
          : await apiIssueToken(roomId);
      setToken(tok.token);
    } catch (e: any) {
      setError(
        e?.body?.error === "invalid_invite"
          ? "초대 링크가 만료되었거나 올바르지 않아요. 호스트에게 새 링크를 받아 주세요."
          : "입장하지 못했어요. 잠시 후 다시 시도해 주세요.",
      );
    } finally {
      setBusy(false);
    }
  }, [nickname, code, roomId]);

  // 승인 모먼트 — 세션 1회성(재연결·리렌더에서 재점화 방지).
  const onUpgraded = useCallback(
    (r: "guest" | "speaker") => {
      setRole(r);
      const key = `ml-approved-${roomId}`;
      const already =
        announcedRef.current ||
        (typeof sessionStorage !== "undefined" &&
          sessionStorage.getItem(key) === "1");
      if (already) return;
      announcedRef.current = true;
      try {
        sessionStorage.setItem(key, "1");
      } catch {
        /* 무시 */
      }
      toast(
        "success",
        r === "speaker"
          ? "음성으로 참여하게 됐어요 · 마이크가 켜졌어요"
          : "무대에 올랐어요 · 카메라와 마이크가 켜졌어요",
      );
    },
    [roomId, toast],
  );

  // ── 종료 상태(재접속 불가): 강퇴 / 방 종료 ──────────────────
  if (terminated === "kicked") {
    return <RemovedState onRerequest={rerequest} />;
  }
  if (terminated === "ended") {
    return <EndedState />;
  }

  // ── 입장 전: 장치 프리뷰 + 폼 ────────────────────────────────
  if (!token) {
    return (
      <main className="container" style={{ maxWidth: 760 }}>
        <h1 style={{ marginBottom: 4 }}>무대 준비</h1>
        <p className="muted" style={{ marginTop: 0, marginBottom: 20 }}>
          카메라·마이크를 확인하고 대기실에 입장해요. 호스트가 승인하면 무대에 올라요.
        </p>
        <div className="join-entry">
          <DevicePreview />
          <div className="card" style={{ alignSelf: "start" }}>
            <label style={{ display: "block", marginBottom: 12 }}>
              <div className="muted" style={{ fontSize: 13 }}>표시할 이름</div>
              <input
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                placeholder="게스트"
                style={inputStyle}
              />
            </label>
            <label style={{ display: "block", marginBottom: 16 }}>
              <div className="muted" style={{ fontSize: 13 }}>초대코드</div>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="host 에게 받은 코드"
                style={inputStyle}
              />
            </label>
            {error && (
              <p style={{ color: "var(--danger)", fontSize: 13 }}>{error}</p>
            )}
            <Button onClick={join} disabled={busy || !code}>
              {busy ? "입장하는 중…" : "대기실 입장"}
            </Button>
          </div>
        </div>
      </main>
    );
  }

  // ── 접속 후: 대기실 / 무대 ───────────────────────────────────
  const statusText =
    role === "speaker"
      ? "🎙 음성 참여 중"
      : role === "guest"
        ? "🎙️ 출연 중"
        : "⏳ 승인 대기 중";

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
        <div
          data-testid={upgraded ? undefined : "waiting-room"}
          className="watch-media"
          style={{
            background: "transparent",
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
          }}
        >
          <div
            className="status-pill"
            style={{
              alignSelf: "flex-start",
              margin: "10px",
              padding: "6px 14px",
              borderRadius: "var(--radius-pill)",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            {statusText}
          </div>
          <div className="watch-stage" style={{ flex: 1 }}>
            <Stage roomId={roomId} />
          </div>
          {upgraded && (
            <div style={{ padding: "8px 10px" }}>
              {/* speaker 는 카메라 컨트롤 비노출(오디오 전용) */}
              <ControlBar
                variation="minimal"
                controls={{
                  camera: role === "guest",
                  microphone: true,
                  screenShare: false,
                  chat: false,
                  leave: true,
                }}
              />
            </div>
          )}
        </div>
        <div className="watch-chat">
          <RealtimeChat roomId={roomId} fill />
        </div>
      </div>

      <RoomAudioRenderer />
      <AudioReach roomId={roomId} />
      <GuestUpgrade roomId={roomId} onUpgraded={onUpgraded} />
      <MuteBanner />
      <ConnectionBanner />
      <ReconnectGuard
        issueToken={async () =>
          (await apiIssueToken(roomId, upgraded ? "guest" : undefined)).token
        }
        onToken={setToken}
        onTerminated={onTerminated}
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

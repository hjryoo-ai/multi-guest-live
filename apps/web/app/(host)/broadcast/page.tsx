"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  LiveKitRoom,
  RoomAudioRenderer,
  ControlBar,
  PreJoin,
  type LocalUserChoices,
} from "@livekit/components-react";
import { LIVEKIT_URL } from "../../../lib/env";
import {
  apiCreateInvite,
  apiCreateRoom,
  apiEndRoom,
  apiGetAlerts,
  apiIssueToken,
  ensureSession,
} from "../../../lib/api";
import { Stage } from "../../../components/Stage";
import { AudioReach } from "../../../components/AudioReach";
import { HostPanel } from "../../../components/HostPanel";
import { ConnectionBanner } from "../../../components/ConnectionBanner";
import { ViewerCount } from "../../../components/ViewerCount";
import { EgressFallbackBanner } from "../../../components/EgressFallbackBanner";
import { ReconnectGuard } from "../../../components/ReconnectGuard";
import { Badge, BottomSheet, Button, useConfirm } from "../../../components/ui";
import { RoomShare } from "../../../components/RoomShare";
import { DemoGuide } from "../../../components/DemoGuide";
import { roomOptions } from "../../../lib/lkOptions";

const DEMO_GUIDE_SEEN_KEY = "ml-demo-guide-seen";

/** 데모 자동 호스트 닉네임(익명, 사람 눈에 구분 가능한 짧은 접미). */
function demoNickname(): string {
  return `데모호스트-${Math.floor(1000 + Math.random() * 9000)}`;
}

type Step = "setup" | "prejoin" | "live";

/** 뷰포트 폭 기반 모바일 판정(호스트는 데스크톱 우선, SSR 기본 false). */
function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 899px)");
    const on = () => setMobile(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return mobile;
}

/** 오디오 도달 경고 대상 닉네임 집합(10초 폴링) — 타일 위 경고에 사용. */
function useAudioAlerts(roomId: string): Set<string> {
  const [nicks, setNicks] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!roomId) return;
    let alive = true;
    const poll = () =>
      apiGetAlerts(roomId)
        .then(({ alerts }) => {
          if (alive) setNicks(new Set(alerts.map((a) => a.nickname)));
        })
        .catch(() => {});
    poll();
    const t = setInterval(poll, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [roomId]);
  return nicks;
}

export default function BroadcastPage() {
  const [stage, setStage] = useState<Step>("setup");
  const [nickname, setNickname] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const [roomId, setRoomId] = useState("");
  const [maxGuests, setMaxGuests] = useState(8);
  const [maxSpeakers, setMaxSpeakers] = useState(20);
  const [viewerMode, setViewerMode] = useState<"webrtc" | "hls">("webrtc");
  const [token, setToken] = useState("");
  const [invite, setInvite] = useState<string>("");
  const [choices, setChoices] = useState<LocalUserChoices | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const demoStarted = useRef(false);

  const confirm = useConfirm();
  const isMobile = useIsMobile();
  const warnNicks = useAudioAlerts(stage === "live" ? roomId : "");

  /**
   * 방 생성 공통 경로 — 버튼(수동)과 데모 자동 진입이 공유한다.
   * demo=true 면 장치 선택(prejoin)을 건너뛰고 바로 live(방문자 첫 접점을 최소 클릭으로).
   */
  const createAndEnter = useCallback(
    async (opts: { nickname: string; title: string; demo: boolean }) => {
      setBusy(true);
      setError("");
      try {
        await ensureSession(opts.nickname);
        const room = await apiCreateRoom({
          title: opts.title,
          maxGuests: 8,
          viewerMode,
        });
        const tok = await apiIssueToken(room.id);
        const inv = await apiCreateInvite(room.id);
        setRoomId(room.id);
        setMaxGuests(room.maxGuests);
        setMaxSpeakers(room.maxSpeakers);
        setToken(tok.token);
        setInvite(inv.code);
        if (opts.demo) {
          // 새로고침 시 ?demo=1 로 방이 또 생기는 것을 차단 — URL 에서 쿼리 제거.
          // (history 교체만; Next 내비게이션/리렌더를 유발하지 않는다.)
          if (typeof window !== "undefined")
            window.history.replaceState(null, "", "/broadcast");
          // 세션당 1회 가이드.
          const seen =
            typeof window !== "undefined" &&
            window.sessionStorage.getItem(DEMO_GUIDE_SEEN_KEY);
          if (!seen) setShowGuide(true);
          setStage("live");
        } else {
          setStage("prejoin");
        }
      } catch {
        setError("방을 만들지 못했어요. 잠시 후 다시 시도해 주세요.");
        demoStarted.current = false; // 데모 자동 진입 실패 시 재시도 허용
      } finally {
        setBusy(false);
      }
    },
    [viewerMode],
  );

  const start = useCallback(
    () =>
      createAndEnter({
        nickname: nickname.trim() || "호스트",
        title: title.trim() || "라이브",
        demo: false,
      }),
    [nickname, title, createAndEnter],
  );

  // 데모 자동 진입(?demo=1). mount-once ref 로 StrictMode 이중 실행·재렌더 중복 생성 방어.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const isDemo =
      new URLSearchParams(window.location.search).get("demo") === "1";
    if (!isDemo || demoStarted.current) return;
    demoStarted.current = true;
    void createAndEnter({
      nickname: demoNickname(),
      title: "데모 라이브",
      demo: true,
    });
  }, [createAndEnter]);

  const dismissGuide = useCallback(() => {
    if (typeof window !== "undefined")
      window.sessionStorage.setItem(DEMO_GUIDE_SEEN_KEY, "1");
    setShowGuide(false);
  }, []);

  const end = useCallback(async () => {
    const ok = await confirm({
      title: "방송을 종료할까요?",
      body: "모든 참가자의 연결이 끊기고 방송이 끝나요. 이 작업은 되돌릴 수 없어요.",
      confirmLabel: "방송 종료",
      danger: true,
    });
    if (!ok) return;
    try {
      await apiEndRoom(roomId);
    } finally {
      setStage("setup");
      setToken("");
    }
  }, [confirm, roomId]);

  if (stage === "setup") {
    return (
      <main className="container">
        <h1>방송 시작</h1>
        <div className="card" style={{ maxWidth: 460 }}>
          <label style={{ display: "block", marginBottom: 12 }}>
            <div className="muted" style={{ fontSize: 13 }}>표시할 이름</div>
            <input
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="호스트"
              style={inputStyle}
            />
          </label>
          <label style={{ display: "block", marginBottom: 16 }}>
            <div className="muted" style={{ fontSize: 13 }}>방 제목</div>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="라이브"
              style={inputStyle}
            />
          </label>
          <label style={{ display: "block", marginBottom: 16 }}>
            <div className="muted" style={{ fontSize: 13 }}>
              시청자 모드 (생성 후 변경 불가)
            </div>
            <select
              value={viewerMode}
              onChange={(e) => setViewerMode(e.target.value as "webrtc" | "hls")}
              style={inputStyle}
            >
              <option value="webrtc">WebRTC (저지연 · 수천)</option>
              <option value="hls">HLS (대규모 · egress)</option>
            </select>
          </label>
          {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
          <Button onClick={start} disabled={busy}>
            {busy ? "만드는 중…" : "방 만들기"}
          </Button>
        </div>
      </main>
    );
  }

  if (stage === "prejoin") {
    return (
      <main className="container">
        <h1>장치 확인</h1>
        <p className="muted">마이크·카메라를 선택하고 미리보기를 확인하세요.</p>
        <div style={{ maxWidth: 640 }}>
          <PreJoin
            joinLabel="입장"
            defaults={{ username: nickname || "호스트" }}
            onSubmit={(c) => {
              setChoices(c);
              setStage("live");
            }}
          />
        </div>
      </main>
    );
  }

  return (
    <LiveKitRoom
      serverUrl={LIVEKIT_URL}
      token={token}
      connect
      options={roomOptions}
      audio={choices?.audioEnabled ?? true}
      video={choices?.videoEnabled ?? true}
      data-lk-theme="default"
    >
      <div className="host-shell">
        <div className="host-header">
          <Badge kind="live">LIVE</Badge>
          <div
            style={{
              display: "flex",
              gap: 10,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <ViewerCount roomId={roomId} />
            <InviteBadge roomId={roomId} code={invite} />
            {isMobile && (
              <Button variant="secondary" size="sm" onClick={() => setSheetOpen(true)}>
                관리
              </Button>
            )}
            <Button variant="danger" size="sm" onClick={end}>
              방송 종료
            </Button>
          </div>
        </div>

        <EgressFallbackBanner />

        <div className="host-body">
          <div className="host-stage">
            <Stage isHost roomId={roomId} warnNicks={warnNicks} />
            <div style={{ marginTop: 12 }}>
              <ControlBar variation="minimal" />
            </div>
            <RoomShare roomId={roomId} code={invite} />
          </div>
          {!isMobile && (
            <aside className="host-side">
              <HostPanel
                roomId={roomId}
                maxGuests={maxGuests}
                maxSpeakers={maxSpeakers}
                warnNicks={warnNicks}
              />
            </aside>
          )}
        </div>
      </div>

      {isMobile && (
        <BottomSheet
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          testid="host-panel-sheet"
        >
          <div style={{ height: "70dvh", display: "flex", flexDirection: "column" }}>
            <HostPanel
              roomId={roomId}
              maxGuests={maxGuests}
              maxSpeakers={maxSpeakers}
              warnNicks={warnNicks}
            />
          </div>
        </BottomSheet>
      )}

      {/* 원격 오디오 재생 — host 가 게스트 음성을 듣기 위한 필수 요소 */}
      <RoomAudioRenderer />
      <AudioReach roomId={roomId} />
      <ConnectionBanner />
      <ReconnectGuard
        issueToken={async () => (await apiIssueToken(roomId)).token}
        onToken={setToken}
      />
      {showGuide && <DemoGuide onClose={dismissGuide} />}
    </LiveKitRoom>
  );
}

function InviteBadge({ roomId, code }: { roomId: string; code: string }) {
  const link =
    typeof window !== "undefined"
      ? `${window.location.origin}/join/${roomId}?code=${code}`
      : "";
  return (
    <button
      className="btn"
      style={{ background: "var(--surface-2)", color: "var(--text)", fontSize: 13 }}
      onClick={() => navigator.clipboard?.writeText(link)}
      title={link}
      data-testid="invite"
      data-room-id={roomId}
      data-code={code}
    >
      초대링크 복사 (코드 {code})
    </button>
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

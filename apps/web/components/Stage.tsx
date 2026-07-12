"use client";

import { useEffect, useRef, useState } from "react";
import {
  useTracks,
  useSpeakingParticipants,
  useParticipants,
  VideoTrack,
  type TrackReferenceOrPlaceholder,
} from "@livekit/components-react";
import { ParticipantEvent, Track, type Participant } from "livekit-client";
import { apiKick, apiMute, apiChangeRole } from "../lib/api";
import { useConfirm, useToast } from "./ui";

/** 표시용 이름(닉네임 or 짧은 id). */
function displayName(p: Participant): string {
  return p.name || p.identity.slice(0, 6);
}

/** 참가자 metadata 의 role 파싱(speaker 판별). */
function roleOf(p: Participant): string {
  try {
    return (JSON.parse(p.metadata || "{}") as { role?: string }).role ?? "";
  } catch {
    return "";
  }
}

/**
 * 시그니처 글로우 링(Track D-1) — rAF 로 participant.audioLevel 을 읽어
 * CSS 변수(--glow: 링 발광, --meter: 레벨미터)만 DOM 에 직접 쓴다.
 * React state 를 쓰지 않으므로 **볼륨 틱당 리렌더 0**. 레이아웃 시프트 없음(outline/box-shadow).
 */
function useAudioGlow(
  ref: React.RefObject<HTMLElement | null>,
  participant: Participant,
) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    let last = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (t - last < 90) return; // ~11fps 스로틀(과한 갱신 방지)
      last = t;
      const lvl = Math.min(1, (participant.audioLevel ?? 0) * 3);
      const s = lvl.toFixed(3);
      el.style.setProperty("--glow", s);
      el.style.setProperty("--meter", s);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [ref, participant]);
}

/** 마이크 구독·음소거 상태(볼륨 아님 — 저빈도 이벤트로만 갱신, 볼륨 리렌더 유발 안 함). */
function useMicSubscribed(participant: Participant): boolean {
  const [subscribed, setSubscribed] = useState(false);
  useEffect(() => {
    const compute = () => {
      const pub = participant.getTrackPublication(Track.Source.Microphone);
      setSubscribed(
        participant.isLocal
          ? !!pub && !pub.isMuted
          : !!pub && pub.isSubscribed && !pub.isMuted,
      );
    };
    compute();
    const evs = [
      ParticipantEvent.TrackMuted,
      ParticipantEvent.TrackUnmuted,
      ParticipantEvent.TrackSubscribed,
      ParticipantEvent.TrackUnsubscribed,
      ParticipantEvent.TrackPublished,
      ParticipantEvent.TrackUnpublished,
      ParticipantEvent.LocalTrackPublished,
      ParticipantEvent.LocalTrackUnpublished,
    ];
    // 타입드 이미터: 배열 순회 시 이벤트별 콜백 시그니처가 좁혀지지 않아 캐스팅.
    evs.forEach((e) => participant.on(e as never, compute as never));
    return () => evs.forEach((e) => participant.off(e as never, compute as never));
  }, [participant]);
  return subscribed;
}

const PAGE_SIZE = 6;

/**
 * 방송 스테이지 — 참가자 타일 + (host) 운영 컨트롤 + 스포트라이트/페이지네이션.
 * 각 타일은 오디오 도달 검증(불변식)의 UI 지표를 노출:
 *   · 원격 오디오 subscribed 배지 · 레벨 미터(useTrackVolume) · 말하기 하이라이트
 */
export function Stage({
  isHost = false,
  roomId,
  warnNicks,
}: {
  isHost?: boolean;
  roomId?: string;
  warnNicks?: Set<string>;
}) {
  const cameraTracks = useTracks([Track.Source.Camera], {
    onlySubscribed: false,
  });
  const speaking = useSpeakingParticipants();
  const [spotlight, setSpotlight] = useState(false);
  const [page, setPage] = useState(0);

  if (cameraTracks.length === 0) {
    return (
      <div>
        <div className="card" style={{ textAlign: "center" }}>
          <p className="muted">참가자 대기 중…</p>
        </div>
        <SpeakerStrip isHost={isHost} roomId={roomId} warnNicks={warnNicks} />
      </div>
    );
  }

  // 스포트라이트: 액티브 스피커(없으면 첫 타일)를 크게, 나머지는 작은 스트립.
  if (spotlight) {
    const activeId = speaking[0]?.identity;
    const main =
      cameraTracks.find((t) => t.participant.identity === activeId) ??
      cameraTracks[0]!;
    const rest = cameraTracks.filter((t) => t !== main);
    return (
      <div>
        <Controls
          spotlight={spotlight}
          onToggle={() => setSpotlight((s) => !s)}
        />
        <Tile trackRef={main} isHost={isHost} roomId={roomId} warnNicks={warnNicks} big />
        <div style={{ display: "flex", gap: 8, marginTop: 8, overflowX: "auto" }}>
          {rest.map((ref) => (
            <div key={tileKey(ref)} style={{ minWidth: 160 }}>
              <Tile trackRef={ref} isHost={isHost} roomId={roomId} warnNicks={warnNicks} />
            </div>
          ))}
        </div>
        <SpeakerStrip isHost={isHost} roomId={roomId} warnNicks={warnNicks} />
      </div>
    );
  }

  const pages = Math.ceil(cameraTracks.length / PAGE_SIZE);
  const current = Math.min(page, pages - 1);
  const shown = cameraTracks.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE);

  return (
    <div>
      <Controls spotlight={spotlight} onToggle={() => setSpotlight((s) => !s)} />
      <div
        style={{
          display: "grid",
          gap: 12,
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
        }}
      >
        {shown.map((ref) => (
          <Tile
            key={tileKey(ref)}
            trackRef={ref}
            isHost={isHost}
            roomId={roomId}
            warnNicks={warnNicks}
          />
        ))}
      </div>
      {pages > 1 && (
        <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 12 }}>
          <button className="btn" style={btnSm} disabled={current === 0} onClick={() => setPage(current - 1)}>
            ‹
          </button>
          <span className="muted" style={{ fontSize: 13 }}>
            {current + 1} / {pages}
          </span>
          <button className="btn" style={btnSm} disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
            ›
          </button>
        </div>
      )}
      <SpeakerStrip isHost={isHost} roomId={roomId} warnNicks={warnNicks} />
    </div>
  );
}

/** 음성 참여(speaker) 스트립 — 비디오 그리드/페이지네이션과 분리. */
function SpeakerStrip({
  isHost,
  roomId,
  warnNicks,
}: {
  isHost: boolean;
  roomId?: string;
  warnNicks?: Set<string>;
}) {
  const participants = useParticipants();
  const speakers = participants.filter((p) => roleOf(p) === "speaker");
  if (speakers.length === 0) return null;
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
        🎙 음성 참여 ({speakers.length})
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        {speakers.map((p) => (
          <SpeakerChip
            key={p.identity}
            participant={p}
            isHost={isHost}
            roomId={roomId}
            warn={warnNicks?.has(displayName(p)) ?? false}
          />
        ))}
      </div>
    </div>
  );
}

function SpeakerChip({
  participant,
  isHost,
  roomId,
  warn = false,
}: {
  participant: Participant;
  isHost: boolean;
  roomId?: string;
  warn?: boolean;
}) {
  const chipRef = useRef<HTMLDivElement>(null);
  useAudioGlow(chipRef, participant); // 아바타에도 동일 발광 문법("소리의 시각화")
  const showMod = isHost && roomId && !participant.isLocal;
  const confirm = useConfirm();
  const toast = useToast();
  const name = displayName(participant);

  async function onToGuest() {
    try {
      await apiChangeRole(roomId!, participant.identity, "guest");
      toast("info", `${name} 님을 게스트로 바꿨어요`);
    } catch {
      toast("error", "전환하지 못했어요");
    }
  }
  async function onKick() {
    const ok = await confirm({
      title: `${name} 님을 강퇴할까요?`,
      body: "이 방송에서 내보내요. 다시 요청하면 재입장할 수 있어요.",
      confirmLabel: "강퇴하기",
      danger: true,
    });
    if (!ok) return;
    try {
      await apiKick(roomId!, participant.identity);
      toast("success", `${name} 님을 강퇴했어요`);
    } catch {
      toast("error", "강퇴하지 못했어요");
    }
  }
  return (
    <div
      ref={chipRef}
      data-testid="speaker-chip"
      data-nick={participant.name ?? participant.identity}
      className="glow"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 10px",
        borderRadius: "var(--radius-pill)",
        background: "var(--bg)",
      }}
    >
      <span
        style={{
          width: 24,
          height: 24,
          borderRadius: "50%",
          background:
            "color-mix(in srgb, var(--brand) calc(var(--glow, 0) * 100%), var(--surface-2))",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 12,
        }}
      >
        {participant.name?.[0] ?? "?"}
      </span>
      <span style={{ fontSize: 13, fontWeight: 600 }}>
        {participant.name || participant.identity.slice(0, 6)}
        {participant.isLocal ? " (나)" : ""}
      </span>
      <AudioStatus participant={participant} />
      {warn && (
        <span title="오디오 도달 확인 필요" style={{ color: "var(--warn)", fontSize: 12 }}>
          ⚠
        </span>
      )}
      {showMod && (
        <span style={{ display: "flex", gap: 6, marginLeft: 4 }}>
          <button
            className="btn"
            style={modBtn}
            title="게스트로 전환(카메라 허용)"
            onClick={onToGuest}
          >
            게스트로
          </button>
          <button
            className="btn"
            style={{ ...modBtn, background: "var(--danger)" }}
            onClick={onKick}
          >
            강퇴
          </button>
        </span>
      )}
    </div>
  );
}

function tileKey(ref: TrackReferenceOrPlaceholder) {
  return `${ref.participant.identity}:${ref.source}`;
}

function Controls({
  spotlight,
  onToggle,
}: {
  spotlight: boolean;
  onToggle: () => void;
}) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
      <button className="btn" style={btnSm} onClick={onToggle}>
        {spotlight ? "그리드 보기" : "스포트라이트"}
      </button>
    </div>
  );
}

function Tile({
  trackRef,
  isHost,
  roomId,
  warnNicks,
  big = false,
}: {
  trackRef: TrackReferenceOrPlaceholder;
  isHost: boolean;
  roomId?: string;
  warnNicks?: Set<string>;
  big?: boolean;
}) {
  const participant = trackRef.participant;
  const tileRef = useRef<HTMLDivElement>(null);
  useAudioGlow(tileRef, participant); // 발광 링(리렌더 없이 CSS 변수만 갱신)
  const showMod = isHost && roomId && !participant.isLocal;
  const confirm = useConfirm();
  const toast = useToast();
  const name = displayName(participant);
  const warn = warnNicks?.has(name) ?? false;

  async function onMute() {
    try {
      await apiMute(roomId!, participant.identity);
      toast("success", `${name} 님을 음소거했어요`);
    } catch {
      toast("error", "음소거하지 못했어요");
    }
  }
  async function onToSpeaker() {
    try {
      await apiChangeRole(roomId!, participant.identity, "speaker");
      toast("info", `${name} 님을 음성 참여로 바꿨어요`);
    } catch {
      toast("error", "전환하지 못했어요");
    }
  }
  async function onKick() {
    const ok = await confirm({
      title: `${name} 님을 강퇴할까요?`,
      body: "이 방송에서 내보내요. 다시 요청하면 재입장할 수 있어요.",
      confirmLabel: "강퇴하기",
      danger: true,
    });
    if (!ok) return;
    try {
      await apiKick(roomId!, participant.identity);
      toast("success", `${name} 님을 강퇴했어요`);
    } catch {
      toast("error", "강퇴하지 못했어요");
    }
  }

  return (
    <div
      ref={tileRef}
      data-testid="tile"
      data-nick={participant.name ?? participant.identity}
      className="glow"
      style={{
        position: "relative",
        aspectRatio: big ? "16 / 9" : "16 / 10",
        background: "var(--bg)",
        borderRadius: 10,
        overflow: "hidden",
      }}
    >
      {warn && (
        <div
          title="이 참가자의 오디오 도달을 확인해 주세요"
          style={{
            position: "absolute",
            top: 8,
            left: 8,
            display: "flex",
            alignItems: "center",
            gap: 4,
            background: "color-mix(in srgb, var(--warn) 22%, rgba(0,0,0,0.7))",
            color: "var(--warn)",
            padding: "3px 8px",
            borderRadius: 6,
            fontSize: 11,
            fontWeight: 700,
            zIndex: 3,
          }}
        >
          ⚠ 오디오 확인
        </div>
      )}
      {trackRef.publication ? (
        <VideoTrack
          trackRef={trackRef as never}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            height: "100%",
            fontSize: 32,
            color: "var(--text-muted)",
          }}
        >
          {participant.name?.[0] ?? "?"}
        </div>
      )}

      <div
        style={{
          position: "absolute",
          left: 8,
          bottom: 8,
          right: 8,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span
          style={{
            background: "rgba(0,0,0,0.6)",
            padding: "2px 8px",
            borderRadius: 6,
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          {participant.name || participant.identity.slice(0, 6)}
          {participant.isLocal ? " (나)" : ""}
        </span>
        <AudioStatus participant={participant} />
      </div>

      {showMod && (
        <div style={{ position: "absolute", top: 8, right: 8, display: "flex", gap: 6 }}>
          <button
            className="btn"
            style={modBtn}
            title="음소거 (게스트 본인만 다시 켤 수 있음)"
            onClick={onMute}
          >
            음소거
          </button>
          <button
            className="btn"
            style={{ ...modBtn, background: "var(--brand-strong)", color: "var(--brand-on)" }}
            title="스피커로 전환(카메라 회수, 오디오 유지)"
            onClick={onToSpeaker}
          >
            스피커로
          </button>
          <button
            className="btn"
            style={{ ...modBtn, background: "var(--danger)" }}
            title="강퇴"
            onClick={onKick}
          >
            강퇴
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * 오디오 수신 배지 + 레벨 미터.
 *   - 배지(🔊/🔇): 구독·음소거 상태 — 저빈도 이벤트로만 갱신(볼륨 리렌더 없음).
 *   - 미터: 조상 타일이 rAF 로 써넣는 CSS 변수 --meter 를 폭에 반영 → React 리렌더 0.
 */
function AudioStatus({ participant }: { participant: Participant }) {
  const subscribed = useMicSubscribed(participant);
  return (
    <span
      title={subscribed ? "오디오 수신 중" : "오디오 없음/미구독"}
      style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
    >
      <span style={{ fontSize: 12 }}>{subscribed ? "🔊" : "🔇"}</span>
      <span
        style={{
          width: 40,
          height: 6,
          borderRadius: 3,
          background: "rgba(255,255,255,0.18)",
          overflow: "hidden",
        }}
      >
        <span
          style={{
            display: "block",
            height: "100%",
            width: "calc(var(--meter, 0) * 100%)",
            background: subscribed ? "var(--brand)" : "var(--text-muted)",
            transition: "width 90ms linear",
          }}
        />
      </span>
    </span>
  );
}

const btnSm: React.CSSProperties = { background: "var(--surface-2)", fontSize: 12, padding: "4px 10px" };
const modBtn: React.CSSProperties = { background: "var(--surface-2)", fontSize: 11, padding: "3px 8px" };

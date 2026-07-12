"use client";

import { useState } from "react";
import { useParticipants } from "@livekit/components-react";
import { type Participant } from "livekit-client";
import { HostQueue } from "./HostQueue";
import { RealtimeChat } from "./Chat";
import { Badge } from "./ui";

type Tab = "people" | "queue" | "chat";

/** 참가자 metadata 의 role 파싱. */
function roleOf(p: Participant): string {
  try {
    return (JSON.parse(p.metadata || "{}") as { role?: string }).role ?? "";
  } catch {
    return "";
  }
}

function roleLabel(p: Participant): string {
  if (p.isLocal) return "호스트";
  const r = roleOf(p);
  return r === "speaker" ? "음성 참여" : r === "guest" ? "출연" : "시청";
}

/**
 * 호스트 우측 패널 — 참가자 / 요청 / 채팅 탭.
 * 탭 전환은 display 토글(모든 패널 상시 마운트)로 처리 → 채팅 히스토리·스크롤·
 * 큐 상태가 탭 전환·폴링에도 보존된다(remount 없음). 기본 탭 = 요청.
 * 데스크톱 사이드와 모바일 바텀시트에서 동일 컴포넌트 재사용.
 */
export function HostPanel({
  roomId,
  maxGuests,
  maxSpeakers,
  warnNicks,
}: {
  roomId: string;
  maxGuests: number;
  maxSpeakers: number;
  warnNicks?: Set<string>;
}) {
  const [tab, setTab] = useState<Tab>("queue");
  const [queueCount, setQueueCount] = useState(0);
  const participants = useParticipants();

  return (
    <div
      data-testid="host-panel"
      className="card"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        padding: 0,
        overflow: "hidden",
      }}
    >
      {/* 탭 바 */}
      <div
        role="tablist"
        style={{
          display: "flex",
          borderBottom: "1px solid var(--border)",
          flex: "0 0 auto",
        }}
      >
        <TabButton active={tab === "people"} onClick={() => setTab("people")}>
          참가자 {participants.length}
        </TabButton>
        <TabButton active={tab === "queue"} onClick={() => setTab("queue")}>
          요청
          {queueCount > 0 && (
            <Badge kind="brand" style={{ marginLeft: 6, padding: "1px 7px" }}>
              {queueCount}
            </Badge>
          )}
        </TabButton>
        <TabButton active={tab === "chat"} onClick={() => setTab("chat")}>
          채팅
        </TabButton>
      </div>

      {/* 패널 영역(모두 상시 마운트, display 토글) */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <div
          style={{
            display: tab === "people" ? "block" : "none",
            overflowY: "auto",
            padding: 14,
          }}
        >
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {participants.map((p) => {
              const name = p.name || p.identity.slice(0, 6);
              const warn = warnNicks?.has(name) ?? false;
              return (
                <li
                  key={p.identity}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "8px 0",
                    borderBottom: "1px solid var(--border)",
                    fontSize: 13,
                  }}
                >
                  <span>
                    {name}
                    {p.isLocal ? " (나)" : ""}
                    {warn && (
                      <span title="오디오 확인 필요" style={{ color: "var(--warn)", marginLeft: 6 }}>
                        ⚠
                      </span>
                    )}
                  </span>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {roleLabel(p)}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>

        <div
          style={{
            display: tab === "queue" ? "block" : "none",
            overflowY: "auto",
            padding: 14,
          }}
        >
          <HostQueue
            roomId={roomId}
            maxGuests={maxGuests}
            maxSpeakers={maxSpeakers}
            onCount={setQueueCount}
          />
        </div>

        <div
          style={{
            display: tab === "chat" ? "flex" : "none",
            flex: 1,
            minHeight: 0,
          }}
        >
          <RealtimeChat roomId={roomId} isHost fill />
        </div>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      style={{
        flex: 1,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 2,
        padding: "12px 8px",
        background: active ? "var(--surface-2)" : "transparent",
        color: active ? "var(--text)" : "var(--text-muted)",
        border: "none",
        borderBottom: active ? "2px solid var(--brand)" : "2px solid transparent",
        fontSize: 13,
        fontWeight: 600,
      }}
    >
      {children}
    </button>
  );
}

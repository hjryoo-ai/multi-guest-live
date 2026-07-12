"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useRoomContext } from "@livekit/components-react";
import { RoomEvent } from "livekit-client";
import {
  DATA_TOPICS,
  SIGNAL_EVENTS,
  type ChatMessageDto,
} from "@multi-live/shared";
import {
  apiGetChat,
  apiSendChat,
  apiHideChat,
  apiUnhideChat,
  apiChatBan,
} from "../lib/api";
import { rejectSpoofedSignal } from "../lib/signal";
import { useConfirm, useToast } from "./ui";

/**
 * 채팅 — 서버 경유 단일화 + 운영 도구(Phase 6B).
 *   - RealtimeChat: LiveKitRoom 안. data channel push + CHAT_MODERATED 실시간 반영.
 *   - PollChat: 모드 B(HLS). GET 폴링(messages + hiddenIds 스냅샷)으로 수렴.
 *   host(isHost) 는 메시지 숨김/해제·유저 차단. 숨김은 tombstone(비-host 에겐 흔적 없이 제거).
 *
 * Phase 6.6: 두 레이아웃.
 *   - panel(기본): 카드 · 고정 높이(호스트 탭·데스크톱 사이드).
 *   - fill: 부모 높이를 채움(모바일 시청 스택). 입력바 safe-area · 키보드 대응.
 * 새 메시지 점프 배지(chat-jump) · 전송 실패 재시도(chat-retry) 포함.
 */

function mergeMessages(
  prev: ChatMessageDto[],
  incoming: ChatMessageDto[],
): ChatMessageDto[] {
  if (incoming.length === 0) return prev;
  const byId = new Map(prev.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.id - b.id).slice(-200);
}

function ChatView({
  messages,
  isHost = false,
  banned = false,
  onSend,
  onHide,
  onUnhide,
  onBan,
  title = "채팅",
  fill = false,
}: {
  messages: ChatMessageDto[];
  isHost?: boolean;
  banned?: boolean;
  onSend: (text: string) => Promise<void>;
  onHide?: (m: ChatMessageDto) => void;
  onUnhide?: (m: ChatMessageDto) => void;
  onBan?: (m: ChatMessageDto) => void;
  title?: string;
  fill?: boolean;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showJump, setShowJump] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    atBottomRef.current = true;
    setShowJump(false);
  }, []);

  const onScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    // 바닥 60px 이내면 "따라가는" 상태로 간주.
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    atBottomRef.current = near;
    if (near) setShowJump(false);
  }, []);

  // 새 메시지: 바닥을 보고 있으면 자동 추적, 아니면 점프 배지 노출.
  useEffect(() => {
    if (atBottomRef.current) scrollToBottom();
    else setShowJump(true);
  }, [messages, scrollToBottom]);

  const doSend = useCallback(
    async (t: string) => {
      setBusy(true);
      setError("");
      try {
        await onSend(t);
        setText("");
        setFailed(null);
        scrollToBottom(true);
      } catch (err: any) {
        // 차단(403 chat_banned)은 상위에서 입력창 전환으로 처리 → 재시도 대상 아님.
        const isBan = err?.status === 403 && err?.body?.error === "chat_banned";
        if (!isBan) setFailed(t);
        setError(
          err?.status === 429
            ? "너무 빠릅니다. 잠시 후 다시."
            : isBan
              ? "채팅이 제한되었습니다."
              : "전송하지 못했어요.",
        );
      } finally {
        setBusy(false);
      }
    },
    [onSend, scrollToBottom],
  );

  const submit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      const t = text.trim();
      if (!t || busy) return;
      void doSend(t);
    },
    [text, busy, doSend],
  );

  return (
    <div
      className={fill ? undefined : "card"}
      style={{
        display: "flex",
        flexDirection: "column",
        height: fill ? "100%" : 360,
        minHeight: 0,
        padding: fill ? 12 : 12,
        background: fill ? "var(--surface)" : undefined,
        borderTop: fill ? "1px solid var(--border)" : undefined,
      }}
    >
      <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
        {title}
      </div>
      {/* 리스트 + 점프 배지(상대 배치) */}
      <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex" }}>
        <div
          ref={listRef}
          onScroll={onScroll}
          style={{
            flex: 1,
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          {messages.length === 0 && (
            <div className="muted" style={{ fontSize: 12 }}>
              아직 메시지가 없습니다.
            </div>
          )}
          {messages.map((m) => (
            <div
              key={m.id}
              data-testid="chat-msg"
              data-msg-id={m.id}
              data-hidden={m.hidden ? "1" : "0"}
              style={{
                fontSize: 13,
                lineHeight: 1.4,
                display: "flex",
                gap: 6,
                alignItems: "baseline",
                opacity: m.hidden ? 0.45 : 1,
              }}
            >
              <span style={{ color: "var(--brand-soft)", fontWeight: 600 }}>
                {m.nickname}
              </span>
              <span
                style={{
                  textDecoration: m.hidden ? "line-through" : "none",
                  flex: 1,
                }}
              >
                {m.text}
              </span>
              {isHost && (
                <span style={{ display: "inline-flex", gap: 4 }}>
                  {m.hidden ? (
                    <button className="btn" style={modBtn} onClick={() => onUnhide?.(m)}>
                      해제
                    </button>
                  ) : (
                    <>
                      <button className="btn" style={modBtn} onClick={() => onHide?.(m)}>
                        숨기기
                      </button>
                      <button
                        className="btn"
                        style={{ ...modBtn, background: "var(--danger)" }}
                        title="이 사용자 채팅 차단"
                        onClick={() => onBan?.(m)}
                      >
                        차단
                      </button>
                    </>
                  )}
                </span>
              )}
            </div>
          ))}
        </div>
        {showJump && (
          <button
            type="button"
            data-testid="chat-jump"
            onClick={() => scrollToBottom(true)}
            style={{
              position: "absolute",
              bottom: 8,
              left: "50%",
              transform: "translateX(-50%)",
              background: "var(--brand)",
              color: "var(--brand-on)",
              border: "none",
              borderRadius: "var(--radius-pill)",
              padding: "6px 14px",
              fontSize: 12,
              fontWeight: 700,
              boxShadow: "var(--shadow)",
              animation: "ml-toast-in 160ms var(--ease)",
            }}
          >
            새 메시지 ↓
          </button>
        )}
      </div>
      {error && (
        <div style={{ color: "var(--danger)", fontSize: 12, marginTop: 4 }}>{error}</div>
      )}
      {failed && !banned && (
        <button
          type="button"
          data-testid="chat-retry"
          onClick={() => void doSend(failed)}
          disabled={busy}
          style={{
            alignSelf: "flex-start",
            background: "transparent",
            border: "1px solid var(--danger)",
            color: "var(--danger-soft)",
            borderRadius: "var(--radius-sm)",
            padding: "4px 10px",
            fontSize: 12,
            marginTop: 6,
          }}
        >
          ↻ 다시 보내기
        </button>
      )}
      {banned ? (
        <div
          data-testid="chat-banned"
          style={{
            fontSize: 12,
            color: "var(--danger-soft)",
            marginTop: 8,
            padding: "8px 0",
            paddingBottom: fill ? "max(8px, env(safe-area-inset-bottom))" : undefined,
          }}
        >
          호스트에 의해 채팅이 제한되었습니다.
        </div>
      ) : (
        <form
          onSubmit={submit}
          style={{
            display: "flex",
            gap: 6,
            marginTop: 8,
            paddingBottom: fill ? "max(0px, env(safe-area-inset-bottom))" : undefined,
          }}
        >
          <input
            data-testid="chat-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onFocus={() => scrollToBottom()}
            maxLength={500}
            placeholder="메시지 입력"
            style={{
              flex: 1,
              padding: "8px 10px",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              color: "var(--text)",
            }}
          />
          <button className="btn" disabled={busy || !text.trim()} type="submit">
            전송
          </button>
        </form>
      )}
    </div>
  );
}

/** LiveKitRoom 컨텍스트 안: data channel 실시간 + CHAT_MODERATED 반영. */
export function RealtimeChat({
  roomId,
  isHost = false,
  fill = false,
}: {
  roomId: string;
  isHost?: boolean;
  fill?: boolean;
}) {
  const room = useRoomContext();
  const [messages, setMessages] = useState<ChatMessageDto[]>([]);
  const [banned, setBanned] = useState(false);
  const confirm = useConfirm();
  const toast = useToast();

  // 저빈도 재조정(4초): GET 스냅샷으로 히스토리·숨김상태를 수렴시킨다.
  //   실시간 CHAT_MODERATED 신호는 즉시성을 주고, 이 재조정이 유실(subscribe-only viewer
  //   의 데이터채널 지연 등) 대비 수렴을 보장한다. host 는 hidden 플래그 포함으로 받는다.
  const reconcile = useCallback(async () => {
    try {
      const r = await apiGetChat(roomId);
      setMessages((prev) => {
        let next = mergeMessages(prev, r.messages);
        if (!isHost && r.hiddenIds.length) {
          next = next.filter((m) => !r.hiddenIds.includes(m.id));
        }
        return next;
      });
    } catch {
      /* 다음 주기 복구 */
    }
  }, [roomId, isHost]);

  useEffect(() => {
    void reconcile();
    const t = setInterval(reconcile, 4000);
    return () => clearInterval(t);
  }, [reconcile]);

  // 실시간 즉시 반영. host 는 hidden 플래그 토글, 비-host 는 제거/복원.
  const applyModeration = useCallback(
    (hiddenIds: number[], unhiddenIds: number[]) => {
      setMessages((prev) => {
        let next = prev;
        if (hiddenIds.length) {
          next = isHost
            ? next.map((m) => (hiddenIds.includes(m.id) ? { ...m, hidden: true } : m))
            : next.filter((m) => !hiddenIds.includes(m.id));
        }
        if (unhiddenIds.length && isHost) {
          next = next.map((m) =>
            unhiddenIds.includes(m.id) ? { ...m, hidden: false } : m,
          );
        }
        return next;
      });
      // 비-host 의 해제 복원은 다음 재조정(GET)이 자연 수행한다.
    },
    [isHost],
  );

  useEffect(() => {
    if (!room) return;
    const onData = (
      payload: Uint8Array,
      participant: Parameters<typeof rejectSpoofedSignal>[0],
      _k: unknown,
      topic?: string,
    ) => {
      // A-1: 채팅 push·모더레이션 신호 모두 서버 발신 → 참가자 위조 차단.
      if (
        (topic === DATA_TOPICS.chat || topic === DATA_TOPICS.signal) &&
        rejectSpoofedSignal(participant, topic)
      )
        return;
      try {
        const parsed = JSON.parse(new TextDecoder().decode(payload));
        if (topic === DATA_TOPICS.chat && parsed?.type === "CHAT" && parsed.message) {
          setMessages((prev) => mergeMessages(prev, [parsed.message]));
        } else if (
          topic === DATA_TOPICS.signal &&
          parsed?.event === SIGNAL_EVENTS.CHAT_MODERATED
        ) {
          applyModeration(
            parsed.payload?.hiddenIds ?? [],
            parsed.payload?.unhiddenIds ?? [],
          );
        }
      } catch {
        /* 무시 */
      }
    };
    room.on(RoomEvent.DataReceived, onData);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
    };
  }, [room, applyModeration]);

  const onSend = useCallback(
    async (text: string) => {
      try {
        // sendData 브로드캐스트는 발신자 제외 → 응답 메시지를 낙관적으로 반영.
        const msg = await apiSendChat(roomId, text);
        setMessages((prev) => mergeMessages(prev, [msg]));
      } catch (err: any) {
        if (err?.status === 403 && err?.body?.error === "chat_banned") {
          setBanned(true);
        }
        throw err;
      }
    },
    [roomId],
  );

  const onHide = useCallback(
    (m: ChatMessageDto) => void apiHideChat(roomId, m.id).catch(() => {}),
    [roomId],
  );
  const onUnhide = useCallback(
    (m: ChatMessageDto) => void apiUnhideChat(roomId, m.id).catch(() => {}),
    [roomId],
  );
  const onBan = useCallback(
    async (m: ChatMessageDto) => {
      const ok = await confirm({
        title: `${m.nickname} 님의 채팅을 차단할까요?`,
        body: "이 사용자는 이 방송에서 더 이상 채팅을 보낼 수 없어요. 언제든 해제할 수 있어요.",
        confirmLabel: "차단하기",
        danger: true,
      });
      if (!ok) return;
      try {
        await apiChatBan(roomId, m.userId);
        toast("success", `${m.nickname} 님의 채팅을 차단했어요`);
      } catch {
        toast("error", "차단하지 못했어요");
      }
    },
    [roomId, confirm, toast],
  );

  return (
    <ChatView
      messages={messages}
      isHost={isHost}
      banned={banned}
      onSend={onSend}
      onHide={onHide}
      onUnhide={onUnhide}
      onBan={onBan}
      fill={fill}
    />
  );
}

/** 모드 B(HLS) 시청자: GET 폴링(messages + hiddenIds 스냅샷)으로 수렴. */
export function PollChat({ roomId, fill = false }: { roomId: string; fill?: boolean }) {
  const [messages, setMessages] = useState<ChatMessageDto[]>([]);
  const [banned, setBanned] = useState(false);
  const cursorRef = useRef<number | undefined>(undefined);

  const poll = useCallback(async () => {
    try {
      const r = await apiGetChat(roomId, cursorRef.current);
      cursorRef.current = r.cursor;
      setMessages((prev) => {
        let next = mergeMessages(prev, r.messages);
        // hiddenIds 스냅샷 ∩ 보유 목록 제거(멱등 수렴).
        if (r.hiddenIds.length) next = next.filter((m) => !r.hiddenIds.includes(m.id));
        return next;
      });
    } catch {
      /* 다음 주기 복구 */
    }
  }, [roomId]);

  useEffect(() => {
    void poll();
    const t = setInterval(poll, 3000);
    return () => clearInterval(t);
  }, [poll]);

  const onSend = useCallback(
    async (text: string) => {
      try {
        const msg = await apiSendChat(roomId, text);
        setMessages((prev) => mergeMessages(prev, [msg]));
      } catch (err: any) {
        if (err?.status === 403 && err?.body?.error === "chat_banned") setBanned(true);
        throw err;
      }
    },
    [roomId],
  );

  return <ChatView messages={messages} banned={banned} onSend={onSend} fill={fill} />;
}

const modBtn: React.CSSProperties = {
  background: "var(--surface-2)",
  fontSize: 10,
  padding: "1px 6px",
};

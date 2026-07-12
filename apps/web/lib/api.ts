"use client";

import { API_URL } from "./env";
import type {
  RoomDto,
  RoomDetailDto,
  TokenResponse,
  InviteResponse,
  JoinRequestDto,
  ChatMessageDto,
  ChatListDto,
  ViewerCountDto,
  HlsInfoDto,
} from "@multi-live/shared";

const SESSION_KEY = "multilive.session";

export interface Session {
  userId: string;
  nickname: string;
  token: string;
}

export function getSession(): Session | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(SESSION_KEY);
  return raw ? (JSON.parse(raw) as Session) : null;
}

function setSession(s: Session) {
  window.localStorage.setItem(SESSION_KEY, JSON.stringify(s));
}

/** 세션이 없으면 닉네임으로 새로 발급. 있으면 재사용. */
export async function ensureSession(nickname: string): Promise<Session> {
  const existing = getSession();
  if (existing) return existing;
  const res = await fetch(`${API_URL}/auth/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nickname }),
  });
  if (!res.ok) throw new Error(`session failed: ${res.status}`);
  const data = (await res.json()) as Session;
  setSession(data);
  return data;
}

function authHeaders(): Record<string, string> {
  const s = getSession();
  return s ? { authorization: `Bearer ${s.token}` } : {};
}

async function req<T>(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...authHeaders(),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw Object.assign(new Error(`${path} → ${res.status}`), {
      status: res.status,
      body: err,
    });
  }
  return (await res.json()) as T;
}

export const apiCreateRoom = (body: {
  title: string;
  maxGuests?: number;
  viewerMode?: "webrtc" | "hls";
}) => req<RoomDto>("/rooms", { method: "POST", body });

export const apiGetRoom = (roomId: string) =>
  req<RoomDetailDto>(`/rooms/${roomId}`);

export const apiIssueToken = (roomId: string, role?: string) =>
  req<TokenResponse>(`/rooms/${roomId}/token`, {
    method: "POST",
    body: role ? { role } : {},
  });

export const apiCreateInvite = (roomId: string) =>
  req<InviteResponse>(`/rooms/${roomId}/invite`, { method: "POST" });

export const apiRequestJoin = (roomId: string, code: string) =>
  req<{ state: string }>(`/rooms/${roomId}/join-requests`, {
    method: "POST",
    body: { code },
  });

export const apiListJoinRequests = (roomId: string) =>
  req<{ requests: JoinRequestDto[] }>(`/rooms/${roomId}/join-requests`);

export const apiApprove = (
  roomId: string,
  userId: string,
  role: "guest" | "speaker" = "guest",
) =>
  req<{ state: string; role: string }>(
    `/rooms/${roomId}/guests/${userId}/approve`,
    { method: "POST", body: { role } },
  );

export const apiChangeRole = (
  roomId: string,
  userId: string,
  role: "guest" | "speaker",
) =>
  req<{ role: string; from?: string }>(
    `/rooms/${roomId}/participants/${userId}/role`,
    { method: "POST", body: { role } },
  );

export const apiReject = (roomId: string, userId: string) =>
  req<{ state: string }>(`/rooms/${roomId}/guests/${userId}/reject`, {
    method: "POST",
  });

export const apiAudioReport = (roomId: string, subscribedAudioTrackSids: string[]) =>
  req<{ ok: boolean; missingTrackSids: string[] }>(
    `/rooms/${roomId}/audio-report`,
    { method: "POST", body: { subscribedAudioTrackSids } },
  );

export const apiMute = (roomId: string, userId: string) =>
  req<{ muted: number }>(`/rooms/${roomId}/guests/${userId}/mute`, {
    method: "POST",
  });

export const apiKick = (roomId: string, userId: string) =>
  req<{ state: string }>(`/rooms/${roomId}/guests/${userId}/kick`, {
    method: "POST",
  });

export const apiGetAlerts = (roomId: string) =>
  req<{ alerts: import("@multi-live/shared").AudioAlertDto[] }>(
    `/rooms/${roomId}/alerts`,
  );

export const apiEndRoom = (roomId: string) =>
  req<{ status: string }>(`/rooms/${roomId}/end`, { method: "POST" });

// ── Phase 4: 채팅 · 시청자 수 · HLS ────────────────────────────
export const apiSendChat = (roomId: string, text: string) =>
  req<ChatMessageDto>(`/rooms/${roomId}/chat`, {
    method: "POST",
    body: { text },
  });

export const apiGetChat = (roomId: string, after?: number) =>
  req<ChatListDto>(
    `/rooms/${roomId}/chat${after !== undefined ? `?after=${after}` : ""}`,
  );

export const apiHideChat = (roomId: string, messageId: number) =>
  req<{ messageId: number; hidden: boolean }>(
    `/rooms/${roomId}/chat/${messageId}/hide`,
    { method: "POST" },
  );
export const apiUnhideChat = (roomId: string, messageId: number) =>
  req<{ messageId: number; hidden: boolean }>(
    `/rooms/${roomId}/chat/${messageId}/unhide`,
    { method: "POST" },
  );
export const apiChatBan = (roomId: string, userId: string) =>
  req<{ userId: string; chatBanned: boolean }>(
    `/rooms/${roomId}/chat-bans/${userId}`,
    { method: "POST" },
  );
export const apiChatUnban = (roomId: string, userId: string) =>
  req<{ userId: string; chatBanned: boolean }>(
    `/rooms/${roomId}/chat-bans/${userId}`,
    { method: "DELETE" },
  );

export const apiGetViewerCount = (roomId: string) =>
  req<ViewerCountDto>(`/rooms/${roomId}/viewer-count`);

export const apiGetHls = (roomId: string) =>
  req<HlsInfoDto>(`/rooms/${roomId}/hls`);

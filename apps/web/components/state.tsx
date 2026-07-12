"use client";

import type { ReactNode } from "react";
import { Button, Skeleton, SkeletonChat } from "./ui";

/* ────────────────────────────────────────────────────────────
 * Phase 6.6 공통 상태 셸 — loading / error / ended / 권한거부 / 빈상태.
 * 카피 원칙: 시스템 용어 금지, 원인 + 다음 행동. 파괴는 시스템 잘못 아님을 전제.
 * ──────────────────────────────────────────────────────────── */

/** 가운데 정렬 상태 카드(아이콘 + 제목 + 설명 + 액션). */
export function CenteredState({
  testid,
  icon,
  title,
  body,
  action,
  tone = "neutral",
}: {
  testid?: string;
  icon?: ReactNode;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  tone?: "neutral" | "danger" | "brand";
}) {
  const accent =
    tone === "danger"
      ? "var(--danger)"
      : tone === "brand"
        ? "var(--brand)"
        : "var(--text-muted)";
  return (
    <div
      data-testid={testid}
      style={{
        minHeight: "60vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div
        className="card"
        style={{ textAlign: "center", maxWidth: 420, width: "100%" }}
      >
        {icon && (
          <div style={{ fontSize: 40, marginBottom: 12, color: accent }}>
            {icon}
          </div>
        )}
        <h2 style={{ margin: "0 0 8px", fontSize: 20 }}>{title}</h2>
        {body && (
          <p
            className="muted"
            style={{ fontSize: 14, lineHeight: 1.6, margin: "0 0 16px" }}
          >
            {body}
          </p>
        )}
        {action}
      </div>
    </div>
  );
}

/** 로딩 스켈레톤 — 시청자(영상+채팅). */
export function LoadingViewer() {
  return (
    <div data-testid="state-loading" style={{ padding: 16 }}>
      <Skeleton w="100%" h="auto" style={{ aspectRatio: "16 / 9", marginBottom: 16 }} />
      <SkeletonChat lines={3} />
    </div>
  );
}

/** 로딩 스켈레톤 — host 대시보드(그리드 자리). */
export function LoadingStage() {
  return (
    <div
      data-testid="state-loading"
      style={{
        display: "grid",
        gap: 12,
        gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        padding: 16,
      }}
    >
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} w="100%" h="auto" style={{ aspectRatio: "16 / 10" }} />
      ))}
    </div>
  );
}

/** 에러 상태 — 원인 + 재시도. */
export function ErrorState({
  message,
  onRetry,
}: {
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <CenteredState
      testid="state-error"
      tone="danger"
      icon="⚠"
      title="문제가 생겼어요"
      body={message ?? "연결이 원활하지 않아요. 잠시 후 다시 시도해 주세요."}
      action={
        onRetry && (
          <Button variant="primary" size="sm" onClick={onRetry}>
            다시 시도
          </Button>
        )
      }
    />
  );
}

/** 방송 종료 화면. */
export function EndedState({ onLeave }: { onLeave?: () => void }) {
  return (
    <CenteredState
      testid="state-ended"
      icon="🎬"
      title="방송이 끝났어요"
      body="오늘도 함께해 주셔서 고마워요. 다음 라이브에서 만나요."
      action={
        <Button variant="secondary" size="sm" onClick={onLeave ?? (() => history.back())}>
          나가기
        </Button>
      }
    />
  );
}

/** 강퇴 안내(비-비난 카피 + 재요청 경로). kicked 는 재승인 필수 정책 그대로. */
export function RemovedState({ onRerequest }: { onRerequest?: () => void }) {
  return (
    <CenteredState
      testid="state-removed"
      icon="👋"
      title="무대에서 내려왔어요"
      body="호스트가 이 방송에서 내보냈어요. 문제가 있었던 건 아니에요 — 원하면 다시 참여를 요청할 수 있어요."
      action={
        <Button
          variant="primary"
          size="sm"
          onClick={onRerequest ?? (() => location.reload())}
        >
          다시 참여 요청
        </Button>
      }
    />
  );
}

/** 브라우저 장치 권한 거부 안내(원인 + 다음 행동). */
export function PermissionDenied({ onRetry }: { onRetry?: () => void }) {
  return (
    <CenteredState
      testid="state-permission"
      tone="danger"
      icon="🎤"
      title="카메라·마이크를 사용할 수 없어요"
      body="브라우저 주소창의 자물쇠(또는 카메라) 아이콘에서 이 사이트의 카메라·마이크를 '허용'으로 바꾼 뒤 다시 시도해 주세요. 카메라 없이 오디오만으로도 참여할 수 있어요."
      action={
        onRetry && (
          <Button variant="primary" size="sm" onClick={onRetry}>
            다시 시도
          </Button>
        )
      }
    />
  );
}

/** 빈 상태(행동 유도). */
export function EmptyState({ title, body }: { title: string; body?: string }) {
  return (
    <div className="muted" style={{ textAlign: "center", padding: "24px 12px", fontSize: 13 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{title}</div>
      {body && <div style={{ fontSize: 12 }}>{body}</div>}
    </div>
  );
}

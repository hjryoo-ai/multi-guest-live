import { DEMO_MODE, DEMO_LIFETIME_MIN } from "../lib/env";

export default function HomePage() {
  return (
    <main className="container">
      <h1>Multi-Live</h1>
      <p className="muted">
        멀티 게스트 라이브 스트리밍 시스템 — 호스트 1명 + 게스트 최대 8명 +
        시청자.
      </p>

      {/* 데모 배너 — NEXT_PUBLIC_DEMO_MODE 표시 플래그로만 노출(표시 전용, 서버 가드와 무관). */}
      {DEMO_MODE && (
        <div className="demo-banner">
          <strong>바로 체험해보기</strong>
          <p className="muted" style={{ margin: "6px 0 0" }}>
            버튼 하나로 데모 방송을 시작하고, QR 로 게스트·시청자를 초대해보세요.
          </p>
          <a className="btn" href="/broadcast?demo=1" data-testid="demo-start">
            데모 시작
          </a>
          {/* 고지 수치는 서버 MAX_ROOM_LIFETIME_MIN 과 함께 설정한 값을 반영(하드코딩 아님). */}
          <p className="muted demo-notice">
            데모 방은 최대 {DEMO_LIFETIME_MIN}분 후 자동 종료되고, 데이터는 주기적으로
            삭제됩니다.
          </p>
        </div>
      )}

      <div className="card" style={{ marginTop: 24 }}>
        <h2 style={{ marginTop: 0 }}>진입점</h2>
        <ul>
          <li>
            <a href="/broadcast">방송 시작 (host)</a>
          </li>
          <li>
            <span className="muted">
              게스트: <code>/join/&lt;roomId&gt;</code>
            </span>
          </li>
          <li>
            <span className="muted">
              시청자: <code>/watch/&lt;roomId&gt;</code>
            </span>
          </li>
        </ul>
      </div>
    </main>
  );
}

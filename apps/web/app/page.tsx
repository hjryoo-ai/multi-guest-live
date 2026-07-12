export default function HomePage() {
  return (
    <main className="container">
      <h1>Multi-Live</h1>
      <p className="muted">
        멀티 게스트 라이브 스트리밍 시스템 — 호스트 1명 + 게스트 최대 8명 +
        시청자.
      </p>

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
        <p className="muted" style={{ fontSize: 13 }}>
          Phase 0 골격입니다. 방 생성/토큰/방송 화면은 이후 Phase에서 채워집니다.
        </p>
      </div>
    </main>
  );
}

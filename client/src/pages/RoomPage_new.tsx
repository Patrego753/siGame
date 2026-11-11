import type { GameState } from "@shared/gameTypes";

function SpectatorConnectCard({
  connect,
}: {
  connect: GameState["spectatorConnect"] | undefined;
}) {
  const password = connect?.wifiPassword?.trim() ?? "";
  const url = connect?.joinUrl?.trim() ?? "";
  const fallbackOrigin = typeof window !== "undefined" ? window.location.origin : "";
  return (
    <div className="spec-connect-card spec-connect-full">
      <div className="spec-connect-content">
        <h2 className="spec-connect-title">Как войти</h2>
        <p className="spec-connect-desc">
          Откройте ссылку на сайт и введите пароль комнаты, который сообщил ведущий.
        </p>
        <div className="spec-connect-grid">
          <div className="spec-connect-item">
            <div className="spec-connect-label">Пароль комнаты</div>
            <div className="spec-connect-value mono">{password || "—"}</div>
          </div>
          <div className="spec-connect-item">
            <div className="spec-connect-label">Ссылка на сайт</div>
            <div className="spec-connect-value spec-connect-url-large">
              {url || fallbackOrigin || "—"}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

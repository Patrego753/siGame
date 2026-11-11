import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Role } from "@shared/gameTypes";
import { writePlayGate, type PlayGate } from "../playGate";

const LS_NICK = "si_nick";
const LS_ROLE = "si_role";

function readStoredRole(): Role | null {
  const raw = localStorage.getItem(LS_ROLE);
  return raw === "host" || raw === "player" || raw === "spectator" ? raw : null;
}

export function HomePage() {
  const nav = useNavigate();
  const [role, setRole] = useState<Role | null>(readStoredRole);
  const [nick, setNick] = useState(() => localStorage.getItem(LS_NICK) ?? "");
  const [roomCode, setRoomCode] = useState("");
  const [formErr, setFormErr] = useState<string | null>(null);

  const title = useMemo(() => {
    if (role === "host") return "Ведущий";
    if (role === "player") return "Игрок";
    if (role === "spectator") return "Зритель (экран)";
    return "Выберите роль";
  }, [role]);

  function goPlay() {
    if (!role) {
      setFormErr("Сначала выберите роль");
      return;
    }
    const trimmedNick = nick.trim();
    const trimmedRoomCode = roomCode.trim().toUpperCase();
    if (!/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/.test(trimmedRoomCode)) {
      setFormErr("Введите пароль комнаты из 4 символов");
      return;
    }
    if (role === "player" && trimmedNick.length === 0) {
      setFormErr("Игроку нужен ник");
      return;
    }
    setFormErr(null);
    localStorage.setItem(LS_ROLE, role);
    if (trimmedNick) localStorage.setItem(LS_NICK, trimmedNick);
    else localStorage.removeItem(LS_NICK);
    const gate: PlayGate = {
      role,
      nickname: role === "player" ? trimmedNick : undefined,
      roomCode: trimmedRoomCode,
    };
    writePlayGate(gate);
    const qs = new URLSearchParams();
    qs.set("role", gate.role);
    if (gate.role === "player" && gate.nickname) qs.set("nick", gate.nickname);
    if (gate.roomCode) qs.set("room", gate.roomCode);
    const search = qs.toString() ? `?${qs.toString()}` : "";
    nav({ pathname: "/play", search }, { state: gate });
  }

  return (
    <div className="layout">
      <header>
        <h1 className="h1">SIGame — веб-стол</h1>
        <p className="sub">
          Локальная игра в одной сети: откройте пак <span className="mono">.siq</span>, ведущий
          ведёт с одного устройства, игроки и зрительский экран — с других (Wi‑Fi той же
          точки или ваш IP в LAN).
        </p>
      </header>

      <div className="card" style={{ marginBottom: "1rem" }}>
        <div style={{ fontWeight: 700, marginBottom: "0.75rem" }}>{title}</div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
            gap: "0.6rem",
          }}
        >
          {(
            [
              ["host", "Ведущий"],
              ["player", "Игрок"],
              ["spectator", "Зритель"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              className={`btn ${role === k ? "btn-gold" : ""}`}
              onClick={() => {
                setRole(k);
                setFormErr(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {formErr && <p className="form-error">{formErr}</p>}
      </div>

      {role === "host" && (
        <div className="card" style={{ marginBottom: "1rem" }}>
          <div className="field" style={{ marginBottom: "0.85rem" }}>
            <label htmlFor="host-room-code">Пароль комнаты</label>
            <input
              id="host-room-code"
              className="input mono"
              maxLength={4}
              minLength={4}
              placeholder="Например, 7KQ2"
              value={roomCode}
              onChange={(e) => {
                setRoomCode(e.target.value.toUpperCase().replace(/[^23456789ABCDEFGHJKLMNPQRSTUVWXYZ]/g, "").slice(0, 4));
                setFormErr(null);
              }}
              autoComplete="off"
              spellCheck={false}
            />
            <p className="sub" style={{ fontSize: "0.82rem", margin: "0.45rem 0 0" }}>
              Введите код, который сообщите игрокам. Комната создастся на сервере после вашего входа.
            </p>
          </div>
          <button type="button" className="btn btn-primary" onClick={goPlay}>
            Создать комнату и войти
          </button>
        </div>
      )}

      {(role === "player" || role === "spectator") && (
        <div className="card">
          <div className="field" style={{ marginBottom: "0.85rem" }}>
            <label htmlFor="room-code">Пароль комнаты</label>
            <input
              id="room-code"
              className="input mono"
              maxLength={4}
              minLength={4}
              placeholder="Например, 7KQ2"
              value={roomCode}
              onChange={(e) => {
                setRoomCode(e.target.value.toUpperCase().replace(/[^23456789ABCDEFGHJKLMNPQRSTUVWXYZ]/g, "").slice(0, 4));
                setFormErr(null);
              }}
              autoComplete="off"
              spellCheck={false}
            />
            <p className="sub" style={{ fontSize: "0.82rem", margin: "0.45rem 0 0" }}>
              Пароль сообщит ведущий вместе со ссылкой на сайт.
            </p>
          </div>
          {role === "player" && (
            <div className="field" style={{ marginBottom: "0.85rem" }}>
              <label htmlFor="nick">Ник игрока</label>
              <input
                id="nick"
                className="input"
                maxLength={32}
                placeholder="Например, Команда А"
                value={nick}
                onChange={(e) => {
                  setNick(e.target.value);
                  setFormErr(null);
                }}
              />
              <p className="sub" style={{ fontSize: "0.82rem", margin: "0.45rem 0 0" }}>
                Очки сохраняются при обновлении страницы на этом устройстве (тот же браузер).
              </p>
            </div>
          )}
          <button type="button" className="btn btn-primary" onClick={goPlay}>
            {role === "player" ? "Войти как игрок" : "Войти как зритель"}
          </button>
        </div>
      )}

      <p className="sub" style={{ fontSize: "0.85rem", marginTop: "1.5rem" }}>
        Формат паков — SIQ v5 (
        <a href="https://github.com/VladimirKhil/SI/wiki/SIQ-file-format-version-5">
          спецификация
        </a>
        ). Запуск: <span className="mono">npm run dev</span> — API на 5174, интерфейс на
        5173.
      </p>
    </div>
  );
}

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type RefObject,
} from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import type {
  BoardRound,
  BuzzEntry,
  ContentItem,
  GameState,
  PlayerState,
  Role,
} from "@shared/gameTypes";
import {
  clearPlayGate,
  normalizePlayGate,
  parsePlayGateFromSearchParams,
  readStoredPlayGate,
  writePlayGate,
  type PlayGate,
} from "../playGate";
import { getOrCreatePlayerKey } from "../playerIdentity";
import { ContentStage } from "../components/ContentStage";
import { useGameSocket } from "../useGameSocket";

const LS_SOUND = "si_sound";
const LS_HOST_TAB = "si-host-tab";

/** Убираем дубль текстовой реплики снизу, если она уже в шапке зрителя. */
function filterTvItemsForStage(
  items: (ContentItem & { mediaUrl?: string })[],
  replicLines?: string[],
): (ContentItem & { mediaUrl?: string })[] {
  if (!replicLines?.length) return items;
  return items.filter((it) => {
    const pl = (it.placement || "screen").toLowerCase();
    if (pl !== "replic") return true;
    const t = (it.type || "text").toLowerCase();
    return t !== "text" && t !== "oral";
  });
}

function playBuzz() {
  if (localStorage.getItem(LS_SOUND) === "0") return;
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.value = 880;
    o.connect(g);
    g.connect(ctx.destination);
    g.gain.value = 0.08;
    o.start();
    setTimeout(() => {
      o.stop();
      void ctx.close();
    }, 120);
  } catch {
    /* ignore */
  }
}

export function RoomPage() {
  const loc = useLocation();
  const nav = useNavigate();
  const [urlSearch] = useSearchParams();
  const searchKey = urlSearch.toString();

  const gate = useMemo((): PlayGate | null => {
    const fromState = normalizePlayGate(loc.state);
    if (fromState) return fromState;
    const fromUrl = parsePlayGateFromSearchParams(new URLSearchParams(searchKey));
    if (fromUrl) return fromUrl;
    return readStoredPlayGate();
  }, [loc.state, searchKey]);

  useEffect(() => {
    const fromState = normalizePlayGate(loc.state);
    if (fromState) {
      writePlayGate(fromState);
      return;
    }
    const fromUrl = parsePlayGateFromSearchParams(new URLSearchParams(searchKey));
    if (fromUrl) writePlayGate(fromUrl);
  }, [loc.state, searchKey]);

  const role = gate?.role;
  const nickname = gate?.nickname;
  const [roomCode, setRoomCode] = useState(() => gate?.roomCode ?? "");

  const {
    connected,
    socketErr,
    clearSocketErr,
    state,
    you,
    question,
    answerOverlay,
    notice,
    clearNotice,
    registerJoinOnConnect,
    join,
    emit,
  } = useGameSocket();

  const [joinErr, setJoinErr] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const [soundOn, setSoundOn] = useState(() => localStorage.getItem(LS_SOUND) !== "0");
  const fileRef = useRef<HTMLInputElement>(null);
  const buzzLock = useRef(false);

  const attemptJoin = useCallback(async () => {
    if (!role) return;
    setJoining(true);
    setJoinErr(null);
    try {
      const r = await join({
        roomCode: roomCode || undefined,
        role,
        createRoom: role === "host" && !roomCode,
        nickname: role === "player" ? nickname : undefined,
        playerKey: role === "player" ? getOrCreatePlayerKey() : undefined,
      });
      if (r.ok) {
        const joinedCode = r.code ?? roomCode;
        if (joinedCode) {
          setRoomCode(joinedCode);
          writePlayGate({ ...gate, roomCode: joinedCode });
          const nextUrl = new URL(window.location.href);
          nextUrl.searchParams.set("room", joinedCode);
          window.history.replaceState(null, "", nextUrl.toString());
        }
        setJoinErr(null);
      }
      else setJoinErr(r.error ?? "Ошибка входа");
    } catch (e) {
      setJoinErr(e instanceof Error ? e.message : "Ошибка входа");
    } finally {
      setJoining(false);
    }
  }, [gate, join, nickname, role, roomCode]);

  useEffect(() => {
    if (!role) {
      clearPlayGate();
      nav("/", { replace: true });
      return;
    }
    let alive = true;
    registerJoinOnConnect(() => {
      void (async () => {
        await attemptJoin();
        if (!alive) return;
      })();
    });
    return () => {
      alive = false;
      registerJoinOnConnect(null);
    };
  }, [attemptJoin, nav, registerJoinOnConnect, role]);

  useEffect(() => {
    localStorage.setItem(LS_SOUND, soundOn ? "1" : "0");
  }, [soundOn]);

  useEffect(() => {
    if (role !== "host" || !you?.isHost) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [role, you?.isHost]);

  const onUpload = async (f: File) => {
    setUploadErr(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("pack", f);
      const id = you?.id;
      if (!id) throw new Error("Сокет ещё не готов");
      const res = await fetch(`/api/room/${roomCode}/upload`, {
        method: "POST",
        headers: { "x-host-socket": id },
        body: fd,
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? "Ошибка загрузки");
    } catch (e) {
      setUploadErr(e instanceof Error ? e.message : "Ошибка");
    } finally {
      setUploading(false);
    }
  };

  const buzz = useCallback((canSend = true, withFeedback = true) => {
    if (!canSend) return;
    if (buzzLock.current) return;
    buzzLock.current = true;
    emit("player:buzz");
    if (withFeedback) {
      playBuzz();
      if (navigator.vibrate) navigator.vibrate(40);
    }
    setTimeout(() => {
      buzzLock.current = false;
    }, 450);
  }, [emit]);

  const board: BoardRound | undefined = state?.pack?.rounds[state.roundIndex];
  const maxQuestions = useMemo(() => {
    if (!board?.themes.length) return 0;
    return Math.max(...board.themes.map((t) => t.questions.length));
  }, [board]);

  if (!role) return null;

  return (
    <div
      className={`layout room-layout${role === "spectator" ? " room-layout--spectator" : ""}${role === "player" ? " room-layout--player" : ""}`}
    >
      <div className="room-top">
        <Link
          to="/"
          className="btn btn-ghost"
          style={{ padding: "0.4rem 0.65rem" }}
          onClick={() => clearPlayGate()}
        >
          ← На главную
        </Link>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
          <span className={`pill ${connected ? "pill-ok" : "pill-off"}`}>
            {connected ? "онлайн" : "нет связи"}
          </span>
          <span className="pill">локальная игра</span>
          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.35rem",
              fontSize: "0.85rem",
              color: "var(--muted)",
            }}
          >
            <input
              type="checkbox"
              checked={soundOn}
              onChange={(e) => setSoundOn(e.target.checked)}
            />
            Звук буззера
          </label>
        </div>
      </div>

      {(joinErr || socketErr) && (
        <div className="card" style={{ borderColor: "#5a3030", marginBottom: "1rem" }}>
          {joinErr && <p style={{ margin: 0 }}>{joinErr}</p>}
          {socketErr && (
            <p style={{ margin: joinErr ? "0.5rem 0 0" : 0 }}>
              Связь: {socketErr}
            </p>
          )}
          <div style={{ marginTop: "0.65rem" }}>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                clearSocketErr();
                setJoinErr(null);
              }}
            >
              Скрыть
            </button>
            {connected && !you && (
              <button
                type="button"
                className="btn btn-primary"
                style={{ marginLeft: "0.5rem" }}
                onClick={() => void attemptJoin()}
                disabled={joining}
              >
                {joining ? "Повтор входа…" : "Повторить вход"}
              </button>
            )}
          </div>
        </div>
      )}
      {notice && (
        <div className="card" style={{ borderColor: "#5a3030", marginBottom: "1rem" }}>
          {notice}
          <div style={{ marginTop: "0.5rem" }}>
            <button type="button" className="btn btn-ghost" onClick={clearNotice}>
              Понятно
            </button>
          </div>
        </div>
      )}

      {role === "host" &&
        connected &&
        !you &&
        !(joinErr || socketErr) && (
          <div className="card" style={{ marginBottom: "1rem" }}>
            Подключение к комнате…
          </div>
        )}

      {role === "host" && you?.isHost && (
        <HostPanel
          state={state}
          roomCode={roomCode}
          you={you}
          uploading={uploading}
          uploadErr={uploadErr}
          fileRef={fileRef}
          onPickFile={() => fileRef.current?.click()}
          onFile={(e) => {
            const f = e.target.files?.[0];
            if (f) void onUpload(f);
            e.target.value = "";
          }}
          emit={emit}
          question={question}
          answerOverlay={answerOverlay}
          board={board}
          maxQuestions={maxQuestions}
        />
      )}

      {role === "host" && you && !you.isHost && (
        <div className="card">В этой комнате уже есть ведущий.</div>
      )}

      {role === "player" && (
        <PlayerPanel state={state} you={you} question={question} buzz={buzz} />
      )}

      {role === "spectator" && (
        <SpectatorPanel
          connected={connected}
          state={state}
          board={board}
          maxQuestions={maxQuestions}
          question={question}
          answerOverlay={answerOverlay}
        />
      )}
    </div>
  );
}

function BuzzQueue({
  buzzes,
  title,
  youId,
}: {
  buzzes: BuzzEntry[];
  title?: string;
  youId?: string;
}) {
  if (buzzes.length === 0) return null;
  return (
    <div className="buzz-queue-wrap">
      {title && <div className="answer-label">{title}</div>}
      <ol className="buzz-queue">
        {buzzes.map((b, idx) => (
          <li
            key={b.playerId}
            className={idx === 0 ? "buzz-queue-first" : ""}
          >
            <span className="buzz-ord">{idx + 1}</span>
            <span className="buzz-name">{b.playerName}</span>
            {youId === b.playerId && <span className="buzz-you">вы</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}

function HostTvVolumeControls({
  state,
  emit,
}: {
  state: ReturnType<typeof useGameSocket>["state"];
  emit: (ev: string, ...args: unknown[]) => void;
}) {
  const master = state?.spectatorVolume?.master ?? 0.85;
  return (
    <div className="spec-volume-row">
      <label>
        Громкость на ТВ
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(master * 100)}
          onChange={(e) =>
            emit("host:setSpectatorVolume", { master: Number(e.target.value) / 100 })
          }
        />
        <span className="mono">{Math.round(master * 100)}%</span>
      </label>
    </div>
  );
}

function HostLiveQuestionBlock({
  question,
  answerOverlay,
}: {
  question: ReturnType<typeof useGameSocket>["question"];
  answerOverlay: ReturnType<typeof useGameSocket>["answerOverlay"];
}) {
  if (question?.view !== "host") return null;
  const qLines = question.questionLines ?? [];
  const aLines = question.answerLines ?? [];
  const rightAns = question.rightTextAnswers ?? [];
  const overlayLines =
    answerOverlay?.view === "host" ? (answerOverlay.answerLines ?? []) : [];
  return (
    <div className="card host-live-question" style={{ marginTop: 0 }}>
      <div className="live-q-head">
        {question.roundName && question.themeName && (
          <span className="pill" style={{ marginRight: "0.5rem" }}>
            {question.roundName} · {question.themeName}
          </span>
        )}
        <span className="mono">Вопрос · {question.price}</span>
        <span className="pill">{question.typeName}</span>
      </div>
      {question.replicLines && question.replicLines.length > 0 && (
        <div className="host-replic-preview">
          <div className="answer-label">Уточнение / реплика</div>
          <p className="answer-text">{question.replicLines.join(" ")}</p>
        </div>
      )}
      <p className="sub" style={{ fontSize: "0.8rem", marginTop: 0 }}>
        Медиа и звук только на устройстве зрителя (ТВ). Здесь — текст и подсказки.
      </p>
      <div className="host-text-block">
        <div className="answer-label">Формулировка</div>
        <ul className="host-lines">
          {qLines.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      </div>
      <div className="host-text-block">
        <div className="answer-label">Ответ (содержимое)</div>
        <ul className="host-lines">
          {aLines.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      </div>
      {rightAns.some((t: string) => String(t).trim()) && (
        <div className="host-text-block">
          <div className="answer-label">Текст ответа в паке</div>
          {rightAns.map((t, i) => (
            <p key={i} className="answer-text">
              {t}
            </p>
          ))}
        </div>
      )}
      {answerOverlay?.view === "host" && (
        <div className="host-tv-sync">
          <span className="pill pill-ok">Ответ сейчас на экране (ТВ)</span>
          <ul className="host-lines">
            {overlayLines.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function HostBoardBlock({
  state,
  board,
  maxQuestions,
  emit,
}: {
  state: ReturnType<typeof useGameSocket>["state"];
  board: BoardRound | undefined;
  maxQuestions: number;
  emit: (ev: string, ...args: unknown[]) => void;
}) {
  if (state?.phase !== "board" || !board) return null;
  return (
    <div className="board-wrap board-wrap--host card" style={{ marginTop: 0 }}>
      <div className="board-title">{board.name}</div>
      <div
        className="board-grid"
        style={{
          gridTemplateColumns: `repeat(${board.themes.length}, minmax(0, 1fr))`,
        }}
      >
        {board.themes.map((th, ti) => (
          <div key={ti} className="board-theme">
            {th.name}
          </div>
        ))}
        {Array.from({ length: maxQuestions }, (_, qi) => (
          <div key={qi} className="board-row">
            {board.themes.map((th, ti) => {
              const cell = th.questions[qi];
              if (!cell) return <div key={ti} className="board-cell empty" />;
              const played = cell.played;
              return (
                <button
                  key={ti}
                  type="button"
                  className={`board-cell ${played ? "played" : ""}`}
                  disabled={played}
                  onClick={() =>
                    emit("host:openCell", { themeIndex: ti, questionIndex: qi })
                  }
                >
                  {played ? "—" : cell.price}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function HostSpectatorConnectForm({ roomCode }: { roomCode: string }) {
  const siteUrl = typeof window !== "undefined" ? window.location.origin : "";
  const [copied, setCopied] = useState<string | null>(null);
  const copyField = async (kind: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 1800);
    } catch {
      setCopied("err");
      window.setTimeout(() => setCopied(null), 1800);
    }
  };
  return (
    <div className="card host-connect-form">
      <h2 className="h1" style={{ fontSize: "1.15rem", marginTop: 0 }}>
        Как войти в комнату
      </h2>
      <p className="sub" style={{ fontSize: "0.85rem", marginTop: 0 }}>
        Передайте игрокам и зрителю пароль комнаты и ссылку на этот сайт.
      </p>
      <div className="host-connect-item">
        <div className="host-connect-label">Пароль комнаты</div>
        <div className="host-connect-value mono" style={{ fontSize: "1.5rem", letterSpacing: "0.18em" }}>
          {roomCode || "…"}
        </div>
        <button type="button" className="btn btn-ghost" onClick={() => void copyField("code", roomCode)}>
          Копировать пароль
        </button>
      </div>
      <div className="host-connect-item" style={{ marginTop: "0.9rem" }}>
        <div className="host-connect-label">Ссылка на сайт</div>
        <div className="host-connect-value" style={{ overflowWrap: "anywhere" }}>{siteUrl || "—"}</div>
        <button type="button" className="btn btn-ghost" onClick={() => void copyField("url", siteUrl)}>
          Копировать ссылку
        </button>
      </div>
      {copied === "code" || copied === "url" ? (
        <p className="sub host-connect-copied" style={{ margin: "0.65rem 0 0", fontSize: "0.8rem" }}>Скопировано в буфер</p>
      ) : copied === "err" ? (
        <p className="sub" style={{ margin: "0.65rem 0 0", fontSize: "0.8rem", color: "var(--danger)" }}>Не удалось скопировать — выделите текст вручную</p>
      ) : null}
    </div>
  );
}

function HostHelpPanel() {
  return (
    <div className="card host-help-panel">
      <h2 className="h1" style={{ fontSize: "1.15rem", marginTop: 0 }}>
        Справка по кнопкам ведущего
      </h2>
      <dl className="host-help-dl">
        <dt>Вкладка «Пак»</dt>
        <dd>
          <strong>Загрузить пак</strong> — выбор файла <span className="mono">.siq</span>.
          После загрузки имя пакета отображается под кнопкой. Пак хранится на сервере:
          обновление страницы ведущего не сбрасывает его, пока работает процесс сервера (в
          том числе в Docker). При полной остановке сервера нужно загрузить пак снова.
          Большой пак лучше загружать через <span className="mono">http://localhost:5174</span>,
          а публичную ссылку туннеля использовать игрокам и зрителям.
        </dd>
        <dt>Вкладка «Игра» — раунд</dt>
        <dd>
          Кнопки с номером раунда переключают активный раунд на табло.
        </dd>
        <dt>Звук на ТВ</dt>
        <dd>
          Ползунок задаёт общую громкость медиа на устройстве зрителя (телевизор).
        </dd>
        <dt>Игроки и очки</dt>
        <dd>
          Поле с числом — очки вручную (сохраняется при уходе с поля). <strong>−100</strong> /{" "}
          <strong>+100</strong> — быстрые шаги. <strong>Ход</strong> — отметка «чей ход» для
          себя (например для секретных тем).
        </dd>
        <dt>Табло</dt>
        <dd>
          Нажмите на цену вопроса, чтобы открыть его. Уже взятые клетки недоступны.
        </dd>
        <dt>Очередь ответов</dt>
        <dd>
          Порядок нажатий игроков на «Ответ!». Первый в списке отвечает сейчас.
        </dd>
        <dt>Верно — полные очки / ½ очков</dt>
        <dd>
          Засчитывает ответ первому в очереди на полную стоимость вопроса или на половину,
          закрывает вопрос и возвращает на табло.
        </dd>
        <dt>Неверно</dt>
        <dd>
          Убирает первого из очереди и запрещает ему снова жать на этом вопросе; остальные
          могут отвечать дальше.
        </dd>
        <dt>Сбросить буззеры</dt>
        <dd>
          Очищает очередь и снятые с игрока ограничения на этом вопросе (если нужно начать
          очередь заново).
        </dd>
        <dt>Показать / скрыть ответ на экране</dt>
        <dd>
          Выводит или убирает блок ответа на экране зрителя (и игроков).
        </dd>
        <dt>Закрыть вопрос</dt>
        <dd>
          Выход к табло без засчитывания (например если вопрос сняли).
        </dd>
        <dt>Вкладка «Подключение»</dt>
        <dd>
          Текст пароля Wi‑Fi и ссылки — только для экрана зрителя во вкладке «Как
          подключиться».
        </dd>
      </dl>
    </div>
  );
}

function HostPanel({
  state,
  roomCode,
  you,
  uploading,
  uploadErr,
  fileRef,
  onPickFile,
  onFile,
  emit,
  question,
  answerOverlay,
  board,
  maxQuestions,
}: {
  state: ReturnType<typeof useGameSocket>["state"];
  roomCode: string;
  you: NonNullable<ReturnType<typeof useGameSocket>["you"]>;
  uploading: boolean;
  uploadErr: string | null;
  fileRef: RefObject<HTMLInputElement>;
  onPickFile: () => void;
  onFile: (e: ChangeEvent<HTMLInputElement>) => void;
  emit: (ev: string, ...args: unknown[]) => void;
  question: ReturnType<typeof useGameSocket>["question"];
  answerOverlay: ReturnType<typeof useGameSocket>["answerOverlay"];
  board: BoardRound | undefined;
  maxQuestions: number;
}) {
  const [hostTab, setHostTabState] = useState<
    "game" | "pack" | "connect" | "help"
  >(() => {
    try {
      const v = sessionStorage.getItem(LS_HOST_TAB);
      if (v === "game" || v === "pack" || v === "connect" || v === "help") return v;
    } catch {
      /* ignore */
    }
    return "game";
  });
  const setHostTab = (t: "game" | "pack" | "connect" | "help") => {
    setHostTabState(t);
    try {
      sessionStorage.setItem(LS_HOST_TAB, t);
    } catch {
      /* ignore */
    }
  };
  const rounds = state?.pack?.rounds ?? [];
  const buzzes = state?.buzzes ?? [];
  const players = state?.players ?? [];
  const falseStartEnabled = state?.falseStartEnabled ?? false;

  return (
    <div className="host-panel-wrap">
      <input ref={fileRef} type="file" accept=".siq" hidden onChange={onFile} />
      <div className="host-tabs">
        <button
          type="button"
          className={`btn ${hostTab === "game" ? "btn-primary" : "btn-ghost"}`}
          onClick={() => setHostTab("game")}
        >
          Игра
        </button>
        <button
          type="button"
          className={`btn ${hostTab === "pack" ? "btn-primary" : "btn-ghost"}`}
          onClick={() => setHostTab("pack")}
        >
          Пак
        </button>
        <button
          type="button"
          className={`btn ${hostTab === "connect" ? "btn-primary" : "btn-ghost"}`}
          onClick={() => setHostTab("connect")}
        >
          Подключение зрителей
        </button>
        <button
          type="button"
          className={`btn ${hostTab === "help" ? "btn-primary" : "btn-ghost"}`}
          onClick={() => setHostTab("help")}
        >
          Справка
        </button>
      </div>

      {hostTab === "game" && (
        <>
          <HostLiveQuestionBlock question={question} answerOverlay={answerOverlay} />
          <HostBoardBlock
            state={state}
            board={board}
            maxQuestions={maxQuestions}
            emit={emit}
          />
          <div className="host-grid">
            <div className="card">
              <h2 className="h1" style={{ fontSize: "1.15rem" }}>
                Раунд
              </h2>
              <div className="round-chips">
                {rounds.map((r: BoardRound, i: number) => (
                  <button
                    key={i}
                    type="button"
                    className={`btn ${state?.roundIndex === i ? "btn-gold" : ""}`}
                    onClick={() => emit("host:setRound", i)}
                  >
                    {i + 1}. {r.name}
                  </button>
                ))}
              </div>
            </div>

            <div className="card host-tv-volume">
              <h2 className="h1" style={{ fontSize: "1.15rem" }}>
                Звук на телевизоре (зритель)
              </h2>
              <p className="sub" style={{ fontSize: "0.8rem", marginTop: 0 }}>
                Громкость сразу на устройстве зрителя.
              </p>
              <HostTvVolumeControls state={state} emit={emit} />
            </div>

            <div className="card host-players">
	              <h2 className="h1" style={{ fontSize: "1.15rem" }}>
	                Игроки и очки
	              </h2>
	              {state?.lastCorrectPlayerId && (
	                <div style={{ marginBottom: "0.75rem", padding: "0.5rem", background: "rgba(76, 217, 100, 0.1)", border: "1px solid #2d5a3a", borderRadius: "8px", fontSize: "0.85rem" }}>
	                  <span style={{ color: "var(--muted)", marginRight: "0.4rem" }}>Последний верный ответ:</span>
	                  <strong style={{ color: "#9dffb0" }}>
	                    {players.find(p => p.id === state.lastCorrectPlayerId)?.name || "???"}
	                  </strong>
	                </div>
	              )}
	              {players.length === 0 && (
                <p className="sub" style={{ fontSize: "0.85rem" }}>
                  Игроки появятся после входа с главной страницы с ролью{" "}
                  <strong>«Игрок»</strong> (не «Зритель») и тем же адресом в браузере, что у
                  ведущего (тот же хост и порт в строке URL).
                </p>
              )}
              <ul className="player-edit-list">
                {players.map((p: PlayerState) => (
                  <li key={p.id}>
                    <span
                      className="mono"
                      style={{ fontSize: "0.75rem", color: "var(--muted)" }}
                    >
                      {p.id.slice(0, 6)}…
                    </span>
                    <strong>{p.name}</strong>
                    <input
                      type="number"
                      className="input score-input"
                      defaultValue={p.score}
                      key={p.score}
                      onBlur={(e) => {
                        const raw = e.target.value.trim();
                        const n = raw === "" ? 0 : Number(raw);
                        emit("host:setScore", {
                          playerId: p.id,
                          score: Number.isFinite(n) ? Math.round(n) : 0,
                        });
                      }}
                    />
                    <div className="score-btns">
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => emit("host:addScore", { playerId: p.id, delta: -100 })}
                      >
                        −100
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => emit("host:addScore", { playerId: p.id, delta: 100 })}
                      >
                        +100
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>

            <div className={`card host-question-controls${(state?.phase === "question" || state?.phase === "revealing") ? " host-question-controls--sticky" : ""}`}>
              <h2 className="h1" style={{ fontSize: "1.15rem" }}>
                Вопрос
              </h2>
              <label
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.45rem",
                  marginBottom: "0.75rem",
                  fontSize: "0.9rem",
                  color: "var(--muted)",
                }}
              >
                <input
                  type="checkbox"
                  checked={falseStartEnabled}
                  onChange={(e) => emit("host:setFalseStart", e.target.checked)}
                />
                Фальстарт (нажатие до вопроса = КД 2 сек)
              </label>
	              {state?.phase === "question" || state?.phase === "revealing" ? (
	                <>
	                  {question?.view === "host" && (
	                    <div className="host-mobile-answer-hint">
	                      <div className="answer-label">Ответ</div>
	                      <div className="answer-text" style={{ fontSize: "0.95rem", fontWeight: "bold", color: "var(--gold)" }}>
	                        {question.rightTextAnswers.join(", ") || question.answerLines.join(" ")}
	                      </div>
	                    </div>
	                  )}
	                  <BuzzQueue buzzes={buzzes} title="Очередь ответов (кто раньше нажал)" />
                  {buzzes.length > 0 && (
                    <div className="verdict-row">
                      <button
                        type="button"
                        className="btn btn-gold"
                        onClick={() =>
                          emit("host:buzzVerdict", { correct: true, half: false })
                        }
                      >
                        Верно — полные очки
                      </button>
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() =>
                          emit("host:buzzVerdict", { correct: true, half: true })
                        }
                      >
                        Верно — ½ очков
                      </button>
                      <button
                        type="button"
                        className="btn btn-danger"
                        onClick={() => emit("host:buzzVerdict", { correct: false })}
                      >
                        Неверно (снять первого)
                      </button>
                    </div>
                  )}
                  <p className="sub" style={{ fontSize: "0.78rem" }}>
                    «Верно» закрывает вопрос и начисляет очки первому в очереди. «Неверно»
                    убирает его из очереди и запрещает нажимать снова на этом вопросе.
                  </p>
                  <div className="host-q-buttons">
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => emit("host:clearBuzz")}
                    >
                      Сбросить буззеры
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => emit("host:replayMedia")}
                    >
                      Переиграть медиа
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() =>
                        emit("host:toggleAnswer", !(state?.answerVisible ?? false))
                      }
                    >
                      {state?.answerVisible ? "Скрыть ответ" : "Показать ответ на экране"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger"
                      onClick={() => emit("host:closeQuestion")}
                    >
                      Закрыть вопрос
                    </button>
                  </div>
                </>
              ) : (
                <p className="sub">Откройте клетку на табло выше.</p>
              )}
            </div>
          </div>
        </>
      )}

      {hostTab === "pack" && (
        <div className="card" style={{ marginTop: "0.75rem" }}>
          <h2 className="h1" style={{ fontSize: "1.15rem", marginTop: 0 }}>
            Пак вопросов
          </h2>
          <p className="sub" style={{ fontSize: "0.85rem" }}>
            Загрузите файл <span className="mono">.siq</span> после подключения сокета.
          </p>
          <button
            type="button"
            className="btn btn-primary"
            disabled={uploading || !you.id}
            onClick={onPickFile}
          >
            {uploading ? "Загрузка…" : "Загрузить пак"}
          </button>
          {uploadErr && (
            <p style={{ color: "var(--danger)", marginTop: "0.5rem" }}>{uploadErr}</p>
          )}
          {state?.pack && (
            <p style={{ marginTop: "0.75rem", color: "var(--muted)" }}>
              <strong>{state.pack.name}</strong>
              {state.pack.restriction && ` · ${state.pack.restriction}`}
            </p>
          )}
        </div>
      )}

      {hostTab === "connect" && (
        <div style={{ marginTop: "0.75rem" }}>
          <HostSpectatorConnectForm roomCode={roomCode} />
        </div>
      )}

      {hostTab === "help" && (
        <div style={{ marginTop: "0.75rem" }}>
          <HostHelpPanel />
        </div>
      )}
    </div>
  );
}

function PlayerPanel({
  state,
  you,
  question,
  buzz,
}: {
  state: ReturnType<typeof useGameSocket>["state"];
  you: ReturnType<typeof useGameSocket>["you"] | null;
  question: ReturnType<typeof useGameSocket>["question"];
  buzz: (canSend?: boolean, withFeedback?: boolean) => void;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const blocked = state?.blockedBuzzPlayerIds ?? [];
  const isBlocked = you?.id ? blocked.includes(you.id) : false;
  const inQueue = (state?.buzzes ?? []).findIndex((b) => b.playerId === you?.id);
  const cooldownUntil = you?.id ? (state?.buzzCooldownUntilByPlayerId?.[you.id] ?? 0) : 0;
  const cooldownMs = Math.max(0, cooldownUntil - nowMs);
  const cooldownActive = cooldownMs > 0;
  const canTapButton = !cooldownActive;
  const cooldownSec = (cooldownMs / 1000).toFixed(1);
  const canBuzz =
    state?.phase === "question" &&
    question?.view === "player" &&
    !state.buzzes.some((b) => b.playerId === you?.id) &&
    !isBlocked &&
    !cooldownActive;

  useEffect(() => {
    if (!cooldownUntil || cooldownUntil <= Date.now()) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 100);
    return () => window.clearInterval(id);
  }, [cooldownUntil]);

  useEffect(() => {
    if (!canBuzz) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" && e.code !== "Enter") return;
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      buzz(canTapButton, canBuzz);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canBuzz, canTapButton, buzz]);

  return (
    <div className="player-shell player-shell--ultra">
      <div className="card player-tv-hint">
        <div className="answer-label">Игрок</div>
        {you?.name && (
          <p className="mono" style={{ margin: "0 0 0.35rem", fontSize: "1rem", color: "var(--gold)" }}>
            {you.name}
          </p>
        )}
        <p className="sub" style={{ margin: 0 }}>
          На этом экране только кнопка ответа.
        </p>
      </div>

      <button
        type="button"
        className={`buzzer buzzer--ultra ${canBuzz ? "active" : "inactive"}`}
        disabled={!canTapButton}
        onClick={() => buzz(canTapButton, canBuzz)}
        title="Пробел или Enter — тоже ответ"
      >
        {cooldownActive ? `КД ${cooldownSec}с` : "Ответ!"}
      </button>
      {cooldownActive && (
        <p className="sub buzz-hint" style={{ color: "var(--gold)" }}>
          Фальстарт: подождите {cooldownSec} сек
        </p>
      )}
      {isBlocked && state?.phase === "question" && (
        <p className="sub buzz-hint" style={{ color: "var(--danger)" }}>
          Вы ошиблись на этом вопросе.
        </p>
      )}
      {!isBlocked && inQueue >= 0 && (
        <p className="sub buzz-hint">
          Вы в очереди: <strong>{inQueue + 1}</strong>
        </p>
      )}
      {!canBuzz && state?.phase === "question" && question?.view === "player" && !isBlocked && (
        <p className="sub buzz-hint">Вы уже нажали — ждите своей очереди</p>
      )}
    </div>
  );
}

function SpectatorPanel({
  connected,
  state,
  board,
  maxQuestions,
  question,
  answerOverlay,
}: {
  connected: boolean;
  state: ReturnType<typeof useGameSocket>["state"];
  board: BoardRound | undefined;
  maxQuestions: number;
  question: ReturnType<typeof useGameSocket>["question"];
  answerOverlay: ReturnType<typeof useGameSocket>["answerOverlay"];
}) {
  const tvQuestion = question?.view === "tv" ? question : null;
  const tvAnswer = answerOverlay?.view === "tv" ? answerOverlay : null;
  const fsRef = useRef<HTMLDivElement>(null);
  const [specTab, setSpecTab] = useState<"play" | "connect">("play");
  const [mediaTick, setMediaTick] = useState(0);
  const [showReconnectHint, setShowReconnectHint] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const hadDisconnectRef = useRef(false);
  const prevConnectedRef = useRef<boolean | null>(null);
  const volMaster = state?.spectatorVolume?.master ?? 0.85;
  const buzzQueueSize = state?.buzzes?.length ?? 0;
  const shouldPauseMedia =
    (state?.phase === "question" || state?.phase === "revealing") && buzzQueueSize > 0;

  useEffect(() => {
    if (prevConnectedRef.current === true && !connected) {
      hadDisconnectRef.current = true;
    }
    prevConnectedRef.current = connected;
  }, [connected]);

  useEffect(() => {
    if (connected && hadDisconnectRef.current) {
      hadDisconnectRef.current = false;
      setMediaTick((n) => n + 1);
      setShowReconnectHint(true);
      const t = window.setTimeout(() => setShowReconnectHint(false), 5000);
      return () => window.clearTimeout(t);
    }
  }, [connected]);

  useEffect(() => {
    if (!connected || (!tvQuestion && !tvAnswer)) return;
    const id = window.requestAnimationFrame(() => {
      const root = fsRef.current;
      if (!root) return;
      root.querySelectorAll("video, audio").forEach((node) => {
        void (node as HTMLMediaElement).play().catch(() => {});
      });
    });
    return () => window.cancelAnimationFrame(id);
  }, [connected, tvQuestion, tvAnswer, mediaTick, question, answerOverlay]);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      const root = fsRef.current;
      if (!root) return;
      root.querySelectorAll("video, audio").forEach((node) => {
        void (node as HTMLMediaElement).play().catch(() => {});
      });
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  useEffect(() => {
    const root = fsRef.current;
    if (!root) return;
    const mediaNodes = root.querySelectorAll("video, audio");
    if (mediaNodes.length === 0) return;

    if (shouldPauseMedia) {
      mediaNodes.forEach((node) => {
        (node as HTMLMediaElement).pause();
      });
      return;
    }

    if (!connected || (!tvQuestion && !tvAnswer)) return;
    mediaNodes.forEach((node) => {
      void (node as HTMLMediaElement).play().catch(() => {});
    });
  }, [shouldPauseMedia, connected, tvQuestion, tvAnswer, mediaTick]);

  const requestWake = async () => {
    try {
      const anyNav = navigator as Navigator & {
        wakeLock?: { request: (t: string) => Promise<{ release: () => void }> };
      };
      await anyNav.wakeLock?.request("screen");
    } catch {
      /* ignore */
    }
  };

  const toggleFs = () => {
    const el = fsRef.current;
    if (!el) return;
    if (document.fullscreenElement === el) {
      void document.exitFullscreen?.();
      return;
    }
    void el.requestFullscreen?.();
  };

  const unblockTvSound = () => {
    const root = fsRef.current;
    if (!root) return;
    root.querySelectorAll("video").forEach((v) => {
      v.muted = false;
      void v.play().catch(() => {});
    });
    root.querySelectorAll("audio").forEach((a) => {
      void (a as HTMLAudioElement).play().catch(() => {});
    });
  };

  useEffect(() => {
    void requestWake();
  }, []);

  useEffect(() => {
    if (specTab !== "play") return;
    const tryEnableMedia = () => {
      unblockTvSound();
      void requestWake();
    };
    tryEnableMedia();
    window.addEventListener("pointerdown", tryEnableMedia, { passive: true });
    window.addEventListener("keydown", tryEnableMedia);
    return () => {
      window.removeEventListener("pointerdown", tryEnableMedia);
      window.removeEventListener("keydown", tryEnableMedia);
    };
  }, [specTab, tvQuestion, tvAnswer, mediaTick]);

  useEffect(() => {
    const onFs = () => {
      const el = fsRef.current;
      setIsFullscreen(Boolean(el && document.fullscreenElement === el));
    };
    document.addEventListener("fullscreenchange", onFs);
    onFs();
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  useEffect(() => {
    if (specTab !== "play") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "f") return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      e.preventDefault();
      toggleFs();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [specTab]);

  return (
    <div className="spectator-root" ref={fsRef}>
      <div className="spectator-tabs">
        <button
          type="button"
          className={`btn ${specTab === "play" ? "btn-primary" : "btn-ghost"}`}
          onClick={() => setSpecTab("play")}
        >
          Игра
        </button>
        <button
          type="button"
          className={`btn ${specTab === "connect" ? "btn-primary" : "btn-ghost"}`}
          onClick={() => setSpecTab("connect")}
        >
          Как подключиться
        </button>
        <button type="button" className="btn btn-ghost" onClick={toggleFs}>
          {isFullscreen ? "Выйти из полного экрана" : "Полный экран"}
        </button>
      </div>

      {specTab === "connect" ? (
        <SpectatorConnectCard connect={state?.spectatorConnect} />
      ) : (
        <>
{/* Текст про громкость удален по просьбе пользователя */}

          {showReconnectHint && (
            <div className="card spec-reconnect-hint" role="status">
              Связь восстановлена. Если звук или видео не вернулись, коснитесь экрана один
              раз для повторной активации.
            </div>
          )}

          <SpectatorBuzzStrip phase={state?.phase} buzzes={state?.buzzes ?? []} />

          <div className="spectator-play-scroll">
            {board && !tvQuestion && maxQuestions > 0 && (
              <div className="spectator-board card">
                <div className="board-title-lg">{board.name}</div>
                <div
                  className="board-grid spec"
                  style={{
                    gridTemplateColumns: `repeat(${board.themes.length}, minmax(0, 1fr))`,
                  }}
                >
                  {board.themes.map((th, ti) => (
                    <div key={ti} className="board-theme">
                      {th.name}
                    </div>
                  ))}
                  {Array.from({ length: maxQuestions }, (_, qi) => (
                    <div key={qi} className="board-row">
                      {board.themes.map((th, ti) => {
                        const c = th.questions[qi];
                        return (
                          <div
                            key={ti}
                            className={`board-cell spec ${c?.played ? "played" : ""}`}
                          >
                            {!c ? "" : c.played ? "—" : c.price}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {(tvQuestion || tvAnswer) && (
              <div className="spectator-overlay spectator-overlay--active card">
                {tvQuestion && (
                  <>
                    <div className="spec-q-banner">
                      <div className="spec-q-meta">
                        {tvQuestion.roundName && (
                          <span className="spec-round">{tvQuestion.roundName}</span>
                        )}
                        {tvQuestion.themeName && (
                          <span className="spec-theme">{tvQuestion.themeName}</span>
                        )}
                        <span className="spec-price mono">{tvQuestion.price}</span>
                      </div>
                      {tvQuestion.replicLines && tvQuestion.replicLines.length > 0 && (
                        <div className="spec-replic-callout">
                          {tvQuestion.replicLines.map((line, i) => (
                            <p key={i}>{line}</p>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="spec-stage-scroll">
                      <ContentStage
                        variant="tv"
                        mediaTick={mediaTick}
                        items={filterTvItemsForStage(
                          tvQuestion.questionContent,
                          tvQuestion.replicLines,
                        )}
                        playback="autoplay-all"
                        volumeMaster={volMaster}
                        volumeMusic={1}
                      />
                    </div>
                  </>
                )}
                {tvAnswer && (
                  <div className="answer-block">
                    <div className="spec-stage-scroll">
                      <ContentStage
                        variant="tv"
                        mediaTick={mediaTick}
                        items={tvAnswer.answerContent}
                        playback="autoplay-all"
                        volumeMaster={volMaster}
                        volumeMusic={1}
                      />
                    </div>
                    {tvAnswer.rightTextAnswers.map((t, i) => (
                      <p key={i} className="answer-text-lg">
                        {t}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            )}

            {state?.players && state.players.length > 0 && (
              <div className="spec-scores">
                {state.players.map((p) => (
                  <div key={p.id} className="spec-score card">
                    <div>{p.name}</div>
                    <div className="mono">{p.score}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function SpectatorBuzzStrip({
  phase,
  buzzes,
}: {
  phase: GameState["phase"] | undefined;
  buzzes: BuzzEntry[];
}) {
  const active = phase === "question" || phase === "revealing";
  if (!active || buzzes.length === 0) return null;
  return (
    <div className="card spec-buzz-strip">
      {buzzes.length > 0 && (
        <>
          <div className="spec-buzz-now">
            Сейчас отвечает:{" "}
            <strong className="spec-buzz-now-name">{buzzes[0].playerName}</strong>
            <span className="spec-buzz-badge">1-й в очереди</span>
          </div>
          <div className="answer-label" style={{ marginTop: "0.5rem" }}>
            Очередь (порядок нажатий)
          </div>
          <ol className="spec-buzz-list">
            {buzzes.map((b, idx) => (
              <li key={b.playerId} className={idx === 0 ? "spec-buzz-li-first" : ""}>
                <span className="buzz-ord">{idx + 1}</span>
                <span className="buzz-name">{b.playerName}</span>
                {idx === 0 && <span className="spec-buzz-live">ходит</span>}
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

function SpectatorConnectCard({
  connect,
}: {
  connect: GameState["spectatorConnect"] | undefined;
}) {
  const wifiName = "";
  const wifi = connect?.wifiPassword?.trim() ?? "";
  const url = connect?.joinUrl?.trim() ?? "";
  const fallbackOrigin =
    typeof window !== "undefined" ? window.location.origin : "";
  return (
    <div className="spec-connect-card spec-connect-full">
      <div className="spec-connect-content">
        <h2 className="spec-connect-title">
          Как подключиться
        </h2>
        <p className="spec-connect-desc">
          Откройте ссылку на сайт и введите пароль комнаты, который сообщил ведущий.
        </p>
        <div className="spec-connect-grid">
          <div className="spec-connect-item">
            <div className="spec-connect-label">Пароль комнаты</div>
            <div className="spec-connect-value mono" style={{ fontSize: "1.4rem", letterSpacing: "0.16em" }}>{wifi || "—"}</div>
          </div>
          <div className="spec-connect-item">
            <div className="spec-connect-label">Ссылка на сайт</div>
            <div className="spec-connect-value spec-connect-url-large">{url || fallbackOrigin || "—"}</div>
          </div>
        </div>
        {!wifi && !url && (
          <p className="spec-connect-fallback">
            Ведущий ещё не заполнил поля — пока можно открыть эту же страницу по адресу{" "}
            {fallbackOrigin ? (
              <code className="mono">{fallbackOrigin}</code>
            ) : (
              "сервера в локальной сети"
            )}
            .
          </p>
        )}
      </div>
    </div>
  );
}

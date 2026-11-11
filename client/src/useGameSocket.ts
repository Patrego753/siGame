import { useCallback, useEffect, useRef, useState } from "react";
import type { ContentItem, GameState, Role } from "@shared/gameTypes";
import { io, type Socket } from "socket.io-client";

/** Между переподключениями в одной вкладке. */
let socketHadDisconnect = false;

export type QuestionPayload = {
  price: number;
  typeName: string;
  roundName?: string;
  themeName?: string;
  replicLines?: string[];
  questionContent: (ContentItem & { mediaUrl?: string })[];
  answerContent?: (ContentItem & { mediaUrl?: string })[];
  rightTextAnswers?: string[];
  wrongTextAnswers?: string[];
};

export type QuestionOpenedPayload =
  | ({ view: "tv" } & QuestionPayload)
  | {
      view: "host";
      price: number;
      typeName: string;
      roundName?: string;
      themeName?: string;
      replicLines?: string[];
      questionLines: string[];
      answerLines: string[];
      rightTextAnswers: string[];
      wrongTextAnswers: string[];
    }
  | {
      view: "player";
      price: number;
      typeName: string;
      roundName?: string;
      themeName?: string;
    };

export type AnswerShownPayload =
  | {
      view: "tv";
      answerContent: (ContentItem & { mediaUrl?: string })[];
      rightTextAnswers: string[];
      wrongTextAnswers: string[];
    }
  | {
      view: "host";
      answerLines: string[];
      rightTextAnswers: string[];
      wrongTextAnswers: string[];
    };

export type You = {
  id: string;
  role: Role;
  isHost: boolean;
  name: string;
};

type JoinWaitResult = {
  ok: boolean;
  error?: string;
  code?: string;
};

type ServerMsg = {
  e: string;
  d?: unknown;
  rid?: string | null;
  ok?: boolean;
  error?: string;
  code?: string;
  snapshot?: { state: GameState; you: You };
};

function createRequestId(): string {
  try {
    if (
      typeof globalThis !== "undefined" &&
      globalThis.crypto &&
      typeof globalThis.crypto.randomUUID === "function"
    ) {
      return globalThis.crypto.randomUUID();
    }
  } catch {
    /* ignore */
  }
  return `rid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildGameWsUrl(): string {
  const raw = String(
    import.meta.env.VITE_SOCKET_URL ?? import.meta.env.VITE_WS_URL ?? "",
  ).trim();
  if (raw) {
    if (
      raw.startsWith("http://") ||
      raw.startsWith("https://") ||
      raw.startsWith("ws://") ||
      raw.startsWith("wss://")
    ) {
      const u = new URL(raw);
      if (u.protocol === "ws:") u.protocol = "http:";
      if (u.protocol === "wss:") u.protocol = "https:";
      // Socket.IO-клиент ожидает базовый origin; путь здесь может стать namespace.
      u.pathname = "/";
      u.search = "";
      u.hash = "";
      return u.toString();
    }
    const proto =
      typeof window !== "undefined" && window.location.protocol === "https:"
        ? "https:"
        : "http:";
    const host = raw.replace(/^\/\//, "");
    return `${proto}//${host}`;
  }
  if (typeof window !== "undefined" && window.location.host) {
    return `${window.location.protocol}//${window.location.host}`;
  }
  return "http://127.0.0.1:5174";
}

function normalizeGameState(s: GameState): GameState {
  return {
    ...s,
    blockedBuzzPlayerIds: s.blockedBuzzPlayerIds ?? [],
    falseStartEnabled: s.falseStartEnabled ?? false,
    buzzCooldownUntilByPlayerId: s.buzzCooldownUntilByPlayerId ?? {},
    spectatorVolume: {
      master:
        typeof s.spectatorVolume?.master === "number"
          ? s.spectatorVolume.master
          : 0.85,
    },
    spectatorConnect: s.spectatorConnect ?? {
      wifiName: "",
      wifiPassword: "",
      joinUrl: "",
    },
  };
}

export function useGameSocket() {
  const socketRef = useRef<Socket | null>(null);
  const joinOnConnectRef = useRef<(() => void) | null>(null);
  const joinWaitersRef = useRef<Map<string, (r: JoinWaitResult) => void>>(
    new Map(),
  );

  const [connected, setConnected] = useState(false);
  const [socketErr, setSocketErr] = useState<string | null>(null);
  const [state, setState] = useState<GameState | null>(null);
  const [you, setYou] = useState<You | null>(null);
  const [question, setQuestion] = useState<QuestionOpenedPayload | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [answerOverlay, setAnswerOverlay] = useState<AnswerShownPayload | null>(
    null,
  );

  useEffect(() => {
    const joinWaiters = joinWaitersRef.current;

    const applySession = (snap: { state: GameState; you: You }) => {
      setState(normalizeGameState(snap.state));
      setYou(snap.you);
    };

    const finishJoinWait = (rid: string | undefined, result: JoinWaitResult) => {
      if (rid && joinWaiters.has(rid)) {
        joinWaiters.get(rid)!(result);
        joinWaiters.delete(rid);
      }
    };

    const dispatch = (m: ServerMsg) => {
      /** Ответ на join: один пакет со снимком — не зависим от отдельного state. */
      if (m.e === "joinResult") {
        const rid = typeof m.rid === "string" ? m.rid : undefined;
        const ok = m.ok === true;
        if (ok && m.snapshot?.state && m.snapshot?.you) {
          applySession(m.snapshot);
        }
        finishJoinWait(rid, {
          ok,
          error: typeof m.error === "string" ? m.error : undefined,
          code: typeof m.code === "string" ? m.code : undefined,
        });
        return;
      }

      /** Старый сервер (если остался): joinAck без snapshot. */
      if (m.e === "joinAck") {
        const rid = typeof m.rid === "string" ? m.rid : undefined;
        finishJoinWait(rid, {
          ok: m.ok === true,
          error: typeof m.error === "string" ? m.error : undefined,
          code: typeof m.code === "string" ? m.code : undefined,
        });
        return;
      }

      switch (m.e) {
        case "state": {
          const p = m.d as { state?: GameState; you?: You } | undefined;
          if (p?.state && p?.you) {
            applySession({ state: p.state, you: p.you });
          }
          break;
        }
        case "questionOpened":
          setQuestion(m.d as QuestionOpenedPayload);
          setAnswerOverlay(null);
          break;
        case "questionClosed":
          setQuestion(null);
          setAnswerOverlay(null);
          break;
        case "answerShown":
          setAnswerOverlay(m.d as AnswerShownPayload);
          break;
        case "answerHidden":
          setAnswerOverlay(null);
          break;
        default:
          break;
      }
    };

    const url = buildGameWsUrl();
    const socket = io(url, {
      path: "/socket.io",
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1200,
      reconnectionDelayMax: 5000,
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      setSocketErr(null);
      setConnected(true);
      joinOnConnectRef.current?.();
      if (socketHadDisconnect) {
        setNotice("Связь восстановлена.");
        socketHadDisconnect = false;
      }
    });

    socket.on("connect_error", () => {
      setSocketErr("Ошибка Socket.IO (проверьте адрес и что сервер запущен)");
    });

    socket.on("disconnect", () => {
      setConnected(false);
      setState(null);
      setYou(null);
      setQuestion(null);
      setAnswerOverlay(null);
      socketHadDisconnect = true;
    });

    socket.on("msg", (m: ServerMsg) => {
      if (m?.e) dispatch(m);
    });

    return () => {
      joinOnConnectRef.current = null;
      joinWaiters.clear();
      const s = socketRef.current;
      socketRef.current = null;
      s?.disconnect();
    };
  }, []);

  const registerJoinOnConnect = useCallback((fn: (() => void) | null) => {
    joinOnConnectRef.current = fn;
    const s = socketRef.current;
    if (fn && s?.connected) fn();
  }, []);

  const join = useCallback(
    (p: {
      roomCode?: string;
      role: Role;
      nickname?: string;
      playerKey?: string;
      createRoom?: boolean;
    }) =>
      new Promise<{ ok: boolean; error?: string; code?: string }>((res) => {
        const s = socketRef.current;
        if (!s || !s.connected) {
          res({ ok: false, error: "Соединение ещё не готово" });
          return;
        }
        const rid = createRequestId();
        let settled = false;
        const t = window.setTimeout(() => {
          if (settled) return;
          settled = true;
          joinWaitersRef.current.delete(rid);
          res({
            ok: false,
            error:
              "Сервер не ответил на вход (проверьте тот же хост:порт у всех устройств).",
          });
        }, 15_000);
        joinWaitersRef.current.set(rid, (r: JoinWaitResult) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(t);
          joinWaitersRef.current.delete(rid);
          if (r.ok) res({ ok: true, code: r.code });
          else res({ ok: false, error: r.error ?? "Ошибка входа" });
        });
        s.emit("msg", { e: "join", d: p, rid });
      }),
    [],
  );

  const emit = useCallback((ev: string, ...args: unknown[]) => {
    const s = socketRef.current;
    if (!s || !s.connected) return;
    if (args.length === 0) s.emit("msg", { e: ev });
    else if (args.length === 1) s.emit("msg", { e: ev, d: args[0] });
    else s.emit("msg", { e: ev, d: args });
  }, []);

  return {
    socket: socketRef.current,
    connected,
    socketErr,
    clearSocketErr: () => setSocketErr(null),
    state,
    you,
    question,
    answerOverlay,
    notice,
    clearNotice: () => setNotice(null),
    registerJoinOnConnect,
    join,
    emit,
  };
}

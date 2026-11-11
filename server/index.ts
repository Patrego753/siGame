import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { randomUUID } from "node:crypto";
import express from "express";
import cors from "cors";
import multer from "multer";
import { Server as SocketIOServer, type Socket } from "socket.io";
import type {
  ContentItem,
  GameState,
  ParsedQuestion,
  PublicPackMeta,
  Role,
} from "../shared/gameTypes.js";
import type { LoadedPack } from "./siqParse.js";
import {
  guessMime,
  parseSiqFile,
  resolveMediaPath,
} from "./siqParse.js";
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, ROOM_CODE_RE } from "../shared/localRoom.js";

const PACK_UPLOAD_LIMIT_MB = Number(process.env.PACK_UPLOAD_LIMIT_MB ?? 300);
const PACK_UPLOAD_LIMIT_BYTES =
  Number.isFinite(PACK_UPLOAD_LIMIT_MB) && PACK_UPLOAD_LIMIT_MB > 0
    ? Math.round(PACK_UPLOAD_LIMIT_MB * 1024 * 1024)
    : 300 * 1024 * 1024;

const uploadDir = path.join(process.env.TMPDIR ?? "/tmp", "sigame-uploads");
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (_req, _file, cb) => cb(null, `${randomUUID()}.siq`),
  }),
  limits: { fileSize: PACK_UPLOAD_LIMIT_BYTES },
});

type Room = {
  code: string;
  hostSocketId: string | null;
  pack: LoadedPack | null;
  game: GameState;
  /** socketId -> last nickname */
  nicknames: Map<string, string>;
  /** Ключ клиента (localStorage) -> очки при отключении для восстановления */
  playerResume: Map<string, { name: string; score: number }>;
  /** Отложенное удаление игрока после краткого дисконнекта (например F5). */
  playerDisconnectTimers: Map<string, ReturnType<typeof setTimeout>>;
};

const rooms = new Map<string, Room>();
function generateRoomCode(): string {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    let code = "";
    for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
      code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
  throw new Error("Не удалось создать свободную комнату");
}

type ClientConn = {
  id: string;
  socket: Socket;
  roomCode?: string;
  role?: Role;
  playerKey?: string;
  playerId?: string;
};

const clients = new Map<string, ClientConn>();

function wsSend(c: ClientConn, event: string, data?: unknown) {
  if (!c.socket.connected) return;
  const payload = data === undefined ? { e: event } : { e: event, d: data };
  c.socket.emit("msg", payload);
}

type SessionSnapshot = {
  state: GameState;
  you: {
    id: string;
    role: Role;
    isHost: boolean;
    name: string;
  };
};

function buildSnapshotFor(room: Room, sid: string, role: Role): SessionSnapshot {
  const conn = clients.get(sid);
  const logicalId = role === "player" ? conn?.playerId ?? sid : sid;
  return {
    state: cloneGameStateForEmit(room.game),
    you: {
      id: logicalId,
      role,
      isHost: room.hostSocketId === sid,
      name: room.nicknames.get(sid) ?? "",
    },
  };
}

/** Один ответ на join: сразу полный снимок комнаты для этого клиента (без гонки с отдельным state). */
function sendJoinResult(
  c: ClientConn,
  rid: string | undefined,
  r:
    | { ok: true; code: string; snapshot: SessionSnapshot }
    | { ok: false; error: string },
) {
  if (!c.socket.connected) return;
  if (r.ok) {
    c.socket.emit("msg", {
      e: "joinResult",
      rid: rid ?? null,
      ok: true,
      code: r.code,
      snapshot: r.snapshot,
    });
  } else {
    c.socket.emit("msg", {
      e: "joinResult",
      rid: rid ?? null,
      ok: false,
      error: r.error,
    });
  }
}

function cloneGameStateForEmit(game: GameState): GameState {
  try {
    return structuredClone(game) as GameState;
  } catch {
    return JSON.parse(JSON.stringify(game)) as GameState;
  }
}

const DEBUG_ROOM = process.env.SI_DEBUG_ROOM === "1";
const SOCKET_IO_ALLOWED_ORIGIN = String(
  process.env.SOCKET_IO_ALLOWED_ORIGIN ?? "",
).trim();
const PLAYER_RECONNECT_GRACE_MS = 15_000;
const FALSE_START_COOLDOWN_MS = 2_000;

/** Клиенты сессии по `roomCode` на соединении. */
function forEachClientInRoom(
  room: Room,
  fn: (c: ClientConn, sid: string, role: Role) => void,
) {
  for (const [sid, c] of clients) {
    if (c.roomCode !== room.code || !c.role) continue;
    if (!c.socket.connected) continue;
    fn(c, sid, c.role);
  }
}

function emitToLogicalRoom(room: Room, ev: string, payload?: unknown) {
  forEachClientInRoom(room, (c) => {
    wsSend(c, ev, payload);
  });
}

function countClientsInRoom(code: string) {
  let n = 0;
  for (const [, c] of clients) {
    if (c.roomCode !== code || !c.role) continue;
    if (!c.socket.connected) continue;
    n++;
  }
  return n;
}

/** Не удалять комнату сразу при обрыве — проверка по логическим клиентам после паузы. */
function scheduleRoomDeletionIfEmpty(code: string, delayMs = 10_000) {
  setTimeout(() => {
    if (countClientsInRoom(code) > 0) return;
    const room = rooms.get(code);
    rooms.delete(code);
    if (room?.pack?.storageDir) {
      void fsp.rm(room.pack.storageDir, { recursive: true, force: true });
    }
  }, delayMs);
}

function initialGame(): GameState {
  return {
    phase: "lobby",
    roundIndex: 0,
    currentPlayerId: null,
    lastCorrectPlayerId: null,
    active: null,
    answerVisible: false,
    buzzes: [],
    blockedBuzzPlayerIds: [],
    falseStartEnabled: false,
    buzzCooldownUntilByPlayerId: {},
    players: [],
    spectatorVolume: { master: 0.85 },
    spectatorConnect: { wifiName: "", wifiPassword: "", joinUrl: "" },
    pack: null,
  };
}

function getOrCreateRoom(code: string): Room {
  let r = rooms.get(code);
  if (!r) {
    r = {
      code,
      hostSocketId: null,
      pack: null,
      game: initialGame(),
      nicknames: new Map(),
      playerResume: new Map(),
      playerDisconnectTimers: new Map(),
    };
    rooms.set(code, r);
  } else if (!r.playerResume) {
    r.playerResume = new Map();
  }
  if (!r.playerDisconnectTimers) {
    r.playerDisconnectTimers = new Map();
  }
  return r;
}

function publicMetaFromPack(p: LoadedPack): PublicPackMeta {
  return {
    name: p.name,
    restriction: p.restriction,
    language: p.language,
    difficulty: p.difficulty,
    rounds: p.rounds,
  };
}

function stripQuestionForPublic(q: ParsedQuestion): {
  price: number;
  typeName: string;
  questionContent: ContentItem[];
} {
  return {
    price: q.price,
    typeName: q.typeName,
    questionContent: q.questionContent,
  };
}

/** Текст для ведущего без медиа (медиа идёт только на зрителя). */
function linesFromContent(items: ContentItem[]): string[] {
  const out: string[] = [];
  for (const it of items) {
    const t = (it.type || "text").toLowerCase();
    const v = (it.value || "").trim();
    if (t === "text" || t === "oral") {
      if (v) out.push(...v.split("\n").filter(Boolean));
    } else if (t === "image" || (it.isRef && /\.(png|jpe?g|gif|webp)$/i.test(v)))
      out.push("[Изображение]");
    else if (t === "audio" || t === "voice" || t === "sound") out.push("[Аудио]");
    else if (t === "video" || (it.isRef && /\.(mp4|webm)$/i.test(v))) out.push("[Видео]");
    else if (it.isRef) out.push(`[Файл: ${v}]`);
    else if (v) out.push(v);
  }
  return out.length ? out : ["—"];
}

function clarifyingLinesFromQuestion(items: ContentItem[]): string[] {
  const out: string[] = [];
  for (const it of items) {
    const pl = (it.placement || "screen").toLowerCase();
    if (pl !== "replic") continue;
    const t = (it.type || "text").toLowerCase();
    if (t === "text" || t === "oral") {
      const v = (it.value || "").trim();
      if (v) out.push(...v.split("\n").map((x) => x.trim()).filter(Boolean));
    }
  }
  return out;
}

function emitQuestionToRoom(
  room: Room,
  q: ParsedQuestion,
  themeIndex: number,
  questionIndex: number,
) {
  const baseUrl = `/api/room/${room.code}/asset?path=`;
  const resolveItems = (items: ContentItem[]) =>
    items.map((it) =>
      it.isRef
        ? { ...it, mediaUrl: baseUrl + encodeURIComponent(it.value) }
        : { ...it },
    );
  const publicQ = stripQuestionForPublic(q);
  const ri = room.game.roundIndex;
  const round = room.game.pack?.rounds[ri];
  const roundName = round?.name ?? "Раунд";
  const themeName = round?.themes[themeIndex]?.name ?? "Тема";
  const replicLines = clarifyingLinesFromQuestion(q.questionContent);
  const tvPayload = {
    view: "tv" as const,
    price: q.price,
    typeName: q.typeName,
    roundName,
    themeName,
    replicLines,
    questionContent: resolveItems(publicQ.questionContent),
  };
  const hostPayload = {
    view: "host" as const,
    price: q.price,
    typeName: q.typeName,
    roundName,
    themeName,
    replicLines,
    questionLines: linesFromContent(q.questionContent),
    answerLines: linesFromContent(q.answerContent),
    rightTextAnswers: q.rightTextAnswers,
    wrongTextAnswers: q.wrongTextAnswers,
  };
  const playerPayload = {
    view: "player" as const,
    price: q.price,
    typeName: q.typeName,
    roundName,
    themeName,
  };
  forEachClientInRoom(room, (c, sid, role) => {
    if (role === "spectator") wsSend(c, "questionOpened", tvPayload);
    else if (role === "player") wsSend(c, "questionOpened", playerPayload);
    else if (role === "host" && sid === room.hostSocketId)
      wsSend(c, "questionOpened", hostPayload);
  });
}

function emitAnswerToRoom(
  room: Room,
  q: ParsedQuestion,
  visible: boolean,
) {
  if (!visible) {
    emitToLogicalRoom(room, "answerHidden");
    return;
  }
  const baseUrl = `/api/room/${room.code}/asset?path=`;
  const resolveItems = (items: ContentItem[]) =>
    items.map((it) =>
      it.isRef
        ? { ...it, mediaUrl: baseUrl + encodeURIComponent(it.value) }
        : { ...it },
    );
  const tvPayload = {
    view: "tv" as const,
    answerContent: resolveItems(q.answerContent),
    rightTextAnswers: q.rightTextAnswers,
    wrongTextAnswers: q.wrongTextAnswers,
  };
  const hostPayload = {
    view: "host" as const,
    answerLines: linesFromContent(q.answerContent),
    rightTextAnswers: q.rightTextAnswers,
    wrongTextAnswers: q.wrongTextAnswers,
  };
  forEachClientInRoom(room, (c, sid, role) => {
    if (role === "spectator") wsSend(c, "answerShown", tvPayload);
    else if (role === "host" && sid === room.hostSocketId)
      wsSend(c, "answerShown", hostPayload);
  });
}

/** После F5 у клиента нет событий questionOpened/answerShown — повторно шлём текущий вопрос одному сокету. */
function resyncActiveQuestionForClient(room: Room, c: ClientConn) {
  if (!room.pack || !room.game.active) return;
  if (room.game.phase !== "question" && room.game.phase !== "revealing") return;
  const { themeIndex, questionIndex } = room.game.active;
  const q = pickQuestion(room, room.game.roundIndex, themeIndex, questionIndex);
  if (!q) return;

  const baseUrl = `/api/room/${room.code}/asset?path=`;
  const resolveItems = (items: ContentItem[]) =>
    items.map((it) =>
      it.isRef
        ? { ...it, mediaUrl: baseUrl + encodeURIComponent(it.value) }
        : { ...it },
    );
  const publicQ = stripQuestionForPublic(q);
  const ri = room.game.roundIndex;
  const round = room.game.pack?.rounds[ri];
  const roundName = round?.name ?? "Раунд";
  const themeName = round?.themes[themeIndex]?.name ?? "Тема";
  const replicLines = clarifyingLinesFromQuestion(q.questionContent);
  const tvPayload = {
    view: "tv" as const,
    price: q.price,
    typeName: q.typeName,
    roundName,
    themeName,
    replicLines,
    questionContent: resolveItems(publicQ.questionContent),
  };
  const hostPayload = {
    view: "host" as const,
    price: q.price,
    typeName: q.typeName,
    roundName,
    themeName,
    replicLines,
    questionLines: linesFromContent(q.questionContent),
    answerLines: linesFromContent(q.answerContent),
    rightTextAnswers: q.rightTextAnswers,
    wrongTextAnswers: q.wrongTextAnswers,
  };
  const playerPayload = {
    view: "player" as const,
    price: q.price,
    typeName: q.typeName,
    roundName,
    themeName,
  };

  const role = c.role;
  if (!role) return;
  if (role === "spectator") {
    wsSend(c, "questionOpened", tvPayload);
    if (room.game.answerVisible) {
      wsSend(c, "answerShown", {
        view: "tv" as const,
        answerContent: resolveItems(q.answerContent),
        rightTextAnswers: q.rightTextAnswers,
        wrongTextAnswers: q.wrongTextAnswers,
      });
    }
  } else if (role === "host" && c.id === room.hostSocketId) {
    wsSend(c, "questionOpened", hostPayload);
    if (room.game.answerVisible) {
      wsSend(c, "answerShown", {
        view: "host" as const,
        answerLines: linesFromContent(q.answerContent),
        rightTextAnswers: q.rightTextAnswers,
        wrongTextAnswers: q.wrongTextAnswers,
      });
    }
  } else if (role === "player") {
    wsSend(c, "questionOpened", playerPayload);
  }
}

function broadcastState(room: Room) {
  forEachClientInRoom(room, (c, sid, role) => {
    wsSend(c, "state", buildSnapshotFor(room, sid, role));
  });
}

/** Один клиент — тот же формат, что при broadcast (после F5 или если событие потерялось). */
function emitStateToSocket(room: Room, c: ClientConn) {
  const role = c.role;
  if (!role || c.roomCode !== room.code) return;
  wsSend(c, "state", buildSnapshotFor(room, c.id, role));
}

function pickQuestion(
  room: Room,
  ri: number,
  ti: number,
  qi: number,
): ParsedQuestion | null {
  return room.pack?.questions[ri]?.[ti]?.[qi] ?? null;
}

function markCurrentQuestionPlayed(room: Room) {
  if (!room.game.active || !room.game.pack) return;
  const { themeIndex, questionIndex } = room.game.active;
  const th =
    room.game.pack.rounds[room.game.roundIndex]?.themes[themeIndex];
  if (th?.questions[questionIndex]) th.questions[questionIndex].played = true;
  const rp =
    room.pack?.rounds[room.game.roundIndex]?.themes[themeIndex]?.questions[
      questionIndex
    ];
  if (rp) rp.played = true;
}

function returnToBoardAfterQuestion(room: Room) {
  if (room.game.answerVisible && room.game.active && room.pack) {
    const { themeIndex, questionIndex } = room.game.active;
    const q = pickQuestion(room, room.game.roundIndex, themeIndex, questionIndex);
    if (q) emitAnswerToRoom(room, q, false);
  }
  room.game.phase = "board";
  room.game.active = null;
  room.game.answerVisible = false;
  room.game.buzzes = [];
  room.game.blockedBuzzPlayerIds = [];
  room.game.buzzCooldownUntilByPlayerId = {};
  emitToLogicalRoom(room, "questionClosed");
  broadcastState(room);
}

const app = express();
app.use(cors());
app.use(express.json());

/** Railway использует этот endpoint перед переключением новой версии. */
app.get("/health", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ ok: true });
});

const clientDist = path.join(process.cwd(), "client", "dist");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
}

app.post(
  "/api/room/:code/upload",
  upload.single("pack"),
  async (req, res) => {
    const code = String(req.params.code ?? "").toUpperCase();
    const hostHeader = String(req.headers["x-host-socket"] ?? "");
    const room = rooms.get(code);
    if (!room) {
      res.status(404).json({ error: "Комната не найдена" });
      return;
    }
    if (!req.file?.path) {
      res.status(400).json({ error: "Файл не получен" });
      return;
    }
    if (!room.hostSocketId || room.hostSocketId !== hostHeader) {
      res.status(403).json({
        error: "Сначала подключитесь к комнате как ведущий (сокет), затем загрузите пак.",
      });
      return;
    }
    try {
      const storageDir = path.join(
        process.env.TMPDIR ?? "/tmp",
        "sigame-packs",
        `${code}-${randomUUID()}`,
      );
      const pack = await parseSiqFile(req.file.path, storageDir);
      if (room.pack?.storageDir) {
        await fsp.rm(room.pack.storageDir, { recursive: true, force: true });
      }
      room.pack = pack;
      room.game.pack = publicMetaFromPack(pack);
      room.game.phase = "board";
      room.game.roundIndex = 0;
      room.game.active = null;
      room.game.answerVisible = false;
      room.game.buzzes = [];
      room.game.blockedBuzzPlayerIds = [];
      room.game.buzzCooldownUntilByPlayerId = {};
      await fsp.rm(req.file.path, { force: true });
      res.json({ ok: true, meta: room.game.pack });
    } catch (e) {
      await fsp.rm(req.file.path, { force: true }).catch(() => undefined);
      res.status(400).json({
        error: e instanceof Error ? e.message : "Ошибка разбора пакета",
      });
    }
  },
);

app.get("/api/room/:code/asset", (req, res) => {
  const code = String(req.params.code ?? "").toUpperCase();
  const p = String(req.query.path ?? "");
  const room = rooms.get(code);
  if (!room?.pack) {
    res.status(404).end();
    return;
  }
  const key = resolveMediaPath(room.pack.files, p);
  if (!key) {
    res.status(404).end();
    return;
  }
  const buf = room.pack.files.get(key);
  if (!buf) {
    res.status(404).end();
    return;
  }
  res.setHeader("Content-Type", guessMime(key));
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.sendFile(buf, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (!(err instanceof multer.MulterError)) return next(err);
    if (err.code === "LIMIT_FILE_SIZE") {
      const maxMb = Math.max(1, Math.round(PACK_UPLOAD_LIMIT_BYTES / (1024 * 1024)));
      res.status(413).json({
        error: `Файл слишком большой. Максимум ${maxMb} МБ.`,
      });
      return;
    }
    res.status(400).json({ error: err.message || "Ошибка загрузки файла" });
  },
);

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  const index = path.join(clientDist, "index.html");
  if (fs.existsSync(index)) res.sendFile(index);
  else res.status(404).send("Соберите клиент: npm run build");
});

function handleWsMessage(c: ClientConn, data: unknown) {
  const msg = data as { e?: string; d?: unknown; rid?: string } | null;
  if (!msg || typeof msg !== "object" || !msg.e) return;

  if (msg.e === "join") {
    const rid = typeof msg.rid === "string" ? msg.rid : undefined;
    const payload = (msg.d ?? {}) as {
      roomCode?: string;
      role: Role;
      nickname?: string;
      playerKey?: string;
      createRoom?: boolean;
    };
    const rawCode = String(payload.roomCode ?? "").toUpperCase().trim();
    const wantsCreate = payload.role === "host" && payload.createRoom === true && !rawCode;
    const code = wantsCreate ? generateRoomCode() : rawCode;
    if (!ROOM_CODE_RE.test(code)) {
      sendJoinResult(c, rid, { ok: false, error: "Введите пароль комнаты из 4 символов." });
      return;
    }
    const existingRoom = rooms.get(code);
    if (!existingRoom && payload.role !== "host") {
      sendJoinResult(c, rid, { ok: false, error: "Комната с таким паролем не найдена." });
      return;
    }
    const room = existingRoom ?? getOrCreateRoom(code);
    room.game.spectatorConnect.wifiPassword = code;

    /** Ровно один ведущий на комнату; игроков и зрителей — сколько угодно. */
    if (payload.role === "host") {
      if (room.hostSocketId && room.hostSocketId !== c.id) {
        sendJoinResult(c, rid, {
          ok: false,
          error: "Ведущий уже подключён. Дождитесь или создайте новую комнату.",
        });
        return;
      }
      room.hostSocketId = c.id;
    }

    const name = (payload.nickname ?? "").trim().slice(0, 32);
    if (payload.role === "player" && name.length === 0) {
      sendJoinResult(c, rid, { ok: false, error: "Введите ник" });
      return;
    }
    if (name.length > 0) room.nicknames.set(c.id, name);

    c.roomCode = code;
    c.role = payload.role;

    if (payload.role === "player") {
      const pk = String(payload.playerKey ?? "").trim().slice(0, 64);
      c.playerKey = pk || undefined;
      const playerId = pk || c.id;
      c.playerId = playerId;
      const pendingRemoval = room.playerDisconnectTimers.get(playerId);
      if (pendingRemoval) {
        clearTimeout(pendingRemoval);
        room.playerDisconnectTimers.delete(playerId);
      }
      const exists = room.game.players.find((x) => x.id === playerId);
      if (exists) {
        exists.name = name || exists.name;
      } else {
        let score = 0;
        let displayName = name || "Игрок";
        if (pk && room.playerResume.has(pk)) {
          const saved = room.playerResume.get(pk)!;
          room.playerResume.delete(pk);
          score = saved.score;
          displayName = name || saved.name;
        }
        room.game.players.push({
          id: playerId,
          name: displayName,
          score,
        });
      }
    } else {
      c.playerId = undefined;
      room.game.players = room.game.players.filter((x) => x.id !== c.id);
    }

    if (room.pack) room.game.pack = publicMetaFromPack(room.pack);

    sendJoinResult(c, rid, {
      ok: true,
      code,
      snapshot: buildSnapshotFor(room, c.id, payload.role),
    });
    broadcastState(room);
    resyncActiveQuestionForClient(room, c);

    if (DEBUG_ROOM) {
      let logicalN = 0;
      for (const [, x] of clients) {
        if (
          x.roomCode === room.code &&
          x.role &&
          x.socket.connected
        )
          logicalN++;
      }
      console.log(
        `[room ${room.code}] join role=${payload.role} id=${c.id.slice(0, 8)}… players=${room.game.players.length} logical=${logicalN}`,
      );
    }
    return;
  }

  const code = c.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  if (!room) return;

  switch (msg.e) {
    case "client:requestState":
      emitStateToSocket(room, c);
      break;
    case "host:setRound": {
      const idx = Number(msg.d);
      if (!room || room.hostSocketId !== c.id) return;
      if (!room.game.pack || idx < 0 || idx >= room.game.pack.rounds.length) return;
      room.game.roundIndex = idx;
      room.game.phase = "board";
      room.game.active = null;
      room.game.answerVisible = false;
      room.game.buzzes = [];
      room.game.blockedBuzzPlayerIds = [];
      room.game.buzzCooldownUntilByPlayerId = {};
      emitToLogicalRoom(room, "roundChanged", { roundIndex: idx });
      broadcastState(room);
      break;
    }
    case "host:openCell": {
      const cell = msg.d as { themeIndex: number; questionIndex: number };
      if (!room || room.hostSocketId !== c.id || !room.pack) return;
      const { themeIndex, questionIndex } = cell;
      const q = pickQuestion(room, room.game.roundIndex, themeIndex, questionIndex);
      if (!q) return;
      const th = room.game.pack?.rounds[room.game.roundIndex]?.themes[themeIndex];
      if (!th || th.questions[questionIndex]?.played) return;
      room.game.active = { themeIndex, questionIndex };
      room.game.phase = "question";
      room.game.answerVisible = false;
      room.game.buzzes = [];
      room.game.blockedBuzzPlayerIds = [];
      emitQuestionToRoom(room, q, themeIndex, questionIndex);
      broadcastState(room);
      break;
    }
    case "host:closeQuestion":
      if (!room || room.hostSocketId !== c.id) return;
      markCurrentQuestionPlayed(room);
      returnToBoardAfterQuestion(room);
      break;
    case "host:toggleAnswer": {
      const visible = Boolean(msg.d);
      if (!room || room.hostSocketId !== c.id || !room.game.active) return;
      room.game.answerVisible = visible;
      room.game.phase = visible ? "revealing" : "question";
      if (!room.pack) return;
      const { themeIndex, questionIndex } = room.game.active;
      const q = pickQuestion(room, room.game.roundIndex, themeIndex, questionIndex);
      if (!q) return;
      emitAnswerToRoom(room, q, visible);
      broadcastState(room);
      break;
    }
    case "host:replayMedia": {
      if (!room || room.hostSocketId !== c.id || !room.game.active || !room.pack) return;
      const { themeIndex, questionIndex } = room.game.active;
      const q = pickQuestion(room, room.game.roundIndex, themeIndex, questionIndex);
      if (!q) return;
      emitQuestionToRoom(room, q, themeIndex, questionIndex);
      if (room.game.answerVisible) emitAnswerToRoom(room, q, true);
      break;
    }
    case "host:setScore": {
      const p = msg.d as { playerId: string; score: number };
      if (!room || room.hostSocketId !== c.id) return;
      const pl = room.game.players.find((x) => x.id === p.playerId);
      if (pl) pl.score = Math.round(p.score);
      broadcastState(room);
      break;
    }
    case "host:addScore": {
      const p = msg.d as { playerId: string; delta: number };
      if (!room || room.hostSocketId !== c.id) return;
      const pl = room.game.players.find((x) => x.id === p.playerId);
      if (pl) pl.score = Math.round(pl.score + p.delta);
      broadcastState(room);
      break;
    }
    case "host:setCurrentPlayer":
      if (!room || room.hostSocketId !== c.id) return;
      room.game.currentPlayerId = (msg.d as string | null) ?? null;
      broadcastState(room);
      break;
    case "host:setSpectatorVolume": {
      const v = msg.d as { master: number };
      if (!room || room.hostSocketId !== c.id) return;
      const master = Math.min(1, Math.max(0, Number(v?.master)));
      if (!Number.isFinite(master)) return;
      room.game.spectatorVolume = { master };
      broadcastState(room);
      break;
    }
    case "host:setFalseStart": {
      if (!room || room.hostSocketId !== c.id) return;
      room.game.falseStartEnabled = Boolean(msg.d);
      broadcastState(room);
      break;
    }
    case "host:setSpectatorConnect": {
      const v = msg.d as { wifiName?: string; wifiPassword?: string; joinUrl?: string };
      if (!room || room.hostSocketId !== c.id) return;
      room.game.spectatorConnect = {
        wifiName: typeof v?.wifiName === "string" ? v.wifiName.slice(0, 200) : "",
        wifiPassword:
          typeof v?.wifiPassword === "string" ? v.wifiPassword.slice(0, 500) : "",
        joinUrl: typeof v?.joinUrl === "string" ? v.joinUrl.slice(0, 2000) : "",
      };
      broadcastState(room);
      break;
    }
    case "host:clearBuzz":
      if (!room || room.hostSocketId !== c.id) return;
      room.game.buzzes = [];
      room.game.blockedBuzzPlayerIds = [];
      room.game.buzzCooldownUntilByPlayerId = {};
      emitToLogicalRoom(room, "buzzCleared");
      broadcastState(room);
      break;
    case "host:buzzVerdict": {
      const payload = msg.d as { correct: boolean; half?: boolean } | boolean;
      if (!room || room.hostSocketId !== c.id) return;
      if (room.game.phase !== "question" && room.game.phase !== "revealing") return;
      if (room.game.buzzes.length === 0 || !room.game.active || !room.pack) return;
      const correct =
        typeof payload === "boolean" ? payload : payload?.correct === true;
      const half =
        typeof payload === "object" && payload !== null && payload.half === true;
      const first = room.game.buzzes[0];
      const { themeIndex, questionIndex } = room.game.active;
      const q = pickQuestion(room, room.game.roundIndex, themeIndex, questionIndex);
      const price = q?.price ?? 0;
      const delta = half ? Math.round(price / 2) : price;
      if (correct) {
        const pl = room.game.players.find((x) => x.id === first.playerId);
        if (pl) {
          pl.score = Math.round(pl.score + delta);
          room.game.lastCorrectPlayerId = pl.id;
        }
        markCurrentQuestionPlayed(room);
        returnToBoardAfterQuestion(room);
      } else {
        const pl = room.game.players.find((x) => x.id === first.playerId);
        if (pl) pl.score = Math.round(pl.score - price);
        if (!room.game.blockedBuzzPlayerIds.includes(first.playerId)) {
          room.game.blockedBuzzPlayerIds.push(first.playerId);
        }
        room.game.buzzes = room.game.buzzes.slice(1);
        broadcastState(room);
      }
      break;
    }
    case "player:buzz":
      if (!room || c.role !== "player") return;
      {
        const actorId = c.playerId ?? c.id;
        const now = Date.now();
        const cooldownUntil = room.game.buzzCooldownUntilByPlayerId[actorId] ?? 0;
        if (cooldownUntil > now) return;
        if (
          room.game.falseStartEnabled &&
          room.game.phase !== "question" &&
          room.game.phase !== "revealing"
        ) {
          room.game.buzzCooldownUntilByPlayerId[actorId] = now + FALSE_START_COOLDOWN_MS;
          broadcastState(room);
          return;
        }
        if (room.game.phase !== "question") return;
        if (room.game.blockedBuzzPlayerIds.includes(actorId)) return;
        const buzzName =
          room.game.players.find((p) => p.id === actorId)?.name ??
          room.nicknames.get(c.id) ??
          "Игрок";
        if (room.game.buzzes.some((b) => b.playerId === actorId)) return;
        room.game.buzzes.push({
          playerId: actorId,
          playerName: buzzName,
          at: Date.now(),
        });
      }
      broadcastState(room);
      break;
    default:
      break;
  }
}

function onWsClose(c: ClientConn) {
  clients.delete(c.id);
  const code = c.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  if (!room) return;
  room.nicknames.delete(c.id);
  if (c.role === "player") {
    const playerId = c.playerId ?? c.id;
    const pk = String(c.playerKey ?? "").trim().slice(0, 64);
    if (pk) {
      schedulePlayerRemoval(room, playerId, pk);
    } else {
      room.game.players = room.game.players.filter((x) => x.id !== playerId);
      room.game.buzzes = room.game.buzzes.filter((b) => b.playerId !== playerId);
      room.game.blockedBuzzPlayerIds = room.game.blockedBuzzPlayerIds.filter(
        (id) => id !== playerId,
      );
      delete room.game.buzzCooldownUntilByPlayerId[playerId];
      if (room.game.currentPlayerId === playerId) {
        room.game.currentPlayerId = null;
      }
    }
  }
  if (room.hostSocketId === c.id) {
    room.hostSocketId = null;
  }
  broadcastState(room);
  if (countClientsInRoom(code) === 0) {
    scheduleRoomDeletionIfEmpty(code);
  }
}

function schedulePlayerRemoval(room: Room, playerId: string, playerKey?: string) {
  const prev = room.playerDisconnectTimers.get(playerId);
  if (prev) clearTimeout(prev);
  const timer = setTimeout(() => {
    room.playerDisconnectTimers.delete(playerId);
    const stillConnected = Array.from(clients.values()).some(
      (x) =>
        x.roomCode === room.code &&
        x.role === "player" &&
        x.playerId === playerId &&
        x.socket.connected,
    );
    if (stillConnected) return;
    const pl = room.game.players.find((x) => x.id === playerId);
    if (pl && playerKey) {
      room.playerResume.set(playerKey, { name: pl.name, score: pl.score });
    }
    room.game.players = room.game.players.filter((x) => x.id !== playerId);
    room.game.buzzes = room.game.buzzes.filter((b) => b.playerId !== playerId);
    room.game.blockedBuzzPlayerIds = room.game.blockedBuzzPlayerIds.filter(
      (id) => id !== playerId,
    );
    delete room.game.buzzCooldownUntilByPlayerId[playerId];
    if (room.game.currentPlayerId === playerId) {
      room.game.currentPlayerId = null;
    }
    broadcastState(room);
    if (countClientsInRoom(room.code) === 0) {
      scheduleRoomDeletionIfEmpty(room.code);
    }
  }, PLAYER_RECONNECT_GRACE_MS);
  room.playerDisconnectTimers.set(playerId, timer);
}

const httpServer = http.createServer(app);
// Большие .siq-паки могут загружаться медленно через внешний туннель.
// Не обрываем такую загрузку стандартным 5-минутным таймаутом Node.js.
httpServer.requestTimeout = 30 * 60 * 1000;
httpServer.headersTimeout = 30 * 60 * 1000 + 10_000;
const io = new SocketIOServer(httpServer, {
  ...(SOCKET_IO_ALLOWED_ORIGIN
    ? { cors: { origin: SOCKET_IO_ALLOWED_ORIGIN } }
    : {}),
});

io.on("connection", (socket) => {
  const id = socket.id;
  const c: ClientConn = { id, socket };
  clients.set(id, c);
  socket.on("msg", (data) => handleWsMessage(c, data));
  socket.on("disconnect", () => onWsClose(c));
  socket.on("error", () => {});
});

const PORT = Number(process.env.PORT ?? 5174);
const HOST = process.env.HOST ?? "0.0.0.0";
httpServer.listen(PORT, HOST, () => {
  console.log(`SI Web: http://localhost:${PORT} (bind ${HOST})`);
});

function shutdown(signal: string) {
  console.log(`[shutdown] ${signal}`);
  io.close(() => {
    httpServer.close(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

import type { Role } from "@shared/gameTypes";

/** Роль + ник после «Войти» — дублируем в sessionStorage, чтобы F5 и прямой /play не теряли вход (важно для телефонов и Docker/LAN). */
export const PLAY_GATE_STORAGE_KEY = "si_play_gate";

export type PlayGate = { role: Role; nickname?: string; roomCode?: string };

function isRole(x: unknown): x is Role {
  return x === "host" || x === "player" || x === "spectator";
}

export function normalizePlayGate(raw: unknown): PlayGate | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as { role?: unknown; nickname?: unknown; roomCode?: unknown };
  if (!isRole(o.role)) return null;
  if (o.role === "player") {
    const n = typeof o.nickname === "string" ? o.nickname.trim() : "";
    if (!n) return null;
    return { role: "player", nickname: n.slice(0, 32), roomCode: normalizeRoomCode(o.roomCode) };
  }
  const nick =
    typeof o.nickname === "string" && o.nickname.trim()
      ? o.nickname.trim().slice(0, 32)
      : undefined;
  const roomCode =
    typeof o.roomCode === "string" && /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/.test(o.roomCode.trim().toUpperCase())
      ? o.roomCode.trim().toUpperCase()
      : undefined;
  return { role: o.role, nickname: nick, roomCode };
}

function normalizeRoomCode(raw: unknown): string | undefined {
  const code = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  return /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/.test(code) ? code : undefined;
}
export function readStoredPlayGate(): PlayGate | null {
  try {
    const raw = sessionStorage.getItem(PLAY_GATE_STORAGE_KEY);
    if (raw) {
      const g = normalizePlayGate(JSON.parse(raw) as unknown);
      if (g) return g;
    }
  } catch {
    /* ignore */
  }
  try {
    const raw = localStorage.getItem(PLAY_GATE_STORAGE_KEY);
    if (raw) return normalizePlayGate(JSON.parse(raw) as unknown);
  } catch {
    /* ignore */
  }
  return null;
}

/** Запасной вход: ?role=player&nick=... (state и sessionStorage иногда теряются на телефонах). */
export function parsePlayGateFromSearchParams(sp: URLSearchParams): PlayGate | null {
  const r = sp.get("role");
  if (!isRole(r)) return null;
  if (r === "player") {
    const nick = (sp.get("nick") ?? sp.get("nickname") ?? "").trim();
    if (!nick) return null;
    return { role: "player", nickname: nick.slice(0, 32), roomCode: normalizeRoomCode(sp.get("room")) };
  }
  const nickRaw = (sp.get("nick") ?? sp.get("nickname") ?? "").trim();
  const nickname = nickRaw ? nickRaw.slice(0, 32) : undefined;
  return { role: r, nickname, roomCode: normalizeRoomCode(sp.get("room")) };
}

export function writePlayGate(gate: PlayGate) {
  const s = JSON.stringify(gate);
  try {
    sessionStorage.setItem(PLAY_GATE_STORAGE_KEY, s);
  } catch {
    /* ignore */
  }
  try {
    localStorage.setItem(PLAY_GATE_STORAGE_KEY, s);
  } catch {
    /* ignore */
  }
}

export function clearPlayGate() {
  try {
    sessionStorage.removeItem(PLAY_GATE_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  try {
    localStorage.removeItem(PLAY_GATE_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

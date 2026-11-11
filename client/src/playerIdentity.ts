const LS_PLAYER_KEY = "si_player_key";

function createPlayerKey(): string {
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
  return `pk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Стабильный id в localStorage — сервер восстанавливает очки после перезагрузки страницы. */
export function getOrCreatePlayerKey(): string {
  try {
    let k = localStorage.getItem(LS_PLAYER_KEY);
    if (!k || k.length < 8) {
      k = createPlayerKey();
      localStorage.setItem(LS_PLAYER_KEY, k);
    }
    return k;
  } catch {
    return createPlayerKey();
  }
}

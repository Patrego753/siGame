/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Опционально: базовый URL Socket.IO (например http://127.0.0.1:5174). */
  readonly VITE_SOCKET_URL?: string;
  /** Устаревшее имя переменной, поддерживается для обратной совместимости. */
  readonly VITE_WS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

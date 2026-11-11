export type Role = "host" | "player" | "spectator";

export type ContentItem = {
  type: string;
  value: string;
  isRef: boolean;
  placement: string;
  duration?: string;
  waitForFinish: boolean;
};

export type ParsedQuestion = {
  price: number;
  typeName: string;
  questionContent: ContentItem[];
  answerContent: ContentItem[];
  rightTextAnswers: string[];
  wrongTextAnswers: string[];
};

export type BoardCell = {
  price: number;
  played: boolean;
};

export type BoardTheme = {
  name: string;
  questions: BoardCell[];
};

export type BoardRound = {
  name: string;
  type?: string;
  themes: BoardTheme[];
};

export type PublicPackMeta = {
  name: string;
  restriction?: string;
  language?: string;
  difficulty?: number;
  rounds: BoardRound[];
};

export type BuzzEntry = {
  playerId: string;
  playerName: string;
  at: number;
};

export type PlayerState = {
  id: string;
  name: string;
  score: number;
};

export type GamePhase =
  | "lobby"
  | "board"
  | "question"
  | "revealing";

export type GameState = {
  phase: GamePhase;
  roundIndex: number;
  /** Moving player for host UI (cat in bag / secret) */
  currentPlayerId: string | null;
  /** ID игрока, который последним ответил правильно */
  lastCorrectPlayerId: string | null;
  active: null | {
    themeIndex: number;
    questionIndex: number;
  };
  /** Whether answer text/media is visible on TV and players */
  answerVisible: boolean;
  buzzes: BuzzEntry[];
  /** Игроки, которые уже ошиблись на этом вопросе и не могут нажать снова */
  blockedBuzzPlayerIds: string[];
  /** Включает штраф за нажатие до старта вопроса: КД 2 секунды */
  falseStartEnabled: boolean;
  /** Unix-ms до которого игрок на КД после фальстарта */
  buzzCooldownUntilByPlayerId: Record<string, number>;
  players: PlayerState[];
  /** Громкость на ТВ: настраивает ведущий, применяется у зрителя (0–1) */
  spectatorVolume: {
    master: number;
  };
  /** Текст для зрителей: пароль Wi‑Fi и ссылка входа (задаёт ведущий) */
  spectatorConnect: {
    wifiName: string;
    wifiPassword: string;
    joinUrl: string;
  };
  pack: PublicPackMeta | null;
};

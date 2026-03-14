export type Side = 'white' | 'black';

export type UserTimeFilter = {
  sinceTimestampMs: number | null;
  cacheKey: string;
  label: string;
};

export type InitialPositionInput = {
  baseFen: string;
  currentFen: string;
  initialHistory: string[];
};

export type MoveStats = {
  san: string;
  total: number;
  white: number;
  draws: number;
  black: number;
};

export type MoveEval = {
  cp?: number;
  mate?: number;
  depth?: number;
};

export type SourceStats = {
  sourceName: string;
  moves: Map<string, MoveStats>;
};

export type CombinedMoveRow = {
  san: string;
  eval?: MoveEval;
  lichessUser?: MoveStats;
  chessComUser?: MoveStats;
  lichessDb?: MoveStats;
};

export type CloudEvalRetryPromptRequest = {
  requestDescription: string;
  retryIndex: number;
  maxRetries: number;
  waitSeconds: number;
};

export type ProgressUpdate = {
  key: string;
  label: string;
  current: number;
  total: number;
  done: boolean;
};

export type EvaluatePositionRequest = {
  lichessUser: string;
  chessComUser: string;
  initialPosition: string;
  history: string[];
  side: Side;
  timeFilter: string;
  forceRefreshUserGames: boolean;
  preferDownloadedUserGames: boolean;
};

export type EvaluatePositionResult = {
  baseFen: string;
  fen: string;
  side: Side;
  positionTurn: Side;
  boardText: string;
  tableText: string;
  rows: CombinedMoveRow[];
  history: string[];
  timeFilterLabel: string;
  userGamesPrimed: boolean;
};

export type BrowserResultEvent = {
  type: 'result';
  baseFen: string;
  fen: string;
  side: Side;
  positionTurn: Side;
  tableText: string;
  rows: CombinedMoveRow[];
  history: string[];
  timeFilterLabel: string;
  userGamesPrimed: boolean;
};

export type UiEvent =
  | { type: 'log'; message: string }
  | { type: 'progress'; key: string; label: string; current: number; total: number; done: boolean }
  | BrowserResultEvent
  | { type: 'error'; message: string }
  | { type: 'done' };

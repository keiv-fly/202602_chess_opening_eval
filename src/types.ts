export type Side = 'white' | 'black';

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

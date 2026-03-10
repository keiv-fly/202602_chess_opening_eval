export type CalculateMoveStatsOptions = {
  fen: string;
  filePaths: string[];
};

export type MoveStatsRow = {
  san: string;
  white: number;
  draws: number;
  black: number;
  total: number;
};

export declare function calculateMoveStats(options: CalculateMoveStatsOptions): Promise<MoveStatsRow[]>;

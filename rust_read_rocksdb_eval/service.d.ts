export type InitOptions = {
  dbPath?: string;
};

export type RocksdbEvalRow = {
  fen: string;
  eval: number | null;
  mate: number | null;
  depth: number | null;
  first_move: string | null;
  error: string | null;
};

export declare function getDefaultDbPath(): string;
export declare function init(options?: InitOptions): Promise<void>;
export declare function queryFens(fens: string[]): Promise<RocksdbEvalRow[]>;
export declare function close(): Promise<void>;
export declare function isInitialized(): Promise<boolean>;
export declare function currentDbPath(): Promise<string | null>;
